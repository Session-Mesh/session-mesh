# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Agent hook payloads: fixtures captured from a throwaway claude 2.1.288 and codex 0.160.0
(tests/fixtures/agent-hooks/).

These pin the fields the event API will rely on. They read the recorded payloads only: they do
not watch the live agents, so re-capture the fixtures after an upgrade and let a changed field fail here."""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent / "fixtures" / "agent-hooks"

# fixture -> (hook_event_name, fields that must be present)
CLAUDE = {
    "session-start": ("SessionStart", {"session_id", "cwd", "source", "model", "transcript_path"}),
    "session-start-print": ("SessionStart", {"session_id", "cwd", "source"}),
    "session-end": ("SessionEnd", {"session_id", "cwd", "reason"}),
    "user-prompt-submit": ("UserPromptSubmit", {"session_id", "cwd", "prompt", "prompt_id", "permission_mode"}),
    "pre-tool-use-bash": ("PreToolUse", {"session_id", "cwd", "tool_name", "tool_input", "tool_use_id"}),
    "pre-tool-use-question": ("PreToolUse", {"session_id", "tool_name", "tool_input"}),
    "pre-tool-use-in-subagent": ("PreToolUse", {"session_id", "tool_name", "agent_id", "agent_type"}),
    "permission-request-bash": ("PermissionRequest", {"session_id", "cwd", "tool_name", "tool_input"}),
    "permission-request-question": ("PermissionRequest", {"session_id", "cwd", "tool_name", "tool_input"}),
    "post-tool-use-question": ("PostToolUse", {"session_id", "tool_name", "tool_input", "tool_response"}),
    "notification-permission": ("Notification", {"session_id", "cwd", "message", "notification_type"}),
    "notification-idle": ("Notification", {"session_id", "cwd", "message", "notification_type"}),
    "stop": ("Stop", {"session_id", "cwd", "last_assistant_message", "background_tasks", "stop_hook_active"}),
    "stop-background-task": ("Stop", {"session_id", "background_tasks", "last_assistant_message"}),
    "subagent-start": ("SubagentStart", {"session_id", "agent_id", "agent_type"}),
    "subagent-stop": ("SubagentStop", {"session_id", "agent_id", "agent_type", "last_assistant_message"}),
    "subagent-stop-internal": ("SubagentStop", {"session_id", "agent_id", "agent_type"}),
    "stop-failure": ("StopFailure", {"session_id", "cwd", "error", "last_assistant_message"}),
}


def claude(name):
    return json.loads((ROOT / "claude" / f"{name}.json").read_text())


@pytest.mark.parametrize("name", sorted(CLAUDE))
def test_claude_event_name_and_fields(name):
    event, fields = CLAUDE[name]
    payload = claude(name)
    assert payload["hook_event_name"] == event
    assert fields <= payload.keys(), fields - payload.keys()


def test_every_claude_fixture_is_covered():
    assert {p.stem for p in (ROOT / "claude").glob("*.json")} == set(CLAUDE)


def test_notification_subtypes_and_messages():
    assert claude("notification-permission")["notification_type"] == "permission_prompt"
    assert claude("notification-permission")["message"] == "Claude needs your permission"
    assert claude("notification-idle")["notification_type"] == "idle_prompt"
    assert claude("notification-idle")["message"] == "Claude is waiting for your input"


def test_question_dialog_is_told_apart_by_tool_name_not_by_notification():
    # AskUserQuestion also raises a permission_prompt Notification: only PermissionRequest.tool_name differs.
    assert claude("permission-request-question")["tool_name"] == "AskUserQuestion"
    questions = claude("permission-request-question")["tool_input"]["questions"]
    assert questions[0]["question"] and [o["label"] for o in questions[0]["options"]]
    assert claude("permission-request-bash")["tool_name"] == "Bash"
    assert claude("permission-request-bash")["tool_input"]["command"]


def test_stop_reports_background_work():
    assert claude("stop")["background_tasks"] == []
    tasks = claude("stop-background-task")["background_tasks"]
    assert tasks and {"id", "type", "status"} <= tasks[0].keys() and tasks[0]["status"] == "running"


def test_subagent_events_carry_an_agent_id_the_main_agents_do_not():
    assert "agent_id" in claude("pre-tool-use-in-subagent")
    assert "agent_id" not in claude("pre-tool-use-bash")
    assert "agent_id" not in claude("stop")
    assert claude("subagent-stop-internal")["agent_type"] == ""


def test_stop_failure_names_its_error():
    assert claude("stop-failure")["error"] == "model_not_found"


def test_session_end_reason_is_present():
    assert isinstance(claude("session-end")["reason"], str)


@pytest.mark.parametrize("name", ["notify-agent-turn-complete-exec", "notify-agent-turn-complete-tui"])
def test_codex_notify_payload(name):
    fx = json.loads((ROOT / "codex" / f"{name}.json").read_text())
    payload = fx["payload"]
    assert payload["type"] == "agent-turn-complete"
    assert {"thread-id", "turn-id", "cwd", "client", "input-messages", "last-assistant-message"} <= payload.keys()
    assert isinstance(payload["input-messages"], list)
    assert "session_id" not in payload  # codex calls it thread-id


def test_fixtures_hold_no_real_paths():
    for path in ROOT.rglob("*.json"):
        text = path.read_text()
        # Only the /home/USER template may appear: no real home directory or per-uid temp dir.
        assert not re.search(r"/(?:home|Users)/(?!USER\b)", text) and "claude-1000" not in text, path
