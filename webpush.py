# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Web Push (RFC 8030) to the owner's browsers, without a third-party library.

The payload is encrypted for the browser (RFC 8291, aes128gcm): the push service
(Google's FCM for Chrome) relays it but cannot read it. The server identifies
itself with a VAPID key (RFC 8292), generated on first use and kept, like the
subscriptions, in ~/.config/session-mesh with mode 0600.

Needs the `cryptography` package; without it push is reported unavailable and
the rest of the mesh works as before.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import threading
import time
from urllib.parse import urlsplit

import aiohttp

import meshpaths
import fsutil

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    AVAILABLE = os.environ.get("MESH_PUSH") != "0"   # MESH_PUSH=0: push off (pre-production, scripts/preprod.sh)
except ImportError:   # pragma: no cover - depends on the host
    AVAILABLE = False

CONF_DIR = meshpaths.CONF_DIR
KEY_FILE = CONF_DIR / "vapid.pem"
SUBS_FILE = CONF_DIR / "push.json"
MAX_SUBS = 20
CONTACT = "mailto:session-mesh@invalid"   # required by VAPID; no real address leaves the machine

# The server POSTs to a subscription's endpoint: only to the browsers' push services,
# never to an address a client made up.
PUSH_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", ".push.apple.com",
              ".notify.windows.com")


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ---------------------------------------------------------------- keys

_key = None
_key_lock = threading.Lock()


def _private_key():
    """The VAPID key: created once and kept. Never silently replaced: every stored
    subscription is bound to it, a new key would make them all fail."""
    global _key
    with _key_lock:
        if _key is None:
            if KEY_FILE.exists():
                _key = serialization.load_pem_private_key(KEY_FILE.read_bytes(), None)   # corrupt: an error, not a new key
            else:
                key = ec.generate_private_key(ec.SECP256R1())
                pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                        serialization.NoEncryption())
                fsutil.atomic_write(KEY_FILE, pem.decode())   # saved before use, or nothing
                _key = key
    return _key


def _raw_public(key):
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def public_key():
    """The applicationServerKey browsers subscribe with (base64url, uncompressed P-256 point)."""
    return b64u(_raw_public(_private_key()))


# ---------------------------------------------------------------- subscriptions

def valid_endpoint(endpoint):
    if not isinstance(endpoint, str) or len(endpoint) > 1024:
        return False
    url = urlsplit(endpoint)
    try:
        port = url.port
    except ValueError:
        return False
    host = (url.hostname or "").lower()
    return url.scheme == "https" and port is None and url.username is None and url.password is None and \
        any(host == h or (h.startswith(".") and host.endswith(h)) for h in PUSH_HOSTS)


def parse_subscription(sub):
    """A browser's PushSubscription JSON reduced to what is kept, or ValueError."""
    if not isinstance(sub, dict) or not valid_endpoint(sub.get("endpoint")):
        raise ValueError("Invalid subscription")
    keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
    try:
        p256dh, auth = unb64u(str(keys.get("p256dh", ""))), unb64u(str(keys.get("auth", "")))
    except (ValueError, TypeError):
        raise ValueError("Invalid keys") from None
    if len(p256dh) != 65 or p256dh[0] != 4 or len(auth) != 16:
        raise ValueError("Invalid keys")
    return {"endpoint": sub["endpoint"], "p256dh": b64u(p256dh), "auth": b64u(auth)}


def load_subs():
    """Stored subscriptions. `detail` (the device opted in to detailed notifications) is True
    only when stored as the boolean True: a record without it, written before the option
    existed, is minimal."""
    try:
        subs = json.loads(SUBS_FILE.read_text())
        return [{**s, "detail": s.get("detail") is True} for s in subs
                if isinstance(s, dict) and valid_endpoint(s.get("endpoint"))]
    except (OSError, ValueError, TypeError):
        return []


def _save_subs(subs):
    fsutil.atomic_write(SUBS_FILE, json.dumps(subs))


_subs_lock = threading.Lock()   # add (worker thread) and remove (event loop) read-modify-write one file


def add_sub(sub, detail=None):
    """Store a subscription. detail=None keeps the device's earlier choice (the page re-subscribes
    at every launch); a new device is minimal."""
    with _subs_lock:
        subs = load_subs()
        before = next((s for s in subs if s["endpoint"] == sub["endpoint"]), {})
        subs = [s for s in subs if s["endpoint"] != sub["endpoint"]]
        flag = before.get("detail", False) if detail is None else detail
        subs.append({**sub, "added": time.time(), "detail": flag})
        _save_subs(subs[-MAX_SUBS:])
        return flag


def set_detail(endpoint, detail):
    """Opt a device in or out of detailed notifications; False if it is not subscribed."""
    with _subs_lock:
        subs = load_subs()
        found = [s for s in subs if s["endpoint"] == endpoint]
        for s in found:
            s["detail"] = detail
        if found:
            _save_subs(subs)
        return bool(found)


def remove_sub(endpoint):
    with _subs_lock:
        subs = load_subs()
        kept = [s for s in subs if s["endpoint"] != endpoint]
        if len(kept) != len(subs):
            _save_subs(kept)
        return len(kept) != len(subs)


# ---------------------------------------------------------------- encryption (RFC 8291)

def _hkdf_expand(prk, info, length):
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


def _hkdf_extract(salt, ikm):
    return hmac.new(salt, ikm, hashlib.sha256).digest()


PAD_BUCKETS = (512, 1024, 2048, 3072)   # plaintext sizes; the body stays under the push services' 4096 bytes


def _padded(data):
    """data + the last-record delimiter (RFC 8188 §2) + zero padding up to the next bucket, so the
    ciphertext's length says which bucket the message is in, not how long it is. Too big for
    any bucket: unpadded."""
    data += b"\x02"
    size = next((b for b in PAD_BUCKETS if b >= len(data)), len(data))
    return data + b"\x00" * (size - len(data))


def encrypt(payload, p256dh, auth, salt=None, sender=None, pad=False):
    """payload (bytes) as an aes128gcm body for the subscription's keys; pad: hide its length."""
    ua_public = unb64u(p256dh)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    sender = sender or ec.generate_private_key(ec.SECP256R1())
    as_public = _raw_public(sender)
    shared = sender.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf_expand(_hkdf_extract(unb64u(auth), shared), b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = salt or os.urandom(16)
    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
    plain = _padded(payload) if pad else payload + b"\x02"   # \x02: last (only) record
    record = AESGCM(cek).encrypt(nonce, plain, None)
    return salt + (4096).to_bytes(4, "big") + bytes([len(as_public)]) + as_public + record


# ---------------------------------------------------------------- VAPID (RFC 8292)

def vapid_header(endpoint, now=None):
    url = urlsplit(endpoint)
    # aud: the push service's origin (RFC 8292), whatever the endpoint's path or port
    claims = {"aud": f"https://{url.hostname}", "exp": int((now or time.time()) + 12 * 3600), "sub": CONTACT}
    signing_input = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode()) + "." + \
        b64u(json.dumps(claims, separators=(",", ":")).encode())
    r, s = decode_dss_signature(_private_key().sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    jwt = signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={jwt}, k={public_key()}"


# ---------------------------------------------------------------- sending

async def send(session, sub, message, ttl=3600):
    """POST one notification; returns the push service's HTTP status (0: not reached)."""
    body = encrypt(json.dumps(message, ensure_ascii=False).encode(), sub["p256dh"], sub["auth"], pad=True)
    headers = {"Authorization": vapid_header(sub["endpoint"]), "TTL": str(ttl), "Urgency": "high",
               "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream"}
    try:
        async with session.post(sub["endpoint"], data=body, headers=headers, allow_redirects=False) as resp:
            return resp.status
    except (OSError, TimeoutError, aiohttp.ClientError) as e:
        print(f"push: {urlsplit(sub['endpoint']).hostname} unreachable: {e}", flush=True)
        return 0


# 404/410: the subscription is gone; 401/403: it was made for another VAPID key
GONE = (401, 403, 404, 410)


async def send_all(session, message, subs=None):
    """Send to every subscription (or to subs), at once; drop those the push service
    refuses for good. One bad subscription never stops the others."""
    subs = load_subs() if subs is None else subs

    async def one(sub):
        try:
            status = await send(session, sub, message)
        except Exception as e:   # noqa: BLE001 - isolate each subscription
            print(f"push: {urlsplit(sub['endpoint']).hostname}: {e!r}", flush=True)
            return False
        if status in GONE:
            print(f"push: {urlsplit(sub['endpoint']).hostname} refuses the subscription ({status}): dropped", flush=True)
            remove_sub(sub["endpoint"])
        elif status and not 200 <= status < 300:
            print(f"push: {urlsplit(sub['endpoint']).hostname} answered {status}", flush=True)
        return 200 <= status < 300
    return sum(await asyncio.gather(*(one(s) for s in subs)))
