# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""respawn.update: what the snapshot stores, when it is written, and what it offers (RS-1, RS-2)."""

import json
import os
import stat

import respawn
from respawn_helpers import SID, SID2, claude, codex, mesh_item, snapshot_file  # noqa: F401
from ptyhost_proc import daemon  # noqa: F401  (a fixture)


def names(offer):
    return [e["name"] for e in offer]


def test_an_entry_keeps_name_cwd_created_agent_and_argv(snapshot_file, tmp_path):
    mesh = [mesh_item("a", tmp_path, 12.5, claude(argv=["claude", "--model", "opus", "fix it"]), cmd="claude fix it"),
            mesh_item("b", tmp_path, 13.5, None, cmd="vim notes.md")]
    respawn.update(mesh, listed=True)
    saved = json.loads(snapshot_file.read_text())
    assert saved["version"] == 1 and saved["lost"] == []
    assert saved["live"][0] == {"name": "a", "cwd": str(tmp_path), "created": 12.5,
                                "agent": {"type": "claude", "session_id": SID,
                                          "argv": ["claude", "--model", "opus", "fix it"]},
                                "cmd": None, "lost_at": None,
                                "org": {"label": None, "folder": None, "rank": None}}
    assert saved["live"][1]["agent"] is None and saved["live"][1]["cmd"] == "vim notes.md"


def test_the_file_is_private_and_leaves_no_temporary_file(snapshot_file, tmp_path):
    for n in range(5):
        respawn.update([mesh_item("a", tmp_path, 1.0, claude(sid=f"{n}abcdefgh"))], listed=True)
    assert stat.S_IMODE(os.stat(snapshot_file).st_mode) == 0o600
    registry = {respawn.IDENTITY_NAME, f"{respawn.IDENTITY_NAME}.lock"}     # the identity registry, its lock
    assert sorted(p.name for p in snapshot_file.parent.iterdir() if p.name not in registry) == [snapshot_file.name]
    assert json.loads(snapshot_file.read_text())["live"][0]["agent"]["session_id"] == "4abcdefgh"


def test_an_unchanged_mesh_does_not_rewrite_the_file(snapshot_file, tmp_path):
    mesh = [mesh_item("a", tmp_path)]
    respawn.update(mesh, listed=True)
    before = (os.stat(snapshot_file).st_mtime_ns, os.stat(snapshot_file).st_ino)
    respawn.update(mesh, listed=True)
    assert (os.stat(snapshot_file).st_mtime_ns, os.stat(snapshot_file).st_ino) == before


def test_a_shell_prompt_is_not_a_running_program(snapshot_file, tmp_path):
    for shell in ("-bash", "/bin/zsh", "sh", "-fish"):
        assert respawn.entry_of(mesh_item("a", tmp_path, cmd=shell))["cmd"] is None


def test_nothing_is_offered_while_the_mesh_is_complete(snapshot_file, tmp_path):
    assert respawn.update([mesh_item("a", tmp_path)], listed=True) == []


def test_an_empty_mesh_keeps_every_previous_session_as_restorable(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0, claude()), mesh_item("b", tmp_path, 2.0)], listed=True)
    offer = respawn.update([], listed=True)
    assert sorted(names(offer)) == ["a", "b"]
    again = respawn.update([], listed=True)                # and it stays, poll after poll
    assert sorted(names(again)) == ["a", "b"]
    assert sorted(e["name"] for e in json.loads(snapshot_file.read_text())["lost"]) == ["a", "b"]


def test_a_new_session_after_the_restart_does_not_erase_the_offer(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0), mesh_item("b", tmp_path, 2.0)], listed=True)
    offer = respawn.update([mesh_item("c", tmp_path, 50.0)], listed=True)
    assert sorted(names(offer)) == ["a", "b"]
    assert [e["name"] for e in json.loads(snapshot_file.read_text())["live"]] == ["c"]


def test_a_taken_name_is_still_offered(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True)
    offer = respawn.update([mesh_item("a", tmp_path, 99.0)], listed=True)   # another session, same name
    assert names(offer) == ["a"]


def test_conditional_forget_preserves_a_replacement_with_the_same_name(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 2.0)], listed=True)
    respawn.forget_live("a", 1.0)
    assert json.loads(snapshot_file.read_text())["live"][0]["created"] == 2.0
    respawn.forget_live("a", 2.0)
    assert json.loads(snapshot_file.read_text())["live"] == []


def test_a_session_that_ended_while_others_live_is_not_offered(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0), mesh_item("b", tmp_path, 2.0)], listed=True)
    assert respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True) == []
    assert names(respawn.update([], listed=True)) == ["a"]


def test_while_ptyhost_does_not_answer_nothing_is_written_or_offered(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path)], listed=True)
    before = snapshot_file.read_text()
    assert respawn.update([], listed=False) == []
    assert snapshot_file.read_text() == before


def test_a_changed_conversation_id_is_saved(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0, claude(sid=SID))], listed=True)
    respawn.update([mesh_item("a", tmp_path, 1.0, claude(sid=SID2))], listed=True)
    assert json.loads(snapshot_file.read_text())["live"][0]["agent"]["session_id"] == SID2


def test_lost_sessions_expire_after_fourteen_days(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True, now=1_000_000)
    assert names(respawn.update([], listed=True, now=1_000_100)) == ["a"]
    assert names(respawn.update([], listed=True, now=1_000_100 + 13 * 86400)) == ["a"]
    assert respawn.update([], listed=True, now=1_000_100 + 15 * 86400) == []


def test_the_lost_list_is_capped(snapshot_file, tmp_path):
    big = [mesh_item(f"s{n}", tmp_path, float(n)) for n in range(respawn.MAX_ENTRIES + 20)]
    respawn.update(big, listed=True)
    assert len(respawn.update([], listed=True)) == respawn.MAX_ENTRIES


def test_forget_live_drops_a_killed_session_before_it_can_be_offered(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True)
    respawn.forget_live("a")
    assert respawn.update([], listed=True) == []


def test_drop_lost_removes_exactly_the_named_entries(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0), mesh_item("b", tmp_path, 2.0)], listed=True)
    respawn.update([], listed=True)
    respawn.drop_lost(["a"])
    assert names(respawn.update([], listed=True)) == ["b"]


def test_what_is_offered_carries_no_argv(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0, codex(argv=["codex", "--yolo", "--api-key", "sekret"]))],
                   listed=True)
    [offer] = respawn.update([], listed=True)
    assert offer == {"name": "a", "cwd": str(tmp_path), "created": 1.0, "agent": "codex",
                     "resumable": True, "running": None}
    assert "sekret" not in json.dumps(offer)


def test_an_agent_without_a_conversation_id_is_not_resumable(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0, claude(sid=None))], listed=True)
    [offer] = respawn.update([], listed=True)
    assert (offer["agent"], offer["resumable"]) == ("claude", False)


def test_a_listed_session_whose_directory_cannot_be_read_is_not_taken_for_a_lost_one(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0, claude())], listed=True)
    unreadable = {**mesh_item("a", tmp_path, 1.0, claude()), "cwd": None}       # /proc raced with the process
    assert respawn.update([unreadable], listed=True) == []
    assert json.loads(snapshot_file.read_text())["live"][0]["agent"]["session_id"] == SID   # entry kept
    assert respawn.update([mesh_item("a", tmp_path, 1.0, claude())], listed=True) == []


def test_an_unwritable_snapshot_does_not_break_the_listing(snapshot_file, tmp_path, monkeypatch):
    def refuse(*args, **kwargs):
        raise PermissionError("read-only config dir")
    monkeypatch.setattr(respawn.fsutil, "atomic_write", refuse)
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True)
    assert respawn.update([mesh_item("b", tmp_path, 2.0)], listed=True) == []


def test_exit_in_the_only_session_is_not_a_restart(snapshot_file, tmp_path):
    """Typing `exit` in the only session left no survivor, which was taken for a ptyhost
    restart: the page offered "Restore 1 session". The host's identity tells them apart."""
    respawn.update([mesh_item("a", tmp_path, 1.0, claude())], listed=True, host="100:5")
    assert respawn.update([], listed=True, host="100:5") == []
    assert json.loads(snapshot_file.read_text())["lost"] == []
    respawn.update([mesh_item("b", tmp_path, 2.0)], listed=True, host="100:5")
    assert names(respawn.update([], listed=True, host="200:7")) == ["b"]   # a new host: restarted
    assert json.loads(snapshot_file.read_text())["host"] == "200:7"


def test_a_restart_with_a_new_session_already_listed_still_offers_the_old_ones(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True, host="100:5")
    assert names(respawn.update([mesh_item("n", tmp_path, 9.0)], listed=True, host="200:7")) == ["a"]


def test_a_restart_and_reused_pid_is_still_a_new_host(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True, host="100:5")
    assert names(respawn.update([], listed=True, host="100:6")) == ["a"]


def test_an_unknown_identity_keeps_the_survivor_rule(snapshot_file, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True, host="100:5")
    assert names(respawn.update([], listed=True, host=None)) == ["a"]
    respawn.drop_lost(["a"])
    assert json.loads(snapshot_file.read_text())["host"] == "100:5"   # kept by the other writers


async def test_host_identity_names_the_listening_process(daemon):  # noqa: F811
    import ptyhost
    identity = await ptyhost.host_identity()
    assert identity is not None and identity.startswith(f"{daemon.pid}:")
    assert respawn.HOST_RE.fullmatch(identity)
    assert await ptyhost.host_identity() == identity
