# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Private bounded Mesh names, exact conversation bindings and recent closures.

No terminal bytes, argv, cwd or credentials belong here. An unavailable agent
identity stays unavailable; never infer a conversation from a directory/name.
"""
import contextlib
import fcntl
import json
import math
import re
import threading
import time

import meshpaths
import fsutil

FILE = meshpaths.CONF_DIR / "conversation-names.json"
MAX_ENTRIES = 500
MAX_ALIASES = 20
KEEP_SECONDS = 90 * 86400
# The agents whose observed conversation id is exact enough to bind a name to it (a Claude pid file, a codex
# rollout held open, the one Pi transcript written since the process started).
BOUND_AGENTS = ("claude", "codex", "pi")
BOUND_SOURCES = ("open_rollout", "pid_metadata", "unique_pi_transcript")
SID_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z-]{7,63}")
_lock = threading.Lock()


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _text(value):
    if not isinstance(value, str):
        return ""
    return " ".join(re.sub(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", "", value).split())[:60]


def _entry(raw):
    if not isinstance(raw, dict) or not _text(raw.get("name")) or not _number(raw.get("created")):
        return None
    if not _number(raw.get("seen")) or not (raw.get("closed_at") is None or _number(raw["closed_at"])):
        return None
    agent, sid = raw.get("agent"), raw.get("sid")
    if agent is not None and agent not in BOUND_AGENTS:
        return None
    if sid is not None and (agent is None or not isinstance(sid, str) or not SID_RE.fullmatch(sid)):
        return None
    aliases = raw.get("aliases", [])
    if not isinstance(aliases, list):
        return None
    return {"name": _text(raw["name"]), "created": raw["created"], "seen": raw["seen"],
            "label": _text(raw.get("label")), "aliases": list(dict.fromkeys(
                _text(a) for a in aliases if _text(a)))[-MAX_ALIASES:],
            "agent": agent, "sid": sid, "closed_at": raw.get("closed_at")}


@contextlib.contextmanager
def _locked():
    with _lock:
        FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(FILE.with_suffix(".lock"), "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield


def _load():
    try:
        raw = json.loads(FILE.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    now = time.time()
    entries = [e for r in raw[:MAX_ENTRIES * 2] if (e := _entry(r))
               and 0 <= now - e["seen"] < KEEP_SECONDS]
    return sorted(entries, key=lambda e: -e["seen"])[:MAX_ENTRIES]


def _save(entries):
    fsutil.atomic_write(FILE, json.dumps(sorted(entries, key=lambda e: -e["seen"])[:MAX_ENTRIES],
                                        ensure_ascii=False))


def _binding(info):
    """(agent, sid, ambiguous) of a discovered agent: the exact conversation when its identity comes from a
    source in BOUND_SOURCES, else (None, None, ambiguous) where ambiguous means that an agent of BOUND_AGENTS
    runs whose identity source is absent (Pi after /new, with two transcripts) or is not in BOUND_SOURCES (a
    guess such as Codex's cwd_unique): never to be taken for the earlier conversation."""
    agent, sid = info.get("type"), info.get("session_id")
    source = info.get("identity_source")
    if source in BOUND_SOURCES and agent in BOUND_AGENTS and isinstance(sid, str) and SID_RE.fullmatch(sid):
        return agent, sid, False
    return None, None, agent in BOUND_AGENTS and source not in BOUND_SOURCES


def _add_entry(entries, matched, name, created, agent, sid, now):
    """(new entry, entries with it): it keeps the aliases of the incarnation's earlier entries, and an exact one
    replaces the unbound ones of that incarnation."""
    previous = max(matched, key=lambda e: e["seen"]) if matched else None
    entry = {"name": name, "created": created, "agent": agent, "sid": sid,
             "label": "", "aliases": list(previous["aliases"]) if previous else [],
             "seen": now, "closed_at": None}
    entries.append(entry)
    if sid:
        entries = [e for e in entries if e is entry or not (
            (e["name"], e["created"]) == (name, created) and e["sid"] is None)]
    return entry, entries


def _close_gone(entries, live, now):
    """An incarnation the listing no longer shows is closed (unless a later observation already is). Whether
    one was."""
    closed = False
    for entry in entries:
        if (entry["name"], entry["created"]) not in live and entry["closed_at"] is None and entry["seen"] <= now:
            entry["closed_at"] = entry["seen"] = now
            closed = True
    return closed


def _set(entry, key, value):
    """Set one field; whether its JSON form changed (an int and an equal float are written differently)."""
    old, entry[key] = entry[key], value
    return type(old) is not type(value) or old != value


def observe(sessions, *, listed=True, now=None):
    """Successful inventory binds observed names to discovered exact IDs.

    A missing incarnation is a closure observation, never a failed listing.
    """
    if not listed:
        return
    now = time.time() if now is None else now
    with _locked():
        entries = _load()
        changed = False     # whether entries differ from what _load read (both used to be serialised to tell)
        live = {(s["name"], s["created"]) for s in sessions}
        for s in sessions:
            name, created = s["name"], s["created"]
            agent, sid, ambiguous = _binding(s.get("agent") or {})
            matched = [e for e in entries if (e["name"], e["created"]) == (name, created)]
            if any(e["closed_at"] is not None for e in matched):
                continue
            entry = next((e for e in matched if (e["agent"], e["sid"]) == (agent, sid)), None)
            # A shell returning after its agent exits retains the last known
            # binding, so the owner can still resume that exact conversation.
            # A running agent whose conversation is not known is not that: its label must not reach the earlier one.
            if entry is None and sid is None and matched and not ambiguous:
                entry = max(matched, key=lambda e: e["seen"])
            # A killed incarnation cannot come back. A list fetched before
            # its kill may finish afterwards; retain the closure tombstone.
            if entry is not None and entry["seen"] > now:
                continue
            if entry is None:
                entry, entries = _add_entry(entries, matched, name, created, agent, sid, now)
                changed = True
            if matched and entry is not _newest(matched):
                changed |= _set(entry, "seen", now)     # back to an earlier conversation: the current one again
            label = _text(s.get("label"))
            changed |= _set(entry, "aliases", list(dict.fromkeys(a for a in [*entry["aliases"], name,
                                                    entry["label"], label] if a))[-MAX_ALIASES:])
            changed |= _set(entry, "label", label)
            changed |= _set(entry, "closed_at", None)
            # Persist time only when identity/names change, not every poll.
            if now - entry["seen"] >= 86400 or changed:
                changed |= _set(entry, "seen", now)
        if _close_gone(entries, live, now) or changed:
            _save(entries)


def _newest(entries):
    return max(entries, key=lambda e: e["seen"]) if entries else None


def rename(name, created, old, new):
    """Capture each successful rename, including mesh-rename CLI mutations.

    The label belongs to the conversation the incarnation is in now (its newest entry), not to the
    ones that ran in it before a /clear or a resume: a History resume of those must not show it."""
    with _locked():
        entries = _load()
        found = [e for e in entries if (e["name"], e["created"]) == (name, created)]
        if not found:
            entries.append({"name": name, "created": created, "agent": None, "sid": None,
                            "label": "", "aliases": [], "seen": time.time(), "closed_at": None})
            found = [entries[-1]]
        entry = _newest(found)
        entry["aliases"] = list(dict.fromkeys(a for a in [*entry["aliases"], name,
            _text(old), _text(new)] if a))[-MAX_ALIASES:]
        entry["label"] = _text(new)
        entry["seen"] = time.time()
        _save(entries)


def close(name, created):
    with _locked():
        entries = _load()
        now = time.time()
        for entry in entries:
            if (entry["name"], entry["created"]) == (name, created):
                entry["closed_at"] = entry["seen"] = now
        _save(entries)


def snapshot():
    with _locked():
        return _load()


def last_label(agent, sid):
    """The label the owner last gave the conversation (agent, sid) in any session, "" when the last
    incarnation had none: what a History resume shows again. Names alone never identify a conversation."""
    found = [e for e in snapshot() if (e["agent"], e["sid"]) == (agent, sid)]
    return max(found, key=lambda e: e["seen"])["label"] if found else ""


def forget(agent, sid):
    """A deleted transcript must not survive as a named recent-history row."""
    with _locked():
        entries = _load()
        kept = [e for e in entries if (e["agent"], e["sid"]) != (agent, sid)]
        if len(kept) != len(entries):
            _save(kept)


def active_aliases(sessions):
    entries = snapshot()
    for s in sessions:
        found = [e for e in entries if (e["name"], e["created"]) == (s["name"], s["created"])]
        s["aliases"] = _aliases(found)


def _aliases(entries):
    chronological = sorted(entries, key=lambda e: e["seen"])
    return list(dict.fromkeys(a for e in chronological for a in e["aliases"] if a))[-MAX_ALIASES:]


def enrich(item, entries):
    found = [e for e in entries if (e["agent"], e["sid"]) == (item["agent"], item["id"])]
    if not found:
        return item
    newest = max(found, key=lambda e: e["seen"])
    return {**item, "mesh_name": newest["name"], "mesh_label": newest["label"],
            "mesh_aliases": _aliases(found)}
