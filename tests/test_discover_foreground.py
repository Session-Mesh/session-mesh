# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Whether a discovered agent currently owns the terminal's input group."""

import discover


def _process(comm, ppid, pgrp, sid, tpgid):
    return (comm, "S", ppid, pgrp, sid, 1, tpgid)


def test_describe_marks_a_background_agent_without_changing_passive_discovery(monkeypatch):
    sid, codex = 100, 200
    procs = {
        sid: _process("bash", 1, sid, sid, sid),
        codex: _process("codex", sid, codex, sid, sid),
    }
    monkeypatch.setattr(discover, "agent_info", lambda pid, kind: {"type": kind, "pid": pid})
    monkeypatch.setattr(discover, "cmdline", lambda pid: [b"codex"] if pid == codex else [b"bash"])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/work")

    described = discover.describe(procs, sid)

    # session_agent still exposes a background Codex for passive status, but
    # input-bearing callers can distinguish it from the shell foreground.
    assert described["agent"] == {"type": "codex", "pid": codex, "foreground": False}


def test_describe_marks_a_foreground_agent(monkeypatch):
    sid, codex = 100, 200
    procs = {
        sid: _process("bash", 1, sid, sid, codex),
        codex: _process("codex", sid, codex, sid, codex),
    }
    monkeypatch.setattr(discover, "agent_info", lambda pid, kind: {"type": kind, "pid": pid})
    monkeypatch.setattr(discover, "cmdline", lambda pid: [b"codex"] if pid == codex else [b"bash"])
    monkeypatch.setattr(discover, "cwd", lambda pid: "/work")

    assert discover.describe(procs, sid)["agent"]["foreground"] is True
