# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Owned interop cleanup survives client death; no owner daemon is contacted."""

import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time

import pytest

import discover
from helpers import kill_session_tree, session_members

REPO = Path(__file__).resolve().parents[1]
PARENT = """
import asyncio, json, pathlib, subprocess, sys
import ptyhost
p = subprocess.Popen([sys.executable, 'tests/ptyhost_proc.py', '--interop'],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL)
info = json.loads(p.stdout.readline())
children = pathlib.Path(f'/proc/{p.pid}/task/{p.pid}/children').read_text().split()
assert len(children) == 1
info.update(adapter=p.pid, daemon=int(children[0]))
ptyhost.SOCK = pathlib.Path(info['socket'])
async def spawn():
    reply = await asyncio.wait_for(ptyhost.request({
        'op': 'new', 'name': 'owned-cleanup', 'cwd': info['home'],
        'command': 'sleep 600'}), 5)
    assert reply['ok']
    sessions = await asyncio.wait_for(ptyhost.request({'op': 'list'}), 5)
    return sessions[0]['pid']
info['session'] = asyncio.run(spawn())
print(json.dumps(info), flush=True)
sys.stdin.buffer.read()
p.stdin.close()
p.wait(timeout=8)
"""


def stopped(pid):
    stat = discover.read_stat(pid)
    return stat is None or stat[1] == "Z"


def identity(pid):
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        return Path(f"/proc/{pid}").stat().st_uid, raw[raw.rindex(")") + 2:].split()[19]
    except FileNotFoundError:
        return None


@pytest.mark.parametrize("mode", ["eof", "parent_term", "parent_kill", "adapter_term", "adapter_int"])
def test_interop_owned_cleanup_after_client_exit(mode, tmp_path):
    env = {**os.environ, "TMPDIR": os.environ["SMESH_TEST_ROOT"]}
    parent = subprocess.Popen([sys.executable, "-c", PARENT], cwd=REPO, env=env,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, start_new_session=True)
    info = None
    owned_home = None
    owned = {}
    try:
        assert select.select([parent.stdout], [], [], 10)[0], "interop startup deadline"
        info = json.loads(parent.stdout.readline())
        home = Path(info["home"])
        assert home.parent == Path(env["TMPDIR"])
        assert home.name.startswith("pd-home-")
        owned_home = home
        for key in ("adapter", "daemon", "session"):
            owned[key] = identity(info[key])
            assert owned[key] is not None
        # The daemon inherits only the read end of the adapter lifetime pipe;
        # its session uses a PTY, not an inherited writer keeping EOF alive.
        lifetime = os.readlink(f"/proc/{info['adapter']}/fd/0")
        for key in ("daemon", "session"):
            for fd in Path(f"/proc/{info[key]}/fd").iterdir():
                try:
                    target = os.readlink(fd)
                    fields = Path(f"/proc/{info[key]}/fdinfo/{fd.name}").read_text().splitlines()
                except FileNotFoundError:
                    # A closed descriptor cannot retain the pipe writer.
                    continue
                if target == lifetime:
                    flags = int(next(x.split()[1] for x in fields if x.startswith("flags:")), 8)
                    assert flags & os.O_ACCMODE == os.O_RDONLY
        if mode == "parent_term":
            os.killpg(parent.pid, signal.SIGTERM)
        elif mode == "parent_kill":
            parent.kill()
        elif mode.startswith("adapter_"):
            os.kill(info["adapter"], signal.SIGTERM if mode.endswith("term") else signal.SIGINT)
            parent.stdin.close()
        else:
            parent.stdin.close()
        parent.wait(timeout=10)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if all(stopped(info[k]) for k in owned) and not home.exists():
                break
            time.sleep(0.02)
        assert stopped(info["adapter"]), "adapter remains runnable"
        assert stopped(info["daemon"]), "owned daemon remains runnable"
        assert stopped(info["session"]), "owned session remains runnable"
        assert not session_members(info["session"]), "owned session descendants remain"
        assert not home.exists(), "owned private home remains"
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=5)
        for stream in (parent.stdin, parent.stdout):
            if stream:
                stream.close()
        if info:
            # A RED run must not itself leave a fixture orphan. Only captured
            # child identities may be signalled, never a rediscovered PID.
            for key, original in owned.items():
                if identity(info[key]) == original and not stopped(info[key]):
                    if key == "session":
                        kill_session_tree(info[key])
                    else:
                        os.kill(info[key], signal.SIGTERM)
            deadline = time.monotonic() + 5
            while any(not stopped(info[k]) for k in owned) and time.monotonic() < deadline:
                time.sleep(0.02)
            if owned_home is not None and all(stopped(info[k]) for k in owned):
                shutil.rmtree(owned_home, ignore_errors=True)
