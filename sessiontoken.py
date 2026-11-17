# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Session tokens: a credential scoped to one mesh session.

    ms1.<name>.<nonce>.<mac>
    mac = HMAC(KEY, "ms1\\0<name>\\0<nonce>") (64 hex)
    KEY = HMAC(master token, "session-mesh/session-token/v1")

The mesh mints one when it creates a session and hands it to the session's shell
(``MESH_SESSION_TOKEN``). Nothing is stored: the server recomputes the MAC, so tokens
survive web-server restarts. A token is honoured only while ptyhost lists a session
of that name whose recorded nonce (``meta.nonce``) matches, so it dies with its
session and a later session reusing the name does not inherit it.

What a token may do is decided by the auth middleware in server.py, not here.
"""

import hashlib
import hmac
import re
import secrets

VERSION = "ms1"
NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,48}")
NONCE_RE = re.compile(r"[0-9a-f]{32}")
MAC_RE = re.compile(r"[0-9a-f]{64}")

KEY = b""


def derive_key(master_token):
    return hmac.new(master_token.encode(), b"session-mesh/session-token/v1", hashlib.sha256).digest()


def configure(master_token):
    """Bind the signing key to the mesh's master token."""
    global KEY
    KEY = derive_key(master_token)


def new_nonce():
    return secrets.token_hex(16)


def _mac(name, nonce):
    if not KEY:   # fail closed: an empty key would make every token forgeable
        raise RuntimeError("sessiontoken.configure() was not called")
    message = "\0".join((VERSION, name, nonce)).encode()
    return hmac.new(KEY, message, hashlib.sha256).hexdigest()


def issue(name, nonce):
    return f"{VERSION}.{name}.{nonce}.{_mac(name, nonce)}"


def signed(token):
    """(name, nonce) if ``token`` is well formed and carries a valid MAC, else None.

    This proves the mesh minted it, not that its session still lives (see ``verify``)."""
    parts = token.split(".") if isinstance(token, str) else []
    if len(parts) != 4 or parts[0] != VERSION or not KEY:
        return None
    _, name, nonce, mac = parts
    if not (NAME_RE.fullmatch(name) and NONCE_RE.fullmatch(nonce) and MAC_RE.fullmatch(mac)):
        return None
    return (name, nonce) if hmac.compare_digest(mac, _mac(name, nonce)) else None


def _recorded_nonce(session):
    meta = session.get("meta")
    nonce = meta.get("nonce") if isinstance(meta, dict) else None
    return nonce if isinstance(nonce, str) and nonce.isascii() else None


def verify(token, sessions):
    """The session name ``token`` speaks for, or None.

    ``sessions`` is ptyhost's ``list`` reply: the token must be signed, and a listed
    session of that name must have recorded the same nonce."""
    claim = signed(token)
    if claim is None:
        return None
    name, nonce = claim
    for session in sessions:
        if not isinstance(session, dict) or session.get("name") != name:
            continue
        recorded = _recorded_nonce(session)
        if recorded is not None and hmac.compare_digest(recorded.encode(), nonce.encode()):
            return name
    return None
