# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Current-only, privacy-preserving local resource observation."""

import math
import os
import sys
import threading
import time

import discover


SAMPLE_EVERY_SECONDS = 10
MAX_TRACKED_IDENTITIES = 200
RECOGNIZED_AGENTS = ("claude", "codex")
_METRIC_STATES = ("reported", "derived", "unavailable", "unknown")
_SOURCES = (
    "management-lifecycle",
    "procfs-stat",
    "procfs-statm",
    "no-approved-adapter",
    "not-current-mesh-agent",
    "not-recognized-agent",
)
_REASONS = (
    "first-sample",
    "not-live",
    "not-collected",
    "procfs-unavailable",
    "association-changed",
    "sampling-capacity",
    "no-lifecycle-window",
)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _metric(state, source, value=None, observed_at=None, window=None, reason=None):
    """Return the only metric shape allowed in the response."""
    if state not in _METRIC_STATES or source not in _SOURCES:
        raise ValueError("invalid closed metric state")
    if state in ("reported", "derived"):
        if not _finite(value) or not _finite(observed_at) or not isinstance(window, dict):
            raise ValueError("invalid observed metric")
        reason = None
    else:
        value = None
        observed_at = observed_at if _finite(observed_at) else None
        window = None
        if reason not in _REASONS:
            raise ValueError("invalid absent metric")
    return {
        "state": state,
        "source": source,
        "value": value,
        "observed_at": observed_at,
        "window": window,
        "reason": reason,
    }


def _unknown(source, reason, observed_at=None):
    return _metric("unknown", source, observed_at=observed_at, reason=reason)


def _unavailable(source, reason, observed_at=None):
    return _metric("unavailable", source, observed_at=observed_at, reason=reason)


def _identity(row):
    if not isinstance(row, dict):
        return None
    name, created = row.get("name"), row.get("created")
    if not isinstance(name, str) or not name or not _finite(created):
        return None
    return name, created


def _raw_entry(raw, identity):
    for item in raw if isinstance(raw, list) else []:
        if _identity(item) == identity:
            pid = item.get("pid") if isinstance(item, dict) else None
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
                return item, pid
    return None


def _parse_stat(text):
    try:
        fields = text[text.rindex(")") + 2:].split()
        return {
            "sid": int(fields[3]),
            "cpu_ticks": int(fields[11]) + int(fields[12]),
            "start_ticks": int(fields[19]),
        }
    except (AttributeError, IndexError, TypeError, ValueError):
        return None


def _read_process(pid):
    """Read one direct scalar while rechecking its procfs incarnation."""
    if sys.platform != "linux":   # no procfs: no metrics
        return None
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            before = _parse_stat(handle.read())
        with open(f"/proc/{pid}/statm", encoding="utf-8") as handle:
            parts = handle.read().split()
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            after = _parse_stat(handle.read())
        resident = int(parts[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, IndexError, TypeError, ValueError):
        return None
    if before is None or after is None or resident < 0:
        return None
    if before["sid"] != after["sid"] or before["start_ticks"] != after["start_ticks"]:
        return None
    return {**after, "rss_bytes": resident}


def _read_start_ticks(pid):
    """Return only the local incarnation marker needed for a safe witness."""
    if sys.platform != "linux":   # no procfs: no metrics
        return None
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            stat = _parse_stat(handle.read())
    except (OSError, TypeError, ValueError):
        return None
    start_ticks = stat.get("start_ticks") if isinstance(stat, dict) else None
    if not isinstance(start_ticks, int) or isinstance(start_ticks, bool) or start_ticks < 0:
        return None
    return start_ticks


def _process_state(processes, pid):
    """Validate the non-content subset of a discover snapshot entry."""
    if not isinstance(processes, dict) or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    state = processes.get(pid)
    if not isinstance(state, tuple) or len(state) != 7:
        return None
    comm, _state, ppid, pgrp, sid, _tty_nr, tpgid = state
    if (not isinstance(comm, str) or not isinstance(ppid, int) or isinstance(ppid, bool)
            or not isinstance(pgrp, int) or isinstance(pgrp, bool)
            or not isinstance(sid, int) or isinstance(sid, bool)
            or not isinstance(tpgid, int) or isinstance(tpgid, bool)):
        return None
    return {"comm": comm, "ppid": ppid, "pgrp": pgrp, "sid": sid, "tpgid": tpgid}


def _comm_only_session_agent(processes, sid):
    """Find a direct Claude/Codex comm in one session without reading argv."""
    if not isinstance(sid, int) or isinstance(sid, bool) or sid <= 0 or not isinstance(processes, dict):
        return None
    leader = _process_state(processes, sid)
    if leader is None or leader["sid"] != sid:
        return None
    found = []
    for pid in processes:
        state = _process_state(processes, pid)
        if state is None or state["sid"] != sid or state["comm"] not in RECOGNIZED_AGENTS:
            continue
        parent = _process_state(processes, state["ppid"])
        if parent is not None and parent["sid"] == sid and parent["comm"] in RECOGNIZED_AGENTS:
            continue
        found.append((pid, state["comm"], state))
    if not found:
        return None
    foreground_group = leader["tpgid"]
    found.sort(key=lambda item: (item[2]["pgrp"] != foreground_group, item[0]))
    return found[0][0], found[0][1]


def _clock_ticks():
    """Return the kernel clock rate only when it is a usable positive scalar."""
    try:
        value = os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError):
        return None
    return value if isinstance(value, int) and value > 0 else None


class Collector:
    """Bounded, memory-only collector of closed resource projections."""

    def __init__(self, process_snapshot=None, association_for_session=None, read_process=None,
                 read_start_ticks=None):
        self._process_snapshot = process_snapshot or discover.snapshot
        self._association_for_session = association_for_session or _comm_only_session_agent
        self._read_process = read_process or _read_process
        self._read_start_ticks = read_start_ticks or _read_start_ticks
        self._baselines = {}
        self._latest = {}
        self._lock = threading.Lock()

    def reset_for_tests(self):
        with self._lock:
            self._baselines.clear()
            self._latest.clear()

    def enrich(self, *, raw, management, listed, now=None, monotonic=None):
        """Project only fixed metrics into the pre-existing management result."""
        now = time.time() if now is None else now
        monotonic = time.monotonic() if monotonic is None else monotonic
        now = now if _finite(now) else None
        monotonic = monotonic if _finite(monotonic) else None
        source = management if isinstance(management, dict) else {}
        rows = source.get("sessions") if isinstance(source.get("sessions"), list) else []
        with self._lock:
            tracked = self._tracked_identities(rows, raw, bool(listed))
            if listed:
                self._prune(tracked)
            resources = self._resources_for_rows(rows, raw, bool(listed), now, monotonic, tracked)
            projected = [
                self._project_row(row, now, resources[index])
                for index, row in enumerate(rows)
            ]
        result = dict(source)
        result["sessions"] = projected
        result["observability"] = {
            "state": "observed" if listed else "unavailable",
            "sampling": {
                "cadence_seconds": SAMPLE_EVERY_SECONDS,
                "max_tracked_identities": MAX_TRACKED_IDENTITIES,
                "retention": {"mode": "none", "persistent": False},
            },
            "window": ({"kind": "current-snapshot", "start": now, "end": now}
                       if now is not None else None),
        }
        return result

    def _tracked_identities(self, rows, raw, listed):
        if not listed:
            return set()
        candidates = set()
        for row in rows:
            identity = _identity(row)
            if (isinstance(row, dict) and identity is not None
                    and row.get("source") == "mesh" and row.get("lifecycle") == "active"
                    and row.get("agent_type") in RECOGNIZED_AGENTS
                    and _raw_entry(raw, identity) is not None):
                candidates.add(identity)
        return set(sorted(candidates)[:MAX_TRACKED_IDENTITIES])

    def _prune(self, tracked):
        for storage in (self._baselines, self._latest):
            for identity in list(storage):
                if identity not in tracked:
                    del storage[identity]

    def _project_row(self, row, now, resources):
        result = dict(row) if isinstance(row, dict) else {}
        duration = self._duration(row, now)
        result["metrics"] = {
            "observed_duration_seconds": duration,
            "cpu_percent": resources["cpu_percent"],
            "rss_bytes": resources["rss_bytes"],
            "tokens": _unavailable("no-approved-adapter", "not-collected"),
        }
        return result

    def _duration(self, row, now):
        identity = _identity(row)
        start = row.get("created") if isinstance(row, dict) else None
        end = row.get("time") if isinstance(row, dict) else None
        if identity is None or not _finite(start) or not _finite(end):
            return _unknown("management-lifecycle", "no-lifecycle-window")
        active = row.get("source") == "mesh" and row.get("lifecycle") == "active"
        if active:
            if now is None:
                return _unknown("management-lifecycle", "no-lifecycle-window")
            end = now
        if not _finite(end) or end < start:
            return _unknown("management-lifecycle", "no-lifecycle-window")
        observed_at = now if active else end
        return _metric("derived", "management-lifecycle", end - start, observed_at,
                       {"start": start, "end": end})

    def _resources_for_rows(self, rows, raw, listed, now, monotonic, tracked):
        """Collect a bounded batch with witnesses before and after direct reads."""
        resources, pending = [], []
        for index, row in enumerate(rows):
            value, candidate = self._prechecked_resources(
                row, raw, listed, now, monotonic, tracked,
            )
            resources.append(value)
            if candidate is not None:
                pending.append((index, row, *candidate))
        if not pending:
            return resources
        try:
            before = self._process_snapshot()
        except (AttributeError, OSError, TypeError, ValueError):
            before = None
        if before is None:
            for index, _row, _identity, _shell_pid in pending:
                resources[index] = self._not_recognized(now)
            return resources
        observed = []
        for index, row, identity, shell_pid in pending:
            witness = self._witness(before, shell_pid, row.get("agent_type"))
            cached = self._latest.get(identity)
            if cached is not None and cached.get("witness") != witness:
                self._discard_identity(identity)
                resources[index] = self._association_changed(now)
                continue
            if witness is None:
                resources[index] = self._not_recognized(now)
                continue
            if cached is not None and self._cache_is_fresh(cached, monotonic):
                resources[index] = self._copy_resources(cached["resources"])
                continue
            if cached is not None and not self._cache_can_expire(cached, monotonic):
                self._discard_identity(identity)
            try:
                reading = self._read_process(witness[2])
            except (AttributeError, OSError, TypeError, ValueError):
                reading = None
            if reading is None:
                resources[index] = self._procfs_unavailable(now)
                continue
            if not self._reading_matches_witness(reading, witness):
                self._discard_identity(identity)
                resources[index] = self._association_changed(now)
                continue
            observed.append((index, row, identity, witness, reading))
        if not observed:
            return resources
        try:
            after = self._process_snapshot()
        except (AttributeError, OSError, TypeError, ValueError):
            after = None
        for index, row, identity, witness, reading in observed:
            if (after is None
                    or self._witness(after, witness[0], row.get("agent_type")) != witness):
                self._discard_identity(identity)
                resources[index] = self._association_changed(now)
            else:
                resources[index] = self._derive_resources(
                    row, identity, witness, reading, now, monotonic,
                )
        return resources

    def _prechecked_resources(self, row, raw, listed, now, monotonic, tracked):
        identity = _identity(row)
        if (not listed or not isinstance(row, dict) or identity is None
                or row.get("source") != "mesh" or row.get("lifecycle") != "active"):
            return self._not_live(now), None
        if row.get("agent_type") not in RECOGNIZED_AGENTS:
            return self._not_recognized(now), None
        raw_match = _raw_entry(raw, identity)
        if raw_match is None:
            return self._not_recognized(now), None
        if identity not in tracked:
            return {
                "rss_bytes": _unknown("not-current-mesh-agent", "sampling-capacity", now),
                "cpu_percent": _unknown("not-current-mesh-agent", "sampling-capacity", now),
            }, None
        if now is None:
            return self._not_recognized(now), None
        _item, shell_pid = raw_match
        return None, (identity, shell_pid)

    def _association(self, processes, shell_pid, expected_type):
        try:
            association = self._association_for_session(processes, shell_pid)
        except (AttributeError, OSError, TypeError, ValueError):
            return None
        if (not isinstance(association, tuple) or len(association) != 2
                or not isinstance(association[0], int) or isinstance(association[0], bool)
                or association[0] <= 0 or association[1] != expected_type):
            return None
        return association

    def _witness(self, processes, shell_pid, expected_type):
        """Keep the process association proof in memory, never in a response."""
        association = self._association(processes, shell_pid, expected_type)
        if association is None:
            return None
        agent_pid, agent_type = association
        try:
            shell_start_ticks = self._read_start_ticks(shell_pid)
            agent_start_ticks = (shell_start_ticks if agent_pid == shell_pid
                                 else self._read_start_ticks(agent_pid))
        except (AttributeError, OSError, TypeError, ValueError):
            return None
        if (not isinstance(shell_start_ticks, int) or isinstance(shell_start_ticks, bool)
                or shell_start_ticks < 0 or not isinstance(agent_start_ticks, int)
                or isinstance(agent_start_ticks, bool) or agent_start_ticks < 0):
            return None
        return shell_pid, shell_start_ticks, agent_pid, agent_type, agent_start_ticks

    def _reading_matches_witness(self, reading, witness):
        """Reject a changed PID incarnation before deriving a scalar."""
        sid = reading.get("sid") if isinstance(reading, dict) else None
        start_ticks = reading.get("start_ticks") if isinstance(reading, dict) else None
        return (isinstance(sid, int) and not isinstance(sid, bool) and sid == witness[0]
                and isinstance(start_ticks, int) and not isinstance(start_ticks, bool)
                and start_ticks == witness[4])

    def _cache_is_fresh(self, cached, monotonic):
        cached_monotonic = cached.get("monotonic")
        return (monotonic is not None and cached_monotonic is not None
                and monotonic >= cached_monotonic
                and monotonic - cached_monotonic < SAMPLE_EVERY_SECONDS)

    def _cache_can_expire(self, cached, monotonic):
        cached_monotonic = cached.get("monotonic")
        return (monotonic is not None and cached_monotonic is not None
                and monotonic >= cached_monotonic)

    def _discard_identity(self, identity):
        self._latest.pop(identity, None)
        self._baselines.pop(identity, None)

    def _association_changed(self, now):
        return {
            "rss_bytes": _unknown("not-recognized-agent", "association-changed", now),
            "cpu_percent": _unknown("not-recognized-agent", "association-changed", now),
        }

    def _procfs_unavailable(self, now):
        return {
            "rss_bytes": _unavailable("procfs-statm", "procfs-unavailable", now),
            "cpu_percent": _unavailable("procfs-stat", "procfs-unavailable", now),
        }

    def _derive_resources(self, row, identity, witness, reading, now, monotonic):
        shell_pid, _shell_start_ticks, _agent_pid, _agent_type, agent_start_ticks = witness
        sid = reading.get("sid") if isinstance(reading, dict) else None
        ticks = reading.get("cpu_ticks") if isinstance(reading, dict) else None
        start_ticks = reading.get("start_ticks") if isinstance(reading, dict) else None
        rss = reading.get("rss_bytes") if isinstance(reading, dict) else None
        if (sid != shell_pid or not isinstance(ticks, int) or isinstance(ticks, bool) or ticks < 0
                or not isinstance(start_ticks, int) or isinstance(start_ticks, bool)
                or start_ticks != agent_start_ticks
                or not isinstance(rss, int) or isinstance(rss, bool) or rss < 0):
            return self._procfs_unavailable(now)
        rss_metric = _metric("reported", "procfs-statm", rss, now, {"start": now, "end": now})
        incarnation = witness
        prior = self._baselines.get(identity)
        self._baselines[identity] = (incarnation, ticks, monotonic)
        if prior is None:
            result = {
                "rss_bytes": rss_metric,
                "cpu_percent": _unknown("procfs-stat", "first-sample", now),
            }
        else:
            old_incarnation, old_ticks, old_monotonic = prior
            if (old_incarnation != incarnation or monotonic is None or old_monotonic is None
                    or monotonic <= old_monotonic or ticks < old_ticks):
                result = {
                    "rss_bytes": rss_metric,
                    "cpu_percent": _unknown("procfs-stat", "first-sample", now),
                }
            else:
                clock_ticks = _clock_ticks()
                if clock_ticks is None:
                    result = {
                        "rss_bytes": rss_metric,
                        "cpu_percent": _unavailable("procfs-stat", "procfs-unavailable", now),
                    }
                else:
                    cpu_percent = (ticks - old_ticks) / clock_ticks / (monotonic - old_monotonic) * 100
                    if not _finite(cpu_percent) or cpu_percent < 0:
                        result = {
                            "rss_bytes": rss_metric,
                            "cpu_percent": _unknown("procfs-stat", "first-sample", now),
                        }
                    else:
                        result = {
                            "rss_bytes": rss_metric,
                            "cpu_percent": _metric("derived", "procfs-stat", cpu_percent, now,
                                                     {"start": old_monotonic, "end": monotonic}),
                        }
        self._latest[identity] = {
            "agent_type": row.get("agent_type"),
            "witness": witness,
            "monotonic": monotonic,
            "resources": self._copy_resources(result),
        }
        return result

    def _copy_resources(self, resources):
        return {
            name: {
                **metric,
                "window": dict(metric["window"]) if isinstance(metric.get("window"), dict) else None,
            }
            for name, metric in resources.items()
        }

    def _not_live(self, now):
        return {
            "rss_bytes": _unknown("not-current-mesh-agent", "not-live"),
            "cpu_percent": _unknown("not-current-mesh-agent", "not-live"),
        }

    def _not_recognized(self, now):
        return {
            "rss_bytes": _unknown("not-recognized-agent", "not-collected", now),
            "cpu_percent": _unknown("not-recognized-agent", "not-collected", now),
        }


DEFAULT = Collector()


def enrich(*, raw, management, listed, now=None, monotonic=None):
    return DEFAULT.enrich(raw=raw, management=management, listed=listed, now=now, monotonic=monotonic)


def reset_for_tests():
    DEFAULT.reset_for_tests()
