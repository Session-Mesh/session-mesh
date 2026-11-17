# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""What a session's agent said last, and claude's waiting state (discover.py)."""

import json

import pytest

import discover


@pytest.mark.parametrize("content,said", [
    ("plain text", "plain text"),
    ([{"type": "text", "text": "done, tests green"}], "done, tests green"),
    ([{"type": "text", "text": "running it"}, {"type": "tool_use", "name": "Bash", "input": {"command": "git push"}}],
     "⚙ Bash · git push"),
    ([{"type": "tool_use", "name": "Edit", "input": {"file_path": "/a/b.py", "old_string": "x"}}], "⚙ Edit · /a/b.py"),
    ([{"type": "tool_use", "name": "AskUserQuestion", "input": {"questions": [{"question": "Delete the copies?"}]}}],
     "❓ Delete the copies?"),
    ([{"type": "tool_use", "name": "TodoWrite", "input": "odd"}], "⚙ TodoWrite"),
    ([{"type": "thinking", "thinking": "hm"}], None),
    ([], None), (None, None), ([42], None), ([{"type": "text", "text": 42}], None),
])
def test_claude_said(content, said):
    assert discover._claude_said(content) == said


def test_claude_info_reports_waiting_and_what_was_said(tmp_path, monkeypatch):
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    sid = "0a1b2c3d-0000-0000-0000-000000000000"
    (tmp_path / ".claude" / "sessions").mkdir(parents=True)
    (tmp_path / ".claude" / "sessions" / "4242.json").write_text(json.dumps(
        {"sessionId": sid, "status": "waiting", "waitingFor": "input needed", "statusUpdatedAt": 1790000000000}))
    proj = tmp_path / ".claude" / "projects" / "-x"
    proj.mkdir(parents=True)
    lines = [
        {"type": "user", "cwd": "/x", "message": {"content": "push it"}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "git push"}}]}},
        {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "sub-agent noise"}]}},
    ]
    (proj / f"{sid}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    info = discover.claude_info(4242)
    assert (info["status"], info["waiting_for"], info["since"], info["said"], info["last"]) == \
        ("waiting", "input needed", 1790000000.0, "⚙ Bash · git push", "push it")


def test_claude_info_has_no_waiting_reason_when_not_waiting(tmp_path, monkeypatch):
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    (tmp_path / ".claude" / "sessions").mkdir(parents=True)
    (tmp_path / ".claude" / "sessions" / "7.json").write_text(json.dumps(
        {"sessionId": None, "status": "idle", "waitingFor": "stale", "statusUpdatedAt": "junk"}))
    info = discover.claude_info(7)
    assert info["waiting_for"] is None and info["since"] is None


def test_claude_info_survives_an_assistant_line_without_message(tmp_path, monkeypatch):
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    sid = "0a1b2c3d-0000-0000-0000-000000000001"
    (tmp_path / ".claude" / "sessions").mkdir(parents=True)
    (tmp_path / ".claude" / "sessions" / "8.json").write_text(json.dumps({"sessionId": sid, "status": "idle"}))
    proj = tmp_path / ".claude" / "projects" / "-x"
    proj.mkdir(parents=True)
    lines = [{"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}},
             {"type": "assistant", "message": None}, {"type": "assistant", "message": "odd"},
             {"type": "user", "message": None}, 42, [1]]
    (proj / f"{sid}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    assert discover.claude_info(8)["said"] == "ok"
