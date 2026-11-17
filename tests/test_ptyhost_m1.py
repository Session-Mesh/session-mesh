# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Audit M1: a large write to a raw-mode program that does not read freezes ptyhost (protocol).

ptyhost runs as a *subprocess* (the ``daemon`` fixture): with the bug present its event
loop spins in the write forever, and it must not be the test process's loop. Every wait is
bounded, and the fixture kills the daemon and every session's process tree whatever the outcome.
"""

import asyncio

import pytest

import ptyhost
from helpers import expect_fixed
from ptyhost_proc import daemon  # noqa: F401  (pytest fixture)

PASTE = 1024 * 1024
LIST_DEADLINE = 3.0


async def test_large_write_to_a_stuck_raw_program_does_not_freeze_ptyhost(daemon, plain_transport_shell):  # noqa: F811
    _, writer = await daemon.raw_idle_session("stuck")       # raw mode is on, nothing reads stdin
    writer.write(ptyhost.frame(b"D", b"x" * PASTE))
    try:
        await asyncio.wait_for(writer.drain(), 5)
    except asyncio.TimeoutError:
        pass                                                  # a stalled socket is part of the symptom
    await asyncio.sleep(0.5)                                  # let ptyhost start on the paste

    try:
        listing = await daemon.request({"op": "list"}, timeout=LIST_DEADLINE)
    except (asyncio.TimeoutError, ConnectionError):
        listing = None
    expect_fixed(listing is not None,
                 f"ptyhost did not answer list within {LIST_DEADLINE}s during a {PASTE}-byte paste")
    assert [s["name"] for s in listing] == ["stuck"]
