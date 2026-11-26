# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""ptyhost wire protocol, black-box against a ptyhost subprocess.

Markers are typed split (printf 'AB''C') so the shell's echo of the typed
command never contains the marker itself; only the command's output does.

All ``protocol``: these hold for any ptyhost implementation (``MESH_PTYHOST_CMD``).
The tests of the Python codec and other internals are in test_ptyhost_impl.py.
"""

import asyncio
import json
import shlex
import stat
import sys
import time
from pathlib import Path

import pytest

import ptyhost
from helpers import read_next_kind, read_until
from ptyhost_proc import bounded, daemon, wait_until  # noqa: F401  (daemon is a fixture)

# Notification ids the host remembers, per session, before the oldest is forgotten.
MAX_NOTIFIED = 256


async def gone(daemon, name):
    return name not in await daemon.names()


async def wait_until_gone(daemon, name, timeout=5.0):
    await wait_until(lambda: gone(daemon, name), timeout)


# ---------------------------------------------------------------- framing

@pytest.mark.ptyhost_t41
async def test_the_wire_layout_is_type_then_four_byte_big_endian_length(daemon):  # noqa: F811
    """Hand-built bytes, no client helper: a `list` request and its reply."""
    reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
    try:
        body = b'{"op": "list"}'
        writer.write(b"C" + len(body).to_bytes(4, "big") + body)
        head = await bounded(reader.readexactly(5))
        assert head[:1] == b"C"
        assert json.loads(await bounded(reader.readexactly(int.from_bytes(head[1:], "big")))) == []
    finally:
        writer.close()


@pytest.mark.ptyhost_t41
async def test_an_oversized_frame_header_closes_the_connection_without_buffering(daemon):  # noqa: F811
    for kind, length in ((b"C", 1 << 31), (b"D", 1 << 31)):
        reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
        try:
            writer.write(kind + length.to_bytes(4, "big"))
            assert await bounded(reader.read()) == b""      # closed, no reply, no wait for the body
        finally:
            writer.close()
    assert daemon.alive() and await daemon.names() == []


@pytest.mark.ptyhost_t41
async def test_deeply_nested_request_gets_an_error_reply(daemon):  # noqa: F811
    reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
    try:
        writer.write(ptyhost.frame(b"C", b"[" * 200000))
        await writer.drain()
        kind, payload = await bounded(ptyhost.read_frame(reader))
        assert kind == b"C" and b"error" in payload
    finally:
        writer.close()


# ---------------------------------------------------------------- daemon

@pytest.mark.ptyhost_t41
async def test_socket_is_private(daemon):  # noqa: F811
    assert stat.S_IMODE(daemon.sock.stat().st_mode) == 0o600
    assert stat.S_IMODE(daemon.sock.parent.stat().st_mode) == 0o700


@pytest.mark.ptyhost_t41
async def test_new_list_kill(daemon):  # noqa: F811
    assert await daemon.request({"op": "list"}) == []
    await daemon.new("alpha")
    listing = await daemon.request({"op": "list"})
    assert [s["name"] for s in listing] == ["alpha"]
    info = listing[0]
    assert isinstance(info["pid"], int) and info["attached"] == 0
    assert info["cwd"] == str(Path.home())
    assert {"created", "activity", "meta"} <= set(info)
    assert info["pty_capabilities"] == ["agent_wake_v1", "human_input_lease_v1", "conditional_input_v1",
                                        "acknowledged_input_v1", "acknowledged_input_v2",
                                        "agent_relaunch_v1", "agent_relaunch_bound_v1", "agent_relaunch_pi_v1"]
    assert await daemon.request({"op": "kill", "name": "alpha"}) == {"ok": True}
    await wait_until_gone(daemon, "alpha")


@pytest.mark.ptyhost_t41
async def test_kill_unknown_session(daemon):  # noqa: F811
    assert await daemon.request({"op": "kill", "name": "ghost"}) == {"ok": False}


@pytest.mark.ptyhost_t41
async def test_kill_if_claims_only_the_exact_incarnation_once(daemon):
    await daemon.new("conditional")
    [session] = await daemon.request({"op": "list"})
    created = session["created"]
    assert await daemon.request({"op": "kill_if", "name": "conditional", "created": created + 1}) == {"ok": False}
    assert await daemon.names() == ["conditional"]
    assert await daemon.request({"op": "kill_if", "name": "conditional", "created": created}) == {"ok": True}
    assert await daemon.request({"op": "kill_if", "name": "conditional", "created": created}) == {"ok": False}
    await wait_until_gone(daemon, "conditional")


@pytest.mark.ptyhost_t41
async def test_kill_if_refuses_a_missing_incarnation(daemon):
    await daemon.new("missing-created")
    assert "error" in await daemon.request({"op": "kill_if", "name": "missing-created"})
    assert await daemon.names() == ["missing-created"]


@pytest.mark.ptyhost_t41
async def test_start_if_types_once_only_into_exact_commandless_incarnation(daemon):
    await daemon.new("deferred")
    [session] = await daemon.request({"op": "list"})
    reader, writer = await daemon.attach("deferred")
    wrong = await daemon.request({"op": "start_if", "name": "deferred",
                                  "created": session["created"] + 1,
                                  "command": "printf 'WRONG'"})
    assert wrong == {"ok": False}
    started = await daemon.request({"op": "start_if", "name": "deferred",
                                    "created": session["created"],
                                    "command": "printf 'DEFERRED_''ONCE\\n'"})
    assert started == {"ok": True}
    output = await read_until(reader, b"DEFERRED_ONCE")
    assert output.count(b"DEFERRED_ONCE") == 1
    assert await daemon.request({"op": "start_if", "name": "deferred",
                                 "created": session["created"],
                                 "command": "printf 'TWICE_''BAD\\n'"}) == {"ok": False}
    writer.write(ptyhost.frame(b"D", b"printf 'AFTER_''START\\n'\r"))
    after = await read_until(reader, b"AFTER_START")
    assert b"TWICE_BAD" not in output + after


def wake_request(session, notification_id="wake_notification_0001", count=2):
    return {"op": "notify_if", "name": session["name"], "created": session["created"],
            "notification_id": notification_id, "count": count, "through_seq": count,
            # Idle evidence later than any input: these cases test the other gates.
            # The input-since-idle gate is tests/ptyhost-wake-idle.test.ts.
            "agent": "codex", "idle_since": time.time() + 3600}


# `exec -a` is a bash builtin option: dash, Debian's and Ubuntu's /bin/sh, refuses it.
@pytest.mark.ptyhost_t41
@pytest.mark.usefixtures("plain_transport_shell")
@pytest.mark.parametrize("agent", ["codex", "claude"])
async def test_notify_if_separates_paste_burst_from_submit(daemon, agent):
    """Regression: a raw text+CR burst only fills real agent editors."""
    await daemon.new(f"wake-submit-{agent}")
    [session] = await daemon.request({"op": "list"})
    reader, _writer = await daemon.attach(session["name"])
    fixture = Path(__file__).parent / "fixtures" / "wake_editor.py"
    command = "exec -a {} {} {}".format(
        shlex.quote(agent), shlex.quote(sys.executable), shlex.quote(str(fixture)))
    assert await daemon.request({
        "op": "start_if", "name": session["name"], "created": session["created"],
        "command": command,
    }) == {"ok": True}
    await read_until(reader, b"WAKE_EDITOR_READY")

    first = wake_request(session, f"wake_submit_{agent}_0001", 1)
    first["agent"] = agent
    assert await daemon.request(first) == {"ok": True, "accepted": True}
    await read_until(reader, b"WAKE_SUBMITTED")

    second = wake_request(session, f"wake_submit_{agent}_0002", 2)
    second["agent"] = agent
    assert await daemon.request(second) == {"ok": True, "accepted": True}
    await read_until(reader, b"WAKE_SUBMITTED")


@pytest.mark.ptyhost_t41
@pytest.mark.usefixtures("plain_transport_shell")
async def test_notify_if_is_exact_idempotent_and_requires_verified_foreground(daemon):
    await daemon.new("wake")
    [session] = await daemon.request({"op": "list"})
    request = wake_request(session)
    assert await daemon.request({**request, "created": session["created"] + 1}) == {
        "ok": False, "reason": "stale_incarnation"}
    assert await daemon.request(request) == {
        "ok": False, "reason": "unsupported_foreground"}

    reader, writer = await daemon.attach("wake")
    assert await daemon.request({"op": "start_if", "name": "wake", "created": session["created"],
                                 "command": "exec -a codex bash --noprofile --norc -i"}) == {"ok": True}
    await read_until(reader, b"codex-")
    assert await daemon.request(request) == {"ok": True, "accepted": True}
    output = await read_until(reader, b"check mail.inbox")
    assert b"check mail.inbox" in output
    assert await daemon.request(request) == {
        "ok": True, "accepted": False, "reason": "already_notified"}
    writer.write(ptyhost.frame(b"D", b"printf 'NO_''DUPLICATE\\n'\r"))
    after = await read_until(reader, b"NO_DUPLICATE")
    assert b"message(s) waiting" not in after


@pytest.mark.ptyhost_t41
@pytest.mark.usefixtures("plain_transport_shell")
async def test_dirty_human_lease_survives_disconnect_and_defers_wake(daemon):
    await daemon.new("leased")
    [session] = await daemon.request({"op": "list"})
    reader, writer = await daemon.attach("leased")
    assert await daemon.request({"op": "start_if", "name": "leased", "created": session["created"],
                                 "command": "exec -a codex bash --noprofile --norc -i"}) == {"ok": True}
    await read_until(reader, b"codex-")
    client_id = "browser_client_00000001"
    second_id = "browser_client_00000002"
    writer.write(ptyhost.frame(b"H", {"client_id": client_id, "dirty": True}))
    reader_other, writer_other = await daemon.attach("leased")
    writer_other.write(ptyhost.frame(b"H", {"client_id": second_id, "dirty": True}))
    await writer.drain()
    await writer_other.drain()
    await asyncio.sleep(0.05)
    request = wake_request(session, "wake_notification_0002", 3)
    assert await daemon.request(request) == {"ok": False, "reason": "human_dirty"}
    writer.close()
    await writer.wait_closed()
    assert await daemon.request(request) == {"ok": False, "reason": "human_dirty"}

    reader2, writer2 = await daemon.attach("leased")
    writer2.write(ptyhost.frame(b"H", {"client_id": client_id, "dirty": False}))
    await writer2.drain()
    await asyncio.sleep(0.05)
    assert await daemon.request(request) == {"ok": False, "reason": "human_dirty"}
    writer_other.write(ptyhost.frame(b"H", {"client_id": second_id, "dirty": False}))
    await writer_other.drain()
    await asyncio.sleep(0.05)
    assert await daemon.request(request) == {"ok": True, "accepted": True}
    await read_until(reader2, b"new message(s) waiting")


async def test_attach_handshake_advertises_optional_input_protocol(daemon):
    await daemon.new("attach-capabilities")
    reader, writer, reply = await ptyhost.attach_info("attach-capabilities", 24, 80)
    try:
        assert reply == {"ok": True, "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"],
                         "replay_geometry": {"rows": 50, "cols": 200}}   # the birth size
    finally:
        writer.close()
        await writer.wait_closed()


@pytest.mark.ptyhost_t41
@pytest.mark.usefixtures("plain_transport_shell")
async def test_human_lease_racing_wake_never_splits_submitted_bytes(daemon):
    await daemon.new("raced")
    [session] = await daemon.request({"op": "list"})
    reader, writer = await daemon.attach("raced")
    assert await daemon.request({"op": "start_if", "name": "raced", "created": session["created"],
                                 "command": "exec -a codex bash --noprofile --norc -i"}) == {"ok": True}
    await read_until(reader, b"codex-")
    request = wake_request(session, "wake_notification_race", 1)

    async def acquire_human_lease():
        writer.write(ptyhost.frame(b"H", {"client_id": "browser_race_0001", "dirty": True}))
        await writer.drain()

    _lease, first = await asyncio.gather(acquire_human_lease(), daemon.request(request))
    assert first in ({"ok": False, "reason": "human_dirty"},
                     {"ok": True, "accepted": True})
    writer.write(ptyhost.frame(b"D", b"printf 'LEASE_RACE_INTACT\\n'\r"))
    await writer.drain()
    output = await read_until(reader, b"LEASE_RACE_INTACT")
    writer.write(ptyhost.frame(b"H", {"client_id": "browser_race_0001", "dirty": False}))
    await writer.drain()
    if not first["ok"]:
        assert await daemon.request(request) == {"ok": True, "accepted": True}
        output += await read_until(reader, b"check mail.inbox")
    assert b"LEASE_RACE_INTACT" in output


@pytest.mark.ptyhost_t41
@pytest.mark.usefixtures("plain_transport_shell")
async def test_notify_idempotency_window_is_bounded(daemon):
    await daemon.new("bounded-wake")
    [session] = await daemon.request({"op": "list"})
    reader, _writer = await daemon.attach("bounded-wake")
    assert await daemon.request({
        "op": "start_if", "name": "bounded-wake", "created": session["created"],
        "command": "exec -a codex bash --noprofile --norc -i",
    }) == {"ok": True}
    await read_until(reader, b"codex-")

    first = None
    for index in range(MAX_NOTIFIED + 1):
        notification_id = f"wake_window_{index:016d}"
        request = wake_request(session, notification_id, 1)
        if first is None:
            first = request
        assert await daemon.request(request) == {"ok": True, "accepted": True}
    assert await daemon.request(first) == {"ok": True, "accepted": True}


@pytest.mark.ptyhost_t41
async def test_duplicate_name_is_refused(daemon):  # noqa: F811
    await daemon.new("twin")
    reply = await daemon.request({"op": "new", "name": "twin", "cwd": "/"})
    assert reply == {"error": "Name already taken"}  # bin/mesh-attach retries under another name on this text
    assert await daemon.names() == ["twin"]


@pytest.mark.ptyhost_t41
async def test_unknown_op_is_an_error(daemon):  # noqa: F811
    assert "error" in await daemon.request({"op": "explode"})


@pytest.mark.ptyhost_t41
async def test_first_frame_not_control_is_an_error(daemon):  # noqa: F811
    reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
    try:
        writer.write(ptyhost.frame(b"D", b"hello"))
        await writer.drain()
        kind, payload = await bounded(ptyhost.read_frame(reader))
        assert kind == b"C" and "error" in json.loads(payload)
    finally:
        writer.close()


async def test_attach_unknown_session_is_an_error(daemon):  # noqa: F811
    reply = await daemon.request({"op": "attach", "name": "ghost", "rows": 24, "cols": 80})
    assert "error" in reply
    with pytest.raises(LookupError):
        await daemon.attach("ghost")


async def test_attach_receives_replay_then_live_output(daemon, plain_transport_shell):  # noqa: F811
    await daemon.new("echo")
    first_reader, first_writer = await daemon.attach("echo")
    first_writer.write(ptyhost.frame(b"D", b"printf 'AB''C\\n'\r"))
    await read_until(first_reader, b"ABC")

    second_reader, second_writer = await daemon.attach("echo")
    kind, replay = await read_next_kind(second_reader, {b"D"})
    assert b"ABC" in replay                      # first D frame is the replay buffer

    second_writer.write(ptyhost.frame(b"D", b"printf 'DE''F\\n'\r"))
    await read_until(second_reader, b"DEF")      # live, on the client that typed
    await read_until(first_reader, b"DEF")       # and fanned out to the other client
    listing = await daemon.request({"op": "list"})
    assert listing[0]["attached"] == 2


async def test_attach_to_a_fresh_session_sends_the_replay_frame_first(daemon):  # noqa: F811
    await daemon.new("fresh")
    reader, _ = await daemon.attach("fresh")
    kind, _ = await bounded(ptyhost.read_frame(reader), 12)
    assert kind == b"D"


async def test_resize_reaches_the_pty(daemon, plain_transport_shell):  # noqa: F811
    await daemon.new("sized")
    reader, writer = await daemon.attach("sized", rows=24, cols=80)
    writer.write(ptyhost.frame(b"D", b"stty size\r"))
    await read_until(reader, b"24 80")
    writer.write(ptyhost.frame(b"R", {"rows": 33, "cols": 77}))
    writer.write(ptyhost.frame(b"D", b"stty size\r"))
    await read_until(reader, b"33 77")


async def test_resize_sizes_are_clamped_to_2_through_65535(daemon, plain_transport_shell):  # noqa: F811
    await daemon.new("clamped")
    reader, writer = await daemon.attach("clamped")
    writer.write(ptyhost.frame(b"R", {"rows": 0, "cols": 65535}))
    writer.write(ptyhost.frame(b"D", b"stty size\r"))
    await read_until(reader, b"2 65535")


async def test_a_new_pty_starts_at_50_rows_by_200_columns(daemon, plain_transport_shell):  # noqa: F811
    await daemon.new("initial")
    reader, writer = await daemon.attach("initial", rows=0, cols=0)   # falsy rows: no resize
    writer.write(ptyhost.frame(b"D", b"stty size\r"))
    await read_until(reader, b"50 200")


async def test_exit_sends_x_with_the_exit_code(daemon, plain_transport_shell):  # noqa: F811
    await daemon.new("leaver")
    reader, writer = await daemon.attach("leaver")
    writer.write(ptyhost.frame(b"D", b"exit 3\r"))
    kind, payload = await read_next_kind(reader, {b"X"})
    assert json.loads(payload) == {"code": 3}
    await wait_until_gone(daemon, "leaver")
