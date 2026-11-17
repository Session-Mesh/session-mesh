# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Mesh names retain exact identity across rename, stop and server restart."""
import json
import stat
import time
import asyncio

import pytest

import conversation_names as names
import organize
import history
import server

SID = "01900000-0000-0000-0000-000000000123"


@pytest.fixture
def registry(tmp_path, monkeypatch):
    monkeypatch.setattr(names, "FILE", tmp_path / "names.json")
    monkeypatch.setattr(organize, "FILE", tmp_path / "mesh.json")
    return names.FILE


def session(created=1, sid=SID, label=None):
    return {"name": "continuous-audit-codex", "created": created, "label": label,
            "agent": {"type": "codex", "session_id": sid, "identity_source": "open_rollout", "argv": ["secret"]},
            "cwd": "/private", "cmd": "secret", "folder": None}


def test_original_name_rename_aliases_and_close_survive_reload(registry):
    names.observe([session()])
    raw = [{"name": "continuous-audit-codex", "created": 1}]
    organize.apply({"op": "rename", "id": raw[0]["name"], "label": "Security work"}, raw)
    organize.apply({"op": "rename", "id": raw[0]["name"], "label": "Review now"}, raw)
    names.observe([session(label="Review now")])
    names.close(raw[0]["name"], 1)
    item = names.enrich({"agent": "codex", "id": SID}, names.snapshot())
    assert item["mesh_name"] == raw[0]["name"]
    assert item["mesh_label"] == "Review now"
    assert set(item["mesh_aliases"]) == {raw[0]["name"], "Security work", "Review now"}
    stored = json.loads(registry.read_text())
    assert stored[0]["closed_at"] is not None
    assert not {"argv", "cwd", "cmd", "folder"} & stored[0].keys()
    assert "secret" not in registry.read_text()
    assert stat.S_IMODE(registry.stat().st_mode) == 0o600


def test_failed_inventory_has_no_closure_authority(registry):
    names.observe([session()])
    names.observe([], listed=False)
    assert names.snapshot()[0]["closed_at"] is None
    names.observe([])
    assert names.snapshot()[0]["closed_at"] is not None


def test_reused_name_and_unknown_identity_never_inherit_conversation(registry):
    names.observe([session(label="Prior")])
    names.observe([session(created=2, sid=None)])
    entries = names.snapshot()
    old = next(e for e in entries if e["created"] == 1)
    new = next(e for e in entries if e["created"] == 2)
    assert old["closed_at"] is not None
    assert new["sid"] is None and new["label"] == ""
    current = [session(created=2, sid=None)]
    names.active_aliases(current)
    assert "Prior" not in current[0]["aliases"]
    other = {"agent": "claude", "id": SID}
    assert names.enrich(other, entries) == other


def test_shell_after_agent_exit_keeps_exact_last_identity(registry):
    names.observe([session()])
    names.observe([session(sid=None)])
    assert len(names.snapshot()) == 1
    assert names.snapshot()[0]["sid"] == SID


def test_rename_before_identity_discovery_attaches_aliases_when_known(registry):
    names.rename("continuous-audit-codex", 1, "Original", "Renamed")
    names.observe([session(label="Renamed")])
    assert len(names.snapshot()) == 1
    assert {"Original", "Renamed"} <= set(names.snapshot()[0]["aliases"])


def test_corrupt_fields_and_old_entries_are_discarded(registry):
    names.observe([session()])
    valid = names.snapshot()[0]
    registry.write_text(json.dumps([{}, {**valid, "sid": "--exec"}, {**valid, "created": True},
                                   {**valid, "seen": time.time() - names.KEEP_SECONDS - 1}, valid]))
    assert names.snapshot() == [valid]


def test_registry_is_bounded_and_aliases_cleaned(registry):
    for i in range(names.MAX_ALIASES + 3):
        names.rename("continuous-audit-codex", 1, f"name-{i}", f"new-{i}\u202e")
    assert len(names.snapshot()[0]["aliases"]) <= names.MAX_ALIASES
    assert "\u202e" not in registry.read_text()


async def test_history_delivers_names_and_closure_when_transcript_generation_unchanged(
        registry, client, auth_cookie, monkeypatch):
    done = asyncio.get_running_loop().create_future()
    done.set_result(None)
    monkeypatch.setattr(server, "history_scan", lambda: done)
    names.observe([session()])
    names.rename("continuous-audit-codex", 1, "Previous", "Current")
    names.close("continuous-audit-codex", 1)
    response = await client.get(f"/api/history?gen={history.gen}", headers=auth_cookie)
    assert response.status == 200
    payload = await response.json()
    assert payload["unchanged"] is True
    assert payload["mesh_names"][0]["sid"] == SID
    assert payload["mesh_names"][0]["closed_at"] is not None
    assert "Previous" in payload["mesh_names"][0]["aliases"]
    names_gen = payload["names_gen"]
    unchanged = await client.get(f"/api/history?gen={history.gen}&names_gen={names_gen}", headers=auth_cookie)
    assert unchanged.status == 200
    same = await unchanged.json()
    assert same["names_unchanged"] is True and "mesh_names" not in same
    names.rename("continuous-audit-codex", 1, "Current", "Renamed again")
    updated = await client.get(f"/api/history?gen={history.gen}&names_gen={names_gen}", headers=auth_cookie)
    changed = await updated.json()
    assert changed["unchanged"] is True and changed["names_unchanged"] is False
    assert changed["names_gen"] != names_gen
    assert changed["mesh_names"][0]["label"] == "Renamed again"


@pytest.mark.parametrize("kill_ok", [True, False])
async def test_kill_captures_identity_before_process_disappears(registry, client, auth_cookie, monkeypatch, kill_ok):
    raw = [{"name": "continuous-audit-codex", "created": 1}]
    calls = []
    async def host(body):
        calls.append(body["op"])
        return raw if body["op"] == "list" else {"ok": kill_ok}
    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(server, "list_sessions", lambda *args: {"mesh": [session(label="Audit")]})
    monkeypatch.setattr(server.respawn, "forget_live", lambda name, created: None)
    monkeypatch.setattr(server.board, "remove", lambda *args: None)
    response = await client.post("/api/kill/continuous-audit-codex", json={"created": 1}, headers=auth_cookie)
    assert response.status == (200 if kill_ok else 409)
    assert calls == ["list", "kill_if"]
    entry = names.snapshot()[0]
    assert entry["sid"] == SID and entry["label"] == "Audit"
    assert (entry["closed_at"] is not None) is kill_ok


def test_late_pre_kill_inventory_cannot_reopen_closed_incarnation(registry):
    names.observe([session()])
    names.close("continuous-audit-codex", 1)
    names.observe([session()])
    names.observe([session(sid="abcdefgh-2222")])
    assert len(names.snapshot()) == 1
    assert names.snapshot()[0]["closed_at"] is not None


def test_directory_fallback_is_not_a_persisted_identity(registry):
    candidate = session()
    candidate["agent"]["identity_source"] = "cwd_unique"
    names.observe([candidate])
    assert names.snapshot()[0]["sid"] is None


def test_old_snapshot_cannot_undo_a_concurrent_rename(registry):
    names.observe([session()])
    earlier = time.time()
    names.rename("continuous-audit-codex", 1, "Previous", "Latest")
    names.observe([session(label="Previous")], now=earlier)
    assert names.snapshot()[0]["label"] == "Latest"


def test_unchanged_inventory_does_not_rewrite_registry(registry):
    names.observe([session()])
    before = registry.stat().st_mtime_ns
    names.observe([session()])
    assert registry.stat().st_mtime_ns == before


def test_conversation_change_does_not_replace_old_binding(registry):
    names.observe([session()])
    newer = "abcdefgh-2222"
    names.observe([session(sid=newer)])
    names.close("continuous-audit-codex", 1)
    entries = names.snapshot()
    assert [e["sid"] for e in entries] == [newer, SID]
    assert len({e["closed_at"] for e in entries}) == 1


def test_aggregate_aliases_are_bounded_across_many_bindings(registry):
    names.observe([session()])
    template = names.snapshot()[0]
    base = time.time() - 100
    registry.write_text(json.dumps([{**template, "seen": base + i, "aliases": [f"alias-{i}"]}
                                   for i in range(50)]))
    entries = names.snapshot()
    item = names.enrich({"agent": "codex", "id": SID}, entries)
    assert item["mesh_aliases"] == [f"alias-{i}" for i in range(30, 50)]
    current = [session()]
    names.active_aliases(current)
    assert current[0]["aliases"] == item["mesh_aliases"]


async def test_live_where_distinguishes_agents_with_same_conversation_id(monkeypatch):
    current = {"kind": "mesh", "agent": {"type": "codex", "session_id": SID}}
    async def sessions():
        return {"mesh": [current], "external": []}
    monkeypatch.setattr(server, "sessions", sessions)
    assert await server.live_where(SID, "codex") == current
    assert await server.live_where(SID, "claude") is None
