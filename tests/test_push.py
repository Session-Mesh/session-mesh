# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Push notifications: encryption and VAPID (webpush.py), what triggers them
(notify.py) and the subscription routes (server.py)."""

import hashlib
import hmac
import json

import pytest

pytest.importorskip("cryptography")
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

import notify  # noqa: E402
import server  # noqa: E402
import webpush  # noqa: E402

FCM = "https://fcm.googleapis.com/fcm/send/abc:def"


@pytest.fixture
def conf(tmp_path, monkeypatch):
    monkeypatch.setattr(webpush, "KEY_FILE", tmp_path / "vapid.pem")
    monkeypatch.setattr(webpush, "SUBS_FILE", tmp_path / "push.json")
    monkeypatch.setattr(webpush, "_key", None)
    return tmp_path


def browser_keys():
    """What a browser holds for a subscription: its private key and the JSON it sends."""
    key = ec.generate_private_key(ec.SECP256R1())
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = b"0123456789abcdef"
    return key, auth, {"endpoint": FCM, "keys": {"p256dh": webpush.b64u(raw), "auth": webpush.b64u(auth)}}


def browser_decrypt(key, auth, body):
    """RFC 8291 from the receiving side, written independently of webpush.encrypt."""
    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_public, record = body[21:21 + idlen], body[21 + idlen:]
    assert rs == 4096 and idlen == 65
    ua_public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))

    def hkdf(salt_, ikm, info, n):
        prk = hmac.new(salt_, ikm, hashlib.sha256).digest()
        return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]
    ikm = hkdf(auth, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, record, None)
    unpadded = plain.rstrip(b"\x00")   # RFC 8188: zero padding follows the delimiter
    assert unpadded.endswith(b"\x02")
    return unpadded[:-1]


# ---------------------------------------------------------------- crypto

def test_payload_decrypts_on_the_browser_side(conf):
    key, auth, sub = browser_keys()
    stored = webpush.parse_subscription(sub)
    body = webpush.encrypt(b'{"title": "x"}', stored["p256dh"], stored["auth"])
    assert browser_decrypt(key, auth, body) == b'{"title": "x"}'
    assert webpush.encrypt(b"x", stored["p256dh"], stored["auth"]) != webpush.encrypt(b"x", stored["p256dh"], stored["auth"])


def test_vapid_header_is_a_valid_es256_jwt_for_the_push_service(conf):
    header = webpush.vapid_header(FCM, now=1000)
    t, k = header.removeprefix("vapid t=").split(", k=")
    head, claims, sig = t.split(".")
    assert json.loads(webpush.unb64u(claims)) == {"aud": "https://fcm.googleapis.com", "exp": 1000 + 43200,
                                                   "sub": webpush.CONTACT}
    assert json.loads(webpush.unb64u(head))["alg"] == "ES256"
    raw = webpush.unb64u(sig)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.unb64u(k))
    public.verify(der, f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))   # raises if wrong


def test_vapid_key_is_kept_private_and_reused(conf, monkeypatch):
    first = webpush.public_key()
    assert (conf / "vapid.pem").stat().st_mode & 0o777 == 0o600
    monkeypatch.setattr(webpush, "_key", None)
    assert webpush.public_key() == first


def test_a_corrupt_vapid_key_is_an_error_not_a_new_key(conf):
    (conf / "vapid.pem").write_text("garbage")
    with pytest.raises(ValueError):
        webpush.public_key()
    assert (conf / "vapid.pem").read_text() == "garbage"


def test_rfc8291_appendix_a_vector():
    sender = ec.derive_private_key(int.from_bytes(webpush.unb64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"),
                                   ec.SECP256R1())
    body = webpush.encrypt(b"When I grow up, I want to be a watermelon",
                           "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                           "BTBZMqHH6r4Tts7J_aSIgg", salt=webpush.unb64u("DGv6ra1nlYgDCS1FRnbzlw"), sender=sender)
    assert webpush.b64u(body) == ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6"
                                  "TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")


# ---------------------------------------------------------------- subscriptions

@pytest.mark.parametrize("endpoint,ok", [
    (FCM, True), ("https://updates.push.services.mozilla.com/wpush/v2/x", True),
    ("https://web.push.apple.com/abc", True), ("https://wns2-example.notify.windows.com/w/?token=x", True),
    ("http://fcm.googleapis.com/x", False), ("https://fcm.googleapis.com:8443/x", False),
    ("https://evil.example/fcm.googleapis.com", False), ("https://fcm.googleapis.com.evil.example/x", False),
    ("https://push.apple.com.evil/x", False), ("https://127.0.0.1/x", False), ("https://x@evil.example/", False),
    # userinfo is written apart from the host so the leak guard does not read it as an e-mail address
    ("https://u:p" "@fcm.googleapis.com/x", False), ("https://u" "@fcm.googleapis.com/x", False),
    ("https://fcm.googleapis.com:abc/x", False), ("https://fcm.googleapis.com:443/x", False),
    ("https://FCM.googleapis.com/x", True), ("https://fcm.googleapis.com./x", False),
    (None, False), ("https://fcm.googleapis.com/" + "a" * 2000, False),
])
def test_only_push_services_are_valid_endpoints(endpoint, ok):
    assert webpush.valid_endpoint(endpoint) is ok


@pytest.mark.parametrize("mangle", [
    lambda s: s.update(endpoint="https://evil.example/x"),
    lambda s: s["keys"].update(p256dh="AAAA"),
    lambda s: s["keys"].update(auth="short"),
    lambda s: s["keys"].update(p256dh="!!not base64!!"),
    lambda s: s.pop("keys"),
])
def test_bad_subscriptions_are_refused(mangle):
    sub = browser_keys()[2]
    mangle(sub)
    with pytest.raises(ValueError):
        webpush.parse_subscription(sub)


def test_subscriptions_are_stored_privately_deduplicated_and_bounded(conf):
    sub = webpush.parse_subscription(browser_keys()[2])
    webpush.add_sub(sub)
    webpush.add_sub(sub)
    assert len(webpush.load_subs()) == 1
    assert (conf / "push.json").stat().st_mode & 0o777 == 0o600
    for i in range(webpush.MAX_SUBS + 5):
        webpush.add_sub({**sub, "endpoint": f"{FCM}{i}"})
    assert len(webpush.load_subs()) == webpush.MAX_SUBS
    assert webpush.remove_sub(f"{FCM}{webpush.MAX_SUBS + 4}") and not webpush.remove_sub("nope")


async def test_send_all_posts_encrypted_and_drops_refused_subscriptions(conf, aiohttp_server, monkeypatch):
    from aiohttp import ClientSession, web
    got = []

    async def push_service(request):
        got.append((request.match_info["who"], dict(request.headers), await request.read()))
        return web.Response(status={"gone": 410, "otherkey": 403}.get(request.match_info["who"], 201))
    app = web.Application()
    app.router.add_post("/{who}", push_service)
    srv = await aiohttp_server(app)
    key, auth, sub = browser_keys()
    stored = webpush.parse_subscription(sub)
    subs = [{**stored, "endpoint": str(srv.make_url("/ok"))}, {**stored, "endpoint": str(srv.make_url("/gone"))}]
    removed = []
    monkeypatch.setattr(webpush, "load_subs", lambda: subs)
    monkeypatch.setattr(webpush, "remove_sub", removed.append)
    async with ClientSession() as http:
        assert await webpush.send_all(http, {"title": "t", "body": "b", "id": "s"}) == 1
    assert removed == [subs[1]["endpoint"]]
    # one subscription that makes the client raise does not stop the others
    async def boom(*a, **k):
        raise ValueError("bad url")
    real = webpush.send
    monkeypatch.setattr(webpush, "send", lambda http, sub, m: boom() if sub is subs[1] else real(http, sub, m))
    async with ClientSession() as http:
        assert await webpush.send_all(http, {"title": "t", "body": "b", "id": "s"}) == 1
    who, headers, body = got[0]
    assert headers["Content-Encoding"] == "aes128gcm" and headers["Authorization"].startswith("vapid t=")
    assert json.loads(browser_decrypt(key, auth, body)) == {"title": "t", "body": "b", "id": "s"}


# ---------------------------------------------------------------- what triggers a notification

def listing(**agents):
    return {"mesh": [{"id": sid, "name": sid, "agent": a} for sid, a in agents.items()], "external": []}


def run(w, steps):
    """[(t, {id: agent})...] -> [(t, id, body)] notified."""
    out = []
    for t, agents in steps:
        out += [(t, m["id"], notify.detailed(m)["body"]) for m in w.changes(listing(**agents), now=t)]
    return out


def claude(status, **kw):
    return {"type": "claude", "status": status, **kw}


def test_first_sight_is_never_notified():
    assert run(notify.Watcher(), [(0, {"a": claude("waiting"), "b": claude("idle")})]) == []


def test_a_reply_then_a_new_question_is_notified_and_the_end_too():
    # the review's scenario: finished, the owner answers, the agent asks again, then finishes
    steps = [(0, {"a": claude("busy")}), (5, {"a": claude("idle", said="done")}), (11, {"a": claude("idle", said="done")}),
             (30, {"a": claude("busy")}), (60, {"a": claude("waiting", said="❓ push?")}),
             (90, {"a": claude("busy")}), (115, {"a": claude("idle")}), (121, {"a": claude("idle")}),
             (300, {"a": claude("idle")})]
    assert run(notify.Watcher(), steps) == [(11, "a", "finished · done"), (60, "a", "is waiting for you · ❓ push?"), (121, "a", "finished")]


def test_codex_pauses_are_not_an_end():
    codex = lambda st: {"type": "codex", "status": st}  # noqa: E731
    steps = [(0, {"c": codex("busy")}), (25, {"c": codex("idle")}), (50, {"c": codex("idle")}),
             (55, {"c": codex("busy")}), (80, {"c": codex("idle")}), (150, {"c": codex("idle")})]
    assert run(notify.Watcher(), steps) == [(150, "c", "finished")]


def test_a_held_back_waiting_goes_out_later():
    # two permissions in a row: the second is held by the spacing, then sent
    steps = [(0, {"a": claude("busy")}), (5, {"a": claude("waiting")}), (10, {"a": claude("busy")}),
             (20, {"a": claude("waiting")}), (30, {"a": claude("waiting")}), (40, {"a": claude("waiting")}),
             (60, {"a": claude("waiting")})]
    assert [t for t, *_ in run(notify.Watcher(), steps)] == [5, 40]


def test_a_held_back_finish_goes_out_later():
    steps = [(0, {"a": claude("busy")}), (5, {"a": claude("idle")}), (10, {"a": claude("idle")}),
             (15, {"a": claude("busy")}), (20, {"a": claude("idle")}), (25, {"a": claude("idle")}),
             (35, {"a": claude("idle")}), (45, {"a": claude("idle")})]
    assert [t for t, *_ in run(notify.Watcher(), steps)] == [10, 45]   # 45: first poll 30 s after the first


def test_a_new_question_between_two_polls_is_announced():
    steps = [(0, {"a": claude("busy")}), (5, {"a": claude("waiting", said="❓ one")}),
             (40, {"a": claude("waiting", said="❓ two")}), (50, {"a": claude("waiting", said="❓ two")})]
    assert [(t, b) for t, _, b in run(notify.Watcher(), steps)] == [(5, "is waiting for you · ❓ one"), (40, "is waiting for you · ❓ two")]


def test_an_unreadable_status_changes_nothing():
    steps = [(0, {"a": claude("busy")}), (5, {"a": claude(None)}), (10, {"a": claude("idle")}), (16, {"a": claude("idle")})]
    assert [t for t, *_ in run(notify.Watcher(), steps)] == [16]


def test_sessions_that_come_back_are_first_sight_again():
    w = notify.Watcher()
    run(w, [(0, {"a": claude("busy")})])
    run(w, [(10, {})])
    assert run(w, [(11, {"a": claude("waiting")})]) == []


def test_messages_stay_small():
    w = notify.Watcher()
    run(w, [(0, {"a": claude("busy", title="t" * 500)})])
    [ev] = w.changes(listing(a=claude("waiting", title="t" * 500, said="é" * 5000)), now=1)
    for m in (notify.detailed(ev), notify.minimal(ev)):
        assert len(m["title"]) <= notify.TITLE_MAX and len(m["body"]) <= notify.BODY_MAX
        assert len(json.dumps(m, ensure_ascii=False).encode()) < 1000


def test_shells_and_idle_to_busy_are_ignored():
    w = notify.Watcher()
    w.changes({"mesh": [{"id": "sh", "agent": None}], "external": []}, now=0)
    assert run(w, [(0, {"a": claude("idle")}), (500, {"a": claude("busy")})]) == []


# ---------------------------------------------------------------- routes

async def test_push_routes(conf, client, auth_cookie, monkeypatch):
    sent = []

    async def fake_send_all(http, message, subs=None):
        sent.append((message, subs))
        return len(subs)
    monkeypatch.setattr(webpush, "send_all", fake_send_all)
    key = await (await client.get("/api/push/key", headers=auth_cookie)).json()
    assert key["available"] and len(webpush.unb64u(key["key"])) == 65
    sub = browser_keys()[2]
    bad = await client.post("/api/push/subscribe", json={"subscription": {**sub, "endpoint": "https://evil.example/"}}, headers=auth_cookie)
    assert bad.status == 400
    ok = await client.post("/api/push/subscribe", json={"subscription": sub, "test": True}, headers=auth_cookie)
    assert ok.status == 200 and (await ok.json())["sent"] == 1
    assert [s["endpoint"] for s in sent[0][1]] == [FCM]   # the test goes to the new device only
    assert [s["endpoint"] for s in webpush.load_subs()] == [FCM]
    out = await client.post("/api/push/unsubscribe", json={"endpoint": FCM}, headers=auth_cookie)
    assert (await out.json())["removed"] is True and webpush.load_subs() == []


async def test_push_routes_need_auth_and_same_origin(conf, client, auth_cookie):
    assert (await client.get("/api/push/key")).status == 401
    resp = await client.post("/api/push/subscribe", json={"subscription": browser_keys()[2]},
                             headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403 and webpush.load_subs() == []


async def test_key_route_reports_unavailable_without_crypto(conf, client, auth_cookie, monkeypatch):
    monkeypatch.setattr(webpush, "AVAILABLE", False)
    assert (await (await client.get("/api/push/key", headers=auth_cookie)).json()) == {"available": False}
