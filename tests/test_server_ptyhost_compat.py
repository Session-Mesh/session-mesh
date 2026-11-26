# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The web server against a misbehaving ptyhost.

A *fake* ptyhost (an asyncio unix server on a temp socket) stands in for the
old daemon that stays running until the owner restarts it: one that closes a
control connection without replying (the old `kill` on ProcessLookupError),
and one frozen (a blocked write) that accepts but never answers.
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path

import aiohttp
import pytest

import ptyhost
import server


class FakePtyhost:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.frames = []          # (kind, payload) received after an attach
        self.writers = []
        self.server = None

    async def handle(self, reader, writer):
        self.writers.append(writer)
        try:
            await self.behaviour(self, reader, writer)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()


async def close_without_reply(fake, reader, writer):
    await ptyhost.read_frame(reader)


async def reply_with_wrong_frame(fake, reader, writer):
    kind, payload = await ptyhost.read_frame(reader)
    fake.frames.append((kind, payload))
    request = json.loads(payload)
    if request.get("op") == "list":
        writer.write(ptyhost.frame(b"C", [{"name": "x", "created": 1.0, "pid": 12345,
                                         "attached": 0, "activity": 0}]))
    else:
        writer.write(ptyhost.frame(b"D", b"not a control reply"))
    await writer.drain()


async def never_reply(fake, reader, writer):
    await ptyhost.read_frame(reader)
    await reader.read()           # until the client gives up and closes


async def accept_attach_and_record(fake, reader, writer):
    await ptyhost.read_frame(reader)
    writer.write(ptyhost.frame(b"C", {"ok": True}) + ptyhost.frame(b"D", b""))
    await writer.drain()
    while True:
        fake.frames.append(await ptyhost.read_frame(reader))


@pytest.fixture
async def fake_ptyhost(monkeypatch):
    # This suite measures socket timeout/protocol behavior, not process
    # discovery.  Keep its deadline independent of the owner's /proc tree.
    monkeypatch.setattr(server.discover, "snapshot", lambda: {})
    monkeypatch.setattr(server.discover, "external_sessions", lambda procs, exclude_parents=(): [])
    runtime = Path(tempfile.mkdtemp(prefix="fake-", dir=os.environ["SMESH_TEST_ROOT"]))
    sock = runtime / "ptyhost.sock"
    monkeypatch.setattr(ptyhost, "SOCK", sock)
    started = []

    async def start(behaviour):
        fake = FakePtyhost(behaviour)
        fake.server = await asyncio.start_unix_server(fake.handle, path=str(sock))
        started.append(fake)
        return fake

    yield start
    for fake in started:
        fake.server.close()
        for writer in fake.writers:
            writer.close()
    sock.unlink(missing_ok=True)
    runtime.rmdir()


async def test_fake_ptyhost_fixture_excludes_real_machine_discovery(fake_ptyhost):
    """PTY timeout tests must not spend their budget scanning owner processes."""
    assert len(server.discover.snapshot()) == 0
    assert len(server.discover.external_sessions({}, exclude_parents=set())) == 0


async def test_kill_answered_by_a_closed_connection_is_503(client, auth_cookie, fake_ptyhost):
    await fake_ptyhost(close_without_reply)
    resp = await asyncio.wait_for(client.post("/api/kill/x", json={"created": 1.0}, headers=auth_cookie), 5)
    assert resp.status == 503


async def test_kill_with_malformed_reply_is_503_after_request_sent(client, auth_cookie, fake_ptyhost):
    fake = await fake_ptyhost(reply_with_wrong_frame)
    resp = await asyncio.wait_for(client.post("/api/kill/x", json={"created": 1.0}, headers=auth_cookie), 5)
    assert resp.status == 503
    assert [json.loads(payload)["op"] for _, payload in fake.frames] == ["list", "kill_if"]


async def test_config_reports_malformed_host_reply(monkeypatch):
    async def identity():
        return None

    async def invalid_reply(_request):
        raise ValueError("invalid control reply")

    monkeypatch.setattr(ptyhost, "host_identity", identity)
    monkeypatch.setattr(ptyhost, "request", invalid_reply)
    result = await server._config_host()
    assert result["running"] is True
    assert result["reply_valid"] is False


async def test_kill_against_a_frozen_ptyhost_is_503_within_the_timeout(
        client, auth_cookie, fake_ptyhost, monkeypatch):
    monkeypatch.setattr(ptyhost, "REQUEST_TIMEOUT", 0.5, raising=False)
    await fake_ptyhost(never_reply)
    resp = await asyncio.wait_for(client.post("/api/kill/x", json={"created": 1.0}, headers=auth_cookie), 1.5)
    assert resp.status == 503


async def test_sessions_against_a_frozen_ptyhost_degrade_to_an_empty_mesh(
        client, auth_cookie, fake_ptyhost, monkeypatch):
    monkeypatch.setattr(ptyhost, "REQUEST_TIMEOUT", 0.5, raising=False)
    await fake_ptyhost(never_reply)
    resp = await asyncio.wait_for(client.get("/api/sessions", headers=auth_cookie), 1.5)
    assert resp.status == 200
    assert (await resp.json())["mesh"] == []


async def test_ws_against_a_frozen_ptyhost_is_404_within_the_timeout(
        client, auth_cookie, fake_ptyhost, monkeypatch):
    monkeypatch.setattr(ptyhost, "REQUEST_TIMEOUT", 0.5, raising=False)
    await fake_ptyhost(never_reply)
    with pytest.raises(aiohttp.WSServerHandshakeError) as excinfo:
        await asyncio.wait_for(client.ws_connect("/ws/x", headers=auth_cookie), 1.5)
    assert excinfo.value.status == 404


async def test_one_websocket_paste_reaches_ptyhost_as_one_d_frame(client, auth_cookie, fake_ptyhost):
    """OQ3: whole-frame drop only keeps a bracketed paste whole if a paste is one D frame."""
    fake = await fake_ptyhost(accept_attach_and_record)
    paste = b"\x1b[200~" + b"line of pasted text\r" * 52000 + b"\x1b[201~"   # ~1 MiB
    ws = await client.ws_connect("/ws/x", headers=auth_cookie)
    try:
        await ws.send_bytes(paste)
        await asyncio.wait_for(_until(lambda: fake.frames), 5)
        await asyncio.sleep(0.2)     # a second frame, if the relay split the paste, lands here
    finally:
        await ws.close()
    assert [(kind, len(payload)) for kind, payload in fake.frames] == [(b"D", len(paste))]
    assert fake.frames[0][1] == paste


async def test_optional_human_lease_is_not_sent_to_an_old_ptyhost(
        client, auth_cookie, fake_ptyhost):
    """A newer browser must retain its D input when the owner has no H capability."""
    fake = await fake_ptyhost(accept_attach_and_record)
    ws = await client.ws_connect("/ws/x", headers=auth_cookie)
    try:
        await ws.send_str(json.dumps(
            {"t": "h", "client_id": "browser_tab_0001", "dirty": True}))
        await ws.send_bytes(b"typed after optional control")
        await asyncio.wait_for(_until(lambda: fake.frames), 5)
    finally:
        await ws.close()
    assert fake.frames == [(b"D", b"typed after optional control")]


async def _until(predicate):
    while not predicate():
        await asyncio.sleep(0.02)


# ---------------------------------------------------------------- an attach closed without a reply

async def test_ws_against_a_ptyhost_closing_the_attach_without_reply_is_404(
        client, auth_cookie, fake_ptyhost):
    await fake_ptyhost(close_without_reply)
    with pytest.raises(aiohttp.WSServerHandshakeError) as excinfo:
        await asyncio.wait_for(client.ws_connect("/ws/x", headers=auth_cookie), 5)
    assert excinfo.value.status == 404


@pytest.mark.parametrize("message", ['{"t": "r", "rows": 1e999, "cols": 5}',
                                     '{"t": "r", "rows": 10}', '{"t": "r", "rows": [1], "cols": 2}',
                                     '[1]'],
                         ids=["infinite", "missing-cols", "list", "not-an-object"])
async def test_a_malformed_resize_message_keeps_the_terminal(client, auth_cookie, fake_ptyhost,
                                                             message):
    fake = await fake_ptyhost(accept_attach_and_record)
    ws = await client.ws_connect("/ws/x", headers=auth_cookie)
    try:
        await ws.send_str(message)
        await ws.send_bytes(b"after")
        await asyncio.wait_for(_until(lambda: fake.frames), 5)
    finally:
        await ws.close()
    assert fake.frames == [(b"D", b"after")]
