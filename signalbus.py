# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Small, process-local registry for declared Mesh signal references.

Signals are deliberately hints rather than a queue: readers receive a snapshot,
and a process restart forgets every reference.  This module accepts only the
v0 board reference shape; it never stores a document or any producer-provided
payload.
"""

from collections import OrderedDict
import math


MAX_SIGNALS = 256


def _reference(envelope):
    """Return a detached declared board reference, or ``None``."""
    if not isinstance(envelope, dict) or set(envelope) != {"v", "type", "source", "object", "at"}:
        return None
    obj = envelope["object"]
    if (envelope.get("v") != 0 or envelope.get("type") != "board.updated"
            or not isinstance(envelope.get("source"), str)
            or not isinstance(obj, dict) or set(obj) != {"kind", "id", "version"}
            or obj.get("kind") != "board" or not isinstance(obj.get("id"), str)
            or not isinstance(obj.get("version"), int) or isinstance(obj.get("version"), bool)
            or obj["version"] < 0 or not isinstance(envelope.get("at"), (int, float))
            or isinstance(envelope.get("at"), bool) or not math.isfinite(envelope["at"])
            or envelope["source"] != obj["id"]):
        return None
    return {"v": 0, "type": "board.updated", "source": obj["id"],
            "object": {"kind": "board", "id": obj["id"], "version": obj["version"]},
            "at": envelope["at"]}


class Registry:
    """Newest declared reference per object, bounded by publication recency."""

    def __init__(self, limit=MAX_SIGNALS):
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("Invalid signal limit")
        self.limit = limit
        self._items = OrderedDict()

    def publish(self, envelope, identity=None):
        reference = _reference(envelope)
        if reference is None:
            raise ValueError("Invalid signal")
        obj = reference["object"]
        key = (reference["type"], obj["kind"], obj["id"])
        # Identity is private registry metadata (for example a session's
        # creation time), never part of the published envelope.  It is
        # stored in this same LRU entry, so it cannot outlive an eviction.
        self._items[key] = (reference, identity)
        self._items.move_to_end(key)
        while len(self._items) > self.limit:
            self._items.popitem(last=False)

    def snapshot(self):
        """Return detached references without acknowledging or consuming them."""
        return [{"v": reference["v"], "type": reference["type"], "source": reference["source"],
                 "object": dict(reference["object"]), "at": reference["at"]}
                for reference, _identity in self._items.values()]

    def discard(self, signal_type, kind, object_id):
        """Forget one object reference when its identity ceases to be live."""
        return self._items.pop((signal_type, kind, object_id), None) is not None

    def discard_if(self, predicate):
        """Forget entries whose private identity no longer matches live state."""
        discarded = 0
        for key, (reference, identity) in list(self._items.items()):
            if predicate(reference, identity):
                self._items.pop(key)
                discarded += 1
        return discarded

    def clear(self):
        """Test/support helper; production never consumes published references."""
        self._items.clear()
