# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Input conformance on a disposable socket, shared by both hosts."""

import asyncio
import json
import os
import tempfile
from pathlib import Path

import pytest

import ptyhost
from ptyhost_proc import Daemon, daemon  # noqa: F401

pytestmark = [pytest.mark.ptyhost_t43]


@pytest.fixture
async def plain_shell_daemon(monkeypatch, tmp_path):
    # Exercise real early shell input without owner login profiles or startup
    # commands changing terminal state. Ignore the host's added -l argument.
    shell = tmp_path / "plain-bash"
    shell.write_text("#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n")
    shell.chmod(0o700)
    runtime = Path(tempfile.mkdtemp(prefix="t43-plain-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime, home=tmp_path, parent_env={**os.environ, "SHELL": str(shell)})
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        yield handle
    finally:
        leftovers = handle.teardown()
    assert not leftovers, f"processes left behind: {leftovers}"


async def test_attached_input_has_one_control_reply_then_data_and_exit(plain_shell_daemon):
    await plain_shell_daemon.new("typed")
    reader, writer = await plain_shell_daemon.attach("typed")
    assert await asyncio.wait_for(ptyhost.read_frame(reader), 5) == (b"D", b"")
    for _ in range(128):
        writer.write(ptyhost.frame(b"D", b""))
    # The marker is absent from the echoed command, so this proves execution.
    writer.write(ptyhost.frame(b"D", b"printf 'T43_%s\\n' OK\r"))
    await writer.drain()
    seen = bytearray()
    while b"T43_OK" not in seen:
        kind, payload = await asyncio.wait_for(ptyhost.read_frame(reader), 5)
        assert kind == b"D", f"unexpected control/exit frame after attach: {kind!r}"
        seen.extend(payload)
    writer.write(ptyhost.frame(b"D", b"exit 7\r"))
    await writer.drain()
    while True:
        kind, payload = await asyncio.wait_for(ptyhost.read_frame(reader), 5)
        assert kind in (b"D", b"X"), f"unexpected second control frame: {kind!r}"
        if kind == b"X":
            assert json.loads(payload) == {"code": 7}
            break
    assert await asyncio.wait_for(reader.read(), 5) == b""


async def test_empty_startup_command_never_types_a_carriage_return(monkeypatch, tmp_path):
    shell = tmp_path / "probe.py"
    shell.write_text(
        "#!/usr/bin/python3\n"
        "import os,select,time\n"
        "os.write(1,b'READY\\n')\n"
        "if select.select([0],[],[],2)[0]: os.write(1,b'GOT_INPUT\\n')\n"
        "else: os.write(1,b'NO_INPUT\\n')\n"
        "time.sleep(60)\n"
    )
    shell.chmod(0o700)
    runtime = Path(tempfile.mkdtemp(prefix="t43-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime, home=tmp_path, parent_env={**os.environ, "SHELL": str(shell)})
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        await handle.new("empty", command="", cwd=str(tmp_path))
        reader, _ = await handle.attach("empty")
        data = bytearray()
        while b"NO_INPUT" not in data and b"GOT_INPUT" not in data:
            kind, payload = await asyncio.wait_for(ptyhost.read_frame(reader), 5)
            assert kind == b"D"
            data.extend(payload)
        assert b"NO_INPUT" in data, data
    finally:
        assert handle.teardown() == {}
