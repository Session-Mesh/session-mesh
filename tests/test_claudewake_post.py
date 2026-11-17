# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Posting the wake line: one line per batch, its confirmation, restarts and stale sockets.

The helpers and the launch cases are in test_claudewake.py; a lost or damaged
state file is in test_claudewake_state.py."""

import asyncio
import json
import os
import shutil
import socket

import pytest

import claudewake
from session_helpers import NONCE
from test_claudewake import OTHER, Clock, Listener, bind, request, wake_dir, wake_of  # noqa: F401  (wake_dir is a fixture)




async def test_one_line_then_the_look_at_the_inbox_confirms_it(wake_dir):
    clock = Clock()
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    path = claudewake.socket_path(wake_dir, NONCE)
    async with Listener(path) as listener:
        assert poster.target(NONCE) == str(path)
        wake = wake_of(poster)
        waiting = {"ok": False, "reason": "not_confirmed"}
        assert await poster.post(request(count=3), wake) == waiting
        for _ in range(3):                     # the dispatcher asks again each second
            clock.now += 1
            assert await poster.post(request(count=3), wake) == waiting
        poster.note_inbox_read("beta", 2.0)
        assert await poster.post(request(count=3), wake) == {"ok": True, "accepted": True}
        assert await poster.post(request(count=3), wake) == {"ok": True, "accepted": True}
        assert await listener.settle(1) == [claudewake.wake_line(3)]


async def test_a_look_at_the_inbox_before_the_line_does_not_confirm_it(wake_dir):
    clock = Clock()
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    poster.note_inbox_read("beta", 2.0)
    clock.now += 1
    async with Listener(claudewake.socket_path(wake_dir, NONCE)):
        assert (await poster.post(request(), wake_of(poster)))["reason"] == "not_confirmed"
        poster.note_inbox_read("beta", 3.0)     # another incarnation does not confirm it either
        assert (await poster.post(request(), wake_of(poster)))["reason"] == "not_confirmed"


async def test_a_line_nobody_follows_becomes_unconfirmed_never_typed_never_a_second_line(wake_dir):
    clock = Clock()
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    unconfirmed = {"ok": False, "reason": "unconfirmed"}
    async with Listener(claudewake.socket_path(wake_dir, NONCE)) as listener:
        assert (await poster.post(request(), wake_of(poster)))["reason"] == "not_confirmed"
        assert poster.unconfirmed() == set()
        clock.now += 19.9
        assert (await poster.post(request(), wake_of(poster)))["reason"] == "not_confirmed"
        clock.now += 0.2
        # The window is over: a running turn defers the judgement, an idle one ends it.
        assert await poster.post(request(), wake_of(poster, "working")) == {"ok": False, "reason": "not_idle"}
        assert await poster.post(request(), wake_of(poster)) == unconfirmed
        assert poster.unconfirmed() == {("beta", 2.0)}
        # Never None again for this batch (None lets the caller type), not even without a socket.
        assert await poster.post(request(), wake_of(poster)) == unconfirmed
        assert await poster.post(request(), None) == unconfirmed
        assert poster.has_line(request()) and not poster.has_line(request("b" * 32))
        poster.note_inbox_read("beta", 2.0)       # the agent looks at last: no typed notice is needed
        assert await poster.post(request(), wake_of(poster)) == {"ok": True, "accepted": True}
        assert poster.unconfirmed() == set()
        assert await listener.settle(1) == [claudewake.wake_line(2)]


async def test_a_restart_of_the_server_neither_repeats_the_line_nor_forgets_it(wake_dir):
    clock = Clock()
    path = claudewake.socket_path(wake_dir, NONCE)
    async with Listener(path) as listener:
        first = claudewake.Poster(wake_dir, 20.0, clock)
        assert (await first.post(request(), wake_of(first)))["reason"] == "not_confirmed"
        second = claudewake.Poster(wake_dir, 20.0, clock)        # the server restarted meanwhile
        assert (await second.post(request(), wake_of(second)))["reason"] == "not_confirmed"
        clock.now += 21
        third = claudewake.Poster(wake_dir, 20.0, clock)
        assert (await third.post(request(), wake_of(third)))["reason"] == "unconfirmed"
        fourth = claudewake.Poster(wake_dir, 20.0, clock)        # and again, after it was judged
        assert fourth.unconfirmed() == {("beta", 2.0)}
        assert (await fourth.post(request(), wake_of(fourth)))["reason"] == "unconfirmed"
        fourth.note_inbox_read("beta", 2.0)
        assert claudewake.Poster(wake_dir, 20.0, clock).unconfirmed() == set()
        assert await listener.settle(1) == [claudewake.wake_line(2)]    # one line in all


async def test_the_remembered_lines_are_private_bounded_and_not_trusted_blindly(wake_dir):
    poster = claudewake.Poster(wake_dir, 20.0, Clock())
    async with Listener(claudewake.socket_path(wake_dir, NONCE)):
        await poster.post(request(), wake_of(poster))
    remembered = wake_dir / claudewake.STATE_FILE
    assert oct(remembered.stat().st_mode & 0o777) == "0o600"
    poster.retain([("other", 9.0)])                                # the incarnation is gone
    assert not poster.has_line(request()) and claudewake.Poster(wake_dir).unconfirmed() == set()
    for doubtful in ("not json", "[]", json.dumps({"lines": [{"name": "beta"}]}),
                     json.dumps({"lines": [{"name": "beta", "created": 2.0, "id": "a" * 32,
                                            "at": 1.0, "state": "delivered"}]})):
        remembered.write_text(doubtful)
        assert claudewake.Poster(wake_dir)._lines == {}


async def test_the_line_is_recorded_durably_before_it_is_sent(wake_dir, monkeypatch):
    poster = claudewake.Poster(wake_dir, 20.0, Clock())
    recorded = []

    async def send(path, line):
        recorded.append(json.loads((wake_dir / claudewake.STATE_FILE).read_text())["lines"])
        return True
    monkeypatch.setattr(claudewake.Poster, "_send", staticmethod(send))
    async with Listener(claudewake.socket_path(wake_dir, NONCE)):
        await poster.post(request(), wake_of(poster))
    assert [[item["id"] for item in lines] for lines in recorded] == [["a" * 32]]


async def test_a_refused_connection_leaves_no_record_but_a_failed_write_keeps_it(wake_dir, monkeypatch):
    poster = claudewake.Poster(wake_dir, 20.0, Clock())
    path = claudewake.socket_path(wake_dir, NONCE)
    stale = socket.socket(socket.AF_UNIX)
    stale.bind(str(path))
    stale.close()                           # nobody listens: no line can have been written
    assert await poster.post(request(), wake_of(poster)) is None
    assert json.loads((wake_dir / claudewake.STATE_FILE).read_text())["lines"] == []
    assert not poster.holds(request())

    async def broken_write(path, line):
        return True                         # the connection was made, the write then failed
    monkeypatch.setattr(claudewake.Poster, "_send", staticmethod(broken_write))
    assert (await poster.post(request(), wake_of(poster)))["reason"] == "not_confirmed"
    assert poster.holds(request())


async def test_a_record_that_cannot_be_made_durable_sends_no_line(wake_dir, monkeypatch):
    poster = claudewake.Poster(wake_dir, 20.0, Clock())
    monkeypatch.setattr(claudewake.Poster, "_save", lambda self: False)
    async with Listener(claudewake.socket_path(wake_dir, NONCE)) as listener:
        assert await poster.post(request(), wake_of(poster)) is None
        assert await listener.settle(0) == []
    assert not poster.holds(request())


async def test_an_invalid_entry_is_dropped_alone_and_the_valid_ones_survive(wake_dir):
    valid = {"name": "beta", "created": 2.0, "id": "a" * 32, "at": 1.0, "state": "unconfirmed"}
    bad = [{"name": "x", "created": 2.0, "id": "y", "at": 1.0, "state": ["unhashable"]}, "text",
           {"name": "beta"}, {**valid, "name": "gamma", "state": "delivered"}]
    (wake_dir / claudewake.STATE_FILE).write_text(json.dumps({"version": 1, "lines": [*bad, valid]}))
    poster = claudewake.Poster(wake_dir, 20.0, Clock())
    assert poster.unconfirmed() == {("beta", 2.0)}
    assert poster.has_line(request())


@pytest.mark.parametrize("damage", ["lost", "corrupt", "invalid_entry"])
@pytest.mark.parametrize("socket_gone", [True, False])
async def test_a_lost_or_damaged_state_never_lets_a_typed_notice_or_a_new_line_through(
        wake_dir, damage, socket_gone):
    clock = Clock()
    path = claudewake.socket_path(wake_dir, NONCE)
    state = wake_dir / claudewake.STATE_FILE
    async with Listener(path) as listener:
        first = claudewake.Poster(wake_dir, 20.0, clock)
        assert (await first.post(request(), wake_of(first)))["reason"] == "not_confirmed"
        if damage == "lost":
            state.unlink()
        elif damage == "corrupt":
            state.write_text("{not json")
        elif damage == "invalid_entry":
            data = json.loads(state.read_text())
            data["lines"].append({"name": "x", "created": 2.0, "id": "y", "at": 1.0, "state": ["bad"]})
            state.write_text(json.dumps(data))
        restarted = claudewake.Poster(wake_dir, 20.0, clock)
        clock.now += 21
        target = None if socket_gone else restarted.target(NONCE)
        wake = None if target is None else {"path": target, "turn": "done"}
        for notification in ("a" * 32, "b" * 32):        # the batch written, then a new one
            batch = request(notification)
            assert restarted.holds(batch)
            result = await restarted.post(batch, wake)
            assert result == {"ok": False, "reason": "unconfirmed"}
        assert restarted.unconfirmed() == {("beta", 2.0)}
        assert await listener.settle(1) == [claudewake.wake_line(2)]    # the one line, never a second
        # An incarnation launched after the damage is not in doubt.
        assert not restarted.holds(request(created=clock.now + 1))
        # The doubt lasts until the session restarts: a read of the inbox does not lift it,
        # the next batch stays unconfirmed and no line is written for it.
        restarted.note_inbox_read("beta", 2.0)
        assert restarted.unconfirmed() == {("beta", 2.0)}
        later = request("c" * 32)
        assert restarted.holds(later)
        assert await restarted.post(later, wake) == {"ok": False, "reason": "unconfirmed"}
        assert restarted.unconfirmed() == {("beta", 2.0)}
        assert await listener.settle(1) == [claudewake.wake_line(2)]


async def test_the_doubt_ends_with_the_incarnations_it_covers(wake_dir):
    clock = Clock()
    (wake_dir / claudewake.STATE_FILE).unlink()
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    assert poster.holds(request(created=2.0))
    poster.retain([("beta", 2.0)])
    assert poster.holds(request(created=2.0))
    poster.retain([("gamma", clock.now + 5)])            # every older incarnation is gone
    assert not poster.holds(request(created=2.0))
    assert json.loads((wake_dir / claudewake.STATE_FILE).read_text()).get("doubt_before") is None
    assert not claudewake.Poster(wake_dir, 20.0, clock).holds(request(created=2.0))


async def test_a_new_batch_is_never_absorbed_it_gets_its_own_line(wake_dir):
    poster = claudewake.Poster(wake_dir, 20.0, Clock())
    async with Listener(claudewake.socket_path(wake_dir, NONCE)) as listener:
        await poster.post(request("a" * 32, 1), wake_of(poster))
        await poster.post(request("b" * 32, 4), wake_of(poster))
        assert await listener.settle(2) == [claudewake.wake_line(1), claudewake.wake_line(4)]


async def test_no_line_while_a_turn_runs(wake_dir):
    poster = claudewake.Poster(wake_dir)
    async with Listener(claudewake.socket_path(wake_dir, NONCE)) as listener:
        for turn in ("working", "waiting_permission", "waiting_question"):
            assert await poster.post(request(), wake_of(poster, turn)) == {"ok": False, "reason": "not_idle"}
        assert await listener.settle(0) == []


async def test_missing_or_refusing_socket_falls_back(wake_dir):
    poster = claudewake.Poster(wake_dir)
    path = claudewake.socket_path(wake_dir, NONCE)
    assert poster.target(NONCE) is None
    assert await poster.post(request(), {"path": str(path), "turn": "done"}) is None
    stale = socket.socket(socket.AF_UNIX)
    stale.bind(str(path))     # a socket file nobody listens on: connection refused
    stale.close()
    assert poster.target(NONCE) == str(path)
    assert await poster.post(request(), {"path": str(path), "turn": "done"}) is None


async def test_only_sockets_of_the_private_directory(wake_dir, short_root):
    poster = claudewake.Poster(wake_dir)
    path = claudewake.socket_path(wake_dir, NONCE)
    outside = short_root / path.name
    async with Listener(outside) as listener:
        wake = {"path": str(outside), "turn": "done"}
        assert await poster.post(request(), wake) is None
        os.symlink(outside, path)          # a link inside the directory is not a socket
        assert poster.target(NONCE) is None
        assert await poster.post(request(), {**wake, "path": str(path)}) is None
        assert await listener.settle(0) == []
    os.unlink(path)
    regular = wake_dir / path.name
    regular.write_text("")
    assert poster.target(NONCE) is None
    regular.unlink()
    async with Listener(path) as listener:
        wake_dir.chmod(0o755)              # a directory others may enter is not trusted
        assert poster.target(NONCE) is None
        assert await poster.post(request(), {"path": str(path), "turn": "done"}) is None
        wake_dir.chmod(0o700)
        assert await listener.settle(0) == []


# ------------------------------------------------------------- stale sockets


def test_sweep_removes_only_old_sockets_that_no_live_incarnation_owns(wake_dir, short_root):
    clock = Clock()
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    mine = claudewake.socket_path(wake_dir, NONCE)
    dead = claudewake.socket_path(wake_dir, OTHER)
    young = claudewake.socket_path(wake_dir, "00" * 16)
    for path, age in ((mine, 3600), (dead, 3600), (young, 5)):
        bind(path, age)
    (wake_dir / "notes.txt").write_text("x")
    (wake_dir / ("0" * 20 + ".sock")).write_text("a regular file under a socket's name")
    outside = short_root / "outside.sock"
    bind(outside)
    os.symlink(outside, wake_dir / ("1" * 20 + ".sock"))
    assert poster.sweep([NONCE]) == 1
    assert mine.exists() and not dead.exists() and young.exists()
    assert (wake_dir / "notes.txt").exists() and (wake_dir / ("0" * 20 + ".sock")).exists()
    assert outside.exists() and (wake_dir / ("1" * 20 + ".sock")).is_symlink()
    bind(dead)
    assert poster.sweep([]) == 0              # throttled
    clock.now += claudewake.SWEEP_SECONDS + 1
    assert poster.sweep([None, "junk"]) == 2  # nothing alive any more: mine goes too, it is old
    assert not dead.exists() and not mine.exists() and young.exists()


def test_sweep_does_nothing_in_a_directory_that_is_not_private(wake_dir):
    dead = claudewake.socket_path(wake_dir, OTHER)
    bind(dead)
    wake_dir.chmod(0o755)
    assert claudewake.Poster(wake_dir).sweep([]) == 0
    assert dead.exists()
    wake_dir.chmod(0o700)
    assert claudewake.Poster(wake_dir / "missing").sweep([]) == 0


# ----------------------------------------------------- failures and a doubtful state


async def test_a_write_that_fails_after_the_connection_keeps_the_record(wake_dir, monkeypatch):
    """The connection was made, so the line may have been delivered: the record stays, nothing is typed."""
    poster = claudewake.Poster(wake_dir, 20.0, Clock())

    async def broken_drain(self):
        raise ConnectionResetError("the listener went away")
    monkeypatch.setattr(asyncio.StreamWriter, "drain", broken_drain)
    async with Listener(claudewake.socket_path(wake_dir, NONCE)):
        assert await poster.post(request(), wake_of(poster)) == {"ok": False, "reason": "not_confirmed"}
    assert poster.holds(request()) and poster.has_line(request())
    stored = json.loads((wake_dir / claudewake.STATE_FILE).read_text())["lines"]
    assert [(item["id"], item["state"]) for item in stored] == [("a" * 32, "sent")]
    assert claudewake.Poster(wake_dir, 20.0, Clock()).has_line(request())


async def test_a_doubt_from_the_future_does_not_cover_later_incarnations(wake_dir):
    clock = Clock()
    state = wake_dir / claudewake.STATE_FILE
    state.write_text(json.dumps({"version": 1, "lines": [], "doubt_before": clock.now + 10 ** 9}))
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    assert poster.holds(request(created=2.0))                    # alive before the load: still doubted
    assert poster.holds(request(created=clock.now))
    assert not poster.holds(request(created=clock.now + 1))     # launched after it: never doubted


@pytest.mark.parametrize("loss", ["opened_to_others", "deleted"])
async def test_a_state_directory_that_stops_being_private_puts_the_live_incarnations_in_doubt(
        wake_dir, loss):
    clock = Clock()
    poster = claudewake.Poster(wake_dir, 20.0, clock)
    async with Listener(claudewake.socket_path(wake_dir, NONCE)) as listener:
        assert (await poster.post(request(), wake_of(poster)))["reason"] == "not_confirmed"
        if loss == "deleted":
            os.unlink(claudewake.socket_path(wake_dir, NONCE))
            shutil.rmtree(wake_dir)
        else:
            wake_dir.chmod(0o755)
        clock.now += 21
        for batch in (request("a" * 32), request("b" * 32)):   # the batch written, then a new one
            assert poster.holds(batch)
            assert await poster.post(batch, None) == {"ok": False, "reason": "unconfirmed"}
        assert poster.unconfirmed() == {("beta", 2.0)}
        assert not poster.holds(request(created=clock.now + 1))   # a later incarnation has no socket
        assert await listener.settle(1) == [claudewake.wake_line(2)]
    if loss == "opened_to_others":
        wake_dir.chmod(0o700)


async def test_a_directory_that_was_never_private_does_not_put_anything_in_doubt(short_root):
    hostile = short_root / "session-mesh" / "claude-wake"
    hostile.mkdir(parents=True, mode=0o755)
    hostile.chmod(0o755)
    for directory in (hostile, short_root / "missing"):
        poster = claudewake.Poster(directory, 20.0, Clock())
        assert not poster.holds(request())
        assert await poster.post(request(), None) is None
