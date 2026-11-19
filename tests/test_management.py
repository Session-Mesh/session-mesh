# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The bounded, read-only management inventory."""

import json

import pytest

import management
import portfolio
import ptyhost
import respawn
import server


def mesh_session(name="alpha", created=100.0, agent_type="codex", status="busy"):
    """A deliberately content-bearing live row: the projection must discard it."""
    return {
        "name": name,
        "created": created,
        "known_agent": agent_type,
        "agent": {"status": status, "reply": "private reply", "cwd": "/private/agent"},
        "cwd": "/private/project",
        "label": "private label",
        "cmd": "private command",
        "token": "private token",
        "pid": 424242,
    }


def host_session(name="alpha", created=100.0, cwd="/tmp"):
    """One well-formed ptyhost ``list`` item, separate from its safe projection."""
    return {"name": name, "pid": 999_991, "cwd": cwd, "created": created,
            "activity": created, "attached": 0, "meta": {}}


def stopped(result):
    """Only the narrowly witnessed departure rows from a management snapshot."""
    return [row for row in result["sessions"] if row["source"] == "observed-stop"]


def test_successful_absence_records_one_safe_observed_stop(tmp_path, monkeypatch):
    """Only two successful snapshots can witness a Mesh identity disappear."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()

    management.snapshot(mesh=[mesh_session()], external=[], listed=True, recovery=[], now=1_000.0)
    result = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_001.0)

    assert result["state"] == "observed"
    assert result["retention"] == {"max_entries": 200, "keep_seconds": 14 * 86400}
    assert result["sessions"] == [{
        "name": "alpha",
        "created": 100.0,
        "source": "observed-stop",
        "agent_type": "codex",
        "lifecycle": "stopped-observed",
        "last_observed_agent_status": "busy",
        "time_basis": "observed_stopped_at",
        "time": 1_001.0,
    }]
    persisted = (tmp_path / "management-sessions.json").read_text(encoding="utf-8")
    assert "private" not in persisted
    assert "424242" not in json.dumps(result)


def test_no_baseline_never_infers_a_departure(tmp_path, monkeypatch):
    """An empty first successful list is evidence of no baseline, not of an exit."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()

    first = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_000.0)
    second = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_001.0)

    assert stopped(first) == []
    assert stopped(second) == []


def test_outage_preserves_ledger_bytes_and_successful_baseline_until_one_stop(tmp_path, monkeypatch):
    """Only the next successful list may compare a pre-outage Mesh baseline."""
    path = tmp_path / "management-sessions.json"
    monkeypatch.setattr(management, "FILE", path)
    management.reset_for_tests()
    now = management.KEEP_SECONDS + 2_000.0

    management.snapshot(mesh=[mesh_session()], external=[], listed=True, recovery=[], now=now)
    # A stale but otherwise valid legacy entry proves an unavailable snapshot does
    # not even rewrite the ledger while pruning its in-memory projection.
    path.write_text(json.dumps({"version": 1, "observed_stops": [{
        "name": "stale", "created": 1.0, "agent_type": "claude",
        "last_observed_agent_status": "idle", "observed_stopped_at": 1.0,
    }]}), encoding="utf-8")
    before_outage = path.read_bytes()
    baseline_before_outage = dict(management._baseline)

    outage = management.snapshot(mesh=[], external=[], listed=False, recovery=[], now=now + 1.0)
    assert outage["state"] == "unavailable"
    assert path.read_bytes() == before_outage
    assert management._baseline == baseline_before_outage

    resumed = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=now + 2.0)
    repeated = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=now + 3.0)
    alpha_rows = [row for row in stopped(resumed) if (row["name"], row["created"]) == ("alpha", 100.0)]
    assert len(alpha_rows) == 1
    assert alpha_rows[0]["time"] == now + 2.0
    assert [row for row in stopped(repeated) if row["name"] == "alpha"] == alpha_rows


def test_same_name_reuse_keeps_the_new_identity_distinct_from_old_stop(tmp_path, monkeypatch):
    """A name is not an identity: its authoritative creation time is part of it."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()

    management.snapshot(mesh=[mesh_session("alpha", 100.0)], external=[], listed=True, recovery=[], now=1_000.0)
    management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_001.0)
    result = management.snapshot(mesh=[mesh_session("alpha", 200.0)], external=[], listed=True,
                                 recovery=[], now=1_002.0)

    assert {(row["source"], row["name"], row["created"]) for row in result["sessions"]} == {
        ("mesh", "alpha", 200.0),
        ("observed-stop", "alpha", 100.0),
    }


def test_external_disappearance_never_enters_the_observed_stop_ledger(tmp_path, monkeypatch):
    """Discovery has no durable identity, so disappearance stays deliberately unknown."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()
    external = {"pid": 42, "cwd": "/private", "agent": {"type": "claude", "status": "waiting"}}

    management.snapshot(mesh=[], external=[external], listed=True, recovery=[], now=1_000.0)
    result = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_001.0)

    assert stopped(result) == []
    assert not management.FILE.exists()


def test_pruning_caps_valid_history_and_rejects_future_or_corrupt_stop_times(tmp_path, monkeypatch):
    """Bad clocks must not occupy retention capacity or survive a successful cleanup."""
    path = tmp_path / "management-sessions.json"
    monkeypatch.setattr(management, "FILE", path)
    management.reset_for_tests()
    now = 2_000_000.0
    records = [{
        "name": f"session-{index}", "created": float(index), "agent_type": "codex",
        "last_observed_agent_status": "idle", "observed_stopped_at": now - index,
    } for index in range(201)]
    records.extend([
        {"name": "future", "created": 999.0, "agent_type": "codex",
         "last_observed_agent_status": "idle", "observed_stopped_at": now + 1.0},
        {"name": "corrupt", "created": 1.0, "agent_type": "codex",
         "last_observed_agent_status": "idle", "observed_stopped_at": "not-a-time"},
    ])
    path.write_text(json.dumps({"version": 1, "observed_stops": records}), encoding="utf-8")

    result = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=now)
    names = {row["name"] for row in stopped(result)}
    saved = json.loads(path.read_text(encoding="utf-8"))["observed_stops"]

    assert len(names) == management.MAX_ENTRIES
    assert "session-0" in names
    assert "session-200" not in names
    assert "future" not in names
    assert "corrupt" not in names
    assert len(saved) == management.MAX_ENTRIES
    assert all(entry["observed_stopped_at"] <= now for entry in saved)


def test_recovery_wins_over_same_identity_stop_but_not_a_distinct_name_reuse(tmp_path, monkeypatch):
    """A restart loss is distinct evidence and removes an older duplicate stop witness."""
    path = tmp_path / "management-sessions.json"
    monkeypatch.setattr(management, "FILE", path)
    management.reset_for_tests()

    management.snapshot(mesh=[mesh_session("alpha", 100.0)], external=[], listed=True, recovery=[], now=1_000.0)
    # Simulate a legacy ledger created before recovery-aware normalization.
    path.write_text(json.dumps({"version": 1, "observed_stops": [
        {"name": "alpha", "created": 100.0, "agent_type": "codex",
         "last_observed_agent_status": "busy", "observed_stopped_at": 1_000.5},
        {"name": "alpha", "created": 200.0, "agent_type": "codex",
         "last_observed_agent_status": "idle", "observed_stopped_at": 1_000.4},
    ]}), encoding="utf-8")

    result = management.snapshot(
        mesh=[], external=[], listed=True,
        recovery=[{"name": "alpha", "created": 100.0, "agent_type": "codex", "lost_at": 1_001.0}],
        now=1_001.0,
    )
    sources = {(row["source"], row["name"], row["created"]) for row in result["sessions"]}
    saved = json.loads(path.read_text(encoding="utf-8"))["observed_stops"]

    assert sources == {
        ("restart-recovery", "alpha", 100.0),
        ("observed-stop", "alpha", 200.0),
    }
    assert [(entry["name"], entry["created"]) for entry in saved] == [("alpha", 200.0)]


def test_failed_atomic_stop_write_is_retried_without_losing_the_witness(tmp_path, monkeypatch):
    """A successful observation remains pending when its first atomic write fails."""
    path = tmp_path / "management-sessions.json"
    monkeypatch.setattr(management, "FILE", path)
    management.reset_for_tests()
    real_atomic_write = management.fsutil.atomic_write
    writes = []

    def fail_once(target, text):
        writes.append(target)
        if len(writes) == 1:
            raise OSError("read-only just this once")
        real_atomic_write(target, text)

    management.snapshot(mesh=[mesh_session()], external=[], listed=True, recovery=[], now=1_000.0)
    monkeypatch.setattr(management.fsutil, "atomic_write", fail_once)

    failed = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_001.0)
    assert [(row["name"], row["time"]) for row in stopped(failed)] == [("alpha", 1_001.0)]
    assert not path.exists()

    baseline_before_outage = dict(management._baseline)
    outage = management.snapshot(mesh=[], external=[], listed=False, recovery=[], now=1_001.5)
    assert outage["state"] == "unavailable"
    assert not path.exists()
    assert management._baseline == baseline_before_outage

    retried = management.snapshot(mesh=[], external=[], listed=True, recovery=[], now=1_002.0)
    saved = json.loads(path.read_text(encoding="utf-8"))["observed_stops"]
    assert writes == [path, path]
    assert [(row["name"], row["time"]) for row in stopped(retried)] == [("alpha", 1_001.0)]
    assert [(entry["name"], entry["observed_stopped_at"]) for entry in saved] == [("alpha", 1_001.0)]


def test_current_mesh_and_external_rows_are_closed_safe_projections(tmp_path, monkeypatch):
    """Live objects carry sensitive material, so management reconstructs every row."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()
    external = {
        "id": "t424242", "pid": 424242, "cwd": "/private/external", "cmd": "private external command",
        "host": "private terminal", "agent": {"type": "claude", "status": "waiting", "title": "private title"},
    }

    result = management.snapshot(mesh=[mesh_session()], external=[external], listed=True, recovery=[], now=1_000.0)

    assert result["sessions"] == [
        {"name": "alpha", "created": 100.0, "source": "mesh", "agent_type": "codex",
         "lifecycle": "active", "last_observed_agent_status": "busy",
         "time_basis": "created", "time": 100.0},
        {"name": None, "created": None, "source": "external", "agent_type": "claude",
         "lifecycle": "active", "last_observed_agent_status": "waiting",
         "time_basis": "unknown", "time": None},
    ]
    text = json.dumps(result)
    for private in ("424242", "/private", "private title", "private command", "private terminal"):
        assert private not in text


def test_unavailable_projection_deduplicates_and_prunes_persisted_witnesses(tmp_path, monkeypatch):
    """A broken ledger may not turn into duplicate or unbounded public history."""
    path = tmp_path / "management-sessions.json"
    monkeypatch.setattr(management, "FILE", path)
    management.reset_for_tests()
    path.write_text(json.dumps({"version": 1, "observed_stops": [
        {"name": "alpha", "created": 100.0, "agent_type": "codex",
         "last_observed_agent_status": "idle", "observed_stopped_at": 1_999_998.0},
        {"name": "alpha", "created": 100.0, "agent_type": "codex",
         "last_observed_agent_status": "busy", "observed_stopped_at": 1_999_999.0},
        {"name": "old", "created": 90.0, "agent_type": "claude",
         "last_observed_agent_status": "idle", "observed_stopped_at": 1.0},
        {"name": "broken", "created": "not-a-time", "token": "private token"},
    ]}), encoding="utf-8")

    result = management.snapshot(mesh=[], external=[], listed=False, recovery=[], now=2_000_000.0)

    assert result["state"] == "unavailable"
    assert result["sessions"] == [{
        "name": "alpha", "created": 100.0, "source": "observed-stop", "agent_type": "codex",
        "lifecycle": "stopped-observed", "last_observed_agent_status": "busy",
        "time_basis": "observed_stopped_at", "time": 1_999_999.0,
    }]


def test_restart_recovery_is_a_separate_closed_management_source(tmp_path, monkeypatch):
    """Recovery records are useful lifecycle evidence, not an excuse to leak their snapshot."""
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    monkeypatch.setattr(respawn, "FILE", tmp_path / "sessions-snapshot.json")
    management.reset_for_tests()
    private = {
        "name": "lost", "cwd": str(work), "created": 100.0,
        "agent": {"type": "codex", "session_id": "0a1b2c3d-1111-2222-3333-444444444444",
                  "argv": ["codex", "private argv"]},
        "cmd": "private command", "label": "private label",
    }
    respawn.update([private], listed=True, now=1_000.0)
    respawn.update([], listed=True, now=1_001.0)

    result = management.snapshot(mesh=[], external=[], listed=True,
                                 recovery=respawn.management_lost(now=1_001.0), now=1_001.0)

    assert result["sessions"] == [{
        "name": "lost", "created": 100.0, "source": "restart-recovery", "agent_type": "codex",
        "lifecycle": "lost-recovery", "last_observed_agent_status": "unknown",
        "time_basis": "lost_at", "time": 1_001.0,
    }]
    text = json.dumps(result)
    for private_text in (str(work), "private argv", "private command", "private label"):
        assert private_text not in text


async def test_authenticated_session_snapshot_embeds_the_closed_management_projection(
        client, auth_cookie, tmp_path, monkeypatch):
    """Management shares the existing owner snapshot; it does not become an endpoint."""
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    monkeypatch.setattr(respawn, "FILE", tmp_path / "sessions-snapshot.json")
    management.reset_for_tests()

    async def listed_host(request):
        assert request == {"op": "list"}
        return [{"name": "alpha", "pid": 999_991, "cwd": str(work), "created": 100.0,
                 "activity": 0, "attached": 0, "meta": {}}]

    def listed(_raw, _listed=True):
        return {"mesh": [{**mesh_session(), "id": "alpha", "cwd": str(work),
                          "agent": {"status": "busy", "title": "private title"}}],
                "external": [], "folders": [], "moved": {}, "opens": {}, "home": str(tmp_path), "now": 1_000.0}

    async def no_worktrees(*_args, **_kwargs):
        return None

    monkeypatch.setattr(ptyhost, "request", listed_host)
    monkeypatch.setattr(server, "list_sessions", listed)
    monkeypatch.setattr(portfolio, "collect_worktrees", no_worktrees)
    response = await client.get("/api/sessions", headers=auth_cookie)

    assert response.status == 200
    body = await response.json()
    row = body["management"]["sessions"][0]
    assert {key: row[key] for key in (
        "name", "created", "source", "agent_type", "lifecycle",
        "last_observed_agent_status", "time_basis", "time",
    )} == {
        "name": "alpha", "created": 100.0, "source": "mesh", "agent_type": "codex",
        "lifecycle": "active", "last_observed_agent_status": "busy",
        "time_basis": "created", "time": 100.0,
    }
    assert row["metrics"] == {
        "observed_duration_seconds": {
            "state": "derived", "source": "management-lifecycle", "value": 900.0,
            "observed_at": 1_000.0, "window": {"start": 100.0, "end": 1_000.0}, "reason": None,
        },
        "cpu_percent": {
            "state": "unknown", "source": "not-recognized-agent", "value": None,
            "observed_at": 1_000.0, "window": None, "reason": "not-collected",
        },
        "rss_bytes": {
            "state": "unknown", "source": "not-recognized-agent", "value": None,
            "observed_at": 1_000.0, "window": None, "reason": "not-collected",
        },
        "tokens": {
            "state": "unavailable", "source": "no-approved-adapter", "value": None,
            "observed_at": None, "window": None, "reason": "not-collected",
        },
    }
    assert body["management"]["observability"] == {
        "state": "observed",
        "sampling": {
            "cadence_seconds": 10, "max_tracked_identities": 200,
            "retention": {"mode": "none", "persistent": False},
        },
        "window": {"kind": "current-snapshot", "start": 1_000.0, "end": 1_000.0},
    }
    text = json.dumps(body["management"])
    for private in ("private title", str(work), "999991"):
        assert private not in text


async def test_server_enriches_only_the_existing_management_snapshot(tmp_path, monkeypatch):
    """The resource projection stays inside the owner snapshot; it adds no second management surface."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()
    raw = [host_session()]
    observed = []

    async def listed_host(request):
        assert request == {"op": "list"}
        return raw

    def listed(_raw, _listed=True):
        return {"mesh": [mesh_session()], "external": [], "folders": [], "moved": {},
                "opens": {}, "home": str(tmp_path), "now": 1_000.0}

    def enrich(*, raw, management, listed, now):
        observed.append((raw, management, listed, now))
        return {**management, "observability": {"state": "observed"}}

    async def no_collect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(ptyhost, "request", listed_host)
    monkeypatch.setattr(server, "list_sessions", listed)
    monkeypatch.setattr(server.respawn, "update", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.respawn, "management_lost", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.portfolio, "observed_inventory", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(server.portfolio, "collect_worktrees", no_collect)
    monkeypatch.setattr(server.portfolio, "attach_diff_selectors", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server.observability, "enrich", enrich)

    result = await server.sessions()

    assert [(call[0], call[2], call[3]) for call in observed] == [(raw, True, 1_000.0)]
    assert observed[0][1]["sessions"][0]["name"] == "alpha"
    assert result["management"]["observability"] == {"state": "observed"}


async def test_server_sessions_preserves_a_baseline_across_outage_then_records_one_stop(tmp_path, monkeypatch):
    """Exercise the ptyhost-list → server.sessions authority bit, not just the ledger helper."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()
    replies = iter([[host_session()], OSError("ptyhost unavailable"), [], []])
    observed_listed = []
    times = iter([1_000.0, 1_001.0, 1_002.0, 1_003.0])

    async def fake_request(request):
        assert request == {"op": "list"}
        reply = next(replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def fake_list_sessions(raw, listed=True):
        observed_listed.append(listed)
        return {"mesh": [mesh_session()] if raw else [], "external": [], "folders": [],
                "moved": {}, "opens": {}, "home": str(tmp_path), "now": next(times)}

    async def no_collect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(ptyhost, "request", fake_request)
    monkeypatch.setattr(server, "list_sessions", fake_list_sessions)
    monkeypatch.setattr(server.respawn, "update", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.respawn, "management_lost", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.portfolio, "observed_inventory", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(server.portfolio, "collect_worktrees", no_collect)
    monkeypatch.setattr(server.portfolio, "attach_diff_selectors", lambda *_args, **_kwargs: None)

    first = await server.sessions()
    outage = await server.sessions()
    resumed = await server.sessions()
    repeated = await server.sessions()

    assert observed_listed == [True, False, True, True]
    assert first["management"]["state"] == "observed"
    assert outage["management"]["state"] == "unavailable"
    alpha_stops = [row for row in stopped(resumed["management"]) if row["name"] == "alpha"]
    assert len(alpha_stops) == 1
    assert alpha_stops[0]["time"] == 1_002.0
    assert [row for row in stopped(repeated["management"]) if row["name"] == "alpha"] == alpha_stops


async def test_an_older_listing_finishing_last_witnesses_no_stop_and_prunes_no_open(tmp_path, monkeypatch):
    """Listings run in parallel (the round, the watchers, actions): the one of the older host read may finish
    last. It must not record a stop of a session created since its read, nor forget that session's board open
    or board signals, nor drop the stop of a session that ended since its read (its ``now`` is earlier)."""
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    management.reset_for_tests()
    monkeypatch.setattr(server, "_RECORDED", [0.0])
    monkeypatch.setattr(server.opens, "OPENS", [])
    monkeypatch.setattr(server.opens, "_BOARD_OPEN_IDENTITIES", {})
    purged = []
    monkeypatch.setattr(server, "_purge_invalid_board_signals", lambda raw: purged.append([s["name"] for s in raw]))
    hosted = [host_session("alpha", 100.0), host_session("y", 150.0)]

    async def fake_request(request):
        assert request == {"op": "list"}
        return list(hosted)

    def fake_list_sessions(raw, listed=True):
        return {"mesh": [mesh_session(item["name"], item["created"]) for item in raw], "external": [], "folders": [],
                "moved": {}, "opens": {}, "home": str(tmp_path),
                "now": 1_001.0 if any(item["name"] == "x" for item in raw) else 1_000.5}

    async def no_collect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(ptyhost, "request", fake_request)
    monkeypatch.setattr(server, "list_sessions", fake_list_sessions)
    monkeypatch.setattr(server.respawn, "record", lambda *_args, **_kwargs: ([], False))
    monkeypatch.setattr(server.respawn, "management_lost", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.portfolio, "observed_inventory", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(server.portfolio, "collect_worktrees", no_collect)
    monkeypatch.setattr(server.portfolio, "attach_diff_selectors", lambda *_args, **_kwargs: None)

    await server.sessions()                                  # the baseline: alpha and y
    older = await server._read_host()                        # a listing reads the host: alpha and y
    hosted[1] = host_session("x", 200.0)                     # y ends; x is created, and asks for its board
    server.opens.record_board_open("x", 200.0)
    await server._listing(None, None)                        # a newer listing finishes first: alpha and x
    late, _ = await server._listing(None, None, older)       # the older one finishes last
    after, _ = await server._listing(None, None)

    for result in (late, after):
        assert not [row for row in stopped(result["management"]) if row["name"] == "x"]
    ledger = management.FILE.read_text()
    assert '"x"' not in ledger and '"y"' in ledger
    assert [row["time"] for row in stopped(after["management"]) if row["name"] == "y"] == [1_001.0]
    assert [entry["session"] for entry in late["opens"] if entry.get("kind") == "board-open"] == ["x"]
    assert purged == [["alpha", "y"], ["alpha", "x"], ["alpha", "x"]], "the older listing purges no board signal"
    assert any(row["name"] == "x" for row in after["management"]["sessions"])


@pytest.mark.parametrize("malformed_reply", [
    pytest.param([{"name": "alpha"}], id="structurally-invalid-list"),
    pytest.param(json.JSONDecodeError("invalid ptyhost JSON", "{", 0), id="invalid-transport-json"),
])
async def test_malformed_ptyhost_list_preserves_management_authority_and_ledger(
        tmp_path, monkeypatch, malformed_reply):
    """A bad delivered list or JSON payload is unavailable, never an empty observation."""
    ledger = tmp_path / "management-sessions.json"
    snapshot = tmp_path / "sessions-snapshot.json"
    monkeypatch.setattr(management, "FILE", ledger)
    monkeypatch.setattr(respawn, "FILE", snapshot)
    management.reset_for_tests()
    ledger.write_text(json.dumps({"version": 1, "observed_stops": [{
        "name": "legacy", "created": 10.0, "agent_type": "claude",
        "last_observed_agent_status": "idle", "observed_stopped_at": 900.0,
    }]}), encoding="utf-8")
    before = ledger.read_bytes()
    replies = iter([[host_session()], malformed_reply, [], []])
    observed_listed = []
    times = iter([1_000.0, 1_001.0, 1_002.0, 1_003.0])

    async def fake_request(request):
        assert request == {"op": "list"}
        reply = next(replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def fake_list_sessions(raw, listed=True):
        observed_listed.append(listed)
        return {"mesh": [mesh_session()] if raw else [], "external": [], "folders": [],
                "moved": {}, "opens": {}, "home": str(tmp_path), "now": next(times)}

    async def no_collect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(ptyhost, "request", fake_request)
    monkeypatch.setattr(server, "list_sessions", fake_list_sessions)
    monkeypatch.setattr(server.respawn, "update", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.respawn, "management_lost", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server.portfolio, "observed_inventory", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(server.portfolio, "collect_worktrees", no_collect)
    monkeypatch.setattr(server.portfolio, "attach_diff_selectors", lambda *_args, **_kwargs: None)

    first = await server.sessions()
    baseline = dict(management._baseline)
    malformed = await server.sessions()
    assert ledger.read_bytes() == before
    assert management._baseline == baseline
    resumed = await server.sessions()
    repeated = await server.sessions()

    assert observed_listed == [True, False, True, True]
    assert first["management"]["state"] == "observed"
    assert malformed["management"]["state"] == "unavailable"
    assert ledger.read_bytes() != before  # the later successful stop is the only permitted mutation
    alpha_stops = [row for row in stopped(resumed["management"]) if row["name"] == "alpha"]
    assert [(row["name"], row["time"]) for row in alpha_stops] == [("alpha", 1_002.0)]
    assert [row for row in stopped(repeated["management"]) if row["name"] == "alpha"] == alpha_stops


async def test_corrupt_respawn_recovery_is_bounded_through_server_management(tmp_path, monkeypatch):
    """A ptyhost outage cannot expose more than the recovery source's 200-entry bound."""
    now = 2_000_000.0
    work = tmp_path / "work"
    work.mkdir()
    snapshot = tmp_path / "sessions-snapshot.json"
    monkeypatch.setattr(management, "FILE", tmp_path / "management-sessions.json")
    monkeypatch.setattr(respawn, "FILE", snapshot)
    management.reset_for_tests()
    lost = [{"name": f"lost-{index:03d}", "cwd": str(work), "created": float(index),
             "agent": None, "cmd": None, "lost_at": now - index}
            for index in range(respawn.MAX_ENTRIES + 1)]
    snapshot.write_text(json.dumps({"version": 1, "live": [], "lost": lost}), encoding="utf-8")
    before = snapshot.read_bytes()

    async def unavailable(request):
        assert request == {"op": "list"}
        raise OSError("ptyhost unavailable")

    def empty_list_sessions(raw, listed=True):
        assert (raw, listed) == ([], False)
        return {"mesh": [], "external": [], "folders": [], "moved": {}, "opens": {},
                "home": str(tmp_path), "now": now}

    async def no_collect(*_args, **_kwargs):
        return None

    monkeypatch.setattr(ptyhost, "request", unavailable)
    monkeypatch.setattr(server, "list_sessions", empty_list_sessions)
    monkeypatch.setattr(server.portfolio, "observed_inventory", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(server.portfolio, "collect_worktrees", no_collect)
    monkeypatch.setattr(server.portfolio, "attach_diff_selectors", lambda *_args, **_kwargs: None)

    data = await server.sessions()

    recoveries = [row for row in data["management"]["sessions"] if row["source"] == "restart-recovery"]
    assert data["management"]["state"] == "unavailable"
    assert len(recoveries) == respawn.MAX_ENTRIES
    assert {row["name"] for row in recoveries} == {
        f"lost-{index:03d}" for index in range(1, respawn.MAX_ENTRIES + 1)
    }
    assert snapshot.read_bytes() == before
