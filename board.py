# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Private, versioned Excalidraw documents bound to mesh session identities.

The ptyhost can reuse a name.  A document is consequently keyed by the pair
``(name, created)`` rather than by the human-visible name alone.  This module
does no network I/O and deliberately does not publish updates: a later change
can consume :func:`updated_envelope` without learning document contents.
"""

import contextlib
import fcntl
import json
import math
import threading
import time

import meshpaths
import fsutil

FILE = meshpaths.CONF_DIR / "board.json"
MAX_ELEMENTS = 1000
MAX_DEPTH = 64
MAX_NODES = 10000
MAX_BYTES = 1024 * 1024
HISTORY_LIMIT = 20
PROVENANCE = frozenset(("owner", "mcp-session", "legacy-unknown"))
_lock = threading.Lock()


class BoardNotLive(Exception):
    """The requested name is not a current ptyhost session."""


class BoardConflict(Exception):
    """A compare-and-swap version did not match the stored document."""


class BoardStorageError(Exception):
    """The private board store could not be safely locked or preserved."""


def empty():
    return {"elements": [], "appState": {}, "files": {}, "version": 0}


@contextlib.contextmanager
def _locked():
    """Serialise writers in this process and sibling mesh processes."""
    with _lock:
        try:
            FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            lockfile = open(FILE.with_name(FILE.name + ".lock"), "a")
        except OSError as exc:
            # A fail-open lock defeats compare-and-swap across mesh processes.
            raise BoardStorageError("Whiteboard storage unavailable") from exc
        with lockfile:
            try:
                fcntl.flock(lockfile, fcntl.LOCK_EX)
            except OSError as exc:
                raise BoardStorageError("Whiteboard storage unavailable") from exc
            try:
                yield
            finally:
                fcntl.flock(lockfile, fcntl.LOCK_UN)


def _valid_json(value, depth=0, count=None):
    """Accept JSON values only, with a finite shape budget.

    Python's JSON decoder accepts NaN and Infinity by default; neither is JSON
    and neither is safe to persist as an Excalidraw document.
    """
    if count is None:
        count = [0]
    count[0] += 1
    if count[0] > MAX_NODES or depth > MAX_DEPTH:
        return False
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_valid_json(item, depth + 1, count) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _valid_json(item, depth + 1, count)
                   for key, item in value.items())
    return False


def validate_document(raw):
    """Return a detached valid document or raise ``ValueError``.

    The exact root shape gives the browser a stable wire format and prevents
    smuggling future asset/file features into this deliberately local v0.
    """
    if not isinstance(raw, dict) or set(raw) != {"elements", "appState", "files", "version"}:
        raise ValueError("Invalid Excalidraw document")
    elements, app_state, files, version = (raw["elements"], raw["appState"], raw["files"], raw["version"])
    if (not isinstance(elements, list) or len(elements) > MAX_ELEMENTS
            or not all(isinstance(element, dict) for element in elements)
            or any(element.get("type") == "image" for element in elements)
            or not isinstance(app_state, dict) or files != {}
            or not isinstance(version, int) or isinstance(version, bool) or version < 0):
        raise ValueError("Invalid Excalidraw document")
    if not _valid_json(raw):
        raise ValueError("Invalid Excalidraw document")
    try:
        encoded = json.dumps(raw, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        raise ValueError("Invalid Excalidraw document") from None
    if len(encoded) > MAX_BYTES:
        raise ValueError("Excalidraw document too large")
    # JSON round-trip detaches mutable inputs and normalises only JSON values.
    return json.loads(encoded)


def _corrupt():
    try:
        # Nanosecond suffix avoids silently overwriting a prior corrupt copy.
        FILE.replace(FILE.with_name(f"{FILE.name}.corrupt-{time.time_ns()}"))
    except OSError as exc:
        # Never replace a malformed document with an empty one if its forensic
        # copy could not be retained.
        raise BoardStorageError("Whiteboard document corrupted, cannot save") from exc
    return {"boards": {}}


def _history_record(raw):
    if not isinstance(raw, dict) or set(raw) != {"document", "provenance", "at"}:
        raise ValueError
    if raw["provenance"] not in PROVENANCE:
        raise ValueError
    at = raw["at"]
    if not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at):
        raise ValueError
    return {"document": validate_document(raw["document"]), "provenance": raw["provenance"], "at": at}


def _load():
    try:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"boards": {}}
    except (OSError, ValueError):
        return _corrupt()
    if (not isinstance(raw, dict) or set(raw) != {"version", "boards"}
            or raw.get("version") not in (1, 2, 3) or not isinstance(raw.get("boards"), dict)):
        return _corrupt()
    migrating = raw["version"] in (1, 2)
    boards = {}
    for name, entry in raw["boards"].items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            return _corrupt()
        if raw["version"] == 1 and set(entry) == {"created", "document"}:
            entry = {**entry, "history": [], "provenance": "legacy-unknown"}
        elif raw["version"] == 2 and set(entry) == {"created", "document", "history"}:
            # v2 attached a snapshot's actor to the write which replaced it.
            # That cannot be reconstructed as the state actor, so erase rather
            # than misattribute every migrated snapshot.
            try:
                history = [_history_record(snapshot) for snapshot in entry["history"]]
            except (TypeError, ValueError):
                return _corrupt()
            entry = {**entry, "history": [{**snapshot, "provenance": "legacy-unknown"}
                                             for snapshot in history],
                     "provenance": "legacy-unknown"}
        elif raw["version"] != 3 or set(entry) != {"created", "document", "history", "provenance"}:
            return _corrupt()
        created = entry["created"]
        if not isinstance(created, (int, float)) or isinstance(created, bool) or not math.isfinite(created):
            return _corrupt()
        try:
            document = validate_document(entry["document"])
            history = entry["history"]
            if not isinstance(history, list) or len(history) > HISTORY_LIMIT:
                raise ValueError
            history = [_history_record(snapshot) for snapshot in history]
        except ValueError:
            return _corrupt()
        if entry["provenance"] not in PROVENANCE:
            return _corrupt()
        boards[name] = {"created": created, "document": document, "history": history,
                        "provenance": entry["provenance"]}
    state = {"boards": boards}
    # A valid v1 file is never rewritten piecemeal.  The first locked reader
    # upgrades it through the same atomic writer used for ordinary mutations.
    if migrating:
        _save(state)
    return state


def _save(state):
    try:
        fsutil.atomic_write(FILE, json.dumps({"version": 3, **state}, ensure_ascii=False, separators=(",", ":")))
    except OSError as exc:
        raise BoardStorageError("Could not save the whiteboard") from exc


def _live(sessions):
    return {entry["name"]: entry["created"] for entry in sessions
            if isinstance(entry, dict) and isinstance(entry.get("name"), str)
            and isinstance(entry.get("created"), (int, float))
            and not isinstance(entry.get("created"), bool) and math.isfinite(entry["created"])}


def get(name, sessions):
    live = _live(sessions)
    if name not in live:
        raise BoardNotLive()
    with _locked():
        entry = _load()["boards"].get(name)
        if not entry or entry["created"] != live[name]:
            return empty()
        return entry["document"]


def replace(name, document, sessions, provenance="owner", at=None):
    """CAS-write a validated document and return its incremented copy."""
    document = validate_document(document)
    if provenance not in ("owner", "mcp-session"):
        raise ValueError("Invalid whiteboard provenance")
    if at is None:
        at = time.time()
    if not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at):
        raise ValueError("Invalid whiteboard date")
    live = _live(sessions)
    if name not in live:
        raise BoardNotLive()
    with _locked():
        state = _load()
        entry = state["boards"].get(name)
        current = entry["document"] if entry and entry["created"] == live[name] else empty()
        history = entry["history"] if entry and entry["created"] == live[name] else []
        current_provenance = entry["provenance"] if entry and entry["created"] == live[name] else "legacy-unknown"
        if document["version"] != current["version"]:
            raise BoardConflict()
        saved = {**document, "version": document["version"] + 1}
        snapshot = {"document": current, "provenance": current_provenance, "at": at}
        state["boards"][name] = {"created": live[name], "document": saved,
                                  "history": [*history, snapshot][-HISTORY_LIMIT:],
                                  "provenance": provenance}
        _save(state)
        return saved


def transfer(old_name, old_created, new_name, new_created):
    """Move an offered lost board to exactly the session just recreated."""
    with _locked():
        state = _load()
        old = state["boards"].get(old_name)
        if not old or old["created"] != old_created:
            return False
        state["boards"].pop(old_name, None)
        state["boards"][new_name] = {"created": new_created, "document": old["document"],
                                      "history": old["history"], "provenance": old["provenance"]}
        _save(state)
    return True


def revisions(name, sessions):
    """Safe metadata for historical documents and the current document."""
    live = _live(sessions)
    if name not in live:
        raise BoardNotLive()
    with _locked():
        entry = _load()["boards"].get(name)
        if not entry or entry["created"] != live[name]:
            documents = [(empty(), "legacy-unknown")]
        else:
            documents = [(snapshot["document"], snapshot["provenance"]) for snapshot in entry["history"]] \
                + [(entry["document"], entry["provenance"])]
        return [{"version": document["version"], "element_count": len(document["elements"]),
                 "status": "available", "provenance": provenance} for document, provenance in documents]


def revision(name, version, sessions):
    """Return only safe summary metadata for one retained revision."""
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        return {"status": "unavailable"}
    found = [item for item in revisions(name, sessions) if item["version"] == version]
    return found[0] if len(found) == 1 else {"status": "unavailable"}


def _identity_map(document):
    mapped = {}
    for element in document["elements"]:
        identity, version = element.get("id"), element.get("version")
        if not isinstance(identity, str) or not identity or not isinstance(version, int) \
                or isinstance(version, bool) or version < 0 or identity in mapped:
            return None
        mapped[identity] = version
    return mapped


def diff_documents(before, after):
    """Return safe structural counts, never caller-controlled element data."""
    before, after = _identity_map(before), _identity_map(after)
    if before is None or after is None or before == after:
        return {"status": "unavailable"}
    return {"status": "available", "added": len(after.keys() - before.keys()),
            "removed": len(before.keys() - after.keys()),
            "modified": sum(before[key] != after[key] for key in before.keys() & after.keys())}


def revision_diff(name, before_version, after_version, sessions):
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0
           for value in (before_version, after_version)):
        return {"status": "unavailable"}
    live = _live(sessions)
    if name not in live:
        raise BoardNotLive()
    with _locked():
        entry = _load()["boards"].get(name)
        docs = [empty()] if not entry or entry["created"] != live[name] else \
            [snapshot["document"] for snapshot in entry["history"]] + [entry["document"]]
        before = [doc for doc in docs if doc["version"] == before_version]
        after = [doc for doc in docs if doc["version"] == after_version]
        if len(before) != 1 or len(after) != 1:
            return {"status": "unavailable"}
        return diff_documents(before[0], after[0])


def latest_change(name, sessions):
    """Return the newest retained structural transition, never board content.

    This is intentionally one fixed self-scoped read for an agent that was
    explicitly asked to inspect a human change.  A missing predecessor or an
    ambiguous structural comparison is unavailable rather than guessed.
    """
    live = _live(sessions)
    if name not in live:
        raise BoardNotLive()
    with _locked():
        entry = _load()["boards"].get(name)
        if not entry or entry["created"] != live[name] or not entry["history"]:
            return {"status": "unavailable"}
        previous = entry["history"][-1]
        before, after = previous["document"], entry["document"]
        diff = diff_documents(before, after)
        if diff.get("status") != "available":
            return {"status": "unavailable"}
        return {"status": "available",
                "from": {"version": before["version"], "element_count": len(before["elements"]),
                         "provenance": previous["provenance"]},
                "to": {"version": after["version"], "element_count": len(after["elements"]),
                       "provenance": entry["provenance"]},
                "diff": {key: diff[key] for key in ("added", "removed", "modified")}}


def restore(name, version, expected_version, sessions, provenance="mcp-session", at=None):
    """CAS-restore one retained snapshot as a new current revision.

    The restored document never leaves this module.  It is copied into a new
    version, so a later restore cannot silently overwrite an intervening draw.
    """
    if (not isinstance(version, int) or isinstance(version, bool) or version < 0
            or not isinstance(expected_version, int) or isinstance(expected_version, bool)
            or expected_version < 0 or provenance not in ("owner", "mcp-session")):
        raise ValueError("Invalid whiteboard restore")
    if at is None:
        at = time.time()
    if not isinstance(at, (int, float)) or isinstance(at, bool) or not math.isfinite(at):
        raise ValueError("Invalid whiteboard date")
    live = _live(sessions)
    if name not in live:
        raise BoardNotLive()
    with _locked():
        state = _load()
        entry = state["boards"].get(name)
        current = entry["document"] if entry and entry["created"] == live[name] else empty()
        history = entry["history"] if entry and entry["created"] == live[name] else []
        current_provenance = entry["provenance"] if entry and entry["created"] == live[name] else "legacy-unknown"
        if current["version"] != expected_version:
            raise BoardConflict()
        retained = [snapshot["document"] for snapshot in history] + [current]
        matches = [document for document in retained if document["version"] == version]
        if len(matches) != 1:
            raise ValueError("Whiteboard revision unavailable")
        saved = {**matches[0], "version": current["version"] + 1}
        snapshot = {"document": current, "provenance": current_provenance, "at": at}
        state["boards"][name] = {"created": live[name], "document": saved,
                                  "history": [*history, snapshot][-HISTORY_LIMIT:],
                                  "provenance": provenance}
        _save(state)
        return saved


def remove(name, created):
    """Forget one identity after an explicit kill or discarded restore offer."""
    with _locked():
        state = _load()
        entry = state["boards"].get(name)
        if not entry or entry["created"] != created:
            return False
        state["boards"].pop(name, None)
        _save(state)
        return True


def updated_envelope(name, version, at):
    """A content-free reference for the future event/MCP integration."""
    return {"v": 0, "type": "board.updated", "source": name,
            "object": {"kind": "board", "id": name, "version": version}, "at": at}
