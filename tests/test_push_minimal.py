# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Minimal push notifications by default: a notification carries the
session label and the kind of event, and nothing the agent wrote. The detailed form is a
per-device opt-in stored with the subscription."""

import json

import pytest

import notify
import server
import webpush
from test_push import FCM, browser_decrypt, browser_keys, conf  # noqa: F401  (conf: fixture)

CANARIES = ["CANARY-SAID", "CANARY-TOOL-ARG", "CANARY-CHOICE-A", "CANARY-CHOICE-B", "CANARY-AITITLE", "CANARY-WAITING"]
ALLOWED = {"title", "body", "id", "kind"}


def agent(status, **kw):
    return {"type": "claude", "status": status, "title": "CANARY-AITITLE", **kw}


def session(a, label="build box"):
    return {"id": "s1", "name": "s1", "kind": "mesh", "label": label, "agent": a}


QUESTION = dict(said="❓ CANARY-SAID which?", waiting_for="input needed", choices=["CANARY-CHOICE-A", "CANARY-CHOICE-B"], ask_id="toolu_1")
PERMISSION = dict(said="Bash: curl https://example.org/CANARY-TOOL-ARG", waiting_for="CANARY-WAITING")
FINISHED = dict(said="CANARY-SAID: edited /project/CANARY-TOOL-ARG.py")


def events(agent_after, label="build box"):
    w = notify.Watcher()
    w.changes({"mesh": [session(agent("busy"), label)], "external": []}, now=0)
    data = {"mesh": [session(agent_after, label)], "external": []}
    return w.changes(data, now=100) or w.changes(data, now=110)   # "finished" waits for the agent to settle


def one_event(status, **kw):
    [ev] = events(agent(status, **kw))
    return ev


@pytest.mark.parametrize("status,extra,kind", [("waiting", QUESTION, "question"), ("waiting", PERMISSION, "waiting"),
                                               ("idle", FINISHED, "finished")])
def test_default_payload_has_exactly_the_allowed_fields_and_no_canary(status, extra, kind):
    msg = notify.minimal(one_event(status, **extra))
    assert set(msg) == ALLOWED and msg["kind"] == kind and msg["id"] == "s1"
    assert msg["title"] == "build box"
    wire = json.dumps(msg, ensure_ascii=False)
    for canary in CANARIES:
        assert canary not in wire
    assert "http" not in wire and "curl" not in wire and "Bash" not in wire


def test_default_body_is_the_kind_only():
    assert notify.minimal(one_event("waiting", **QUESTION))["body"] == "is waiting for you · question"
    assert notify.minimal(one_event("waiting", **PERMISSION))["body"] == "is waiting for you"
    assert notify.minimal(one_event("idle", **FINISHED))["body"] == "finished"


def test_default_title_never_falls_back_to_the_agent_title():
    [ev] = events(agent("waiting", **PERMISSION), label=None)
    assert "CANARY-AITITLE" not in json.dumps(notify.minimal(ev)) and notify.minimal(ev)["title"] == "s1"


def test_only_the_detailed_form_carries_the_agent_text():
    msg = notify.message(one_event("waiting", **QUESTION), detail=False)
    assert msg == notify.minimal(one_event("waiting", **QUESTION))
    full = notify.message(one_event("waiting", **QUESTION), detail=True)
    assert "CANARY-SAID" in full["body"] and full["title"] == "build box (claude)"
    [titled] = events(agent("waiting", **QUESTION), label=None)
    assert "CANARY-AITITLE" in notify.detailed(titled)["title"]   # the old fallback, detailed form only


# ---------------------------------------------------------------- what the server hands to each device

def subs(**flags):
    return [{"endpoint": f"https://fcm.googleapis.com/{name}", "p256dh": "k", "auth": "a", "detail": on} for name, on in flags.items()]


def test_deliveries_split_devices_and_only_opted_in_ones_get_choices(monkeypatch):
    monkeypatch.setattr(server, "ACTIONS", {})
    monkeypatch.setattr(server, "ANSWER_BUTTONS", True)
    s = session(agent("waiting", **QUESTION))
    out = server.deliveries(one_event("waiting", **QUESTION), s, subs(plain=False, rich=True))
    by = {group[0]["endpoint"].rsplit("/", 1)[1]: msg for msg, group in out}
    assert set(by) == {"plain", "rich"}
    plain, rich = by["plain"], by["rich"]
    assert set(plain) == ALLOWED
    for canary in CANARIES:
        assert canary not in json.dumps(plain, ensure_ascii=False)
    assert [a["title"] for a in rich["actions"]] == ["CANARY-CHOICE-A", "CANARY-CHOICE-B"] and "CANARY-SAID" in rich["body"]


def test_deliveries_group_devices_and_skip_empty_groups(monkeypatch):
    monkeypatch.setattr(server, "ACTIONS", {})
    monkeypatch.setattr(server, "ANSWER_BUTTONS", True)
    ev, s = one_event("idle", **FINISHED), session(agent("idle", **FINISHED))
    assert [len(g) for _, g in server.deliveries(ev, s, subs(a=False, b=False))] == [2]
    assert [len(g) for _, g in server.deliveries(ev, s, subs(a=True))] == [1]
    assert server.deliveries(ev, s, []) == []
    [(msg, group)] = server.deliveries(ev, s, [{"endpoint": "https://fcm.googleapis.com/x"}])   # no flag at all: minimal
    assert set(msg) == ALLOWED and len(group) == 1


# ---------------------------------------------------------------- opt-in and migration

def test_a_new_subscription_is_minimal_and_the_opt_in_is_kept_with_it(conf):
    sub = webpush.parse_subscription(browser_keys()[2])
    webpush.add_sub(sub)
    assert [s["detail"] for s in webpush.load_subs()] == [False]
    assert webpush.set_detail(FCM, True) is True
    assert [s["detail"] for s in webpush.load_subs()] == [True]
    webpush.add_sub(sub)   # the page re-subscribes at every launch: it must not reset the choice
    assert [s["detail"] for s in webpush.load_subs()] == [True]
    webpush.add_sub(sub, detail=False)
    assert [s["detail"] for s in webpush.load_subs()] == [False]
    assert webpush.set_detail("https://fcm.googleapis.com/other", True) is False


def test_existing_subscriptions_become_minimal(conf):
    stored = webpush.parse_subscription(browser_keys()[2])
    webpush.SUBS_FILE.write_text(json.dumps([{**stored, "added": 1.0},                            # written before the flag existed
                                             {**stored, "endpoint": FCM + "2", "detail": "yes"},  # not a boolean
                                             {**stored, "endpoint": FCM + "3", "detail": True}]))
    assert [s["detail"] for s in webpush.load_subs()] == [False, False, True]


async def test_detail_routes(conf, client, auth_cookie):
    sub = browser_keys()[2]
    r = await client.post("/api/push/subscribe", json={"subscription": sub}, headers=auth_cookie)
    assert (await r.json())["detail"] is False
    r = await client.post("/api/push/detail", json={"endpoint": FCM, "detail": True}, headers=auth_cookie)
    assert r.status == 200 and (await r.json()) == {"ok": True, "detail": True}
    r = await client.post("/api/push/subscribe", json={"subscription": sub}, headers=auth_cookie)
    assert (await r.json())["detail"] is True   # re-subscribing keeps it
    r = await client.post("/api/push/subscribe", json={"subscription": sub, "detail": False}, headers=auth_cookie)
    assert (await r.json())["detail"] is False
    assert (await client.post("/api/push/detail", json={"endpoint": FCM, "detail": "yes"}, headers=auth_cookie)).status == 400
    assert (await client.post("/api/push/detail", json={"endpoint": "https://fcm.googleapis.com/none", "detail": True},
                              headers=auth_cookie)).status == 404
    assert (await client.post("/api/push/detail", json={"endpoint": FCM, "detail": True})).status == 401
    resp = await client.post("/api/push/detail", json={"endpoint": FCM, "detail": True},
                             headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403 and webpush.load_subs()[0]["detail"] is False


# ---------------------------------------------------------------- padding

def test_encrypted_length_does_not_follow_the_content(conf):
    key, auth, sub = browser_keys()
    stored = webpush.parse_subscription(sub)
    short = webpush.encrypt(json.dumps({"title": "a", "body": "finished", "id": "s1", "kind": "finished"}).encode(),
                            stored["p256dh"], stored["auth"], pad=True)
    long_ = webpush.encrypt(json.dumps({"title": "b" * 60, "body": "is waiting for you · question", "id": "session-12", "kind": "question"}).encode(),
                            stored["p256dh"], stored["auth"], pad=True)
    assert len(short) == len(long_)
    assert json.loads(browser_decrypt(key, auth, short))["body"] == "finished"
    big = webpush.encrypt(b"x" * 600, stored["p256dh"], stored["auth"], pad=True)
    assert len(big) > len(short) and len(big) - 86 - 16 in webpush.PAD_BUCKETS   # header, tag


def test_what_the_browser_decrypts_by_default_has_no_canary(conf):
    key, auth, sub = browser_keys()
    stored = webpush.parse_subscription(sub)
    for status, extra in (("waiting", QUESTION), ("waiting", PERMISSION), ("idle", FINISHED)):
        message = notify.message(one_event(status, **extra), detail=False)
        body = webpush.encrypt(json.dumps(message, ensure_ascii=False).encode(), stored["p256dh"], stored["auth"], pad=True)
        plain = browser_decrypt(key, auth, body).decode()
        assert set(json.loads(plain)) == ALLOWED and not any(c in plain for c in CANARIES)
        assert len(body) == 86 + 512 + 16


def test_padding_off_keeps_the_rfc_layout(conf):
    key, auth, sub = browser_keys()
    stored = webpush.parse_subscription(sub)
    body = webpush.encrypt(b"abc", stored["p256dh"], stored["auth"])
    assert len(body) == 86 + 3 + 1 + 16 and browser_decrypt(key, auth, body) == b"abc"


def test_oversized_payload_is_not_padded_beyond_the_limit(conf):
    stored = webpush.parse_subscription(browser_keys()[2])
    body = webpush.encrypt(b"x" * 3500, stored["p256dh"], stored["auth"], pad=True)
    assert len(body) <= 4096
