# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Shared by the session-respawn tests: mesh items as the server lists them, and a private snapshot file."""

import pytest

import respawn

SID = "0a1b2c3d-1111-2222-3333-444444444444"
SID2 = "9f8e7d6c-1111-2222-3333-555555555555"


def mesh_item(name, cwd, created=1000.0, agent=None, cmd="-sh"):
    """A mesh session as ``server.list_sessions`` describes it (only what the snapshot reads)."""
    return {"name": name, "id": name, "kind": "mesh", "cwd": str(cwd), "created": created, "cmd": cmd,
            "agent": agent}


def claude(sid=SID, argv=None):
    return {"type": "claude", "session_id": sid, "pid": 1, "argv": argv or ["claude"], "title": "ignored"}


def codex(sid=SID2, argv=None):
    return {"type": "codex", "session_id": sid, "pid": 2, "argv": argv or ["codex", "--yolo"]}


@pytest.fixture
def snapshot_file(tmp_path, monkeypatch):
    import server

    # Core restore fixture: explicit empty-source evidence, not missing-file evidence.
    async def empty_artifacts(op, name, created, target=None):
        assert op in ("list", "restore-probe", "remove")
        if op == "remove":
            return {"ok": True}
        return {"required": False} if op == "restore-probe" else {"catalogue_present": True, "source_present": True, "references": []}

    monkeypatch.setattr(server, "artifact_lifecycle", empty_artifacts)
    path = tmp_path / "conf" / "sessions-snapshot.json"
    monkeypatch.setattr(respawn, "FILE", path)
    return path
