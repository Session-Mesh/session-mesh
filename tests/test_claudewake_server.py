# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The messaging-socket wake of a Claude session, through server.py.

Delivery, then confirmation by a look at the inbox, then the typed fallback;
and every path that launches a Claude session."""

import asyncio
import contextlib
import os
import shlex
import socket
import time

import pytest

import agentmail
import agentmcp
import agentwake
import claudewake
import resumeargs
import server
import session_helpers
from session_helpers import NONCE, add_session
from test_claudewake import Listener, OTHER, bind

CAPABILITIES = ["agent_wake_v1", "human_input_lease_v1"]
KEY = "crossSessionInbound"


@pytest.fixture
def mesh_listing(monkeypatch):
    return session_helpers.listing.__wrapped__(monkeypatch)


def remove_wake_directory():
    """The directory is the server's own (under /tmp when the test root is long): leave nothing."""
    if server.CLAUDE_WAKE_DIR.exists():
        for leftover in server.CLAUDE_WAKE_DIR.iterdir():
            leftover.unlink()
        with contextlib.suppress(OSError):
            server.CLAUDE_WAKE_DIR.rmdir()


class Peer:
    """alpha (Codex) writes to beta (Claude, with a socket); typed collects what reaches the host."""

    def __init__(self, listing, typed, headers):
        self.listing, self.headers = listing, headers
        self._requests = typed
        self.path = claudewake.socket_path(server.CLAUDE_WAKE_DIR, NONCE)

    @property
    def typed(self):
        """The typed notices that reached the PTY host (the ``cancel_submit`` that follows one is not)."""
        return [message for message in self._requests if message["op"] == "notify_if"]


@pytest.fixture
def claude_peer(client, mesh_listing, monkeypatch, tmp_path):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = add_session(mesh_listing, "alpha", OTHER)
    beta = add_session(mesh_listing, "beta", NONCE)
    mesh_listing[0]["meta"]["known_agent"] = "codex"
    mesh_listing[1]["meta"]["known_agent"] = "claude"
    mesh_listing[1]["pty_capabilities"] = list(CAPABILITIES)
    for index, session in enumerate(mesh_listing, 1):
        session.update(pid=index, activity=float(index), attached=0)
    typed = []

    async def host(message):
        if message["op"] == "list":
            return mesh_listing
        typed.append(message)
        return {"ok": True, "accepted": True}

    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(client.app["event_state"], "idle_since", lambda name, nonce: 5.0)
    assert claudewake.ensure_directory(server.CLAUDE_WAKE_DIR)
    yield Peer(mesh_listing, typed, {"alpha": alpha, "beta": beta})
    remove_wake_directory()


def send(text):
    live = [{"id": "alpha", "created": 1.0, "agent": "codex"},
            {"id": "beta", "created": 2.0, "agent": "claude"}]
    agentmail.send(live[0], live[1], "message", text, live)


def dispatcher_of(client):
    return agentwake.Dispatcher(
        lambda: server._agent_wake_live(None, client.app["event_state"], client.app["claude_wakes"]),
        client.app["agent_wakes"]._notify)


async def look_at_inbox(client, peer, who="beta"):
    response = await client.get("/api/agent-mail/@self/inbox", headers=peer.headers[who])
    assert response.status == 200
    return (await response.json())["messages"]


async def test_a_batch_is_woken_on_the_socket_and_confirmed_by_the_look_at_the_inbox(client, claude_peer):
    async with Listener(claude_peer.path) as listener:
        for text in ("SECRET-ONE do this", "SECRET-TWO", "SECRET-THREE"):
            send(text)
        dispatcher = dispatcher_of(client)
        assert await dispatcher.dispatch_once() is True      # line sent, not yet confirmed
        assert await dispatcher.dispatch_once() is True      # still waiting: no second line
        assert len(await look_at_inbox(client, claude_peer)) == 3
        assert await dispatcher.dispatch_once() is False     # confirmed: the wake is delivered
        assert await dispatcher.dispatch_once() is False     # nothing left
        lines = await listener.settle(1)
    assert lines == [claudewake.wake_line(3)] and b"SECRET" not in lines[0]
    assert claude_peer.typed == []                           # nothing typed in the terminal


LIVE = [{"id": "alpha", "created": 1.0, "agent": "codex"}, {"id": "beta", "created": 2.0, "agent": "claude"}]


async def test_without_that_look_the_wake_is_unconfirmed_and_nothing_is_ever_typed(client, claude_peer, monkeypatch):
    monkeypatch.setattr(client.app["claude_wakes"], "_confirm", 0.05)
    async with Listener(claude_peer.path) as listener:
        send("one")
        dispatcher = dispatcher_of(client)
        assert await dispatcher.dispatch_once() is True
        await asyncio.sleep(0.1)
        assert await dispatcher.dispatch_once() is False     # judged: nothing more to retry
        assert await dispatcher.dispatch_once() is False
        assert claude_peer.typed == []                       # a typed Enter could answer Claude's dialog
        assert client.app["claude_wakes"].unconfirmed() == {("beta", 2.0)}
        assert len(await listener.settle(1)) == 1
    assert agentmail.claim_wake(LIVE[1], LIVE)["state"] == "claimed"    # never counted as delivered


async def test_the_unconfirmed_state_is_shown_to_the_owner_and_cleared_by_the_look(
        client, claude_peer, monkeypatch, auth_cookie):
    monkeypatch.setattr(client.app["claude_wakes"], "_confirm", 0.05)

    async def shown():
        response = await client.get("/api/agent-mail/overview", headers=auth_cookie)
        return {row["identity"]["id"]: row["wake_unconfirmed"] for row in (await response.json())["sessions"]}

    async with Listener(claude_peer.path):
        send("one")
        dispatcher = dispatcher_of(client)
        await dispatcher.dispatch_once()
        assert await shown() == {"alpha": False, "beta": False}
        await asyncio.sleep(0.1)
        await dispatcher.dispatch_once()
        assert await shown() == {"alpha": False, "beta": True}
        await look_at_inbox(client, claude_peer)
        assert await shown() == {"alpha": False, "beta": False}
        assert await dispatcher.dispatch_once() is False
    assert claude_peer.typed == []


async def test_nothing_is_typed_even_when_the_socket_is_gone_after_the_line(client, claude_peer, monkeypatch):
    monkeypatch.setattr(client.app["claude_wakes"], "_confirm", 0.05)
    async with Listener(claude_peer.path):
        send("one")
        dispatcher = dispatcher_of(client)
        assert await dispatcher.dispatch_once() is True
    assert not claude_peer.path.exists()                     # Claude exited: no socket in the listing now
    await asyncio.sleep(0.1)
    assert await dispatcher.dispatch_once() is False
    assert claude_peer.typed == []
    assert client.app["claude_wakes"].unconfirmed() == {("beta", 2.0)}


async def test_a_restart_of_the_server_after_the_line_types_nothing_and_writes_no_second_line(
        client, claude_peer, monkeypatch):
    monkeypatch.setattr(client.app["claude_wakes"], "_confirm", 0.05)
    async with Listener(claude_peer.path) as listener:
        send("one")
        assert await dispatcher_of(client).dispatch_once() is True
        for _ in range(2):                                   # a restart each side of the judgement
            poster = client.app["claude_wakes"]
            poster._lines.clear()
            poster._reads.clear()
            poster._load()                                   # what a new server process does first
            await asyncio.sleep(0.1)
            await dispatcher_of(client).dispatch_once()
        assert client.app["claude_wakes"].unconfirmed() == {("beta", 2.0)}
        assert claude_peer.typed == []
        assert len(await listener.settle(1)) == 1


async def test_a_look_at_the_inbox_after_the_window_still_confirms_the_wake(client, claude_peer, monkeypatch):
    monkeypatch.setattr(client.app["claude_wakes"], "_confirm", 0.05)
    async with Listener(claude_peer.path):
        send("one")
        dispatcher = dispatcher_of(client)
        assert await dispatcher.dispatch_once() is True
        await asyncio.sleep(0.1)
        assert await dispatcher.dispatch_once() is False     # unconfirmed
        await look_at_inbox(client, claude_peer)
        assert await dispatcher.dispatch_once() is False
        assert agentmail.claim_wake(LIVE[1], LIVE) is None   # injected: counted as delivered
        assert claude_peer.typed == []

async def test_another_sessions_look_at_its_inbox_confirms_nothing(client, claude_peer, monkeypatch):
    monkeypatch.setattr(client.app["claude_wakes"], "_confirm", 5.0)
    async with Listener(claude_peer.path):
        send("one")
        dispatcher = dispatcher_of(client)
        assert await dispatcher.dispatch_once() is True
        await look_at_inbox(client, claude_peer, "alpha")
        assert await dispatcher.dispatch_once() is True


async def test_a_message_arriving_during_the_wait_is_neither_lost_nor_absorbed(client, claude_peer):
    async with Listener(claude_peer.path) as listener:
        send("one")
        dispatcher = dispatcher_of(client)
        assert await dispatcher.dispatch_once() is True
        send("two")                                           # a second batch forms behind the first
        assert await dispatcher.dispatch_once() is True       # still waiting for the first look
        await look_at_inbox(client, claude_peer)
        assert await dispatcher.dispatch_once() is True       # the second batch has its own line now
        await look_at_inbox(client, claude_peer)
        assert await dispatcher.dispatch_once() is False
        assert await listener.settle(2) == [claudewake.wake_line(1), claudewake.wake_line(1)]
    assert claude_peer.typed == []


async def test_a_socket_does_not_make_a_session_capable_of_the_typed_wake(client, claude_peer):
    del claude_peer.listing[1]["pty_capabilities"]            # an older PTY host
    async with Listener(claude_peer.path) as listener:
        live = await server._agent_wake_live(None, client.app["event_state"], client.app["claude_wakes"])
        beta = next(item for item in live if item["id"] == "beta")
        assert "wake_socket" in beta and beta["wake_capable"] is False
        send("one")
        assert await dispatcher_of(client).dispatch_once() is True    # durable and dormant
        assert await listener.settle(0) == [] and claude_peer.typed == []
    claude_peer.listing[1]["pty_capabilities"] = ["agent_wake_v1"]
    live = await server._agent_wake_live(None, client.app["event_state"], client.app["claude_wakes"])
    assert next(item for item in live if item["id"] == "beta")["wake_capable"] is False


async def test_without_a_socket_the_typed_notice_is_used_directly(client, claude_peer):
    stale = socket.socket(socket.AF_UNIX)
    stale.bind(str(claude_peer.path))
    stale.close()                                             # nobody listens: connection refused
    send("one")
    assert await dispatcher_of(client).dispatch_once() is False
    assert len(claude_peer.typed) == 1
    claude_peer.path.unlink()
    live = await server._agent_wake_live(None, client.app["event_state"], client.app["claude_wakes"])
    assert "wake_socket" not in next(item for item in live if item["id"] == "beta")


async def test_the_dispatch_removes_the_sockets_of_dead_incarnations_only(client, claude_peer):
    dead = claudewake.socket_path(server.CLAUDE_WAKE_DIR, "ab" * 16)
    fresh = claudewake.socket_path(server.CLAUDE_WAKE_DIR, "cd" * 16)
    bind(dead)
    bind(fresh, age=1)
    async with Listener(claude_peer.path):
        await server._agent_wake_live(None, client.app["event_state"], client.app["claude_wakes"])
        assert not dead.exists() and fresh.exists() and claude_peer.path.exists()


# --------------------------------------------------------- every Claude launch


@pytest.fixture
def capable(monkeypatch, short_root):
    monkeypatch.setattr(claudewake, "supported", lambda env: True)
    monkeypatch.setattr(claudewake.claudepolicy, "managed_directory", lambda: short_root / "no-managed")


@pytest.fixture
def launches(monkeypatch):
    sent, listing = [], []

    async def host(message):
        sent.append(message)
        if message["op"] == "list":
            return listing
        if message["op"] == "new":
            listing.append({"name": message["name"], "created": 9.0, "meta": message["meta"]})
        if message["op"] == "kill_if" and message["name"] == "old":
            listing[:] = [item for item in listing if item["name"] != "old"]
        return {"ok": True}

    monkeypatch.setattr(server, "host", host)
    yield sent, listing
    remove_wake_directory()


def socket_words(command, nonce):
    expected = claudewake.socket_path(server.CLAUDE_WAKE_DIR, nonce)
    return shlex.split(command)[-2:] == ["--messaging-socket-path", str(expected)]


async def test_every_claude_launch_gets_the_socket_of_its_own_incarnation(capable, launches):
    sent, listing = launches
    await server.new_session("fresh", "/", server.PRESETS["claude"], "claude", "claude")
    new = next(message for message in sent if message["op"] == "new")
    assert socket_words(new["command"], new["meta"]["nonce"]) and KEY not in new["command"]
    listing.append({"name": "old", "created": 1.0, "meta": {}})
    sent.clear()
    resumed = shlex.join(agentmcp.inject("claude", resumeargs.resume_argv(     # as server._resume_argv builds it
        "claude", ["claude", "--messaging-socket-path", "/x/old.sock"], "S")))
    await server.replace_session("old", 1.0, "again", "/", resumed, "claude", "claude")
    prepared = next(message for message in sent if message["op"] == "new")
    assert prepared["command"] is None                       # the dormant shell runs nothing
    start = next(message for message in sent if message["op"] == "start_if")
    assert socket_words(start["command"], prepared["meta"]["nonce"])
    assert shlex.split(start["command"]).count("--messaging-socket-path") == 1
    await server.new_session("shell", "/", "bash", None, None)
    assert next(m for m in reversed(sent) if m["op"] == "new")["command"] == "bash"


async def test_a_conversation_resumed_from_the_history_gets_the_socket_too(capable, launches, home_dir,
                                                                          monkeypatch):
    sent, _ = launches

    async def nobody(_sid, _agent):
        return None

    async def detail(_agent, _sid):
        return {"cwd": str(home_dir), "resumable": True}

    monkeypatch.setattr(server, "live_where", nobody)
    monkeypatch.setattr(server, "history_detail", detail)
    await server._resume_history("claude", "0123456789abcdef")
    new = next(message for message in sent if message["op"] == "new")
    assert new["meta"]["known_agent"] == "claude"
    assert socket_words(new["command"], new["meta"]["nonce"]) and KEY not in new["command"]
    sent.clear()
    await server._resume_history("codex", "0123456789abcdef")
    assert "--messaging-socket-path" not in next(m for m in sent if m["op"] == "new")["command"]


async def test_a_restart_and_a_restore_go_through_the_same_launch(capable, launches, monkeypatch):
    """Approved restart (session actions) and restore call new_session or replace_session with the
    agent type as known_agent: that is the only condition the launch needs."""
    sent, _ = launches
    for agent, expect in (("claude", True), ("codex", False)):
        sent.clear()
        command = shlex.join(agentmcp.inject(agent, [agent]))      # the bridge entry, as a real launch has it
        await server.new_session("x", "/", command, agent, agent)
        words = shlex.split(next(m for m in sent if m["op"] == "new")["command"])
        assert ("--messaging-socket-path" in words) is expect


async def test_a_launch_survives_unreadable_settings_with_the_typed_wake(capable, launches, short_root, monkeypatch):
    sent, _ = launches
    fifo = short_root / "claude-settings"
    fifo.mkdir()
    os.mkfifo(fifo / "settings.json")
    monkeypatch.setattr(server.ptyhost, "clean_env", lambda extra=None: {
        "PATH": "/usr/bin:/bin", "HOME": str(short_root), "CLAUDE_CONFIG_DIR": str(fifo)})
    started = time.monotonic()
    await server.new_session("fresh", "/", server.PRESETS["claude"], "claude", "claude")
    assert time.monotonic() - started < 5
    new = next(message for message in sent if message["op"] == "new")
    assert new["command"] == server.PRESETS["claude"]
