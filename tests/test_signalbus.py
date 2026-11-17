# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The bounded, reference-only, process-local signal registry."""

import signalbus


def envelope(name="alpha", version=1, at=1.0):
    return {"v": 0, "type": "board.updated", "source": name,
            "object": {"kind": "board", "id": name, "version": version}, "at": at}


def test_registry_coalesces_and_snapshots_without_consuming():
    registry = signalbus.Registry()
    registry.publish(envelope(version=1))
    registry.publish(envelope(version=2, at=2.0))
    assert registry.snapshot() == [envelope(version=2, at=2.0)]
    assert registry.snapshot() == [envelope(version=2, at=2.0)]
    snapshot = registry.snapshot()
    snapshot[0]["object"]["id"] = "changed"
    assert registry.snapshot() == [envelope(version=2, at=2.0)]


def test_registry_is_bounded_by_publication_recency():
    registry = signalbus.Registry(limit=2)
    registry.publish(envelope("one"))
    registry.publish(envelope("two"))
    registry.publish(envelope("one", version=2))  # refreshed, so two is oldest
    registry.publish(envelope("three"))
    assert [item["object"]["id"] for item in registry.snapshot()] == ["one", "three"]


def test_private_identities_share_the_same_eviction_bound():
    registry = signalbus.Registry(limit=2)
    registry.publish(envelope("one"), identity=1.0)
    registry.publish(envelope("two"), identity=2.0)
    registry.publish(envelope("three"), identity=3.0)
    seen = []
    assert registry.discard_if(lambda reference, identity: seen.append((reference["object"]["id"], identity)) and False) == 0
    assert seen == [("two", 2.0), ("three", 3.0)]


def test_registry_can_forget_one_board_identity():
    registry = signalbus.Registry()
    registry.publish(envelope("old"))
    registry.publish(envelope("other"))
    assert registry.discard("board.updated", "board", "old") is True
    assert registry.discard("board.updated", "board", "old") is False
    assert registry.snapshot() == [envelope("other")]


def test_registry_refuses_content_or_an_undeclared_shape():
    registry = signalbus.Registry()
    bad = envelope()
    bad["document"] = {"elements": [{"text": "private"}]}
    try:
        registry.publish(bad)
    except ValueError:
        pass
    else:
        raise AssertionError("content-bearing signal was accepted")
    assert registry.snapshot() == []
