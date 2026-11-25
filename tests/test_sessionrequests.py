# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

from concurrent.futures import ThreadPoolExecutor
import sqlite3
import os
import sqlite3
from pathlib import Path

import pytest

import sessionrequests


def source(name="alpha", created=1.0, agent="codex"):
    return {"id": name, "created": created, "agent": agent, "cwd": "/work"}


def store(tmp_path, *, clock=lambda: 10.0):
    return sessionrequests.Requests(tmp_path / "session-requests.sqlite3", clock=clock)


def test_launch_options_and_settings_keep_distinct_approved_states(tmp_path):
    requests = store(tmp_path)
    launch = requests.create(source(), {"action": "create", "preset": "codex"},
                             enabled_agents={"codex"}, resumable={"codex"})
    settings = requests.create(source(name="beta"), {"action": "settings", "effort": "high"},
                               enabled_agents={"codex"}, resumable={"codex"}, conversation="conversation-id")
    for entry in (launch, settings):
        claim = requests.claim(entry["id"], "a" * 32)
        assert requests.decide(entry["id"], True, claim["claim_nonce"],
                               approved_options=["--model", "test"], options_revision="rev")["state"] == "approved"
    assert {item["id"] for item in requests.approved()} == {launch["id"], settings["id"]}
    with sqlite3.connect(tmp_path / "session-requests.sqlite3") as db:
        rows = dict(db.execute("SELECT action, state FROM session_requests"))
    assert rows == {"create": "approved_options_v1", "settings": "settings_approved"}
    assert requests.begin_execution(launch["id"])["state"] == "executing"
    assert requests.begin_execution(settings["id"])["state"] == "executing"
    with sqlite3.connect(tmp_path / "session-requests.sqlite3") as db:
        rows = dict(db.execute("SELECT action, state FROM session_requests"))
    assert rows == {"create": "executing", "settings": "settings_executing"}


def test_fence_evidence_retains_terminal_result_across_expiry_and_budget(tmp_path, monkeypatch):
    now = [10.0]
    protected = set()
    requests = sessionrequests.Requests(tmp_path / 'actions.sqlite3', clock=lambda: now[0],
                                        retain_terminal=lambda request_id: request_id in protected)
    made = requests.create(source(), {'action': 'restart'}, enabled_agents={'codex'}, resumable={'codex'})
    claim = requests.claim(made['id'], 'a' * 32)
    requests.decide(made['id'], True, claim['claim_nonce'])
    requests.begin_execution(made['id'])
    protected.add(made['id'])
    requests.finish(made['id'], error='inspect')
    now[0] += sessionrequests.TTL + 1
    monkeypatch.setattr(sessionrequests, 'MAX_TERMINAL_REQUESTS', 0)
    assert requests.status(made['id'])['state'] == 'failed'
    requests.close()
    requests = sessionrequests.Requests(tmp_path / 'actions.sqlite3', clock=lambda: now[0],
                                        retain_terminal=lambda request_id: request_id in protected)
    assert requests.status(made['id'])['state'] == 'failed'
    protected.clear()
    assert requests.status(made['id']) is None
    requests.close()


def test_retention_io_failure_does_not_purge_terminal_result(tmp_path):
    now = [10.0]
    def retention(_request_id): raise PermissionError('unavailable')
    path = tmp_path / 'actions.sqlite3'
    requests = sessionrequests.Requests(path, clock=lambda: now[0], retain_terminal=retention)
    made = requests.create(source(), {'action': 'restart'}, enabled_agents={'codex'}, resumable={'codex'})
    claim = requests.claim(made['id'], 'a' * 32)
    requests.decide(made['id'], True, claim['claim_nonce'])
    requests.begin_execution(made['id'])
    # The retention error rolls back finish, preserving the in-flight evidence.
    with pytest.raises(sqlite3.OperationalError):
        requests.finish(made['id'], error='inspect')
    with sqlite3.connect(path) as raw:
        assert raw.execute('SELECT state FROM session_requests WHERE id = ?', (made['id'],)).fetchone() == ('executing',)
    requests.close()


def test_agent_request_is_pending_and_only_visible_to_its_incarnation(tmp_path):
    requests = store(tmp_path)
    made = requests.create(source(), {"action": "create", "preset": "claude",
                                      "name": "review", "model": "sonnet"},
                           enabled_agents={"claude", "codex"}, resumable={"claude", "codex"})
    assert made["state"] == "pending"
    assert requests.own(made["id"], source()) == made
    assert requests.own(made["id"], source(created=2.0)) is None
    assert requests.pending() == [made]


def test_restart_is_self_only_and_requires_resumable_agent(tmp_path):
    requests = store(tmp_path)
    made = requests.create(source(), {"action": "restart", "model": "gpt-6.1-sol"},
                           enabled_agents={"codex"}, resumable={"codex"})
    assert made["preset"] == "codex" and made["name"] is None
    with pytest.raises(ValueError):
        requests.create(source(agent="pi"), {"action": "restart"},
                        enabled_agents={"pi"}, resumable={"codex"})


@pytest.mark.parametrize("body", [
    {"action": "create", "preset": "custom"},
    {"action": "create", "preset": "codex", "model": "bad model"},
    {"action": "restart", "preset": "codex"},
    {"action": "create", "preset": "codex", "extra": True},
])
def test_request_contract_rejects_open_or_ambiguous_inputs(tmp_path, body):
    with pytest.raises(ValueError):
        store(tmp_path).create(source(), body, enabled_agents={"codex"}, resumable={"codex"})


def test_only_one_tab_claims_and_a_loser_cannot_change_the_decision(tmp_path):
    requests = store(tmp_path)
    made = requests.create(source(), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    tab_a, tab_b = "a" * 32, "b" * 32
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda tab: requests.claim(made["id"], tab), (tab_a, tab_b)))
    won = [claim for claim in claims if claim is not None]
    assert len(won) == 1
    winner = won[0]
    loser_tab = tab_b if winner["tab_nonce"] == tab_a else tab_a
    assert requests.claim(made["id"], loser_tab) is None
    assert requests.decide(made["id"], False, "not-the-claim") is None
    assert requests.decide(made["id"], True, winner["claim_nonce"], approved_options=[], options_revision="rev")["state"] == "approved"
    assert requests.decide(made["id"], False, winner["claim_nonce"]) is None
    assert requests.begin_execution(made["id"])["state"] == "executing"
    done = requests.finish(made["id"], result={"id": "new-codex"})
    assert done["state"] == "completed" and done["result"] == {"id": "new-codex"}


def test_tab_nonce_does_not_recover_a_claim_secret(tmp_path):
    requests = store(tmp_path)
    made = requests.create(source(), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    first = requests.claim(made["id"], "a" * 32)
    assert requests.claim(made["id"], "a" * 32) is None
    for wrong in ("", "é", "\ud800"):       # refused, never a TypeError from the comparison
        assert requests.claim(made["id"], "a" * 32, wrong) is None
    assert requests.claim(made["id"], "a" * 32, first["claim_nonce"]) == first
    approved = requests.decide(made["id"], True, first["claim_nonce"], approved_options=[], options_revision="rev")
    assert requests.decide(made["id"], True, first["claim_nonce"], approved_options=[], options_revision="rev") == approved


def test_restart_preserves_intent_claim_and_terminal_status(tmp_path):
    path = tmp_path / "session-requests.sqlite3"
    first = sessionrequests.Requests(path, clock=lambda: 10.0)
    made = first.create(source(), {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    claim = first.claim(made["id"], "a" * 32)
    first.close()

    second = sessionrequests.Requests(path, clock=lambda: 11.0)
    assert second.claim(made["id"], "a" * 32) is None
    assert second.claim(made["id"], "a" * 32, claim["claim_nonce"]) == claim
    second.decide(made["id"], True, claim["claim_nonce"], approved_options=[], options_revision="rev")
    second.begin_execution(made["id"])
    second.finish(made["id"], result={"id": "created"})
    second.close()

    third = sessionrequests.Requests(path, clock=lambda: 12.0)
    assert third.own(made["id"], source())["state"] == "completed"
    assert third.own(made["id"], source())["result"] == {"id": "created"}


def test_pending_survives_restart_without_becoming_claimed(tmp_path):
    path = tmp_path / "session-requests.sqlite3"
    first = sessionrequests.Requests(path, clock=lambda: 10.0)
    made = first.create(source(), {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    first.close()
    recovered = sessionrequests.Requests(path, clock=lambda: 11.0)
    assert recovered.status(made["id"])["state"] == "pending"
    assert recovered.claim(made["id"], "a" * 32)["request"]["state"] == "claimed"


def test_restart_never_reexecutes_an_uncertain_execution(tmp_path):
    path = tmp_path / "session-requests.sqlite3"
    first = sessionrequests.Requests(path, clock=lambda: 10.0)
    made = first.create(source(), {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    claim = first.claim(made["id"], "a" * 32)
    first.decide(made["id"], True, claim["claim_nonce"], approved_options=[], options_revision="rev")
    first.begin_execution(made["id"])
    first.close()

    recovered = sessionrequests.Requests(path, clock=lambda: 11.0)
    status = recovered.own(made["id"], source())
    assert status["state"] == "execution_unknown"
    assert recovered.begin_execution(made["id"]) is None


def test_approved_survives_restart_and_is_the_only_recoverable_work(tmp_path):
    path = tmp_path / "session-requests.sqlite3"
    first = sessionrequests.Requests(path, clock=lambda: 10.0)
    made = first.create(source(), {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    claim = first.claim(made["id"], "a" * 32)
    first.decide(made["id"], True, claim["claim_nonce"], approved_options=[], options_revision="rev")
    first.close()

    recovered = sessionrequests.Requests(path, clock=lambda: 11.0)
    assert [item["id"] for item in recovered.approved()] == [made["id"]]
    assert recovered.begin_execution(made["id"])["state"] == "executing"
    assert recovered.begin_execution(made["id"]) is None


def test_approval_snapshot_survives_reopen_and_cannot_be_replaced_by_retry(tmp_path):
    first = store(tmp_path)
    made = first.create(source(), {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    claim = first.claim(made["id"], "a" * 32)
    nonce = claim["claim_nonce"]
    assert first.decide(made["id"], True, nonce) is None
    approved = first.decide(made["id"], True, nonce, approved_options=["--before"], options_revision="rev-before")
    assert "_approved_options" not in approved
    assert first._db.execute("SELECT count(*) FROM session_requests WHERE state = 'approved'").fetchone()[0] == 0
    assert first._db.execute("UPDATE session_requests SET state = 'executing' WHERE id = ? AND state = 'approved'",
                             (made["id"],)).rowcount == 0
    assert first.decide(made["id"], True, nonce, approved_options=["--after"], options_revision="rev-after") == approved
    first.close()
    recovered = store(tmp_path)
    assert "_approved_options" not in recovered.status(made["id"])
    assert recovered.begin_execution(made["id"])["_approved_options"] == ["--before"]


def test_old_writer_cannot_approve_a_pending_create_without_snapshot(tmp_path):
    requests = store(tmp_path)
    made = requests.create(source(), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    requests.claim(made["id"], "a" * 32)
    with pytest.raises(sqlite3.IntegrityError, match="requires bound launch options"):
        requests._db.execute("UPDATE session_requests SET state = 'approved' WHERE id = ?", (made["id"],))
    assert requests.status(made["id"])["state"] == "claimed"


def test_expired_claim_can_be_replaced_but_old_claim_cannot_decide(tmp_path):
    now = [10.0]
    requests = store(tmp_path, clock=lambda: now[0])
    made = requests.create(source(), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    old = requests.claim(made["id"], "a" * 32)
    now[0] += sessionrequests.CLAIM_TTL + 1
    new = requests.claim(made["id"], "b" * 32)
    assert new and new["claim_nonce"] != old["claim_nonce"]
    assert requests.decide(made["id"], True, old["claim_nonce"]) is None


def test_terminal_result_is_retained_for_a_full_ttl(tmp_path):
    now = [10.0]
    requests = store(tmp_path, clock=lambda: now[0])
    made = requests.create(source(), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    claim = requests.claim(made["id"], "a" * 32)
    requests.decide(made["id"], False, claim["claim_nonce"])
    now[0] += sessionrequests.TTL - 1
    assert requests.own(made["id"], source())["state"] == "rejected"
    now[0] += 2
    assert requests.own(made["id"], source()) is None


def test_terminal_history_does_not_consume_active_quota(tmp_path, monkeypatch):
    monkeypatch.setattr(sessionrequests, "MAX_ACTIVE_REQUESTS", 2)
    requests = store(tmp_path)
    for name in ("one", "two", "three"):
        made = requests.create(source(), {"action": "create", "preset": "codex", "name": name},
                               enabled_agents={"codex"}, resumable={"codex"})
        claim = requests.claim(made["id"], "a" * 32)
        requests.decide(made["id"], False, claim["claim_nonce"])
    assert requests.create(source(), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})["state"] == "pending"


def test_one_incarnation_cannot_exhaust_the_global_active_quota(tmp_path, monkeypatch):
    monkeypatch.setattr(sessionrequests, "MAX_ACTIVE_REQUESTS", 3)
    monkeypatch.setattr(sessionrequests, "MAX_ACTIVE_PER_SOURCE", 2)
    requests = store(tmp_path)
    for name in ("one", "two"):
        requests.create(source(), {"action": "create", "preset": "codex", "name": name},
                        enabled_agents={"codex"}, resumable={"codex"})
    with pytest.raises(ValueError, match="this session"):
        requests.create(source(), {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    assert requests.create(source("beta"), {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})


def test_terminal_retention_is_bounded_oldest_first(tmp_path, monkeypatch):
    now = [10.0]
    monkeypatch.setattr(sessionrequests, "MAX_TERMINAL_REQUESTS", 2)
    requests = store(tmp_path, clock=lambda: now[0])
    made = []
    for index in range(3):
        item = requests.create(source(), {"action": "create", "preset": "codex", "name": f"n{index}"},
                               enabled_agents={"codex"}, resumable={"codex"})
        claim = requests.claim(item["id"], "a" * 32)
        requests.decide(item["id"], False, claim["claim_nonce"])
        made.append(item)
        now[0] += 1
    # The terminal transition itself enforces the independent history budget.
    assert requests.status(made[-1]["id"])["state"] == "rejected"
    assert requests.status(made[0]["id"]) is None


def test_database_and_sidecars_stay_private_under_umask_022(tmp_path):
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    old = os.umask(0o022)
    try:
        requests = sessionrequests.Requests(private / "requests.sqlite3")
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{private / 'requests.sqlite3'}{suffix}")
            if path.exists():
                assert path.stat().st_mode & 0o777 == 0o600
        requests.close()
    finally:
        os.umask(old)


@pytest.mark.parametrize("kind", ["directory-mode", "directory-symlink", "database-symlink",
                                  "sidecar-symlink"])
def test_store_rejects_unsafe_existing_custody(tmp_path, kind):
    private = tmp_path / "private"
    if kind == "directory-mode":
        private.mkdir(mode=0o755)
        target = private / "requests.sqlite3"
    elif kind == "directory-symlink":
        real = tmp_path / "real"
        real.mkdir(mode=0o700)
        private.symlink_to(real, target_is_directory=True)
        target = private / "requests.sqlite3"
    elif kind == "database-symlink":
        private.mkdir(mode=0o700)
        real = tmp_path / "real.sqlite3"
        real.touch(mode=0o600)
        target = private / "requests.sqlite3"
        target.symlink_to(real)
    else:
        private.mkdir(mode=0o700)
        target = private / "requests.sqlite3"
        outside = tmp_path / "outside"
        outside.touch(mode=0o600)
        Path(f"{target}-wal").symlink_to(outside)
    with pytest.raises(ValueError):
        sessionrequests.Requests(target)


def test_a_corrupt_database_is_set_aside_and_the_store_starts_empty(tmp_path, capsys):
    """A damaged file made every server start fail (a restart loop): it is renamed like the
    other corrupt state files, logged, and an empty store takes its place."""
    path = tmp_path / "session-requests.sqlite3"
    path.write_bytes(b"this is not a SQLite database" * 100)
    path.chmod(0o600)
    requests = sessionrequests.Requests(path, clock=lambda: 10.0)
    assert requests.pending() == []
    kept = [p.name for p in tmp_path.iterdir() if p.name.startswith("session-requests.sqlite3.corrupt-")]
    assert len(kept) == 1 and (tmp_path / kept[0]).read_bytes().startswith(b"this is not")
    assert "session-requests.sqlite3.corrupt-" in capsys.readouterr().err
    made = requests.create(source(), {"action": "create", "preset": "claude"},
                           enabled_agents={"claude"}, resumable={"claude"})
    assert requests.pending() == [made]
