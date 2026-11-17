# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Opt-in native PTY UID split, exercised with three real Linux namespace UIDs.

Run after building the native host with MESH_PTYHOST_NATIVE=<absolute binary>.
The user namespace is disposable; no owner daemon or session is touched.
"""

import asyncio
import hashlib
import json
import os
import pwd
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
NAMESPACE_PYTHON = "/usr/bin/python3"
RUNNER_UID = 1001
AGENT_UID = 1000
WEB_UID = 1002


def _as_runner(native, runtime, *, capabilities=True, host_args=()):
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(runtime),
        "SHELL": "/bin/sh",
        "XDG_RUNTIME_DIR": str(runtime),
        "MESH_PTY_AGENT_UID": str(AGENT_UID),
        "MESH_PARENT_ONLY": "runner-secret-canary",
    }
    argv = [
        "/usr/bin/setpriv",
        f"--reuid={RUNNER_UID}",
        f"--regid={RUNNER_UID}",
        "--clear-groups",
    ]
    if capabilities:
        argv += [
            "--ambient-caps=+setuid,+setgid,+setpcap",
            "--inh-caps=+setuid,+setgid,+setpcap",
        ]
    argv.append("--no-new-privs")
    return subprocess.Popen(
        argv + [native, *host_args], env=env, cwd="/", stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, start_new_session=True,
    )


def _wait_socket(proc, path):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if path.is_socket():
            return
        if proc.poll() is not None:
            raise AssertionError(f"host exited before socket: {proc.stderr.read()!r}")
        time.sleep(0.03)
    raise AssertionError("host never opened socket")


async def _request(sock, command):
    reader, writer = await asyncio.open_unix_connection(str(sock))
    try:
        payload = json.dumps(command).encode()
        writer.write(b"C" + len(payload).to_bytes(4, "big") + payload)
        await writer.drain()
        header = await reader.readexactly(5)
        assert header[:1] == b"C"
        return json.loads(await reader.readexactly(int.from_bytes(header[1:], "big")))
    finally:
        writer.close()
        await writer.wait_closed()


async def _attach_replay(sock):
    reader, writer = await asyncio.open_unix_connection(str(sock))
    try:
        payload = json.dumps({
            "op": "attach", "name": "isolated", "rows": 24, "cols": 80,
        }).encode()
        writer.write(b"C" + len(payload).to_bytes(4, "big") + payload)
        await writer.drain()
        output = bytearray()
        for _ in range(10):
            header = await asyncio.wait_for(reader.readexactly(5), 2)
            body = await reader.readexactly(int.from_bytes(header[1:], "big"))
            if header[:1] == b"C":
                assert json.loads(body)["ok"] is True
            elif header[:1] == b"D":
                output.extend(body)
            if b"MESH_UID_SPLIT_READY" in output and b"REGAIN_REFUSED" in output:
                return bytes(output)
        raise AssertionError(f"missing PTY output: {output[-1000:]!r}")
    finally:
        writer.close()
        await writer.wait_closed()


def _web_can_connect(sock):
    script = (
        f"import os,socket,sys; assert os.geteuid()=={WEB_UID}; "
        "s=socket.socket(socket.AF_UNIX); "
        "s.connect(sys.argv[1]); s.close()"
    )
    return subprocess.run(
        ["/usr/bin/setpriv", f"--reuid={WEB_UID}", f"--regid={WEB_UID}",
         f"--groups={RUNNER_UID}", sys.executable, "-c", script, str(sock)],
        capture_output=True, text=True, timeout=3,
    )


async def _one_host(native, base, *, capabilities, attempt):
    runtime = base / f"runtime-{attempt}"
    runtime.mkdir(mode=0o710)
    os.chown(runtime, RUNNER_UID, RUNNER_UID)
    runtime.chmod(0o710)
    cwd = base / "agent-cwd"
    sock = runtime / "session-mesh" / "ptyhost.sock"
    proc = _as_runner(native, runtime, capabilities=capabilities)
    try:
        _wait_socket(proc, sock)
        assert Path(f"/proc/{proc.pid}/status").read_text().split("Uid:\t", 1)[1].startswith(
            f"{RUNNER_UID}\t"
        )
        assert (sock.stat().st_mode & 0o777) == 0o660
        assert _web_can_connect(sock).returncode == 0
        rejected = await _request(sock, {
            "op": "new", "name": "loader-injection", "cwd": str(cwd),
            "env": {"LD_PRELOAD": str(base / "attacker.so")},
        })
        assert rejected == {"error": "invalid env"}
        marker = cwd / f"started-{attempt}"
        reply = await _request(sock, {
            "op": "new", "name": "isolated", "cwd": str(cwd),
            "command": f"touch {marker}; printf 'MESH_UID_SPLIT_READY\\n'; "
                       "if /usr/bin/setpriv --reuid=1001 --regid=1001 --clear-groups "
                       "true >/dev/null 2>&1; then echo REGAINED; "
                       "else echo REGAIN_REFUSED; fi; sleep 20",
        })
        assert reply == {"ok": True, "name": "isolated"}
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline and not marker.exists():
            if not capabilities:
                break
            await asyncio.sleep(0.1)
        if capabilities:
            assert marker.exists(), "the PTY shell did not execute as the agent"
            replay = await _attach_replay(sock)
            assert b"REGAINED\r" not in replay
            assert b"runner-secret-canary" not in replay
            sessions = await _request(sock, {"op": "list"})
            pid = next(s["pid"] for s in sessions if s["name"] == "isolated")
            status = Path(f"/proc/{pid}/status").read_text()
            assert f"Uid:\t{AGENT_UID}\t{AGENT_UID}\t{AGENT_UID}\t{AGENT_UID}" in status
            assert f"Gid:\t{AGENT_UID}\t{AGENT_UID}\t{AGENT_UID}\t{AGENT_UID}" in status
            assert "Groups:\t" + str(AGENT_UID) not in status  # clear-groups
            assert "CapEff:\t0000000000000000" in status
            assert "CapBnd:\t0000000000000000" in status
            assert "NoNewPrivs:\t1" in status
            child_env = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
            assert f"HOME={pwd.getpwuid(AGENT_UID).pw_dir}".encode() in child_env
            assert not any(x.startswith((b"LD_", b"MESH_PARENT_ONLY=")) for x in child_env)
            fds = [os.readlink(p) for p in Path(f"/proc/{pid}/fd").iterdir()]
            assert not any("runner-secret" in fd for fd in fds)
            denied = subprocess.run(
                ["/usr/bin/setpriv", f"--reuid={AGENT_UID}",
                 f"--regid={AGENT_UID}", "--clear-groups", "/usr/bin/test", "-r",
                 str(base / "runner-secret")], timeout=3,
            )
            assert denied.returncode != 0
            # Neither the agent's UID nor its groups may enter the private socket.
            denied_socket = subprocess.run(
                ["/usr/bin/setpriv", f"--reuid={AGENT_UID}",
                 f"--regid={AGENT_UID}", "--clear-groups", sys.executable,
                 "-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); "
                 "s.connect(sys.argv[1])", str(sock)], capture_output=True, timeout=3,
            )
            assert denied_socket.returncode != 0
        else:
            await asyncio.sleep(0.6)
            assert not marker.exists(), "privilege-drop failure fell back to runner UID"
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.communicate(timeout=7)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate(timeout=3)


def _inside(native):
    with tempfile.TemporaryDirectory(prefix="mesh-uid-split-") as temp:
        base = Path(temp)
        base.chmod(0o711)
        cwd = base / "agent-cwd"
        cwd.mkdir(mode=0o700)
        os.chown(cwd, AGENT_UID, AGENT_UID)
        secret = base / "runner-secret"
        secret.write_text("not for agents")
        os.chown(secret, RUNNER_UID, RUNNER_UID)
        secret.chmod(0o600)
        asyncio.run(_one_host(native, base, capabilities=True, attempt=1))
        # Process restart uses a fresh runtime directory, as systemd RuntimeDirectory does.
        asyncio.run(_one_host(native, base, capabilities=True, attempt=2))
        asyncio.run(_one_host(native, base, capabilities=False, attempt=3))


def _canonical(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _sealed_presets(base, cwd):
    launchers = base / "launchers"
    launchers.mkdir(mode=0o755)
    launchers.chmod(0o755)
    source = _canonical({
        "version": 1, "runner_id": "local", "resource_id": "agent",
        "incarnation": "1" * 32, "correlation_id": "2" * 32,
    })
    receipt = "3" * 64 + ":" + "4" * 16
    configs = {}
    presets = []
    for kind, prefix in (("claude", "--resume"), ("codex", "resume")):
        cli = launchers / kind
        cli.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" > ./resume-args\n"
                       "printf '%s\\n' \"$(id -u):$HOME\" > ./resume-identity\n"
                       "sleep 10\n")
        cli.chmod(0o755)
        sid = "a" * 8 + "-" + "b" * 4 + "-" + "c" * 4 + "-" + "d" * 4 + "-" + ("e" * 11 + ("1" if kind == "claude" else "2"))
        args = [prefix, sid]
        profile_base = {
            "arguments": args, "conversationId": sid,
            "kind": kind, "version": 1,
        }
        fingerprint = _sha(_canonical(profile_base))
        profile = {**profile_base, "fingerprint": fingerprint}
        presets.append({
            "source": source, "receipt": receipt, "cwd": str(cwd),
            "profile": profile,
        })
        configs[kind] = "resume-" + _sha(_canonical({
            "cwd": str(cwd), "profile": fingerprint,
            "receipt": receipt, "source": source,
        }))
    sealed = {
        "version": 1,
        "launchers": {
            kind: {
                "executable": {
                    "path": str(launchers / kind),
                    "sha256": hashlib.sha256((launchers / kind).read_bytes()).hexdigest(),
                },
                "entrypoint": [], "environment": [],
            } for kind in ("claude", "codex")
        },
        "presets": presets,
    }
    private = base / "sealed"
    private.mkdir(mode=0o700)
    os.chown(private, RUNNER_UID, RUNNER_UID)
    config = private / "presets.json"
    content = _canonical(sealed)
    config.write_text(content)
    os.chown(config, RUNNER_UID, RUNNER_UID)
    config.chmod(0o600)
    return config, _sha(content), configs


async def _preset_host(native, base):
    cwd = base / "agent-cwd"
    cwd.mkdir(mode=0o700)
    os.chown(cwd, AGENT_UID, AGENT_UID)
    config, digest, selectors = _sealed_presets(base, cwd)
    runtime = base / "runtime-presets"
    runtime.mkdir(mode=0o710)
    os.chown(runtime, RUNNER_UID, RUNNER_UID)
    runtime.chmod(0o710)
    sock = runtime / "session-mesh" / "ptyhost.sock"
    proc = _as_runner(native, runtime, host_args=("--agent-preset-config", str(config), digest))
    try:
        _wait_socket(proc, sock)
        for kind in ("claude", "codex"):
            selector = selectors[kind]
            assert await _request(sock, {"op": "preset_ready", "preset": selector}) == {"version": 1, "ready": True}
            reply = await _request(sock, {
                "op": "new_preset_bound", "name": kind, "preset": selector,
                "deadline_ns": str(time.monotonic_ns() + 5_000_000_000),
            })
            assert reply.get("ok") is True, reply
            sid = ("a" * 8 + "-" + "b" * 4 + "-" + "c" * 4 + "-"
                   + "d" * 4 + "-" + "e" * 11
                   + ("1" if kind == "claude" else "2"))
            expected = ("--resume " if kind == "claude" else "resume ") + sid + "\n"
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                args = cwd / "resume-args"
                if args.exists() and args.read_text() == expected:
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError(f"{kind} did not launch exact resume")
            identity = (cwd / "resume-identity").read_text()
            assert identity.startswith(f"{AGENT_UID}:{pwd.getpwuid(AGENT_UID).pw_dir}")
            args.unlink()
        os.chown(cwd, RUNNER_UID, RUNNER_UID)
        refused = await _request(sock, {"op": "preset_ready", "preset": selectors["claude"]})
        assert "error" in refused, refused
        os.chown(cwd, AGENT_UID, AGENT_UID)
        moved = base / "agent-cwd-moved"
        cwd.rename(moved)
        cwd.symlink_to(moved, target_is_directory=True)
        refused = await _request(sock, {"op": "preset_ready", "preset": selectors["codex"]})
        assert "error" in refused, refused
        cwd.unlink()
        moved.rename(cwd)
        launcher = base / "launchers" / "claude"
        launcher.write_text("#!/bin/sh\nexit 0\n")
        launcher.chmod(0o755)
        refused = await _request(sock, {"op": "preset_ready", "preset": selectors["claude"]})
        assert "error" in refused, refused
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.communicate(timeout=7)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate(timeout=3)


def _inside_presets(native):
    with tempfile.TemporaryDirectory(prefix="mesh-preset-uid-") as temp:
        base = Path(temp)
        base.chmod(0o711)
        asyncio.run(_preset_host(native, base))


def test_native_pty_host_drops_agent_uid_and_refuses_failed_drop():
    native = os.environ.get("MESH_PTYHOST_NATIVE")
    if not native:
        pytest.skip("set MESH_PTYHOST_NATIVE to built native host")
    assert Path(native).is_file(), native
    if not shutil.which("unshare") or not shutil.which("setpriv"):
        pytest.skip("Linux namespace/setpriv tooling unavailable")
    probe = subprocess.run(
        ["unshare", "--map-auto", "--setuid", "0", "--setgid", "0",
         "/usr/bin/true"], capture_output=True, text=True,
    )
    if probe.returncode != 0:
        pytest.skip(f"subordinate UID namespace unavailable: {probe.stderr.strip()}")
    with tempfile.TemporaryDirectory(prefix="mesh-uid-test-stage-") as stage:
        Path(stage).chmod(0o755)
        staged_script = Path(stage) / "uid_test.py"
        staged_native = Path(stage) / "mesh_ptyhost"
        shutil.copy2(__file__, staged_script)
        shutil.copy2(native, staged_native)
        staged_script.chmod(0o644)
        staged_native.chmod(0o755)
        result = subprocess.run(
            ["unshare", "--map-auto", "--setuid", "0", "--setgid", "0",
            NAMESPACE_PYTHON, str(staged_script), "--inside", str(staged_native)],
            capture_output=True, text=True, timeout=90,
        )
    assert result.returncode == 0, result.stdout + result.stderr


def test_native_preset_resumes_after_drop_and_refuses_wrong_cwd_owner():
    native = os.environ.get("MESH_PTYHOST_NATIVE")
    if not native:
        pytest.skip("set MESH_PTYHOST_NATIVE to built native host")
    probe = subprocess.run(
        ["unshare", "--map-auto", "--setuid", "0", "--setgid", "0",
         "/usr/bin/true"], capture_output=True, text=True,
    )
    if probe.returncode != 0:
        pytest.skip(f"subordinate UID namespace unavailable: {probe.stderr.strip()}")
    with tempfile.TemporaryDirectory(prefix="mesh-preset-test-stage-") as stage:
        Path(stage).chmod(0o755)
        staged_script = Path(stage) / "uid_test.py"
        staged_native = Path(stage) / "mesh_ptyhost"
        shutil.copy2(__file__, staged_script)
        shutil.copy2(native, staged_native)
        staged_script.chmod(0o644)
        staged_native.chmod(0o755)
        result = subprocess.run(
            ["unshare", "--map-auto", "--setuid", "0", "--setgid", "0",
            NAMESPACE_PYTHON, str(staged_script), "--inside-presets", str(staged_native)],
            capture_output=True, text=True, timeout=90,
        )
    assert result.returncode == 0, result.stdout + result.stderr


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--inside":
    _inside(sys.argv[2])
elif __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--inside-presets":
    _inside_presets(sys.argv[2])
