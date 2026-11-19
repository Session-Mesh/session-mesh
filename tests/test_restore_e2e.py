# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""End to end: real ptyhost subprocesses, the real server app, a fake `claude` that records its argv.

Create two sessions, kill the whole ptyhost, start another one, restore through the API, and check
the new sessions have the right directory and that the agent was relaunched on the same conversation.
"""

import os
import stat
import tempfile
from pathlib import Path

import pytest

import agentmcp
import organize
import ptyhost
import respawn
import resumeargs
from ptyhost_proc import Daemon, daemon, wait_until  # noqa: F401  (daemon: pytest fixture)
from respawn_helpers import SID, snapshot_file  # noqa: F401

pytestmark = pytest.mark.usefixtures("plain_transport_shell")


def fake_claude_script(log):
    """What the agent does: tell claude's session registry its conversation id, keep a transcript (a restore
    checks it exists), record its argv, stay up."""
    return ("#!/bin/sh\n"
            'mkdir -p "$HOME/.claude/sessions" "$HOME/.claude/projects/e2e"\n'
            f': >> "$HOME/.claude/projects/e2e/{SID}.jsonl"\n'
            f'printf \'{{"sessionId":"{SID}","status":"idle"}}\' > "$HOME/.claude/sessions/$$.json"\n'
            f'{{ echo "--- start"; for a in "$@"; do echo "$a"; done; }} >> "{log}"\n'
            "while :; do sleep 1; done\n")


@pytest.fixture
def fake_claude(monkeypatch):
    bindir = Path(tempfile.mkdtemp(prefix="fc-", dir=os.environ["SMESH_TEST_ROOT"]))
    log = bindir / "argv.log"
    script = bindir / "claude"
    script.write_text(fake_claude_script(log))
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    return script, log


async def sessions(client, headers):
    return await (await client.get("/api/sessions", headers=headers)).json()


async def test_sessions_come_back_after_the_ptyhost_is_replaced(client, auth_cookie, fake_claude, daemon,
                                                               monkeypatch, snapshot_file, tmp_path):
    monkeypatch.setattr(organize, "FILE", tmp_path / "mesh.json")
    script, log = fake_claude
    work = Path(tempfile.mkdtemp(prefix="w-", dir=os.environ["SMESH_TEST_ROOT"]))
    (work / "one").mkdir()
    (work / "two").mkdir()
    agent_cmd = f"{script} --model opus 'my first prompt'"
    for name, cwd, command in (("agent1", work / "one", agent_cmd), ("shell1", work / "two", "")):
        body = {"preset": "custom", "command": command, "cwd": str(cwd), "name": name}
        if not command:
            body = {"preset": "shell", "cwd": str(cwd), "name": name}
        resp = await client.post("/api/new", json=body, headers=auth_cookie)
        assert resp.status == 200, await resp.text()

    async def agent_known():
        mesh = {s["name"]: s for s in (await sessions(client, auth_cookie))["mesh"]}
        agent = (mesh.get("agent1") or {}).get("agent")
        return bool(agent and agent.get("session_id") == SID) and "shell1" in mesh
    await wait_until(agent_known, timeout=15)
    assert sorted(e["name"] for e in respawn._load()["live"]) == ["agent1", "shell1"]
    for op in ({"op": "folder-add", "name": "projects"}, {"op": "folder-add", "name": "notes"},
               {"op": "rename", "id": "agent1", "label": "Mon agent"},
               {"op": "move", "id": "agent1", "folder": "projects"},
               {"op": "move", "id": "shell1", "folder": "notes"}):
        assert (await client.post("/api/organize", json=op, headers=auth_cookie)).status == 200
    placed = {s["name"]: (s["label"], s["folder"]) for s in (await sessions(client, auth_cookie))["mesh"]}
    assert placed == {"agent1": ("Mon agent", "projects"), "shell1": (None, "notes")}
    assert log.read_text().count("--- start") == 1

    leftovers = daemon.teardown()          # the owner's `systemctl restart session-mesh-pty`
    assert not leftovers
    runtime = Path(tempfile.mkdtemp(prefix="pd2-", dir=os.environ["SMESH_TEST_ROOT"]))
    second = Daemon(runtime)
    monkeypatch.setattr(ptyhost, "SOCK", second.sock)
    try:
        await second.wait_for_socket()
        data = await sessions(client, auth_cookie)
        assert data["mesh"] == []
        assert sorted(e["name"] for e in data["restorable"]) == ["agent1", "shell1"]

        resp = await client.post("/api/restore", json={"names": ["agent1", "shell1"]}, headers=auth_cookie)
        body = await resp.json()
        assert resp.status == 200 and all(r["ok"] for r in body["results"].values()), body
        assert [body["results"][n]["id"] for n in ("agent1", "shell1")] == ["agent1", "shell1"]

        async def agent_back():
            mesh = {s["name"]: s for s in (await sessions(client, auth_cookie))["mesh"]}
            agent = (mesh.get("agent1") or {}).get("agent")
            return mesh if agent and agent.get("session_id") == SID else None
        mesh = await wait_until(agent_back, timeout=15)
        assert (mesh["agent1"]["cwd"], mesh["shell1"]["cwd"]) == (str(work / "one"), str(work / "two"))
        assert (await sessions(client, auth_cookie))["restorable"] == []
        # the arrangement came back too: same folders, same labels
        assert {n: (s["label"], s["folder"]) for n, s in mesh.items()} == placed

        starts = [chunk.strip().splitlines() for chunk in log.read_text().split("--- start") if chunk.strip()]
        assert starts[0] == ["--model", "opus", "my first prompt"]
        # a shell script's argv[0] is /bin/sh, so resumeargs cannot read its options: the bare resume
        # (options kept from a real binary's argv are covered in test_restore_api.py)
        assert starts[1] == agentmcp.inject("claude", resumeargs.resume_argv("claude", ["/bin/sh", str(script)], SID))[1:]
        assert "my first prompt" not in starts[1]
        assert len(starts) == 2
    finally:
        assert not second.teardown()


async def test_exit_in_the_only_session_offers_nothing_to_restore(client, auth_cookie, daemon,
                                                                  monkeypatch, snapshot_file, tmp_path):
    """The same host lists no session after `exit`: that session ended, nothing was lost."""
    monkeypatch.setattr(organize, "FILE", tmp_path / "mesh.json")
    resp = await client.post("/api/new", json={"preset": "shell", "cwd": str(tmp_path), "name": "only"},
                             headers=auth_cookie)
    assert resp.status == 200, await resp.text()
    assert [s["name"] for s in (await sessions(client, auth_cookie))["mesh"]] == ["only"]
    reader, writer = await daemon.attach("only")
    writer.write(ptyhost.frame(b"D", b"exit\r"))

    async def ended():
        return (await sessions(client, auth_cookie))["mesh"] == []
    await wait_until(ended, timeout=10)
    assert (await sessions(client, auth_cookie))["restorable"] == []
    assert respawn._load()["lost"] == []
