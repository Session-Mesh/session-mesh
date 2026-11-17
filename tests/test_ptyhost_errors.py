# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Every control request gets exactly one control reply (ptyhost half).

Black-box against a ptyhost subprocess (protocol). The kill fault injections and the
typing-task reference check are in test_ptyhost_impl.py: no reliable black-box trigger.
"""

import asyncio
import json

import pytest

import ptyhost
from helpers import read_until
from ptyhost_proc import bounded, daemon, wait_until  # noqa: F401  (daemon is a fixture)


async def raw_exchange(daemon, kind, payload):
    """Send one first frame on a fresh connection; return the first reply frame."""
    reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
    try:
        writer.write(kind + len(payload).to_bytes(4, "big") + payload)
        await writer.drain()
        return await bounded(ptyhost.read_frame(reader))
    finally:
        writer.close()


@pytest.mark.ptyhost_t41
async def test_new_with_a_missing_cwd_replies_an_error_and_leaks_no_fd(daemon):
    req = {"op": "new", "name": "nowhere", "cwd": "/definitely/not/here"}
    assert "error" in await daemon.request(req)      # first call warms up lazy fds
    before = daemon.fd_count()
    for _ in range(20):
        assert "error" in await daemon.request(req)
    # The daemon may still hold the last request's connection for a moment after
    # replying; a leak (2 pty fds per call) would never settle back.
    await wait_until(lambda: daemon.fd_count() <= before, timeout=3)
    assert await daemon.names() == []


@pytest.mark.ptyhost_t41
async def test_new_without_a_name_replies_an_error(daemon):
    assert "error" in await daemon.request({"op": "new", "cwd": "/"})
    assert daemon.alive()
    assert await daemon.names() == []


async def test_attach_with_an_invalid_size_is_refused_before_joining(daemon):
    await daemon.new("sized")
    reply = await daemon.request({"op": "attach", "name": "sized", "rows": "x", "cols": 80})
    assert "error" in reply
    [info] = await daemon.request({"op": "list"})
    assert info["attached"] == 0


async def test_a_malformed_resize_frame_is_ignored(daemon, plain_transport_shell):
    await daemon.new("resized")
    reader, writer = await daemon.attach("resized")
    writer.write(ptyhost.frame(b"R", b"{"))
    writer.write(ptyhost.frame(b"R", {"rows": "x"}))
    writer.write(ptyhost.frame(b"R", b"\xff"))
    writer.write(ptyhost.frame(b"R", {"rows": 10 ** 6, "cols": 80}))   # beyond the ioctl's u16
    writer.write(ptyhost.frame(b"D", b"echo still-$((2+2))\r"))
    await read_until(reader, b"still-4")
    assert "Traceback" not in daemon.stderr()


@pytest.mark.parametrize("payload", [b"not json", b"[1, 2]", b'{"op": ["list"]}'],
                         ids=["not-json", "not-an-object", "unhashable-op"])
@pytest.mark.ptyhost_t41
async def test_a_malformed_request_replies_an_error(daemon, payload):
    kind, reply = await raw_exchange(daemon, b"C", payload)
    assert kind == b"C" and "error" in json.loads(reply)
    assert daemon.alive()


@pytest.mark.ptyhost_t41
async def test_kill_of_an_unknown_session_still_replies_ok_false(daemon):
    assert await daemon.request({"op": "kill", "name": "ghost"}) == {"ok": False}


# ---------------------------------------------------------------- an infinite attach size

async def test_attach_with_an_infinite_size_replies_an_error(daemon):
    await daemon.new("huge")
    payload = b'{"op": "attach", "name": "huge", "rows": 1e999, "cols": 5}'
    kind, reply = await raw_exchange(daemon, b"C", payload)
    assert kind == b"C" and "error" in json.loads(reply)
    assert "Traceback" not in daemon.stderr()


async def test_an_infinite_resize_frame_is_ignored(daemon, plain_transport_shell):
    await daemon.new("inf")
    reader, writer = await daemon.attach("inf")
    writer.write(ptyhost.frame(b"R", b'{"rows": 1e999, "cols": 5}'))
    writer.write(ptyhost.frame(b"R", b'{"rows": NaN, "cols": 5}'))
    writer.write(ptyhost.frame(b"D", b"echo still-$((3+3))\r"))
    await read_until(reader, b"still-6")
    assert "Traceback" not in daemon.stderr()
