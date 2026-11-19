# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The codex rollout fallback only answers when it is unambiguous (R33)."""

import json
import os
import time

import pytest

import discover
import respawn
import resumeargs
import server
from respawn_helpers import mesh_item, snapshot_file  # noqa: F401  (a fixture)


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


def _host(monkeypatch, codex, cwds, held, listing_fails=False):
    """A fake process table: pids in ``codex`` are codex agents, ``cwds`` their folders, ``held`` the rollouts
    each holds open (None: unreadable)."""
    def snapshot():
        if listing_fails:
            raise PermissionError("/proc")
        return {pid: ("codex", 0, 1) for pid in codex}
    monkeypatch.setattr(discover, "snapshot", snapshot)
    monkeypatch.setattr(discover, "read_stat", lambda pid: None)
    monkeypatch.setattr(discover, "cwd", lambda pid: cwds[pid])
    monkeypatch.setattr(discover, "proc_start", lambda pid: time.time() - 100)
    monkeypatch.setattr(discover, "_open_rollouts", lambda pid: held[pid])


def _rollouts(tmp_path, monkeypatch, **ids):
    paths = {}
    for name, sid in ids.items():
        paths[name] = tmp_path / f"rollout-{name}.jsonl"
        _rollout(paths[name], "/w", sid)
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(p) for p in paths.values()])
    return paths


def test_one_candidate_is_used_only_by_the_one_codex_of_the_folder(tmp_path, monkeypatch):
    """A single candidate is accepted only when exactly one codex runs in the folder (B2: the count was
    skipped, so an idle resumed codex A took the rollout of a codex B started later in the same folder)."""
    _rollouts(tmp_path, monkeypatch, a="A")
    _host(monkeypatch, [100], {100: "/w"}, {100: []})
    assert discover.codex_info(100).get("session_id") == "A"


def test_b2_idle_resumed_codex_does_not_take_a_later_codexs_rollout(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, b="B")        # only B has written since A started
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/w"}, {100: [], 200: [str(tmp_path / "rollout-b.jsonl")]})
    assert discover.codex_info(100).get("session_id") is None      # A
    assert discover.codex_info(200)["session_id"] == "B"           # B: exact, holds it open
    assert discover.codex_info(200)["identity_source"] == "open_rollout"


def test_a_rollout_held_by_a_codex_elsewhere_is_not_taken(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, b="B")
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/other"}, {100: [], 200: [str(tmp_path / "rollout-b.jsonl")]})
    assert discover.codex_info(100).get("session_id") is None


def test_an_unreadable_neighbour_fails_closed(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, a="A")
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/other"}, {100: [], 200: None})
    monkeypatch.setattr(discover, "_fds_gone", lambda pid: False)       # it exists, its files are unreadable
    monkeypatch.setattr(discover, "_same_user", lambda pid: True)       # and it is this user's
    assert discover.codex_info(100).get("session_id") is None


def test_a_neighbour_that_exited_while_listed_holds_nothing(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, a="A")
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/other"}, {100: [], 200: None})
    monkeypatch.setattr(discover, "_fds_gone", lambda pid: True)
    assert discover.codex_info(100).get("session_id") == "A"


def test_an_unreadable_codex_of_another_user_is_skipped(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, a="A")
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/other"}, {100: [], 200: None})
    monkeypatch.setattr(discover, "_fds_gone", lambda pid: False)
    monkeypatch.setattr(discover, "_same_user", lambda pid: False)
    assert discover.codex_info(100).get("session_id") == "A"


def test_a_codex_helper_of_another_codex_is_not_counted(tmp_path, monkeypatch):
    _host(monkeypatch, [100, 101], {100: "/w", 101: "/w"}, {100: [], 101: []})
    monkeypatch.setattr(discover, "snapshot", lambda: {100: ("codex", 0, 1), 101: ("codex", 0, 100)})
    monkeypatch.setattr(discover, "read_stat", lambda pid: ("codex", 0, 1) if pid == 100 else None)
    assert discover._codex_count("/w") == 1


def test_a_listing_scans_the_codex_processes_once(tmp_path, monkeypatch):
    paths = [tmp_path / f"rollout-{n}.jsonl" for n in "abc"]
    for path, folder, sid in zip(paths, ("/w", "/x", "/y"), "ABC"):
        _rollout(path, folder, sid)
    monkeypatch.setattr(discover, "recent_rollouts", lambda days=30: [str(p) for p in paths])
    _host(monkeypatch, [100, 200, 300], {100: "/w", 200: "/x", 300: "/y"}, {100: [], 200: [], 300: []})
    scans, reads = [], []
    real_snapshot, real_open = discover.snapshot, discover._open_rollouts
    monkeypatch.setattr(discover, "snapshot", lambda: scans.append(1) or real_snapshot())
    monkeypatch.setattr(discover, "_open_rollouts", lambda pid: reads.append(pid) or real_open(pid))
    with discover.listing_scope():
        results = [discover.codex_info(pid).get("session_id") for pid in (100, 200, 300)]
    assert results == ["A", "B", "C"]
    assert len(scans) == 1 and sorted(reads) == [100, 100, 200, 200, 300, 300]   # own check, and neighbours once
    assert discover._codex_view() is not discover._codex_view()           # nothing outlives the listing


def test_an_unreadable_process_table_fails_closed(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, a="A")
    _host(monkeypatch, [100], {100: "/w"}, {100: []}, listing_fails=True)
    assert discover._codex_count("/w") == 2
    assert discover.codex_info(100).get("session_id") is None


def test_an_exact_open_rollout_is_never_degraded(tmp_path, monkeypatch):
    paths = _rollouts(tmp_path, monkeypatch, a="A", b="B")
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/w"}, {100: [str(paths["a"])], 200: []})
    info = discover.codex_info(100)
    assert (info["session_id"], info["identity_source"]) == ("A", "open_rollout")


def _described(source, sid):
    return {"agent": {"type": "codex", "session_id": sid, "identity_source": source}}


def test_a_guess_duplicating_an_exact_id_is_dropped(tmp_path):
    guessed, exact = _described("cwd_unique", "X"), _described("open_rollout", "X")
    discover.drop_duplicate_guessed_ids([guessed, exact])
    assert guessed["agent"]["session_id"] is None and guessed["agent"]["identity_source"] is None
    assert exact["agent"] == {"type": "codex", "session_id": "X", "identity_source": "open_rollout"}


def test_two_guesses_of_one_id_are_both_dropped_and_distinct_ones_kept():
    one, two, other = (_described("cwd_unique", "X"), _described("unique_pi_transcript", "X"),
                       _described("cwd_unique", "Y"))
    discover.drop_duplicate_guessed_ids([one, two, other, {"agent": None}])
    assert one["agent"]["session_id"] is None and two["agent"]["session_id"] is None
    assert other["agent"]["session_id"] == "Y"


def test_many_guesses_of_one_id_are_all_dropped_in_one_pass():
    guesses = [_described("cwd_unique", "X") for _ in range(2000)] + [_described("cwd_unique", "Y")]
    discover.drop_duplicate_guessed_ids(guesses)
    assert all(g["agent"]["session_id"] is None for g in guesses[:-1])
    assert guesses[-1]["agent"]["session_id"] == "Y"


# ---------------------------------------------------------------- the conversation named by `codex resume <id>`

ID = "019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b"
ID2 = "019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a2c"
CODEX_JS = "/usr/lib/node_modules/@openai/codex/bin/codex.js"
MESH_TAIL = ["--no-alt-screen", "-c", "tui.raw_output_mode=false", "-c", "mcp_servers.mesh-board.args=[]"]


@pytest.mark.parametrize("argv", [
    ["codex", "resume", ID],
    ["codex", "resume", ID, *MESH_TAIL],                                         # what the mesh launches
    ["/usr/local/bin/codex", "resume", ID, "--yolo", *MESH_TAIL],
    ["node", CODEX_JS, "resume", ID, "--yolo"],                                  # the npm launcher
    ["npx", "-y", "@openai/codex", "resume", ID],
    ["codex", "--cd", "/w", "-c", "model=o3", "-mgpt", "--config=x=1",
     "--dangerously-bypass-approvals-and-sandbox", "resume", ID, "--last"],     # options before, anything after
])
def test_the_id_after_resume_is_read(argv):
    assert resumeargs.resumed_codex_id(argv) == ID


@pytest.mark.parametrize("argv", [
    ["codex"], ["codex", "--yolo"], ["codex", "resume"],
    ["codex", "resume", "--last"], ["codex", "resume", "--all"], ["codex", "resume", "--yolo", ID],
    ["codex", "resume", ID.upper()], ["codex", "resume", ID[:-1]], ["codex", "resume", f"{ID}x"],
    ["codex", "resume", "-" + ID[1:]],
    ["codex", "-c", "resume", ID],                    # "resume" is the value of -c, ID a prompt
    ["codex", "--unknown-option", "resume", ID],      # its arity cannot be read
    ["codex", "exec", "resume", ID], ["codex", "fix it", "resume", ID], ["codex", "--", "resume", ID],
    ["/bin/sh", "-c", f"codex resume {ID}"], ["node", "/tmp/codex.js", "resume", ID], [],
])
def test_no_id_is_read_from_other_shapes(argv):
    assert resumeargs.resumed_codex_id(argv) is None


def _launched(monkeypatch, argvs):
    """The launch arguments of the fake host's processes (pid -> words)."""
    monkeypatch.setattr(discover, "cmdline", lambda pid: [w.encode() for w in argvs.get(pid, [])])


def test_an_idle_codex_launched_on_a_conversation_gets_it(tmp_path, monkeypatch):
    """The common case: a resumed codex that holds no rollout open had no id (restored as a shell)."""
    _rollouts(tmp_path, monkeypatch)                 # no rollout written since it started
    _host(monkeypatch, [100], {100: "/w"}, {100: []})
    _launched(monkeypatch, {100: ["codex", "resume", ID, *MESH_TAIL]})
    info = discover.codex_info(100)
    assert (info["session_id"], info["identity_source"]) == (ID, "argv_resume")


def test_the_rollout_of_the_named_conversation_describes_it(tmp_path, monkeypatch):
    paths = _rollouts(tmp_path, monkeypatch, a=ID, b=ID2)
    _host(monkeypatch, [100], {100: "/w"}, {100: []})
    _launched(monkeypatch, {100: ["codex", "resume", ID]})
    os.utime(paths["a"], (time.time() - 50, time.time() - 50))      # the other one is newer: not taken
    info = discover.codex_info(100)
    assert (info["session_id"], info["identity_source"], info["status"]) == (ID, "argv_resume", "idle")


def test_an_open_rollout_that_agrees_stays_open_rollout(tmp_path, monkeypatch):
    paths = _rollouts(tmp_path, monkeypatch, a=ID)
    _host(monkeypatch, [100], {100: "/w"}, {100: [str(paths["a"])]})
    _launched(monkeypatch, {100: ["codex", "resume", ID]})
    info = discover.codex_info(100)
    assert (info["session_id"], info["identity_source"]) == (ID, "open_rollout")


def test_an_open_rollout_that_disagrees_wins_and_is_noted_once(tmp_path, monkeypatch, capsys):
    """After /new inside codex the open rollout is the conversation; the argument names the old one."""
    paths = _rollouts(tmp_path, monkeypatch, b=ID2)
    _host(monkeypatch, [100], {100: "/w"}, {100: [str(paths["b"])]})
    _launched(monkeypatch, {100: ["codex", "resume", ID]})
    monkeypatch.setattr(discover, "_argv_conflicts_noted", set())
    first, second = discover.codex_info(100), discover.codex_info(100)
    assert (first["session_id"], first["identity_source"]) == (ID2, "open_rollout") and first == second
    noted = capsys.readouterr().out
    assert noted.count("the open rollout is used") == 1 and ID not in noted and ID2 not in noted


def test_two_codex_launched_on_one_conversation_are_both_contested(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch, a=ID)
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/other"}, {100: [], 200: []})
    _launched(monkeypatch, {100: ["codex", "resume", ID], 200: ["node", CODEX_JS, "resume", ID]})
    with discover.listing_scope():
        found = [discover.codex_info(pid).get("session_id") for pid in (100, 200)]
    assert found == [None, None]       # no folder guess either: the rollout of ID is in /w, where 100 runs


def test_of_two_codex_on_one_conversation_the_one_holding_it_open_keeps_it(tmp_path, monkeypatch):
    paths = _rollouts(tmp_path, monkeypatch, a=ID)
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/w"}, {100: [], 200: [str(paths["a"])]})
    _launched(monkeypatch, {100: ["codex", "resume", ID], 200: ["codex", "resume", ID]})
    assert discover.codex_info(100).get("session_id") is None
    assert (discover.codex_info(200)["session_id"], discover.codex_info(200)["identity_source"]) == (ID, "open_rollout")


def test_a_conversation_another_codex_holds_open_is_not_claimed_by_argument(tmp_path, monkeypatch):
    paths = _rollouts(tmp_path, monkeypatch, a=ID)
    _host(monkeypatch, [100, 200], {100: "/w", 200: "/other"}, {100: [], 200: [str(paths["a"])]})
    _launched(monkeypatch, {100: ["codex", "resume", ID], 200: ["codex"]})
    assert discover.codex_info(100).get("session_id") is None


def test_a_codex_helper_with_the_same_arguments_is_not_a_second_claim(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch)
    _host(monkeypatch, [100, 101], {100: "/w", 101: "/w"}, {100: [], 101: []})
    monkeypatch.setattr(discover, "snapshot", lambda: {100: ("codex", 0, 1), 101: ("codex", 0, 100)})
    monkeypatch.setattr(discover, "read_stat", lambda pid: ("codex", 0, 1) if pid == 100 else None)
    _launched(monkeypatch, {100: ["codex", "resume", ID], 101: ["codex", "resume", ID]})
    assert discover.codex_info(100)["session_id"] == ID


def test_an_unreadable_process_table_names_no_conversation_by_argument(tmp_path, monkeypatch):
    _rollouts(tmp_path, monkeypatch)
    _host(monkeypatch, [100], {100: "/w"}, {100: []}, listing_fails=True)
    _launched(monkeypatch, {100: ["codex", "resume", ID]})
    assert discover.codex_info(100).get("session_id") is None


def test_an_argument_id_is_exact_against_a_guess_of_another_session():
    guessed, named = _described("cwd_unique", ID), _described("argv_resume", ID)
    discover.drop_duplicate_guessed_ids([guessed, named])
    assert guessed["agent"]["session_id"] is None and named["agent"]["session_id"] == ID


def test_the_named_conversation_survives_a_host_restart(tmp_path, monkeypatch, snapshot_file):
    """Observed while the codex runs, stored in the snapshot, resumed after the host and its process are gone."""
    _rollouts(tmp_path, monkeypatch)
    _host(monkeypatch, [100], {100: str(tmp_path)}, {100: []})
    argv = ["codex", "resume", ID, "--yolo", *MESH_TAIL]
    _launched(monkeypatch, {100: argv})
    agent = {**discover.codex_info(100), "pid": 100, "argv": argv}
    respawn.update([mesh_item("c", tmp_path, 7.0, agent)], listed=True, host="host-1")
    stored = json.loads(snapshot_file.read_text())["live"][0]["agent"]
    assert (stored["session_id"], stored["identity_source"]) == (ID, "argv")
    offer = respawn.update([], listed=True, host="host-2")      # a new host: the session is lost
    assert offer[0]["resumable"] is True
    lost = json.loads(snapshot_file.read_text())["lost"][0]["agent"]
    assert server._resume_argv(lost)[:4] == ["codex", "resume", ID, "--yolo"]
