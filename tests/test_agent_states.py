# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Real agent states: fixtures captured from a throwaway claude 2.1.288 and codex 0.160.0,
then anonymised (tests/fixtures/agent-states/).

These tests fail when the agents report their states differently, which is what the push
notifications and the answer buttons rely on: re-capture the fixtures after an upgrade."""

import json
import os
import time
from pathlib import Path

import pytest

import discover
import notify
import server

FIXTURES = Path(__file__).parent / "fixtures" / "agent-states"
PID = 4242

# What claude 2.1.288 wrote in ~/.claude/sessions/<pid>.json, state by state.
REPORTED = {
    "idle": ("idle", None),
    "working": ("busy", None),
    "question": ("waiting", "input needed"),
    "permission": ("waiting", "permission prompt"),
    "permission-denied": ("idle", None),
    "question-background-agent": ("waiting", "input needed"),
    "background-shell": ("shell", None),
}


def fixture(agent, name):
    return json.loads((FIXTURES / agent / f"{name}.json").read_text())


def claude_info(tmp_path, monkeypatch, name):
    """discover.claude_info over a fixture laid out as claude lays out its files."""
    fx = fixture("claude", name)
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    sessions = tmp_path / ".claude" / "sessions"
    project = tmp_path / ".claude" / "projects" / "-tmp-scratch"
    sessions.mkdir(parents=True)
    project.mkdir(parents=True)
    (sessions / f"{PID}.json").write_text(json.dumps(fx["session"]))
    lines = "".join(json.dumps(line) + "\n" for line in fx["transcript"])
    (project / f"{fx['session']['sessionId']}.jsonl").write_text(lines)
    return discover.claude_info(PID)


def mesh_session(agent, sid="s1"):
    return {"id": sid, "kind": "mesh", "name": sid, "agent": agent}


@pytest.mark.parametrize("name", sorted(REPORTED))
def test_claude_reports_these_exact_values(name):
    session = fixture("claude", name)["session"]
    status, waiting_for = REPORTED[name]
    assert session["status"] == status
    assert session.get("waitingFor") == waiting_for
    assert session["version"] == "2.1.288"


def test_a_permission_prompt_is_not_the_question_dialog():
    """The answer-button guard reads "input needed" as "question dialog open"."""
    assert fixture("claude", "permission")["session"]["waitingFor"] != notify.QUESTION_DIALOG
    assert fixture("claude", "question")["session"]["waitingFor"] == notify.QUESTION_DIALOG


@pytest.mark.parametrize("name,expected", [
    ("idle", {"status": "idle", "waiting_for": None, "choices": None, "ask_id": None}),
    ("working", {"status": "busy", "waiting_for": None, "choices": None, "ask_id": None}),
    ("question", {"status": "waiting", "waiting_for": "input needed", "said": "❓ Question 1?",
                  "choices": ["Option A", "Option B"], "ask_id": "toolu_0001"}),
    ("permission", {"status": "waiting", "waiting_for": "permission prompt", "choices": None, "ask_id": None}),
    ("question-background-agent", {"status": "waiting", "waiting_for": "input needed",
                                   "said": "❓ Question 1?", "choices": None, "ask_id": None}),
    ("background-shell", {"status": "shell", "waiting_for": None, "choices": None, "ask_id": None}),
])
def test_discover_reads_each_state(tmp_path, monkeypatch, name, expected):
    info = claude_info(tmp_path, monkeypatch, name)
    assert {k: info.get(k) for k in expected} == expected
    assert info["cwd"] == "/tmp/scratch" and info["title"] == "Conversation title"


def test_a_pending_permission_is_not_in_the_transcript_yet(tmp_path, monkeypatch):
    """claude writes the tool_use line only once the prompt is answered: while it is open,
    the transcript ends with the user's prompt, so "said" is the reply before it."""
    fx = fixture("claude", "permission")
    assert fx["transcript"][-1]["type"] == "user"
    info = claude_info(tmp_path, monkeypatch, "permission")
    assert not info["said"].startswith("⚙")
    denied = fixture("claude", "permission-denied")["transcript"]
    assert any(b.get("type") == "tool_use" and b.get("name") == "Bash"
               for line in denied if line["type"] == "assistant" for b in line["message"]["content"])


def test_a_denied_permission_shows_claude_interruption_as_last_prompt(tmp_path, monkeypatch):
    info = claude_info(tmp_path, monkeypatch, "permission-denied")
    assert info["said"] == "⚙ Bash · a shell command"
    assert info["last"] == "[Request interrupted by user for tool use]"


def test_a_question_asked_beside_a_background_agent_shares_its_message():
    """Agent and AskUserQuestion are two tool_use blocks of one assistant message."""
    lines = fixture("claude", "question-background-agent")["transcript"]
    tools = [(line["message"]["id"], b["name"]) for line in lines if line["type"] == "assistant"
             for b in line["message"]["content"] if b["type"] == "tool_use"]
    assert [name for _, name in tools[-2:]] == ["Agent", "AskUserQuestion"]
    assert tools[-1][0] == tools[-2][0]


def watch(tmp_path, monkeypatch, before, after):
    """The notification a busy-then-<after> session produces."""
    watcher = notify.Watcher()
    first = claude_info(tmp_path / "a", monkeypatch, before)
    watcher.changes({"mesh": [mesh_session(first)], "external": []}, now=1000)
    second = claude_info(tmp_path / "b", monkeypatch, after)
    return watcher.changes({"mesh": [mesh_session(second)], "external": []}, now=1001)


@pytest.mark.parametrize("state,kind", [
    ("question", "question"),
    ("permission", "waiting"),
    ("question-background-agent", "question"),
])
def test_push_kind_per_state(tmp_path, monkeypatch, state, kind):
    events = watch(tmp_path, monkeypatch, "working", state)
    assert [e["kind"] for e in events] == [kind]


def poll_statuses(*steps):
    """The events a mesh claude session produces when it reports (status, seconds) in turn."""
    watcher, out, now = notify.Watcher(), [], 1000
    for status, wait in steps:
        now += wait
        agent = {"type": "claude", "status": status, "said": "reply"}
        out.append([e["kind"] for e in watcher.changes({"mesh": [mesh_session(agent)], "external": []}, now=now)])
    return out


def test_a_turn_that_ends_in_a_background_shell_is_finished_once():
    """The turn is over while the shell runs: one "finished", as for idle, and nothing more
    when the shell ends and claude settles to idle (no second push for the same turn)."""
    settle = notify.SETTLE["claude"]
    got = poll_statuses(("busy", 0), ("shell", 1), ("shell", settle), ("shell", 60), ("idle", 5), ("idle", 60))
    assert got == [[], [], ["finished"], [], [], []]


def test_a_turn_claude_starts_after_the_shell_is_notified_again():
    settle = notify.SETTLE["claude"]
    got = poll_statuses(("busy", 0), ("shell", 1), ("shell", settle), ("busy", 5), ("idle", 1), ("idle", notify.SPACING["done"] + settle))
    assert got == [[], [], ["finished"], [], [], ["finished"]]


def test_an_unknown_future_status_is_never_a_finished_turn():
    settle = notify.SETTLE["claude"]
    assert poll_statuses(("busy", 0), ("future-state", 1), ("future-state", settle)) == [[], [], []]


@pytest.mark.parametrize("status,idle", [("idle", True), ("waiting", True), ("busy", False),
                                         ("shell", False), ("future-state", False), (None, False)])
def test_looks_idle_never_lets_the_mesh_type_over_a_running_shell(status, idle):
    """looks_idle gates resume-when-idle, which SIGTERMs the agent and reopens it: that would
    kill the background shell, so "shell" and any unknown status are not idle."""
    assert server.looks_idle({"type": "claude", "status": status}) is idle


@pytest.fixture
def buttons_on(monkeypatch):
    monkeypatch.setattr(server, "ACTIONS", {})
    monkeypatch.setattr(server, "ANSWER_BUTTONS", True)


@pytest.mark.parametrize("state,offered", [
    ("question", ["Option A", "Option B"]),
    ("permission", None),
    ("question-background-agent", None),
    ("idle", None),
])
def test_answer_buttons_per_state(tmp_path, monkeypatch, buttons_on, state, offered):
    agent = claude_info(tmp_path, monkeypatch, state)
    message = server.with_actions({"id": "s1"}, mesh_session(agent))
    titles = [a["title"] for a in message.get("actions", [])]
    assert (titles or None) == offered


# ---------------------------------------------------------------- codex

def codex_info(tmp_path, monkeypatch, rollout=None):
    path = tmp_path / "rollout-2026-01-01T00-00-00-scratch.jsonl"
    lines = fixture("codex", "idle")["rollout"] if rollout is None else rollout
    path.write_text("".join(json.dumps(x) + "\n" for x in lines))
    rollout = path
    old = time.time() - 600
    os.utime(rollout, (old, old))
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(rollout)])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/tmp/scratch")
    monkeypatch.setattr(discover, "proc_start", lambda pid: old - 100)
    monkeypatch.setattr(discover, "_codex_count", lambda d: 1)
    monkeypatch.setattr(os, "listdir", lambda p: [])   # no rollout held open: the fallback path
    return discover.codex_info(os.getpid())


def test_codex_rollout_fields_discover_reads(tmp_path, monkeypatch):
    info = codex_info(tmp_path, monkeypatch)
    assert (info["session_id"], info["cwd"], info["last"], info["status"]) == \
        ("00000000-0000-7000-8000-000000000001", "/tmp/scratch", "user prompt 1", "idle")


def test_codex_0160_writes_no_agent_message_event():
    """codex 0.160 puts its reply in item_completed (AgentMessage), the assistant response_item and
    task_complete.last_agent_message, not in the event_msg agent_message discover reads."""
    lines = fixture("codex", "idle")["rollout"]
    kinds = {(x["type"], x["payload"].get("type")) for x in lines}
    assert ("event_msg", "agent_message") not in kinds
    assert ("event_msg", "task_complete") in kinds


def test_codex_said_is_read(tmp_path, monkeypatch):
    assert codex_info(tmp_path, monkeypatch)["said"] == "assistant text 1"


@pytest.mark.parametrize("source", [
    lambda t, k: (t, k) == ("event_msg", "item_completed"),
    lambda t, k: (t, k) == ("event_msg", "task_complete"),
    lambda t, k: t == "response_item",
])
def test_codex_said_comes_from_any_one_of_the_three_new_places(tmp_path, monkeypatch, source):
    rollout = [x for x in fixture("codex", "idle")["rollout"]
               if x["type"] in ("session_meta", "turn_context") or source(x["type"], x["payload"].get("type"))]
    assert codex_info(tmp_path, monkeypatch, rollout=rollout)["said"] == "assistant text 1"


def test_codex_said_still_reads_the_older_agent_message_event(tmp_path, monkeypatch):
    rollout = [x for x in fixture("codex", "idle")["rollout"] if x["type"] in ("session_meta", "turn_context")]
    rollout.append({"type": "event_msg", "payload": {"type": "agent_message", "message": " older reply \n"}})
    assert codex_info(tmp_path, monkeypatch, rollout=rollout)["said"] == "older reply"


def test_codex_said_is_the_latest_reply_and_ignores_the_users_messages(tmp_path, monkeypatch):
    rollout = fixture("codex", "idle")["rollout"]
    second = json.loads(json.dumps(rollout[-1]))
    second["payload"]["last_agent_message"] = "assistant text 2"
    assert codex_info(tmp_path, monkeypatch, rollout=rollout + [second])["said"] == "assistant text 2"
    user_only = [x for x in rollout if x["payload"].get("role") != "assistant"
                 and x["payload"].get("type") not in ("item_completed", "task_complete")]
    assert codex_info(tmp_path, monkeypatch, rollout=user_only)["said"] is None
