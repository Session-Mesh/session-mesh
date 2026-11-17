# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The short-lived, closed board-open member of the browser open queue."""

import opens


import pytest


@pytest.fixture(autouse=True)
def clean_queue():
    opens.OPENS.clear()
    opens._BOARD_OPEN_IDENTITIES.clear()
    opens._BOARD_REFRESH_IDENTITIES.clear()
    yield
    opens.OPENS.clear()
    opens._BOARD_OPEN_IDENTITIES.clear()
    opens._BOARD_REFRESH_IDENTITIES.clear()


def test_board_open_record_is_exactly_the_declared_closed_union_member(monkeypatch):
    monkeypatch.setattr(opens.time, "time", lambda: 100.0)
    assert opens.record_board_open("alpha", 1.0) is True
    entry = opens.OPENS[-1]
    assert set(entry) == {"kind", "session", "seq", "at"}
    assert entry["kind"] == "board-open"
    assert entry["session"] == "alpha"
    assert entry["at"] == 100.0
    assert entry["seq"] > 10 ** 12
    assert "target" not in entry and "url" not in entry and "token" not in entry


def test_board_open_coalesces_for_twelve_seconds_then_emits_a_new_sequence(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(opens.time, "time", lambda: now[0])
    assert opens.record_board_open("alpha", 1.0) is True
    first = opens.OPENS[-1]["seq"]
    now[0] += 11.999
    assert opens.record_board_open("alpha", 1.0) is False
    assert [entry["seq"] for entry in opens.OPENS] == [first]
    now[0] += .001
    assert opens.record_board_open("alpha", 1.0) is True
    assert len(opens.OPENS) == 1 and opens.OPENS[0]["seq"] > first


def test_expired_board_open_is_removed_independently_of_document_retention(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(opens.time, "time", lambda: now[0])
    opens.OPENS.append({"kind": "file", "target": "/tmp/kept", "at": 1})
    opens.record_board_open("alpha", 1.0)
    now[0] += opens.BOARD_OPEN_TTL
    assert opens.snapshot() == [{"kind": "file", "target": "/tmp/kept", "at": 1}]


def test_total_open_queue_stays_bounded(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(opens.time, "time", lambda: now[0])
    for index in range(opens.KEEP_OPENS + 4):
        opens.OPENS.append({"kind": "file", "target": f"/tmp/{index}", "at": now[0]})
    opens.record_board_open("alpha", 1.0)
    assert len(opens.OPENS) == opens.KEEP_OPENS
    assert opens.OPENS[-1]["kind"] == "board-open"


def test_name_reuse_drops_the_old_incarnation_without_exposing_it(monkeypatch):
    monkeypatch.setattr(opens.time, "time", lambda: 100.0)
    assert opens.record_board_open("alpha", 1.0) is True
    old = opens.OPENS[-1]["seq"]
    # Snapshot revalidation drops a command from an old terminal incarnation.
    assert opens.snapshot({"alpha": 2.0}) == []
    assert opens.record_board_open("alpha", 2.0) is True
    entry = opens.OPENS[-1]
    assert entry["seq"] > old and set(entry) == {"kind", "session", "seq", "at"}


def test_conditional_discard_preserves_a_newer_board_command(monkeypatch):
    monkeypatch.setattr(opens.time, "time", lambda: 100.0)
    opens.record_board_open("alpha", 2.0)
    opens.record_board_refresh("alpha", 2.0)
    opens.discard_board_open("alpha", 1.0)
    assert [entry["kind"] for entry in opens.OPENS] == ["board-open", "board-refresh"]
    opens.discard_board_open("alpha", 2.0)
    assert opens.OPENS == []


def test_board_refresh_is_closed_coalesced_and_tied_to_the_live_incarnation(monkeypatch):
    monkeypatch.setattr(opens.time, "time", lambda: 100.0)
    assert opens.record_board_refresh("alpha", 1.0) is True
    assert opens.record_board_refresh("alpha", 1.0) is False
    entry = opens.OPENS[-1]
    assert entry == {"kind": "board-refresh", "session": "alpha", "seq": entry["seq"], "at": 100.0}
    assert opens.snapshot({"alpha": 2.0}) == []
