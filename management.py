# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Bounded, evidence-only inventory for the local Mesh management view.

This is deliberately not a process monitor.  It remembers only an exact Mesh
identity that was present in one successful ptyhost list and absent in a later
successful list.  The persistent file contains that narrow witness, never a
terminal command, CWD, transcript, label, process id or agent payload.
"""

import json
import math
import re
import threading
import time

import meshpaths
import fsutil


FILE = meshpaths.CONF_DIR / "management-sessions.json"
MAX_ENTRIES = 200
KEEP_SECONDS = 14 * 86400
AGENT_TYPES = ("claude", "codex", "opencode", "copilot", "gemini", "pi")
AGENT_STATUSES = ("busy", "waiting", "shell", "idle")
NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,48}")
_lock = threading.Lock()
_baseline = {}
_order = [float("-inf")]   # the order of the host read behind ``_baseline`` (server._read_host)
# A failed atomic write must not make a witnessed departure disappear merely
# because the next successful list has already replaced ``_baseline``.  This
# bounded process-local retry set is populated only by successful observations.
_pending_stops = {}


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _agent_type(value):
    return value if value in AGENT_TYPES else "unknown"


def _agent_status(session):
    agent = session.get("agent")
    status = agent.get("status") if isinstance(agent, dict) else None
    return status if status in AGENT_STATUSES else "unknown"


def _live(session):
    """The only facts that can form a witnessed Mesh identity."""
    if not isinstance(session, dict):
        return None
    name, created = session.get("name"), session.get("created")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name) or not _number(created):
        return None
    return {"name": name, "created": created,
            "agent_type": _agent_type(session.get("known_agent")),
            "last_observed_agent_status": _agent_status(session)}


def _key(entry):
    return entry["name"], entry["created"]


def _valid_stop(raw):
    if not isinstance(raw, dict):
        return None
    name, created, observed = raw.get("name"), raw.get("created"), raw.get("observed_stopped_at")
    if (not isinstance(name, str) or not NAME_RE.fullmatch(name)
            or not _number(created) or not _number(observed)):
        return None
    return {"name": name, "created": created,
            "agent_type": _agent_type(raw.get("agent_type")),
            "last_observed_agent_status": (raw.get("last_observed_agent_status")
                                             if raw.get("last_observed_agent_status") in AGENT_STATUSES
                                             else "unknown"),
            "observed_stopped_at": observed}


def _load():
    try:
        raw = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    values = raw.get("observed_stops") if isinstance(raw, dict) else []
    values = values if isinstance(values, list) else []
    return [entry for item in values if (entry := _valid_stop(item))]


def _prune(entries, now):
    newest = sorted((entry for entry in entries
                     if 0 <= now - entry["observed_stopped_at"] < KEEP_SECONDS),
                    key=lambda entry: -entry["observed_stopped_at"])
    kept, identities = [], set()
    for entry in newest:
        identity = _key(entry)
        if identity not in identities:
            identities.add(identity)
            kept.append(entry)
    return kept[:MAX_ENTRIES]


def _save(entries):
    try:
        fsutil.atomic_write(FILE, json.dumps({"version": 1, "observed_stops": entries},
                                              separators=(",", ":"), sort_keys=True))
    except OSError as exc:
        print(f"management: ledger not written: {exc!r}", flush=True)
        return False
    return True


def _project_stop(entry):
    return {"name": entry["name"], "created": entry["created"], "source": "observed-stop",
            "agent_type": entry["agent_type"], "lifecycle": "stopped-observed",
            "last_observed_agent_status": entry["last_observed_agent_status"],
            "time_basis": "observed_stopped_at", "time": entry["observed_stopped_at"]}


def _project_mesh(entry):
    return {"name": entry["name"], "created": entry["created"], "source": "mesh",
            "agent_type": entry["agent_type"], "lifecycle": "active",
            "last_observed_agent_status": entry["last_observed_agent_status"],
            "time_basis": "created", "time": entry["created"]}


def _project_external(session):
    """External discovery has no safe durable identity or creation timestamp."""
    if not isinstance(session, dict):
        return None
    agent = session.get("agent")
    agent_type = _agent_type(agent.get("type") if isinstance(agent, dict) else None)
    return {"name": None, "created": None, "source": "external", "agent_type": agent_type,
            "lifecycle": "active", "last_observed_agent_status": _agent_status(session),
            "time_basis": "unknown", "time": None}


def _recovery(entry, now):
    if not isinstance(entry, dict):
        return None
    name, created, lost_at = entry.get("name"), entry.get("created"), entry.get("lost_at")
    if (not isinstance(name, str) or not NAME_RE.fullmatch(name)
            or not _number(created) or not _number(lost_at)
            or not 0 <= now - lost_at < KEEP_SECONDS):
        return None
    return {"name": name, "created": created, "agent_type": _agent_type(entry.get("agent_type")),
            "lost_at": lost_at}


def _project_recovery(entry):
    return {"name": entry["name"], "created": entry["created"], "source": "restart-recovery",
            "agent_type": entry["agent_type"], "lifecycle": "lost-recovery",
            "last_observed_agent_status": "unknown", "time_basis": "lost_at", "time": entry["lost_at"]}


def _recoveries(values, now):
    """Normalise recovery evidence before comparing it to stopped observations.

    A recovery is the stronger explanation for its exact identity.  Keep only
    its latest observation if legacy input contains the same identity twice;
    identities with the same name but another creation time remain separate.
    """
    selected = {}
    for raw in values if isinstance(values, list) else []:
        entry = _recovery(raw, now)
        if entry is None:
            continue
        key = _key(entry)
        if key not in selected or entry["lost_at"] > selected[key]["lost_at"]:
            selected[key] = entry
    # Recovery evidence follows respawn's newest-created retention rule.  The
    # second sort is presentation order only, after the bound has been fixed.
    bounded = sorted(selected.values(),
                     key=lambda entry: (-entry["created"], entry["name"], -entry["lost_at"]))[:MAX_ENTRIES]
    return sorted(bounded, key=lambda entry: (-entry["lost_at"], entry["name"], entry["created"]))


def _witness(kept, live, recovery_keys, now, order):
    """Under _lock: a stop for each session of the baseline that ``live`` no longer has; ``live``
    (of the host read ``order``) becomes the baseline. Return the pruned ledger."""
    seen = {_key(entry) for entry in kept}
    for key, entry in _baseline.items():
        if key not in live and key not in seen and key not in recovery_keys:
            kept.append({**entry, "observed_stopped_at": now})
            seen.add(key)
    _baseline.clear()
    _baseline.update(live)
    _order[0] = _order[0] if order is None else order
    return _prune(kept, now)


def snapshot(mesh, external, listed, recovery, now=None, order=None):
    """Return a safe management projection and record a witnessed Mesh absence.

    ``listed`` is the ptyhost authority bit: a failed list never changes either
    the previous successful baseline or the persistent ledger.  ``order``: that
    of the host read (server._read_host); a read older than the baseline's
    changes neither the baseline nor the ledger (listings run in parallel).
    """
    now = time.time() if now is None else now
    with _lock:
        recovered = _recoveries(recovery, now)
        recovery_keys = {_key(entry) for entry in recovered}
        old = _load()
        # Pending evidence is already a successful observation, but is not
        # durable until its atomic write succeeds.  Merge it before the usual
        # exact-identity de-duplication so a retry neither loses nor duplicates
        # an absence after the live baseline moves on.
        kept = _prune(old + list(_pending_stops.values()), now)
        current = []
        if listed:
            # A restart-recovery record is more precise than an ordinary
            # observed absence.  Drop any legacy matching stop only after a
            # successful list gives this snapshot authority to mutate storage.
            kept = [entry for entry in kept if _key(entry) not in recovery_keys]
            live = { _key(entry): entry for session in mesh if (entry := _live(session)) }
            current = [_project_mesh(entry) for entry in live.values()]
            current.extend(entry for session in external if (entry := _project_external(session)))
            if order is None or order >= _order[0]:   # an older read's earlier ``now`` would prune newer stops
                kept = _witness(kept, live, recovery_keys, now, order)
                _pending_stops.clear()
                if kept != old and not _save(kept):
                    # Keep the entire bounded desired ledger: it includes a new
                    # witnessed stop (if any) and makes the next successful list
                    # retry exactly the state that could not be committed.
                    _pending_stops.update({_key(entry): entry for entry in kept})
        else:
            # Keep the on-disk ledger byte-for-byte intact while ptyhost is
            # unavailable.  Its safe, pruned in-memory projection (including
            # already witnessed but not-yet-durable pending evidence) is still
            # useful, but absence has no authority to repair or rewrite facts.
            kept = [entry for entry in kept if _key(entry) not in recovery_keys]
        return {"state": "observed" if listed else "unavailable",
                "retention": {"max_entries": MAX_ENTRIES, "keep_seconds": KEEP_SECONDS},
                "sessions": current + [_project_recovery(entry) for entry in recovered]
                + [_project_stop(entry) for entry in kept]}


def reset_for_tests():
    """Clear the process-local witness baseline between isolated tests."""
    with _lock:
        _baseline.clear()
        _pending_stops.clear()
        _order[0] = float("-inf")
