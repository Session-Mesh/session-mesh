# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""scripts/preprod.sh: a pre-production mesh that cannot disturb the live one.

Everything runs on scratch paths under a fake HOME holding a sentinel ~/.config/session-mesh: the
sentinel stands for the live mesh's state, and must come out of the whole scenario byte for byte
and mtime for mtime unchanged.
"""

import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

import aiohttp
import pytest

import discover
from helpers import kill_session_tree
from ptyhost_proc import ptyhost_command, wait_until
from respawn_helpers import SID

REPO = Path(__file__).resolve().parent.parent
LAUNCHER = REPO / "scripts" / "preprod.sh"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def tree_state(root):
    """{relative path: (mtime_ns, bytes or None)} for everything under root, root's own mtime included."""
    state = {".": (root.stat().st_mtime_ns, None)}
    for path in sorted(root.rglob("*")):
        state[str(path.relative_to(root))] = (path.stat().st_mtime_ns, path.read_bytes() if path.is_file() else None)
    return state


class World:
    """A fake HOME with a sentinel live config, scratch preprod paths, and a fake `claude` on PATH."""

    def __init__(self, root):
        self.root = root
        self.home = root / "home"
        self.live = self.home / ".config" / "session-mesh"
        self.live.mkdir(parents=True, mode=0o700)
        for name, content in (("token", "LIVE-TOKEN\n"), ("sessions-snapshot.json", '{"live": [], "lost": []}'),
                              ("mesh.json", "{}"), ("push.json", '[{"endpoint": "https://live.example/1"}]'),
                              ("vapid.pem", "LIVE-KEY"), ("pending.json", "[]")):
            (self.live / name).write_text(content)
        self.cache = self.home / ".cache" / "session-mesh"
        self.cache.mkdir(parents=True)
        (self.cache / "history.json").write_text("{}")
        self.live_runtime = root / "livert"
        self.live_runtime.mkdir(mode=0o700)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.agent = self.bin / "claude"
        self.agent.write_text("#!/bin/sh\n"
                              'mkdir -p "$HOME/.claude/sessions"\n'
                              f'printf \'{{"sessionId":"{SID}","status":"idle"}}\' > "$HOME/.claude/sessions/$$.json"\n'
                              "while :; do sleep 1; done\n")
        self.agent.chmod(self.agent.stat().st_mode | stat.S_IXUSR)
        self.port = free_port()
        self.pre = root / "pre"
        self.env = {"PATH": f"{self.bin}:{os.environ['PATH']}", "HOME": str(self.home),
                    "XDG_RUNTIME_DIR": str(self.live_runtime), "MESH_PREPROD_PORT": str(self.port),
                    "MESH_PREPROD_DIR": str(self.pre), "MESH_PREPROD_RUNTIME": str(root / "prert"),
                    # Never depend on the live checkout's ignored .venv.  This
                    # is also the contract users need for a fresh worktree.
                    # Keep the virtual-environment launcher itself.  Resolving
                    # it follows its symlink to the system interpreter and
                    # recreates the fresh-worktree dependency mismatch this
                    # test is meant to prevent.
                    "MESH_PYTHON": sys.executable,
                    "MESH_PTYHOST_CMD": ptyhost_command()[0]}
        if "MESH_MESH_HISTORY_CMD" in os.environ:
            self.env["MESH_MESH_HISTORY_CMD"] = os.environ["MESH_MESH_HISTORY_CMD"]

    def run(self, *args, **env_over):
        return subprocess.run([str(LAUNCHER), *args], env={**self.env, **env_over}, capture_output=True, text=True,
                              timeout=60, cwd=REPO)


@pytest.fixture
def world():
    ns = World(Path(tempfile.mkdtemp(prefix="pp-", dir=os.environ["SMESH_TEST_ROOT"])))
    yield ns
    ns.run("stop")
    shutil.rmtree(ns.root, ignore_errors=True)


# ---------------------------------------------------------------- safety check

def test_check_accepts_scratch_paths(world):
    out = world.run("check")
    assert out.returncode == 0, out.stderr


@pytest.mark.parametrize("env_over, reason", [
    ({"MESH_PREPROD_PORT": "7690"}, "is the live mesh's"),
    ({"MESH_PORT": "7777", "MESH_PREPROD_PORT": "7777"}, "is the live mesh's"),
    ({"MESH_PREPROD_PORT": "80"}, "invalid port"),
    ({"MESH_PREPROD_PORT": "abc"}, "invalid port"),
])
def test_check_refuses_a_live_or_bad_port(world, env_over, reason):
    out = world.run("check", **env_over)
    assert out.returncode != 0 and reason in out.stderr, out.stderr


def test_check_refuses_the_live_config_dir(world):
    link_base = world.root / "linkbase"
    link_base.mkdir()
    (link_base / "conf").symlink_to(world.live)       # BASE/conf resolves to the live config dir
    out = world.run("check", MESH_PREPROD_DIR=str(link_base))
    assert out.returncode != 0 and "live mesh's" in out.stderr, out.stderr
    inside = world.run("check", MESH_PREPROD_DIR=str(world.live))   # BASE/conf inside the live config dir
    assert inside.returncode != 0 and "live mesh's" in inside.stderr, inside.stderr


def test_check_refuses_the_live_runtime_dir(world):
    for runtime in (world.env["XDG_RUNTIME_DIR"], f"/run/user/{os.getuid()}"):
        out = world.run("check", MESH_PREPROD_RUNTIME=runtime)
        assert out.returncode != 0 and "runtime dir" in out.stderr, out.stderr


def test_check_refuses_a_busy_port(world):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        out = world.run("check", MESH_PREPROD_PORT=str(s.getsockname()[1]))
    assert out.returncode != 0 and "already in use" in out.stderr, out.stderr


def test_start_fails_before_launch_when_the_selected_python_lacks_aiohttp(world):
    missing = world.root / "python-without-aiohttp"
    missing.write_text("#!/bin/sh\nexit 1\n")
    missing.chmod(missing.stat().st_mode | stat.S_IXUSR)

    out = world.run("start", MESH_PYTHON=str(missing))

    assert out.returncode != 0
    assert "cannot import aiohttp" in out.stderr
    assert not world.pre.exists()


# ---------------------------------------------------------------- the acceptance scenario

async def test_a_preprod_mesh_creates_restores_and_closes_sessions_and_the_live_one_sees_nothing(world, plain_transport_shell):
    world.env["SHELL"] = os.environ["SHELL"]
    before = {d: tree_state(d) for d in (world.live, world.cache, world.live_runtime)}

    started = world.run("start")
    assert started.returncode == 0, started.stderr
    assert f"http://127.0.0.1:{world.port}/" in started.stdout
    assert str(world.pre / "conf" / "token") in started.stdout
    token = (world.pre / "conf" / "token").read_text().strip()
    assert token != "LIVE-TOKEN"
    base = f"http://127.0.0.1:{world.port}"
    work = world.root / "work"
    work.mkdir()

    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as http:
        async def call(method, path, **kw):
            async with http.request(method, base + path, **kw) as resp:
                return resp.status, (await resp.json() if resp.content_type == "application/json" else await resp.text())

        async def agent_and_shell_up():
            _, data = await call("GET", "/api/sessions")
            names = {s["name"]: s for s in data["mesh"]}
            agent = (names.get("agent1") or {}).get("agent")
            return bool(agent and agent.get("session_id") == SID and "shell1" in names)

        async def restorable():
            _, data = await call("GET", "/api/sessions")
            return sorted(e["name"] for e in data["restorable"]) or None

        async with http.get(f"{base}/login?token={token}", allow_redirects=False) as resp:
            assert resp.status == 302
        for body in ({"preset": "custom", "command": str(world.agent), "cwd": str(work), "name": "agent1"},
                     {"preset": "shell", "cwd": str(work), "name": "shell1"},
                     {"preset": "shell", "cwd": str(work), "name": "doomed"}):
            status, text = await call("POST", "/api/new", json=body)
            assert status == 200, text
        await wait_until(agent_and_shell_up, timeout=20)
        assert (world.pre / "conf" / "sessions-snapshot.json").exists()
        _, listed = await call("GET", "/api/sessions")
        doomed_created = next(s["created"] for s in listed["mesh"] if s["name"] == "doomed")
        assert (await call("POST", "/api/kill/doomed", json={"created": doomed_created}))[0] == 200

        # the ptyhost dies with its sessions, then comes back: the sessions are offered for restore
        pid = int((world.pre / "ptyhost.pid").read_text())
        children = {p for p, st in discover.snapshot().items() if st[2] == pid}
        os.kill(pid, signal.SIGKILL)
        for child in children:
            assert not kill_session_tree(child)
        assert world.run("start").returncode == 0
        assert await wait_until(restorable, timeout=15) == ["agent1", "shell1"]
        status, body = await call("POST", "/api/restore", json={"names": ["agent1", "shell1"]})
        assert status == 200 and all(r["ok"] for r in body["results"].values()), body
        await wait_until(agent_and_shell_up, timeout=20)

        # push is off here: nothing can subscribe, so the store stays empty
        _, key = await call("GET", "/api/push/key")
        assert key.get("available") is False
        assert not (world.pre / "conf" / "push.json").exists()

        for name in ("agent1", "shell1"):
            _, listed = await call("GET", "/api/sessions")
            created = next(s["created"] for s in listed["mesh"] if s["name"] == name)
            assert (await call("POST", f"/api/kill/{name}", json={"created": created}))[0] == 200

    pids = [int((world.pre / f"{name}.pid").read_text()) for name in ("server", "ptyhost")]
    assert all(Path(f"/proc/{pid}").exists() for pid in pids)
    assert world.run("stop").returncode == 0
    assert world.run("status").returncode == 3
    # the pid files named the python processes themselves, and those are gone (nothing left running)
    assert not any(Path(f"/proc/{pid}").exists() for pid in pids)

    # the live mesh saw nothing: same files, same bytes, same mtimes
    assert {d: tree_state(d) for d in before} == before
    # and the pre-production state is where it was told to be
    assert {p.name for p in (world.pre / "conf").iterdir()} >= {"token", "sessions-snapshot.json"}
    assert not list(world.pre.glob("*.pid"))
