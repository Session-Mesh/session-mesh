# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The codex rollout fallback only answers when it is unambiguous (R33)."""

import json
import os
import time

import discover


def _rollout(path, cwd, sid):
    path.write_text(json.dumps({"type": "session_meta", "payload": {"cwd": cwd, "id": sid}}) + "\n")


def test_two_candidates_and_two_codex_give_no_session_id(tmp_path, monkeypatch):
    monkeypatch.setattr(discover, "_codex_count", lambda d: 2)
    a, b = tmp_path / "rollout-a.jsonl", tmp_path / "rollout-b.jsonl"
    _rollout(a, "/w", "A")
    _rollout(b, "/w", "B")
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(a), str(b)])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/w")
    monkeypatch.setattr(discover, "proc_start", lambda pid: time.time() - 100)
    monkeypatch.setattr(os, "listdir", lambda p: [])        # no rollout held open
    assert discover.codex_info(os.getpid()).get("session_id") is None


def test_a_lone_codex_with_two_rollouts_takes_the_newest(tmp_path, monkeypatch):
    a, b = tmp_path / "rollout-a.jsonl", tmp_path / "rollout-b.jsonl"
    _rollout(a, "/w", "A")
    _rollout(b, "/w", "B")
    os.utime(a, (time.time() - 50, time.time() - 50))
    monkeypatch.setattr(discover, "_codex_count", lambda d: 1)
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(a), str(b)])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/w")
    monkeypatch.setattr(discover, "proc_start", lambda pid: time.time() - 100)
    monkeypatch.setattr(os, "listdir", lambda p: [])
    assert discover.codex_info(os.getpid()).get("session_id") == "B"


def test_one_candidate_is_used(tmp_path, monkeypatch):
    a = tmp_path / "rollout-a.jsonl"
    _rollout(a, "/w", "A")
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(a)])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/w")
    monkeypatch.setattr(discover, "proc_start", lambda pid: time.time() - 100)
    monkeypatch.setattr(os, "listdir", lambda p: [])
    assert discover.codex_info(os.getpid()).get("session_id") == "A"
