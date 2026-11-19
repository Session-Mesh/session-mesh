# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Smoke only: discover.py against real claude/codex transcripts is out of scope."""

import os

import discover


def test_snapshot_sees_this_process():
    procs = discover.snapshot()
    assert os.getpid() in procs
    assert procs[os.getpid()][2] == os.getppid()


def test_home_is_the_test_home():
    assert discover.HOME == os.environ["HOME"]


def test_a_process_name_that_is_not_utf8_does_not_break_the_snapshot(tmp_path):
    """A program run through a file name holding a byte that is not UTF-8 gets that name as its
    comm. Reading /proc/<pid>/stat as text then failed, and the whole session list with it."""
    import subprocess
    name = os.fsencode(tmp_path) + b"/x\xff"
    os.symlink("/bin/sleep", name)
    child = subprocess.Popen([name, "30"])
    try:
        procs = discover.snapshot()
        assert procs[child.pid][0] == "x�" and procs[child.pid][2] == os.getpid()
        assert discover.proc_start(child.pid) > 0
    finally:
        child.kill()
        child.wait()


def test_malformed_transcript_lines_are_skipped(tmp_path, monkeypatch):
    """One odd line (valid JSON of the wrong shape, or nested past the parser's depth) must not
    make the description of the session, hence the whole session list, fail."""
    import json
    monkeypatch.setattr(discover, "HOME", str(tmp_path))
    sid = "0a1b2c3d-0000-0000-0000-000000000000"
    (tmp_path / ".claude" / "sessions").mkdir(parents=True)
    (tmp_path / ".claude" / "sessions" / "4242.json").write_text(json.dumps({"sessionId": sid}))
    proj = tmp_path / ".claude" / "projects" / "-x"
    proj.mkdir(parents=True)
    odd = ["[" * 100000, "42", '{"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}']
    (proj / f"{sid}.jsonl").write_text("\n".join(odd) + "\n")
    assert discover.claude_info(4242)["said"] == "hi"

    (tmp_path / ".claude" / "sessions" / "4243.json").write_text("[1]")
    assert discover.claude_info(4243) == {"type": "claude"}

    rollout = tmp_path / "rollout-a.jsonl"
    lines = [{"type": "session_meta", "payload": {"cwd": "/w", "id": "A"}}, 42, {"payload": "x"},
             {"type": "event_msg", "payload": {"type": "item_completed", "item": "x"}},
             {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "content": 7}}},
             {"type": "response_item", "payload": {"type": "message", "role": "user", "content": 7}},
             {"type": "turn_context", "payload": {"cwd": ["/w"]}},
             {"type": "event_msg", "payload": {"type": "agent_message", "message": "done"}}]
    rollout.write_text("\n".join(json.dumps(x) for x in lines) + "\n" + "[" * 100000 + "\n")
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(rollout)])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/w")
    monkeypatch.setattr(discover, "proc_start", lambda pid: 0)
    monkeypatch.setattr(discover, "_codex_count", lambda d: 1)   # a lone codex: its candidate is accepted
    monkeypatch.setattr(os, "listdir", lambda p: [])
    info = discover.codex_info(os.getpid())
    assert info["session_id"] == "A" and info["said"] == "done" and info["cwd"] is None

    pi_dir = tmp_path / "pi"
    (pi_dir / "sessions" / "x").mkdir(parents=True)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(pi_dir))
    monkeypatch.setattr(discover, "snapshot", lambda: {})
    pi_lines = [{"type": "session", "version": 3, "cwd": "/w", "id": "P"},
                {"message": {"role": "assistant", "content": [{"type": "text", "text": "pi said"}]}}]
    (pi_dir / "sessions" / "x" / "s.jsonl").write_text(
        "\n".join(json.dumps(x) for x in pi_lines) + "\n" + "[" * 100000 + "\n")
    assert discover.pi_info(os.getpid())["said"] == "pi said"
