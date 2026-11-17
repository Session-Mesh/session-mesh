# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The Python client of the native host (ptyhost.py): framing and the frame-size limit.

The host itself is tested black-box (test_ptyhost*.py). The last test here is the one fault of the
host that needs the client's help to be set up.
"""

import asyncio
import json
import struct

import pytest

import ptyhost
from helpers import kill_session_tree
from ptyhost_proc import wait_until


def test_frame_layout():
    """The Python client codec (``ptyhost.frame``); the wire layout itself is pinned in test_ptyhost.py."""
    assert ptyhost.frame(b"D", b"abc") == b"D\x00\x00\x00\x03abc"
    assert ptyhost.frame(b"C", {"op": "list"}) == b"C\x00\x00\x00\x0e" + b'{"op": "list"}'


async def test_frame_round_trip():
    reader = asyncio.StreamReader()
    blob = bytes(range(256)) * 300            # binary, > 64 KiB, every byte value
    reader.feed_data(ptyhost.frame(b"D", blob) + ptyhost.frame(b"C", {"op": "new", "name": "é"})
                     + ptyhost.frame(b"X", b""))
    reader.feed_eof()
    assert await ptyhost.read_frame(reader) == (b"D", blob)
    kind, payload = await ptyhost.read_frame(reader)
    assert kind == b"C" and json.loads(payload) == {"op": "new", "name": "é"}
    assert await ptyhost.read_frame(reader) == (b"X", b"")
    with pytest.raises(asyncio.IncompleteReadError):
        await ptyhost.read_frame(reader)


async def test_an_oversized_frame_header_is_refused_by_the_client_codec():
    reader = asyncio.StreamReader()
    reader.feed_data(b"C" + struct.pack(">I", 1 << 31))
    with pytest.raises(ConnectionError):
        await ptyhost.read_frame(reader)


async def test_kill_of_a_session_whose_process_group_is_already_gone_is_not_an_error(pty):
    """The group vanishes before the host signals it: ``kill`` ends the session or finds it already
    gone (ok false), never an error reply, and the host keeps serving. A refusal by the OS (EPERM)
    has no black-box trigger and is not tested."""
    await pty.new("dying")
    [session] = await pty.request({"op": "list"})
    assert not kill_session_tree(session["pid"])
    reply = await pty.request({"op": "kill", "name": "dying"})
    assert reply in ({"ok": True}, {"ok": False}), reply
    await wait_until(lambda: _names_empty(pty))
    assert pty.alive()


async def _names_empty(pty):
    return await pty.names() == []
