# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Helpers shared by the test modules: process cleanup, frame reading, known-defect asserts."""

import asyncio
import os
import signal
import subprocess
import sys
import time

import discover
import ptyhost


class KnownDefect(AssertionError):
    """Raised only by the assertion that encodes an audit finding.

    The xfail markers use ``raises=KnownDefect`` so that a setup failure inside
    such a test (a timeout while waiting for a prompt, say) is reported as a
    failure instead of being swallowed as an expected xfail.
    """


def expect_fixed(condition, message):
    if not condition:
        raise KnownDefect(message)


# ---------------------------------------------------------------- processes

def session_members(sid):
    """Live (non-zombie) pids whose Unix session id is ``sid``.

    ptyhost starts each shell with ``start_new_session=True``, so the shell's pid
    is the sid of everything it spawns. Interactive sh puts foreground jobs in
    their own process group, so killing the shell's pgrp is not enough.
    """
    if sys.platform != "linux":
        return _session_members_ps(sid)
    members = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        stat = discover.read_stat(int(entry))
        if stat and stat[4] == sid and stat[1] != "Z":
            members.append(int(entry))
    return members


def _session_members_ps(sid):
    """session_members without /proc (macOS): ps lists the pids and their state, getsid gives the session.

    The PTY host that could describe them through discover may already be stopped at teardown."""
    listing = subprocess.run(["ps", "-A", "-o", "pid=,stat="], capture_output=True, text=True, check=True).stdout
    members = []
    for line in listing.splitlines():
        fields = line.split()
        if len(fields) != 2 or not fields[0].isdigit() or fields[1].startswith("Z"):
            continue
        try:
            if os.getsid(int(fields[0])) == sid:
                members.append(int(fields[0]))
        except OSError:   # exited since the listing, or not ours to inspect
            pass
    return members


def kill_session_tree(sid, timeout=5.0):
    """SIGKILL every process in session ``sid``; return the pids still alive at the deadline."""
    deadline = time.monotonic() + timeout
    while True:
        members = session_members(sid)
        if not members or time.monotonic() > deadline:
            return members
        for pid in members:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.05)


# ---------------------------------------------------------------- frames

async def read_until(reader, marker, timeout=10.0):
    """Collect D frames until ``marker`` appears; fail with the tail of the output otherwise."""
    seen = bytearray()

    async def pump():
        # Search only the bytes a frame can add to a match: a host that sends
        # many small frames must not make this scan quadratic.
        found = marker in seen
        while not found:
            kind, payload = await ptyhost.read_frame(reader)
            if kind == b"D":
                start = max(0, len(seen) - len(marker) + 1)
                seen.extend(payload)
                found = seen.find(marker, start) != -1

    try:
        await asyncio.wait_for(pump(), timeout)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError) as exc:
        raise AssertionError(f"{marker!r} not seen within {timeout}s; got {bytes(seen[-300:])!r}") from exc
    return bytes(seen)


async def read_next_kind(reader, kinds, timeout=10.0):
    """Skip frames until one whose type is in ``kinds``; return (kind, payload)."""
    async def pump():
        while True:
            kind, payload = await ptyhost.read_frame(reader)
            if kind in kinds:
                return kind, payload

    return await asyncio.wait_for(pump(), timeout)
