# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Pi's native MCP overlay is invocation-local and fails before agent launch."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest

import agentmcp
import discover
import pimcp
import server


def test_pi_wake_retries_failed_send_without_retrying_a_busy_agent():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node not installed")
    subprocess.run([node, str(Path(__file__).with_name("pi_wake_retry.mjs"))],
                   check=True, timeout=15, capture_output=True, text=True)


def test_version_gate_is_closed(monkeypatch):
    monkeypatch.setattr(pimcp.shutil, "which", lambda *_args, **_kwargs: "/tmp/pi")
    for version in ("0.85.1", "1.2.0", "1.3.0-rc.1", "banner 1.3.0"):
        monkeypatch.setattr(pimcp.subprocess, "run", lambda *_args, **_kwargs:
                            SimpleNamespace(stdout=version))
        with pytest.raises(pimcp.PiUnavailable):
            pimcp.binary()
    monkeypatch.setattr(pimcp.subprocess, "run", lambda *_args, **_kwargs:
                        SimpleNamespace(stdout="1.3.0\n"))
    assert pimcp.binary() == "/tmp/pi"


def test_private_overlay_keeps_ambient_configuration_and_sessions(tmp_path, monkeypatch):
    base = tmp_path / "base"
    base.mkdir()
    (base / "auth.json").write_text("auth")
    ambient = {"mcpServers": {"other": {"command": "other-mcp"},
                              "mesh-board": {"command": "old-mesh"}}, "custom": True}
    (base / "mcp.json").write_text(json.dumps(ambient))
    (base / "sessions").mkdir()
    board = tmp_path / "mesh-board-mcp"
    board.write_text("binary")
    board.chmod(0o700)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(base))
    monkeypatch.setattr(pimcp, "binary", lambda _environ=None: "/tmp/pi")
    monkeypatch.setattr(agentmcp, "BOARD_MCP", str(board))
    executable, overlay = pimcp.prepare(tmp_path / "mesh")
    assert executable == "/tmp/pi"
    assert overlay != base and overlay.stat().st_mode & 0o777 == 0o700
    assert (overlay / "auth.json").is_symlink()
    assert (overlay / "sessions").resolve() == base / "sessions"
    assert json.loads((base / "mcp.json").read_text()) == ambient
    assert (overlay / "mcp.json").stat().st_mode & 0o777 == 0o600
    config = json.loads((overlay / "mcp.json").read_text())
    assert config == {"custom": True, "mcpServers": {"other": {"command": "other-mcp"}, "mesh-board": {
        "command": str(board), "args": [], "env": {}, "exposure": "direct", "enabled": True}}}
    assert "MESH_SESSION_TOKEN" not in (overlay / "mcp.json").read_text()


def test_invalid_ambient_configuration_fails_without_rewriting_it(tmp_path, monkeypatch):
    base = tmp_path / "base"
    base.mkdir()
    config = base / "mcp.json"
    config.write_text("{invalid")
    board = tmp_path / "mesh-board-mcp"
    board.touch(mode=0o700)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(base))
    monkeypatch.setattr(pimcp, "binary", lambda _environ=None: "/tmp/pi")
    monkeypatch.setattr(agentmcp, "BOARD_MCP", str(board))
    with pytest.raises(pimcp.PiUnavailable, match="Invalid Pi MCP configuration"):
        pimcp.prepare(tmp_path / "mesh")
    assert config.read_text() == "{invalid"


def test_missing_bridge_refuses_overlay(tmp_path, monkeypatch):
    monkeypatch.setattr(pimcp, "binary", lambda _environ=None: "/tmp/pi")
    monkeypatch.setattr(agentmcp, "BOARD_MCP", str(tmp_path / "missing"))
    with pytest.raises(pimcp.PiUnavailable, match="Mesh MCP server unavailable"):
        pimcp.prepare(tmp_path)


def test_new_pi_session_uses_private_overlay_without_ptyhost_env_change(monkeypatch, tmp_path):
    overlay = tmp_path / "overlay"
    calls = []
    async def unique(*_args):
        return "pi-one"
    async def host(request):
        calls.append(request)
    monkeypatch.setattr(server, "unique_name", unique)
    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(server.sessiontoken, "new_nonce", lambda: "nonce")
    monkeypatch.setattr(server.sessiontoken, "issue", lambda *_args: "token")
    result = asyncio.run(server.new_session("pi", str(tmp_path), "pi -e builtin:mcp", "pi", "pi",
                                            pi_runtime=("/tmp/pi", overlay)))
    assert result == "pi-one"
    command = calls[0]["command"]
    assert command == (f"PI_CODING_AGENT_DIR={overlay} /tmp/pi --extension "
                       f"{Path(server.__file__).with_name('pi_mesh_wake.mjs')} -e builtin:mcp")
    assert "PI_CODING_AGENT_DIR" not in calls[0]["env"]
    assert calls[0]["meta"]["known_agent"] == "pi"


def test_pi_resume_requires_unique_existing_v3_transcript(tmp_path, monkeypatch):
    sid = "123e4567-e89b-12d3-a456-426614174000"
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    directory = tmp_path / ".pi/agent/sessions/project"
    directory.mkdir(parents=True)
    transcript = directory / "one.jsonl"
    transcript.write_text(json.dumps({"type": "session", "version": 3, "id": sid,
                                      "cwd": str(tmp_path)}) + "\n")
    assert discover.pi_session_path(sid) == str(transcript)
    assert server._resume_argv({"type": "pi", "session_id": sid}) == [
        "pi", "--session", str(transcript), "-e", "builtin:mcp"]
    (directory / "two.jsonl").write_text(transcript.read_text())
    assert discover.pi_session_path(sid) is None


async def test_missing_pi_transcript_does_not_abort_restore_batch(tmp_path, monkeypatch):
    sid = "123e4567-e89b-12d3-a456-426614174000"
    entry = {"name": "missing-pi", "cwd": str(tmp_path), "created": 1.0, "agent": {"type": "pi", "session_id": sid}}
    monkeypatch.setattr(server.respawn, "lost_entry", lambda _name: entry)
    monkeypatch.setattr(discover, "pi_session_path", lambda _sid: None)
    result = await server.restore_one("missing-pi", set(), asyncio.Lock())
    assert result["ok"] is False
    assert "missing or ambiguous" in result["error"]


def test_pi_discovery_fails_closed_on_two_current_transcripts(tmp_path, monkeypatch):
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    monkeypatch.setattr(discover, "cwd", lambda _pid: str(tmp_path))
    monkeypatch.setattr(discover, "proc_start", lambda _pid: 1)
    monkeypatch.setattr(discover, "snapshot", lambda: {})
    directory = tmp_path / ".pi/agent/sessions/project"
    directory.mkdir(parents=True)
    def write(name, sid):
        path = directory / name
        path.write_text(json.dumps({"type": "session", "version": 3, "id": sid,
                                    "cwd": str(tmp_path)}) + "\n" +
                        json.dumps({"type": "message", "message": {"role": "user",
                                    "content": [{"type": "text", "text": "Hello Pi"}]}}) + "\n")
    write("one.jsonl", "123e4567-e89b-12d3-a456-426614174000")
    info = discover.pi_info(42)
    assert info["session_id"] == "123e4567-e89b-12d3-a456-426614174000"
    assert info["last"] == "Hello Pi"
    write("two.jsonl", "123e4567-e89b-12d3-a456-426614174001")
    assert discover.pi_info(42) == {"type": "pi"}


def test_pi_discovery_refuses_another_process_in_same_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(discover, "cwd", lambda _pid: str(tmp_path))
    monkeypatch.setattr(discover, "proc_start", lambda _pid: 1)
    monkeypatch.setattr(discover, "snapshot", lambda: {43: ("pi",)})
    assert discover.pi_info(42) == {"type": "pi"}


@pytest.mark.parametrize("script", [
    "/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "/opt/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
])
def test_pi_node_entrypoints_are_discovered(monkeypatch, script):
    monkeypatch.setattr(discover, "cmdline", lambda _pid: [b"node", script.encode()])
    assert discover.is_agent(42, ("node",)) == "pi"


def test_pi_visible_in_new_session_dialog():
    html = (Path(__file__).resolve().parent.parent / "static/index.html").read_text()
    assert '<input type="radio" name="preset" value="pi"> Pi' in html


def test_real_pi_connects_to_mesh_mcp_when_available(tmp_path, monkeypatch):
    if not shutil.which("pi", path=str(Path.home() / ".local/bin") + os.pathsep + os.environ.get("PATH", "")):
        pytest.skip("Pi is not installed")
    if not Path(agentmcp.BOARD_MCP).is_file():
        pytest.skip("mesh-board-mcp is not installed in the selected switch")
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi"))
    try:
        pimcp.binary()
    except pimcp.PiUnavailable:
        pytest.skip("installed Pi does not support the built-in MCP")
    executable, overlay = pimcp.prepare(tmp_path / "mesh")
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(overlay),
               MESH_SESSION_TOKEN="invalid-test-token", PI_OFFLINE="1")
    result = subprocess.run([executable, "mcp", "list", "--json"], env=env,
                            capture_output=True, text=True, timeout=20, check=True)
    servers = json.loads(result.stdout)["servers"]
    mesh = next(item for item in servers if item["name"] == "mesh-board")
    assert mesh["state"] == "connected"
    assert {"whiteboard", "demo", "mail", "session", "agent_guide_read"} == set(mesh["tools"])
