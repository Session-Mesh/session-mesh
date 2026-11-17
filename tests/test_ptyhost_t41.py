# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Disposable control-plane evidence for the native ptyhost; no attach/replay or owner runtime."""
import asyncio
import json
import os
import signal
import tempfile
from pathlib import Path

import pytest

import ptyhost
from ptyhost_proc import Daemon, bounded, daemon, wait_until  # noqa: F401
from test_ptyhost_env import environ_of

pytestmark = [pytest.mark.ptyhost_t41]


async def test_bounded_json_refusal_leaves_listener_usable(daemon):
    for payload in [b"not json", b"0", b"[]", b'{"op":"list","ignored":"\xff"}',
                    b'{"op":"list","ignored":"\\ud800"}', b"[" * 200000,
                    b'{' + b'"meta":' + b"[" * 129 + b"0" + b"]" * 129 + b"}"]:
        reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
        try:
            writer.write(ptyhost.frame(b"C", payload))
            await writer.drain()
            kind, body = await bounded(ptyhost.read_frame(reader))
            assert kind == b"C" and "error" in json.loads(body)
            assert await bounded(reader.read()) == b""
        finally:
            writer.close()
        assert await daemon.request({"op": "list", "ignored": "é"}) == []


async def test_shutdown_cancels_incomplete_control_connection(daemon):
    reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
    try:
        writer.write(b"C\x00")
        await writer.drain()
        daemon.proc.send_signal(signal.SIGTERM)
        await wait_until(lambda: daemon.proc.poll() is not None, timeout=5)
        assert daemon.proc.returncode == 0, daemon.stderr()
        assert await bounded(reader.read()) == b""
    finally:
        writer.close()


async def test_actual_child_has_controlling_tty_dimensions_and_output_activity(monkeypatch, tmp_path):
    shell = tmp_path / "tty-proof.py"
    proof = tmp_path / "proof.json"
    shell.write_text("#!/usr/bin/python3\nimport os,fcntl,termios,struct,json,time,sys\n"
                     "fd=os.open('/dev/tty',os.O_RDWR)\n"
                     "dims=struct.unpack('HHHH',fcntl.ioctl(fd,termios.TIOCGWINSZ,b'\\0'*8))\n"
                     "json.dump([os.isatty(0),os.isatty(1),os.isatty(2),list(dims),sys.argv[1:]],"
                     "open(os.path.join(os.environ['HOME'],'proof.json'),'w'))\n"
                     "print('discarded output',flush=True)\n"
                     "while True: time.sleep(0.1)\n")
    shell.chmod(0o700)
    runtime = Path(tempfile.mkdtemp(prefix="t41-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime, home=tmp_path, parent_env={"SHELL": str(shell)})
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        await handle.new("tty", cwd=str(tmp_path))
        await wait_until(proof.exists)
        assert json.loads(proof.read_text()) == [True, True, True, [50, 200, 0, 0], ["-l"]]
        async def output_was_drained():
            [info] = await handle.request({"op": "list"})
            return info["activity"] > info["created"]
        await wait_until(output_was_drained)
    finally:
        assert handle.teardown() == {}


async def test_missing_shell_selects_bash(monkeypatch, tmp_path):
    runtime = Path(tempfile.mkdtemp(prefix="t41-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime, home=tmp_path, parent_env={})
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        await handle.new("fallback", cwd=str(tmp_path))
        [info] = await handle.request({"op": "list"})
        # Wait for the exec to land: before it, /proc shows the host's empty environment.
        expected = (str(tmp_path / ".local/bin") + ":/usr/bin:/bin").encode()
        await environment_after_exec(info["pid"], {b"PATH": expected})
        assert Path(f"/proc/{info['pid']}/exe").resolve().name == "bash"
    finally:
        assert handle.teardown() == {}


@pytest.mark.parametrize("target", ["file", "socket", "symlink"])
async def test_existing_socket_target_is_not_modified(target, tmp_path):
    import socket
    # pytest's descriptive node directory can exceed AF_UNIX's byte limit;
    # retain the same private short runtime boundary as other daemon fixtures.
    runtime = Path(tempfile.mkdtemp(prefix="t41-", dir=os.environ["SMESH_TEST_ROOT"]))
    directory = runtime / "session-mesh"
    directory.mkdir(parents=True, mode=0o700)
    path = directory / "ptyhost.sock"
    existing = None
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("untouched")
    sentinel.chmod(0o640)
    if target == "file":
        path.write_text("untouched")
    elif target == "symlink":
        path.symlink_to(sentinel)
    else:
        existing = socket.socket(socket.AF_UNIX)
        existing.bind(str(path))
    before = path.lstat()
    handle = Daemon(runtime)
    try:
        await wait_until(lambda: handle.proc.poll() is not None)
        assert handle.proc.returncode != 0
        after = path.lstat()
        assert (after.st_ino, after.st_mode) == (before.st_ino, before.st_mode)
        assert sentinel.read_text() == "untouched" and sentinel.stat().st_mode & 0o777 == 0o640
    finally:
        if handle.proc.poll() is None:
            handle.proc.kill()
            handle.proc.wait(timeout=5)
        if existing is not None:
            existing.close()


async def test_creation_order_session_leaders_and_reaped_kill(daemon):
    await daemon.new("second-spelling")
    await daemon.new("first-spelling")
    records = await daemon.request({"op": "list"})
    assert [s["name"] for s in records] == ["second-spelling", "first-spelling"]
    for info in records:
        assert os.getsid(info["pid"]) == info["pid"] == os.getpgid(info["pid"])
        assert isinstance(info["created"], (float, int))
        assert isinstance(info["activity"], (float, int))
    pid = records[0]["pid"]
    assert await daemon.request({"op": "kill", "name": records[0]["name"]}) == {"ok": True}
    await wait_until(lambda: not Path(f"/proc/{pid}").exists())
    await wait_until(lambda: _name_absent(daemon, records[0]["name"]))


async def _name_absent(handle, name):
    return name not in await handle.names()


async def environment_after_exec(pid, expected):
    # A creation reply does not make /proc/environ snapshots atomic with exec.
    # Observe the actual injected values, not a sleep or a transient snapshot.
    def ready():
        actual = environ_of(pid)
        return actual if all(actual.get(key) == value for key, value in expected.items()) else False
    return await wait_until(ready)


@pytest.mark.parametrize("count,accepted", [(4096, True), (4097, False)])
async def test_unicode_environment_character_boundary(daemon, count, accepted):
    reply = await daemon.request({"op": "new", "name": "unicode", "cwd": str(Path.home()),
                                  "env": {"MESH_UNICODE": "é" * count}})
    assert (reply.get("ok") is True) == accepted
    if accepted:
        [info] = await daemon.request({"op": "list"})
        expected = ("é" * count).encode()
        actual = await environment_after_exec(info["pid"], {b"MESH_UNICODE": expected})
        assert actual[b"MESH_UNICODE"] == expected
    else:
        assert "error" in reply and await daemon.names() == []


async def test_exactly_32_environment_items(daemon):
    extra = {f"MESH_K{i}": "v" for i in range(32)}
    assert await daemon.request({"op": "new", "name": "env32", "cwd": str(Path.home()),
                                  "env": extra}) == {"ok": True, "name": "env32"}
    [info] = await daemon.request({"op": "list"})
    actual = await environment_after_exec(info["pid"], {k.encode(): b"v" for k in extra})
    assert all(actual[k.encode()] == b"v" for k in extra)


@pytest.mark.parametrize("path_mode", ["absent", "present", "prefixed"])
async def test_synthetic_parent_whitelist_and_path(monkeypatch, path_mode):
    home = Path.home()
    local_bin = str(home / ".local" / "bin")
    inherited = {name: f"synthetic-{name}" for name in (
        "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME",
        "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY",
        "SSH_AUTH_SOCK", "EDITOR", "VISUAL")}
    inherited.update(HOME=str(home), SHELL="/bin/bash", OMITTED_CONTEXT="canary")
    if path_mode != "absent":
        inherited["PATH"] = (local_bin + ":" if path_mode == "prefixed" else "") + "/usr/bin:/bin"
    runtime = Path(tempfile.mkdtemp(prefix="t41-", dir=os.environ["SMESH_TEST_ROOT"]))
    # Kept so that tools inside a session find the same socket; it must name a valid directory.
    inherited["MESH_RUNTIME_DIR"] = str(runtime)
    handle = Daemon(runtime, parent_env=inherited)
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        await handle.new("whitelist")
        [info] = await handle.request({"op": "list"})
        expected = {name.encode(): value.encode() for name, value in inherited.items()
                    if name not in {"PATH", "OMITTED_CONTEXT"}}
        expected.update({
            b"TERM": b"xterm-256color", b"COLORTERM": b"truecolor",
            b"PATH": (local_bin + ":/usr/bin:/bin").encode(),
            b"XDG_RUNTIME_DIR": str(runtime).encode(),
        })
        # TERM/PATH alone can match an intermediate process environment;
        # wait for the complete whitelist before inspecting the snapshot.
        actual = await environment_after_exec(info["pid"], expected)
        assert all(actual[name.encode()] == value.encode()
                   for name, value in inherited.items() if name not in {"PATH", "OMITTED_CONTEXT"})
        assert actual[b"XDG_RUNTIME_DIR"] == str(runtime).encode()
        assert b"OMITTED_CONTEXT" not in actual
        assert actual[b"TERM"] == b"xterm-256color"
        assert actual[b"COLORTERM"] == b"truecolor"
        assert actual[b"PATH"] == (local_bin + ":/usr/bin:/bin").encode()
    finally:
        assert not handle.teardown()


async def test_control_reply_closes_after_one_request(daemon):
    reader, writer = await bounded(asyncio.open_unix_connection(str(daemon.sock)))
    try:
        writer.write(ptyhost.frame(b"C", {"op": "list"}))
        await writer.drain()
        kind, body = await bounded(ptyhost.read_frame(reader))
        assert kind == b"C" and json.loads(body) == []
        assert await bounded(reader.read()) == b""
    finally:
        writer.close()


@pytest.mark.parametrize("extra", [{"meta": []}, {"name": ""}, {"cwd": None},
                                   {"env": {"MESH_SURROGATE": "\ud800"}}])
async def test_candidate_invalid_new_fields_create_nothing(daemon, extra):
    reply = await daemon.request({"op": "new", "name": "refused", "cwd": str(Path.home()), **extra})
    assert isinstance(reply.get("error"), str)
    assert await daemon.names() == []


async def test_hup_ignoring_child_keeps_control_live_then_shutdown_reaps(monkeypatch, tmp_path):
    shell = tmp_path / "ignore-hup.py"
    ready = tmp_path / "ready"
    shell.write_text("#!/usr/bin/python3\nimport os,signal,time\n"
                     "signal.signal(signal.SIGHUP, signal.SIG_IGN)\n"
                     "open(os.path.join(os.environ['HOME'],'ready'),'w').close()\n"
                     "while True: time.sleep(0.1)\n")
    shell.chmod(0o700)
    runtime = Path(tempfile.mkdtemp(prefix="t41-", dir=os.environ["SMESH_TEST_ROOT"]))
    handle = Daemon(runtime, home=tmp_path, parent_env={"SHELL": str(shell), "PATH": "/usr/bin:/bin"})
    monkeypatch.setattr(ptyhost, "SOCK", handle.sock)
    try:
        await handle.wait_for_socket()
        await handle.new("ignore", cwd=str(tmp_path))
        [info] = await handle.request({"op": "list"})
        await wait_until(ready.exists)
        assert await handle.request({"op": "kill", "name": "ignore"}, timeout=1) == {"ok": True}
        assert await handle.names() == ["ignore"]
        assert Path(f"/proc/{info['pid']}").exists()
        handle.proc.send_signal(signal.SIGTERM)
        await wait_until(lambda: handle.proc.poll() is not None, timeout=5)
        assert handle.proc.returncode == 0, handle.stderr()
        assert not Path(f"/proc/{info['pid']}").exists()
    finally:
        assert not handle.teardown()
