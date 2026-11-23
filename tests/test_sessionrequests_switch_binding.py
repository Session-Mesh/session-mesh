# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import copy
import sqlite3

import pytest

import sessionrequests


SOURCE = {"id": "s", "created": 1.0, "agent": "codex", "cwd": "/work"}
BODY = {"action": "switch_account", "account": "target"}
PAIR = {"backend": "codex", "source": {"id": "source", "context_revision": "a" * 64},
        "target": {"id": "target", "context_revision": "b" * 64}}


def make(db, binding=PAIR):
    return db.create(SOURCE, BODY, enabled_agents={"codex"}, resumable={"codex"},
                     current_account="source", switch_binding=binding)


def test_binding_survives_claim_approval_and_restart_without_paths(tmp_path):
    path = tmp_path / "requests.sqlite3"
    db = sessionrequests.Requests(path, clock=lambda: 10.0)
    binding = copy.deepcopy(PAIR)
    request = make(db, binding)
    binding["source"]["id"] = "changed"
    assert request["switch_binding"] == PAIR
    assert "switch_binding" not in db.public(request)
    claim = db.claim(request["id"], "a" * 32)
    assert claim["request"]["switch_binding"] == PAIR
    approved = db.decide(request["id"], True, claim["claim_nonce"])
    assert approved["switch_binding"] == PAIR
    db.close()
    db = sessionrequests.Requests(path, clock=lambda: 11.0)
    assert db.status(request["id"])["switch_binding"] == PAIR
    assert db.begin_execution(request["id"])["switch_binding"] == PAIR
    db.close()


@pytest.mark.parametrize("change", ["backend", "source", "target", "revision", "path", "missing"])
def test_invalid_binding_is_rejected_before_any_intent(tmp_path, change):
    binding = copy.deepcopy(PAIR)
    if change == "backend":
        binding["backend"] = "claude"
    elif change in ("source", "target"):
        binding[change]["id"] = "wrong"
    elif change == "revision":
        binding["source"]["context_revision"] = "A" * 64
    elif change == "path":
        binding["source"]["path"] = "/secret"
    else:
        del binding["target"]
    db = sessionrequests.Requests(tmp_path / "requests.sqlite3", clock=lambda: 10.0)
    with pytest.raises(ValueError, match="Invalid switch binding"):
        make(db, binding)
    assert db.pending() == []
    db.close()


def test_old_database_migrates_without_inventing_binding(tmp_path):
    path = tmp_path / "requests.sqlite3"
    db = sessionrequests.Requests(path, clock=lambda: 10.0)
    old = make(db, None)
    db.close()
    with sqlite3.connect(path) as raw:
        raw.execute("ALTER TABLE session_requests DROP COLUMN switch_binding_json")
    db = sessionrequests.Requests(path, clock=lambda: 11.0)
    assert db.status(old["id"]) == old
    assert "switch_binding" not in db.status(old["id"])
    db.close()


def test_agent_cannot_supply_binding_in_body(tmp_path):
    db = sessionrequests.Requests(tmp_path / "requests.sqlite3", clock=lambda: 10.0)
    with pytest.raises(ValueError):
        db.create(SOURCE, {**BODY, "switch_binding": PAIR}, enabled_agents={"codex"},
                  resumable={"codex"}, current_account="source")
    db.close()


def test_binding_cannot_be_attached_to_restart(tmp_path):
    db = sessionrequests.Requests(tmp_path / "requests.sqlite3", clock=lambda: 10.0)
    with pytest.raises(ValueError, match="Only an account switch"):
        db.create(SOURCE, {"action": "restart"}, enabled_agents={"codex"},
                  resumable={"codex"}, switch_binding=PAIR)
    assert db.pending() == []
    db.close()
