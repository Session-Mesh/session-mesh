# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The answer buttons are off unless the owner turns them on.

The switch is MESH_ANSWER_BUTTONS=1 in the server's environment, read once at startup."""

import inspect

import pytest

import server
from session_helpers import add_session, listing  # noqa: F401
from test_push_actions import mesh

SUBS = [{"endpoint": "https://fcm.googleapis.com/plain", "p256dh": "k", "auth": "a", "detail": False},
        {"endpoint": "https://fcm.googleapis.com/rich", "p256dh": "k", "auth": "a", "detail": True}]


def event():
    return {"id": "ask", "kind": "question", "label": "l", "full_label": "l", "type": "claude", "detail": "x"}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(server, "ACTIONS", {})


def messages():
    return [m for m, _ in server.deliveries(event(), mesh(), SUBS)]


def test_default_is_off():
    assert server.ANSWER_BUTTONS is False
    assert server.answer_buttons_enabled({}) is False


@pytest.mark.parametrize("value", ["", "0", "true", "yes", "on", "1 ", "2", "TRUE"])
def test_only_the_exact_value_one_turns_it_on(value):
    assert server.answer_buttons_enabled({"MESH_ANSWER_BUTTONS": value}) is False
    assert server.answer_buttons_enabled({"MESH_ANSWER_BUTTONS": "1"}) is True


def test_off_no_delivery_carries_buttons(monkeypatch):
    monkeypatch.setattr(server, "ANSWER_BUTTONS", False)
    out = messages()
    assert len(out) == 2
    for m in out:
        assert "actions" not in m and "token" not in m
    assert server.ACTIONS == {}
    assert "actions" not in server.with_actions({"id": "ask"}, mesh())


async def test_off_act_refuses_even_with_a_valid_looking_token(client, auth_cookie, monkeypatch):
    monkeypatch.setattr(server, "ANSWER_BUTTONS", True)
    token = server.with_actions({"id": "ask"}, mesh())["token"]
    monkeypatch.setattr(server, "ANSWER_BUTTONS", False)
    monkeypatch.setattr(server, "type_into", lambda *a: pytest.fail("typed while the switch is off"))
    resp = await client.post("/api/push/act", json={"token": token, "action": "0"}, headers=auth_cookie)
    assert resp.status == 403 and "MESH_ANSWER_BUTTONS" in await resp.text()


def test_on_buttons_only_for_detailed_devices(monkeypatch):
    monkeypatch.setattr(server, "ANSWER_BUTTONS", True)
    plain, rich = messages()
    assert "actions" not in plain and "token" not in plain
    assert [a["title"] for a in rich["actions"]] == ["Tea", "Coffee"] and rich["token"] in server.ACTIONS


@pytest.mark.parametrize("path", ["/api/push/subscribe", "/api/push/detail", "/api/push/unsubscribe",
                                  "/api/push/act", "/api/config", "/api/settings"])
async def test_no_http_route_changes_the_switch(client, auth_cookie, monkeypatch, path):
    monkeypatch.setattr(server, "ANSWER_BUTTONS", False)
    body = {"answer_buttons": True, "ANSWER_BUTTONS": True, "MESH_ANSWER_BUTTONS": "1",
            "endpoint": "https://fcm.googleapis.com/x", "detail": True, "token": "x", "action": "0"}
    for method in ("POST", "PUT", "PATCH"):
        await client.request(method, path, json=body, headers=auth_cookie)
        await client.request(method, path + "?MESH_ANSWER_BUTTONS=1&answer_buttons=1", headers=auth_cookie)
    assert server.ANSWER_BUTTONS is False


def test_the_switch_is_assigned_once_at_import():
    src = inspect.getsource(server)
    assert src.count("ANSWER_BUTTONS =") == 1
    assert "global ANSWER_BUTTONS" not in src


@pytest.mark.parametrize("on", [True, False])
async def test_a_session_token_is_refused_on_act(client, listing, monkeypatch, on):  # noqa: F811
    monkeypatch.setattr(server, "ANSWER_BUTTONS", on)
    token = server.with_actions({"id": "ask"}, mesh()).get("token", "made-up")
    headers = add_session(listing, "alpha")
    monkeypatch.setattr(server, "type_into", lambda *a: pytest.fail("a session token typed"))
    resp = await client.post("/api/push/act", json={"token": token, "action": "0"}, headers=headers)
    assert resp.status == 401
