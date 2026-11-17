# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The current-only resource projection."""

import json

import observability


def make_collector(**kwargs):
    """Inject safe witnesses so unit tests never inspect the host's process table."""
    kwargs.setdefault("read_start_ticks", lambda _pid: 77)
    return observability.Collector(**kwargs)


def active_management_row():
    return {
        "name": "alpha",
        "created": 100.0,
        "source": "mesh",
        "agent_type": "codex",
        "lifecycle": "active",
        "last_observed_agent_status": "busy",
        "time_basis": "created",
        "time": 100.0,
    }


def ptyhost_row():
    return {
        "name": "alpha",
        "created": 100.0,
        "pid": 101,
        "cwd": "/private/cwd",
        "activity": 100.0,
        "attached": 1,
        "meta": {},
    }


def test_exact_active_agent_first_sample_reports_rss_but_not_cpu():
    """The first safe reading exposes only closed scalars, never its process identity."""
    reader_calls = []

    def read_process(pid):
        reader_calls.append(pid)
        return {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192}

    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=read_process,
    )
    management = {"state": "observed", "sessions": [active_management_row()]}

    result = collector.enrich(
        raw=[ptyhost_row()],
        management=management,
        listed=True,
        now=200.0,
        monotonic=20.0,
    )

    metric = result["sessions"][0]["metrics"]
    assert reader_calls == [202]
    assert metric["rss_bytes"] == {
        "state": "reported",
        "source": "procfs-statm",
        "value": 8192,
        "observed_at": 200.0,
        "window": {"start": 200.0, "end": 200.0},
        "reason": None,
    }
    assert metric["cpu_percent"] == {
        "state": "unknown",
        "source": "procfs-stat",
        "value": None,
        "observed_at": 200.0,
        "window": None,
        "reason": "first-sample",
    }
    text = json.dumps(result)
    for private in ("101", "202", "77", "40", "/private/cwd"):
        assert private not in text


def test_matching_second_sample_derives_cpu_over_its_actual_interval(monkeypatch):
    """A second unchanged incarnation turns ticks into a nonzero rate, not a total."""
    readings = iter([
        {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
        {"sid": 101, "start_ticks": 77, "cpu_ticks": 45, "rss_bytes": 8192},
    ])
    monkeypatch.setattr(observability, "_clock_ticks", lambda: 10)
    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda _pid: next(readings),
    )
    management = {"state": "observed", "sessions": [active_management_row()]}

    collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                   now=200.0, monotonic=20.0)
    result = collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                              now=210.0, monotonic=30.0)

    assert result["sessions"][0]["metrics"]["cpu_percent"] == {
        "state": "derived",
        "source": "procfs-stat",
        "value": 5.0,
        "observed_at": 210.0,
        "window": {"start": 20.0, "end": 30.0},
        "reason": None,
    }


def test_refresh_inside_cadence_reuses_only_safe_cached_scalars():
    """A page refresh cannot cause a second procfs read before the ten-second bound."""
    reader_calls = []
    snapshot_calls = []

    def read_process(pid):
        reader_calls.append(pid)
        return {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192}

    collector = make_collector(
        process_snapshot=lambda: (snapshot_calls.append(True) or {101: object(), 202: object()}),
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=read_process,
    )
    management = {"state": "observed", "sessions": [active_management_row()]}

    collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                   now=200.0, monotonic=20.0)
    result = collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                              now=201.0, monotonic=21.0)

    assert reader_calls == [202]
    assert len(snapshot_calls) == 3  # first pre/post pair, then one cache-witness view
    assert result["sessions"][0]["metrics"]["rss_bytes"]["observed_at"] == 200.0
    assert result["sessions"][0]["metrics"]["cpu_percent"]["reason"] == "first-sample"


def test_non_live_rows_never_select_or_read_an_arbitrary_process():
    """Stopped, recovery and external inventory evidence is not process authority."""
    reader_calls = []
    rows = [
        {
            "name": None, "created": None, "source": "external", "agent_type": "claude",
            "lifecycle": "active", "last_observed_agent_status": "waiting",
            "time_basis": "unknown", "time": None,
        },
        {
            "name": "stopped", "created": 10.0, "source": "observed-stop", "agent_type": "codex",
            "lifecycle": "stopped-observed", "last_observed_agent_status": "idle",
            "time_basis": "observed_stopped_at", "time": 20.0,
        },
        {
            "name": "lost", "created": 10.0, "source": "restart-recovery", "agent_type": "codex",
            "lifecycle": "lost-recovery", "last_observed_agent_status": "unknown",
            "time_basis": "lost_at", "time": 20.0,
        },
    ]
    collector = make_collector(
        process_snapshot=lambda: (_ for _ in ()).throw(AssertionError("no discovery")),
        association_for_session=lambda *_args: (_ for _ in ()).throw(AssertionError("no association")),
        read_process=lambda pid: reader_calls.append(pid),
    )

    result = collector.enrich(raw=[], management={"state": "observed", "sessions": rows},
                              listed=True, now=30.0, monotonic=30.0)

    assert reader_calls == []
    for row in result["sessions"]:
        for key in ("rss_bytes", "cpu_percent"):
            assert row["metrics"][key] == {
                "state": "unknown",
                "source": "not-current-mesh-agent",
                "value": None,
                "observed_at": None,
                "window": None,
                "reason": "not-live",
            }
        assert row["metrics"]["tokens"] == {
            "state": "unavailable",
            "source": "no-approved-adapter",
            "value": None,
            "observed_at": None,
            "window": None,
            "reason": "not-collected",
        }


def test_unavailable_ptyhost_authority_forms_no_process_association():
    """An outage keeps lifecycle facts but never turns raw remnants into a sample."""
    collector = make_collector(
        process_snapshot=lambda: (_ for _ in ()).throw(AssertionError("no discovery")),
        association_for_session=lambda *_args: (_ for _ in ()).throw(AssertionError("no association")),
        read_process=lambda _pid: (_ for _ in ()).throw(AssertionError("no procfs")),
    )

    result = collector.enrich(
        raw=[ptyhost_row()], management={"state": "unavailable", "sessions": [active_management_row()]},
        listed=False, now=200.0, monotonic=20.0,
    )

    assert result["observability"]["state"] == "unavailable"
    for key in ("rss_bytes", "cpu_percent"):
        assert result["sessions"][0]["metrics"][key] == {
            "state": "unknown",
            "source": "not-current-mesh-agent",
            "value": None,
            "observed_at": None,
            "window": None,
            "reason": "not-live",
        }


def test_changed_association_discards_the_read_instead_of_relabeling_it():
    """A process swap during a procfs read is an explicit unknown result."""
    associations = iter([(202, "codex"), (303, "codex")])
    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object(), 303: object()},
        association_for_session=lambda _procs, _sid: next(associations),
        read_process=lambda _pid: {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
    )

    metric = collector.enrich(
        raw=[ptyhost_row()], management={"state": "observed", "sessions": [active_management_row()]},
        listed=True, now=200.0, monotonic=20.0,
    )["sessions"][0]["metrics"]

    assert metric["rss_bytes"] == {
        "state": "unknown",
        "source": "not-recognized-agent",
        "value": None,
        "observed_at": 200.0,
        "window": None,
        "reason": "association-changed",
    }
    assert metric["cpu_percent"] == {
        "state": "unknown",
        "source": "not-recognized-agent",
        "value": None,
        "observed_at": 200.0,
        "window": None,
        "reason": "association-changed",
    }


def test_shell_pid_replacement_invalidates_a_cached_resource_witness():
    """A same-name Mesh row cannot reuse or immediately replace a changed witness."""
    reader_calls = []
    raw_before = ptyhost_row()
    raw_after = {**ptyhost_row(), "pid": 102}

    def association(_procs, shell_pid):
        return ({101: (202, "codex"), 102: (303, "codex")}.get(shell_pid))

    def read_process(agent_pid):
        reader_calls.append(agent_pid)
        return {
            202: {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
            303: {"sid": 102, "start_ticks": 88, "cpu_ticks": 4, "rss_bytes": 4096},
        }[agent_pid]

    collector = make_collector(
        process_snapshot=lambda: {101: object(), 102: object(), 202: object(), 303: object()},
        association_for_session=association,
        read_process=read_process,
        read_start_ticks=lambda pid: {101: 55, 102: 66, 202: 77, 303: 88}[pid],
    )
    management = {"state": "observed", "sessions": [active_management_row()]}

    collector.enrich(raw=[raw_before], management=management, listed=True, now=200.0, monotonic=20.0)
    changed = collector.enrich(
        raw=[raw_after], management=management, listed=True, now=201.0, monotonic=21.0,
    )["sessions"][0]["metrics"]
    metrics = collector.enrich(
        raw=[raw_after], management=management, listed=True, now=202.0, monotonic=22.0,
    )["sessions"][0]["metrics"]

    assert reader_calls == [202, 303]
    assert changed["rss_bytes"]["state"] == "unknown"
    assert changed["rss_bytes"]["reason"] == "association-changed"
    assert metrics["rss_bytes"]["value"] == 4096
    assert metrics["cpu_percent"]["state"] == "unknown"
    assert metrics["cpu_percent"]["reason"] == "first-sample"


def test_same_pid_new_start_tick_invalidates_a_cached_resource_witness():
    """PID/type equality is insufficient: a new start tick becomes unknown first."""
    reader_calls = []
    readings = iter([
        {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
        {"sid": 101, "start_ticks": 78, "cpu_ticks": 4, "rss_bytes": 4096},
    ])
    start_ticks = iter((11, 77, 11, 77, 11, 78, 11, 78, 11, 78))
    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda pid: (reader_calls.append(pid) or next(readings)),
        read_start_ticks=lambda _pid: next(start_ticks),
    )
    management = {"state": "observed", "sessions": [active_management_row()]}

    collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                     now=200.0, monotonic=20.0)
    changed = collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                                now=201.0, monotonic=21.0)["sessions"][0]["metrics"]
    metrics = collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                                now=202.0, monotonic=22.0)["sessions"][0]["metrics"]

    assert reader_calls == [202, 202]
    assert changed["rss_bytes"]["state"] == "unknown"
    assert changed["rss_bytes"]["reason"] == "association-changed"
    assert metrics["rss_bytes"]["value"] == 4096
    assert metrics["cpu_percent"]["state"] == "unknown"
    assert metrics["cpu_percent"]["reason"] == "first-sample"


def test_same_pid_type_with_changed_post_read_start_tick_is_rejected():
    """A PID reused during one sample becomes unknown, never a relabelled scalar."""
    start_ticks = iter((11, 77, 11, 78))
    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda _pid: {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
        read_start_ticks=lambda _pid: next(start_ticks),
    )

    metrics = collector.enrich(
        raw=[ptyhost_row()], management={"state": "observed", "sessions": [active_management_row()]},
        listed=True, now=200.0, monotonic=20.0,
    )["sessions"][0]["metrics"]

    for key in ("rss_bytes", "cpu_percent"):
        assert metrics[key]["state"] == "unknown"
        assert metrics[key]["reason"] == "association-changed"


def test_default_association_reads_comm_but_never_cmdline(monkeypatch):
    """The production collector must not touch argv even when a comm is unfamiliar."""
    monkeypatch.setattr(
        observability.discover, "cmdline",
        lambda _pid: (_ for _ in ()).throw(AssertionError("argv must stay unread")),
    )
    processes = {
        101: ("bash", "S", 1, 101, 101, 0, 101),
        202: ("codex", "S", 101, 101, 101, 0, 101),
        303: ("node", "S", 101, 101, 101, 0, 101),
    }
    collector = make_collector(
        process_snapshot=lambda: processes,
        read_process=lambda _pid: {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
        read_start_ticks=lambda _pid: 77,
    )

    metrics = collector.enrich(
        raw=[ptyhost_row()], management={"state": "observed", "sessions": [active_management_row()]},
        listed=True, now=200.0, monotonic=20.0,
    )["sessions"][0]["metrics"]

    assert metrics["rss_bytes"]["state"] == "reported"
    assert metrics["cpu_percent"]["reason"] == "first-sample"


def test_procfs_failure_and_process_replacement_do_not_reuse_old_cpu():
    """Failure is unavailable; a fresh incarnation gets a fresh unknown baseline."""
    failure = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda _pid: None,
    )
    management = {"state": "observed", "sessions": [active_management_row()]}
    unavailable = failure.enrich(raw=[ptyhost_row()], management=management, listed=True,
                                 now=200.0, monotonic=20.0)["sessions"][0]["metrics"]
    assert unavailable["rss_bytes"]["state"] == "unavailable"
    assert unavailable["cpu_percent"]["reason"] == "procfs-unavailable"

    readings = iter([{"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192}])
    start_ticks = iter((11, 77, 11, 77, 11, 78))
    replacement = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda _pid: next(readings),
        read_start_ticks=lambda _pid: next(start_ticks),
    )
    replacement.enrich(raw=[ptyhost_row()], management=management, listed=True,
                       now=200.0, monotonic=20.0)
    changed = replacement.enrich(raw=[ptyhost_row()], management=management, listed=True,
                                 now=210.0, monotonic=30.0)["sessions"][0]["metrics"]
    assert changed["rss_bytes"]["state"] == "unknown"
    assert changed["cpu_percent"]["state"] == "unknown"
    assert changed["cpu_percent"]["reason"] == "association-changed"


def test_raw_procfs_and_metadata_canaries_never_reach_closed_projection():
    """Only the fixed scalars cross from raw ptyhost/procfs inputs to JSON."""
    raw = ptyhost_row()
    raw["meta"] = {"argv": "private argv", "prompt": "private prompt", "token": "private credential"}
    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda _pid: {"sid": 101, "start_ticks": 222222, "cpu_ticks": 40, "rss_bytes": 8192},
        read_start_ticks=lambda pid: {101: 111111, 202: 222222}[pid],
    )

    result = collector.enrich(raw=[raw], management={"state": "observed", "sessions": [active_management_row()]},
                              listed=True, now=200.0, monotonic=20.0)

    text = json.dumps(result)
    for private in ("private argv", "private prompt", "private credential", "101", "202", "111111", "222222", "40"):
        assert private not in text


def test_zero_cpu_is_a_numeric_measurement_not_an_absence(monkeypatch):
    """A real no-CPU interval stays distinct from first-sample unknown."""
    readings = iter([
        {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
        {"sid": 101, "start_ticks": 77, "cpu_ticks": 40, "rss_bytes": 8192},
    ])
    monkeypatch.setattr(observability, "_clock_ticks", lambda: 10)
    collector = make_collector(
        process_snapshot=lambda: {101: object(), 202: object()},
        association_for_session=lambda _procs, sid: (202, "codex") if sid == 101 else None,
        read_process=lambda _pid: next(readings),
    )
    management = {"state": "observed", "sessions": [active_management_row()]}

    collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                   now=200.0, monotonic=20.0)
    metric = collector.enrich(raw=[ptyhost_row()], management=management, listed=True,
                              now=210.0, monotonic=30.0)["sessions"][0]["metrics"]["cpu_percent"]

    assert metric["state"] == "derived"
    assert metric["value"] == 0.0
    assert metric["reason"] is None


def test_sampling_cap_is_deterministic_and_never_selects_overflow_processes():
    """At most 200 current identities get a process read; overflow is explicit unknown."""
    reader_calls, snapshot_calls = [], []
    rows, raw = [], []
    for index in range(observability.MAX_TRACKED_IDENTITIES + 1):
        name = f"s{index:03d}"
        pid = 1_000 + index
        rows.append({
            "name": name, "created": float(index), "source": "mesh", "agent_type": "codex",
            "lifecycle": "active", "last_observed_agent_status": "busy",
            "time_basis": "created", "time": float(index),
        })
        raw.append({"name": name, "created": float(index), "pid": pid, "cwd": "/tmp",
                    "activity": float(index), "attached": 0, "meta": {}})

    collector = make_collector(
        process_snapshot=lambda: (snapshot_calls.append(True) or {}),
        association_for_session=lambda _procs, sid: (sid + 10_000, "codex"),
        read_process=lambda pid: (reader_calls.append(pid) or {
            "sid": pid - 10_000, "start_ticks": pid, "cpu_ticks": 1, "rss_bytes": 4096,
        }),
        read_start_ticks=lambda pid: pid,
    )
    result = collector.enrich(raw=raw, management={"state": "observed", "sessions": rows},
                              listed=True, now=300.0, monotonic=30.0)

    assert len(reader_calls) == observability.MAX_TRACKED_IDENTITIES
    assert len(snapshot_calls) == 2
    overflow = result["sessions"][-1]["metrics"]
    assert overflow["rss_bytes"]["state"] == "unknown"
    assert overflow["rss_bytes"]["reason"] == "sampling-capacity"
