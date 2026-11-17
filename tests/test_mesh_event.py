# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The hook relay maps facts only and cannot fail an agent invocation."""

import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time


ROOT = Path(__file__).parent / "fixtures" / "agent-hooks"
PATH = Path(__file__).parent.parent / "bin" / "mesh-event"
LOADER = importlib.machinery.SourceFileLoader("mesh_event", str(PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
mesh_event = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(mesh_event)


def claude(name):
    return json.loads((ROOT / "claude" / f"{name}.json").read_text())


def test_claude_maps_only_the_documented_main_agent_states():
    assert mesh_event.claude_event(claude("user-prompt-submit"), 1)["type"] == "working"
    assert mesh_event.claude_event(claude("pre-tool-use-bash"), 1)["type"] == "working"
    assert mesh_event.claude_event(claude("pre-tool-use-question"), 1) is None
    assert mesh_event.claude_event(claude("permission-request-bash"), 1)["type"] == "waiting_permission"
    assert mesh_event.claude_event(claude("permission-request-question"), 1)["type"] == "waiting_question"
    assert mesh_event.claude_event(claude("post-tool-use-question"), 1)["type"] == "working"
    assert mesh_event.claude_event(claude("stop"), 1)["type"] == "done"
    assert mesh_event.claude_event(claude("stop-background-task"), 1) is None
    assert mesh_event.claude_event(claude("stop-failure"), 1)["type"] == "error"
    assert mesh_event.claude_event(claude("pre-tool-use-in-subagent"), 1) is None


def test_relay_never_includes_agent_content_in_detail():
    event = mesh_event.claude_event(claude("pre-tool-use-bash"), 1)
    text = json.dumps(event)
    assert "touch other.txt" not in text and "DESCRIPTION" not in text
    assert event["detail"] == {"source": "claude", "hook": "PreToolUse", "tool": "Bash", "tool_use_id": "toolu_PLACEHOLDER"}


def test_codex_done_keeps_thread_reference_not_assistant_or_prompt_content():
    payload = json.loads((ROOT / "codex" / "notify-agent-turn-complete-exec.json").read_text())["payload"]
    event = mesh_event.codex_event(payload, 1)
    assert event["type"] == "done"
    assert event["detail"] == {"source": "codex", "hook": "agent-turn-complete", "thread_id": "THREAD-ID"}
    assert "PROMPT" not in json.dumps(event) and "REPLY" not in json.dumps(event)


def test_non_ascii_hook_fields_are_trimmed_to_the_server_detail_byte_limit():
    payload = {"hook_event_name": "PreToolUse", "tool_name": "😀" * 300,
               "tool_use_id": "😀" * 300}
    event = mesh_event.claude_event(payload, 1)
    assert len(json.dumps(event["detail"], separators=(",", ":"), ensure_ascii=False).encode()) <= 2048


def test_main_without_a_session_token_is_silent(monkeypatch, capsys):
    monkeypatch.delenv("MESH_SESSION_TOKEN", raising=False)
    mesh_event.main(["mesh-event", "claude"])
    assert capsys.readouterr().out == ""


def test_cli_never_fails_or_writes_when_the_mesh_is_unreachable():
    env = {**os.environ, "MESH_SESSION_TOKEN": "token", "MESH_PORT": "1"}
    result = subprocess.run([sys.executable, str(PATH), "codex", '{"type":"agent-turn-complete"}'],
                            env=env, capture_output=True, text=True, timeout=3, check=False)
    assert result.returncode == 0 and result.stdout == "" and result.stderr == ""


def test_send_has_a_real_total_deadline(monkeypatch):
    def slow(*_args, **_kwargs):
        time.sleep(.2)

    monkeypatch.setattr(mesh_event.urllib.request, "urlopen", slow)
    before = time.monotonic()
    mesh_event.send("token", {"type": "done"}, .01)
    assert time.monotonic() - before < .1
