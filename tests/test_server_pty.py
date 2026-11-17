# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Server routes that drive ptyhost: /api/new, /api/sessions, /ws relay, /api/kill (server.py:109-206, 533-585)."""

import asyncio
import json

import aiohttp
import pytest
from aiohttp import web

import server


async def mesh_names(client, headers):
    resp = await client.get("/api/sessions", headers=headers)
    assert resp.status == 200
    return [s["name"] for s in (await resp.json())["mesh"]]


async def ws_read_until(ws, marker, timeout=10.0):
    seen = bytearray()

    async def pump():
        while marker not in seen:
            msg = await ws.receive()
            if msg.type != aiohttp.WSMsgType.BINARY:
                raise AssertionError(f"websocket ended ({msg.type}) before {marker!r}")
            seen.extend(msg.data)

    try:
        await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError as exc:
        raise AssertionError(f"{marker!r} not seen within {timeout}s; got {bytes(seen[-300:])!r}") from exc
    return bytes(seen)


async def test_new_ws_relay_and_kill(client, auth_cookie, pty, home_dir, plain_transport_shell):
    resp = await client.post("/api/new", json={"preset": "shell", "cwd": str(home_dir), "name": "srv-a"},
                             headers=auth_cookie)
    assert resp.status == 200
    assert await resp.json() == {"id": "srv-a"}

    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert data["ptyhost"] is True
    [session] = data["mesh"]
    assert session["name"] == "srv-a" and session["kind"] == "mesh"

    ws = await client.ws_connect("/ws/srv-a?rows=30&cols=90", headers=auth_cookie)
    try:
        await ws.send_bytes(b"printf 'WS''OK\\n'\r")
        await ws_read_until(ws, b"WSOK")
        await ws.send_bytes(b"stty size\r")
        await ws_read_until(ws, b"30 90")
        await ws.send_str(json.dumps({"t": "r", "rows": 31, "cols": 91}))
        await ws.send_bytes(b"stty size\r")
        await ws_read_until(ws, b"31 91")
    finally:
        await ws.close()

    resp = await client.post("/api/kill/srv-a", json={"created": session["created"]}, headers=auth_cookie)
    assert resp.status == 200
    for _ in range(100):
        if "srv-a" not in await mesh_names(client, auth_cookie):
            break
        await asyncio.sleep(0.05)
    assert "srv-a" not in await mesh_names(client, auth_cookie)


async def test_new_with_a_taken_name_gets_a_suffix(client, auth_cookie, pty, home_dir):
    body = {"preset": "shell", "cwd": str(home_dir), "name": "dup"}
    first = await (await client.post("/api/new", json=body, headers=auth_cookie)).json()
    second = await (await client.post("/api/new", json=body, headers=auth_cookie)).json()
    assert (first["id"], second["id"]) == ("dup", "dup-2")


async def test_kill_requires_exact_created_and_preserves_a_replacement(client, auth_cookie, pty):
    await pty.new("replace")
    [original] = await pty.request({"op": "list"})
    assert (await client.post("/api/kill/replace", headers=auth_cookie)).status == 400
    assert (await client.post("/api/kill/replace", json={"created": original["created"] + 1},
                              headers=auth_cookie)).status == 409
    assert [s["name"] for s in await pty.request({"op": "list"})] == ["replace"]
    assert (await client.post("/api/kill/replace", json={"created": original["created"]},
                              headers=auth_cookie)).status == 200
    assert (await client.post("/api/kill/replace", json={"created": original["created"]},
                              headers=auth_cookie)).status == 409


@pytest.mark.parametrize("created", [None, True, "1", float("inf"), float("nan")])
async def test_kill_refuses_invalid_created_before_host_access(client, auth_cookie, monkeypatch, created):
    async def forbidden_host(_request):
        pytest.fail("invalid incarnation reached ptyhost")
    monkeypatch.setattr(server, "host", forbidden_host)
    response = await client.post("/api/kill/invalid", json={"created": created}, headers=auth_cookie)
    assert response.status == 400


async def test_kill_replacement_between_list_and_host_claim_does_not_teardown(
        client, auth_cookie, monkeypatch):
    calls = []
    async def changing_host(req):
        calls.append(req)
        return [{"name": "race", "created": 1.0}] if req["op"] == "list" else {"ok": False}
    monkeypatch.setattr(server, "host", changing_host)
    monkeypatch.setattr(server, "list_sessions", lambda *args: {"mesh": []})
    monkeypatch.setattr(server.respawn, "forget_live", lambda *args: pytest.fail("forgot replacement"))
    monkeypatch.setattr(server.board, "remove", lambda *args: pytest.fail("removed replacement"))
    response = await client.post("/api/kill/race", json={"created": 1.0}, headers=auth_cookie)
    assert response.status == 409
    assert calls[-1] == {"op": "kill_if", "name": "race", "created": 1.0}


async def test_kill_on_an_old_host_fails_closed(client, auth_cookie, monkeypatch):
    calls = []
    async def old_host(req):
        calls.append(req["op"])
        if req["op"] == "list":
            return [{"name": "old", "created": 1.0}]
        raise web.HTTPBadRequest(text="Unknown op: kill_if")
    monkeypatch.setattr(server, "host", old_host)
    monkeypatch.setattr(server, "list_sessions", lambda *args: {"mesh": []})
    response = await client.post("/api/kill/old", json={"created": 1.0}, headers=auth_cookie)
    assert response.status == 503
    assert calls == ["list", "kill_if"]


@pytest.mark.parametrize("body", [
    {"preset": "shell", "name": "bad name!"},
    {"preset": "shell", "cwd": "/definitely/not/here"},
], ids=["invalid-name", "missing-cwd"])
async def test_new_rejects_bad_input(client, auth_cookie, pty, body):
    resp = await client.post("/api/new", json=body, headers=auth_cookie)
    assert resp.status == 400


async def test_ws_to_unknown_session_is_404(client, auth_cookie, pty):
    with pytest.raises(aiohttp.WSServerHandshakeError) as excinfo:
        await client.ws_connect("/ws/ghost", headers=auth_cookie)
    assert excinfo.value.status == 404


async def test_new_without_ptyhost_is_503(client, auth_cookie, home_dir):
    resp = await client.post("/api/new", json={"preset": "shell", "cwd": str(home_dir)},
                             headers=auth_cookie)
    assert resp.status == 503
