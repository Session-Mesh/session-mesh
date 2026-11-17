# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""A snapshot is only written by the server, yet every read validates it (RS-1 hardening)."""

import json

import pytest

import respawn
from respawn_helpers import SID, mesh_item, snapshot_file  # noqa: F401


def good(tmp_path, **over):
    entry = {"name": "ok", "cwd": str(tmp_path), "created": 1.0, "agent": None, "cmd": None, "lost_at": None}
    entry.update(over)
    return entry


def write(snapshot_file, lost):
    snapshot_file.parent.mkdir(parents=True, exist_ok=True)
    snapshot_file.write_text(json.dumps({"version": 1, "live": [], "lost": lost}))


@pytest.mark.parametrize("over", [
    {"name": "../x"}, {"name": "a b"}, {"name": "x" * 49}, {"name": ""}, {"name": 5}, {"name": "a\n"},
    {"cwd": "relative/dir"}, {"cwd": "/definitely/not/here"}, {"cwd": 5}, {"cwd": None},
    {"created": "yesterday"}, {"created": True}, {"created": float("inf")},
    {"agent": {"type": "bash", "session_id": SID, "argv": ["bash"]}},
    {"agent": {"type": "claude", "session_id": "--dangerous", "argv": ["claude"]}},
    {"agent": {"type": "claude", "session_id": "x", "argv": ["claude"]}},
    {"agent": {"type": "claude", "session_id": SID, "argv": "claude"}},
    {"agent": {"type": "claude", "session_id": SID, "argv": ["claude", 5]}},
    {"agent": {"type": "claude", "session_id": SID, "argv": ["a"] * 201}},
    {"agent": {"type": "claude", "session_id": SID, "argv": ["a" * 4097]}},
    {"agent": "claude"}, {"agent": []}, {"cmd": 5}, {"lost_at": "now"},
])
def test_an_invalid_entry_is_never_offered(snapshot_file, tmp_path, over):
    write(snapshot_file, [good(tmp_path, **over), good(tmp_path, name="fine")])
    assert [e["name"] for e in respawn.update([], listed=True)] == ["fine"]
    assert respawn.lost_entry("fine") is not None


def test_a_cwd_that_is_a_file_is_refused(snapshot_file, tmp_path):
    f = tmp_path / "file"
    f.write_text("x")
    write(snapshot_file, [good(tmp_path, cwd=str(f))])
    assert respawn.update([], listed=True) == []


@pytest.mark.parametrize("text", ["", "not json", "[]", "null", '{"lost": 5}', '{"lost": {"a": 1}}',
                                  '{"live": "x", "lost": [1, "a", null, []]}'])
def test_a_corrupt_file_is_an_empty_snapshot(snapshot_file, tmp_path, text):
    snapshot_file.parent.mkdir(parents=True, exist_ok=True)
    snapshot_file.write_text(text)
    assert respawn.update([], listed=True) == []
    respawn.update([mesh_item("a", tmp_path)], listed=True)         # and it heals on the next write
    assert json.loads(snapshot_file.read_text())["live"][0]["name"] == "a"


def test_an_invalid_live_entry_is_not_promoted_to_lost(snapshot_file, tmp_path):
    snapshot_file.parent.mkdir(parents=True, exist_ok=True)
    snapshot_file.write_text(json.dumps({"version": 1, "lost": [], "live": [good(tmp_path, name="a b")]}))
    assert respawn.update([], listed=True) == []


def test_lost_entry_revalidates_at_restore_time(snapshot_file, tmp_path):
    victim = tmp_path / "gone"
    victim.mkdir()
    write(snapshot_file, [good(tmp_path, cwd=str(victim))])
    assert respawn.lost_entry("ok") is not None
    victim.rmdir()
    assert respawn.lost_entry("ok") is None


def test_marking_or_required_dropping_an_unknown_offer_raises(snapshot_file, tmp_path):
    write(snapshot_file, [good(tmp_path)])
    nonce = "a" * 32
    with pytest.raises(LookupError):
        respawn.begin_restoring("ghost", 1.0, nonce)
    with pytest.raises(LookupError):
        respawn.begin_restoring("ok", 2.0, nonce)      # right name, other incarnation
    with pytest.raises(LookupError):
        respawn.bind_restoring("ghost", 1.0, nonce, 3.0)
    with pytest.raises(LookupError):
        respawn.drop_lost(["ghost"], required=True)
    respawn.drop_lost(["ghost"])                         # ignoring an unknown offer stays silent
    assert respawn.lost_entry("ok") is not None
    respawn.begin_restoring("ok", 1.0, nonce)
    assert respawn.lost_entry("ok")["restoring"] == {"nonce": nonce}


def test_a_huge_integer_is_not_a_number(snapshot_file, tmp_path):
    assert not respawn._number(10 ** 400)
    write(snapshot_file, [good(tmp_path, created=10 ** 400)])
    assert respawn.lost_entry("ok") is None
    with pytest.raises(ValueError):
        respawn.parse_expected({"name": "ok", "created": 10 ** 400, "agent_kind": None, "resume_id": None,
                                "cwd": str(tmp_path)})
