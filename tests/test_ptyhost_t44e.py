# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Candidate-only, opt-in passive observation on disposable OCaml hosts."""

import asyncio
import json
import os
import signal
import tempfile
from pathlib import Path

import pytest

import ptyhost
from helpers import read_until
from ptyhost_proc import Daemon, wait_until


pytestmark = pytest.mark.ptyhost_t44e

# The completion marker cannot occur in an echoed input command.
SECRET_COMMAND = b"printf 'SECRET-''MARKER\\n'\r"
SECRET_OUTPUT = b"SECRET-MARKER\r\n"


def test_observer_output_barrier_cannot_match_input_echo():
    assert b"SECRET-MARKER" not in SECRET_COMMAND
    assert SECRET_OUTPUT not in SECRET_COMMAND.replace(b"\r", b"\r\n")


async def _exercise_disposable_host(monkeypatch, *, enabled):
    runtime = Path(tempfile.mkdtemp(prefix="tap-", dir=os.environ["SMESH_TEST_ROOT"]))
    env = {**os.environ}
    env.pop("MESH_PTY_OBSERVE_BASENAME", None)
    if enabled:
        env["MESH_PTY_OBSERVE_BASENAME"] = "trace.ndjson"
    handle = Daemon(runtime, parent_env=env)
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    trace = runtime / "session-mesh" / "trace.ndjson"
    try:
        await handle.wait_for_socket()
        if enabled:
            assert trace.exists() and trace.stat().st_mode & 0o777 == 0o600
        else:
            assert not trace.exists()
        await handle.new("private-session", cwd=str(runtime))
        initial = (await handle.request({"op": "list"}))[0]["attached"]
        reader, writer = await handle.attach("private-session", rows=31, cols=71)
        attached = (await handle.request({"op": "list"}))[0]["attached"]
        # A normal shell command and resize still cross the same PTY. Their
        # content and identifying values must never enter the trace.
        # attach consumed C; the one D replay may already contain all startup
        # output. A second unsolicited frame is not guaranteed before input.
        kind, _snapshot = await asyncio.wait_for(ptyhost.read_frame(reader), timeout=5)
        assert kind == b"D"
        writer.write(ptyhost.frame(b"D", b"stty size\r"))
        await writer.drain()
        initial_size = b"31 71" in await read_until(reader, b"31 71", timeout=10)
        writer.write(ptyhost.frame(b"D", SECRET_COMMAND))
        await writer.drain()
        await read_until(reader, SECRET_OUTPUT, timeout=10)
        writer.write(ptyhost.frame(b"R", {"rows": 33, "cols": 73}))
        await writer.drain()
        writer.write(ptyhost.frame(b"D", b"stty size\r"))
        await writer.drain()
        resized = b"33 73" in await read_until(reader, b"33 73", timeout=10)
        writer.write(ptyhost.frame(
            b"D", b"printenv MESH_PTY_OBSERVE_BASENAME || printf 'x%dy' 7\r"))
        await writer.drain()
        no_env_leak = b"x7y" in await read_until(reader, b"x7y", timeout=10)
        still_attached = (await handle.request({"op": "list"}))[0]["attached"]
        writer.close()
        await writer.wait_closed()
        async def detached():
            return (await handle.request({"op": "list"}))[0]["attached"] == 0
        await wait_until(detached)
        remaining = await handle.names()
        if enabled:
            await wait_until(lambda: '"family":"detach"' in trace.read_text())
            text = trace.read_text()
            assert "SECRET-MARKER" not in text
            assert "private-session" not in text
            assert str(runtime) not in text
            records = [json.loads(line) for line in text.splitlines()]
            assert records[0] == {"schema": "mesh-pty-observe/v1"}
            assert len(records) <= 1025
            assert all(set(row) <= {"seq", "family", "bytes"} for row in records[1:])
            families = {row["family"] for row in records[1:]}
            assert {"create", "attach", "resize", "input", "output", "detach"} <= families
            handle.proc.send_signal(signal.SIGTERM)
            await asyncio.wait_for(asyncio.to_thread(handle.proc.wait), timeout=10)
            assert not trace.exists(), "host exit retained its observation sink"
        else:
            assert not trace.exists(), "default-off host created an observation artifact"
        return (initial, attached, initial_size, resized, no_env_leak,
                still_attached, remaining)
    finally:
        leftovers = handle.teardown()
        assert not leftovers


async def test_observer_does_not_change_session_or_terminal_behavior(monkeypatch):
    plain = await _exercise_disposable_host(monkeypatch, enabled=False)
    observed = await _exercise_disposable_host(monkeypatch, enabled=True)
    assert plain == observed == (0, 1, True, True, True, 1, ["private-session"])


async def test_observer_rejects_symlink_sink_without_touching_target():
    runtime = Path(tempfile.mkdtemp(prefix="tap-symlink-", dir=os.environ["SMESH_TEST_ROOT"]))
    directory = runtime / "session-mesh"
    directory.mkdir(mode=0o700)
    target = runtime / "sentinel"
    target.write_text("preserve")
    (directory / "trace.ndjson").symlink_to(target)
    env = {**os.environ, "MESH_PTY_OBSERVE_BASENAME": "trace.ndjson"}
    handle = Daemon(runtime, parent_env=env)
    try:
        await asyncio.wait_for(asyncio.to_thread(handle.proc.wait), timeout=10)
        assert handle.proc.returncode != 0
        assert target.read_text() == "preserve"
        assert not handle.sock.exists()
    finally:
        leftovers = handle.teardown()
    assert not leftovers


async def test_observer_rejects_reserved_socket_name_at_startup():
    runtime = Path(tempfile.mkdtemp(prefix="tap-reserved-", dir=os.environ["SMESH_TEST_ROOT"]))
    env = {**os.environ, "MESH_PTY_OBSERVE_BASENAME": "ptyhost.sock"}
    handle = Daemon(runtime, parent_env=env)
    try:
        await asyncio.wait_for(asyncio.to_thread(handle.proc.wait), timeout=10)
        assert handle.proc.returncode != 0
        assert not handle.sock.exists()
    finally:
        leftovers = handle.teardown()
    assert not leftovers
