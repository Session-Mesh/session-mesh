# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Bounded, evidence-labelled portfolio facts."""

import asyncio

import portfolio
import server


def session(name, created, cwd, **extra):
    return {"id": name, "name": name, "created": created, "cwd": cwd,
            "agent": {"name": "codex", "status": "busy", "pid": 99,
                      "argv": ["codex"], "last": "private prompt", "said": "private reply"},
            "cmd": "secret command", "label": "private label", "activity": 7.0, **extra}


def test_groups_exact_observed_directories_and_whitelists_session_fields():
    result = portfolio.observed_inventory([
        session("later", 2.0, "/work/a"), session("earlier", 1.0, "/work/a"),
        session("same-name-different-path", 3.0, "/other/a"),
    ], listed=True, observed_at=42.0)

    assert result["observed_at"] == 42.0
    assert result["source"] == "ptyhost+proc"
    assert result["mesh_sessions"]["state"] == "observed"
    assert [(d["cwd"], [s["name"] for s in d["sessions"]])
            for d in result["mesh_sessions"]["directories"]] == [
                ("/other/a", ["same-name-different-path"]), ("/work/a", ["earlier", "later"])]
    row = result["mesh_sessions"]["directories"][1]["sessions"][0]
    assert row == {"id": "earlier", "name": "earlier", "created": 1.0,
                   "agent": {"status": "busy"}, "activity": 7.0}
    assert "private" not in repr(result)
    assert "codex" not in repr(result)  # metadata name is not a closed vocabulary
    assert result["worktrees"] == {"state": "not-collected"}
    assert result["historical_state"] == {"state": "not-collected"}


def test_missing_cwd_is_explicitly_unlocated_not_a_guessed_directory():
    result = portfolio.observed_inventory([session("unknown", 1.0, None)], listed=True, observed_at=42.0)
    assert result["mesh_sessions"]["directories"] == []
    assert [s["name"] for s in result["mesh_sessions"]["unlocated"]] == ["unknown"]


def test_unavailable_listing_is_not_an_empty_observed_inventory():
    result = portfolio.observed_inventory([], listed=False, observed_at=42.0)
    assert result["mesh_sessions"] == {"state": "unavailable"}
    assert "directories" not in result["mesh_sessions"]


def test_invalid_records_do_not_create_an_inferred_entry():
    result = portfolio.observed_inventory([
        {}, {"name": "bad-created", "created": True, "cwd": "/x"},
        {"name": "ok", "created": 1, "cwd": "/x", "agent": "not-an-object"},
    ], listed=True, observed_at=42.0)
    assert result["mesh_sessions"]["directories"] == [{"cwd": "/x", "sessions": [
        {"id": "ok", "name": "ok", "created": 1, "agent": None}]}]


async def test_owner_session_listing_carries_the_observed_projection(client, auth_cookie, pty, monkeypatch):
    monkeypatch.setattr(server.discover, "external_sessions", lambda *a, **k: [])
    async def unavailable(*_):
        return {"state": "unavailable"}
    monkeypatch.setattr(portfolio, "_run_observer", unavailable)
    await pty.new("inventory")
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    inventory = data["portfolio"]
    assert inventory["mesh_sessions"]["state"] == "observed"
    assert inventory["source"] == "ptyhost+proc"
    assert inventory["worktrees"]["state"] == "observed"
    assert inventory["worktrees"]["source"] == portfolio.OBSERVER_SOURCE
    assert inventory["historical_state"] == {"state": "not-collected"}
    assert [s["name"] for row in inventory["mesh_sessions"]["directories"]
            for s in row["sessions"]] == ["inventory"]


async def test_contextual_diff_route_uses_only_a_fresh_selector_and_exact_revalidated_cwd(client, auth_cookie, pty, monkeypatch):
    async def observed(*_):
        return {"state": "observed", "worktrees": []}
    monkeypatch.setattr(portfolio, "_run_observer", observed)
    called = []

    async def contextual(executable, cwd):
        called.append((executable, cwd))
        return {"state": "observed", "files": ["safe.py"], "unified": "<b>diff</b>"}
    monkeypatch.setattr(portfolio, "_run_contextual_diff", contextual)
    await pty.new("contextual")
    listing = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    row = listing["portfolio"]["mesh_sessions"]["directories"][0]
    selector = row["diff_selector"]
    response = await client.get(f"/api/portfolio/diff/{selector}", headers=auth_cookie)
    assert response.status == 200
    assert await response.json() == {"state": "observed", "files": ["safe.py"], "unified": "<b>diff</b>"}
    assert called == [(portfolio.contextual_diff_path(server.ROOT), row["cwd"])]
    assert (await client.get(f"/api/portfolio/diff/{selector}?cwd=/forged", headers=auth_cookie)).status == 404
    assert (await client.get("/api/portfolio/diff/forged", headers=auth_cookie)).status == 404

    async def changed_live(_):
        return [{"name": "contextual", "created": 999, "cwd": row["cwd"]}]
    monkeypatch.setattr(server.ptyhost, "request", changed_live)
    assert (await client.get(f"/api/portfolio/diff/{selector}", headers=auth_cookie)).status == 404
    assert len(called) == 1


async def test_worktree_collection_uses_only_bounded_observed_cwds_and_keeps_states_distinct(tmp_path):
    inventory = portfolio.observed_inventory([
        session(f"s{i}", i, f"/work/{i}") for i in range(portfolio.MAX_DIRECTORIES + 2)
    ], listed=True, observed_at=42.0)
    calls = []

    async def runner(executable, cwd):
        calls.append((executable, cwd))
        if cwd.endswith("/0"):
            return {"state": "observed", "worktrees": [{"path": cwd, "head": None, "branch": None,
                                                            "detached": False, "bare": False}]}
        if cwd.endswith("/1"):
            return {"state": "not-a-repository"}
        return {"state": "invalid-output"}

    await portfolio.collect_worktrees(inventory, root=tmp_path, observed_at=43.0, runner=runner)
    rows = inventory["worktrees"]["directories"]
    assert len(calls) == portfolio.MAX_DIRECTORIES
    assert len(rows) == portfolio.MAX_DIRECTORIES
    assert rows[0] == {"cwd": "/work/0", "state": "observed", "source": portfolio.OBSERVER_SOURCE,
                       "observed_at": 43.0, "worktrees": [{
        "path": "/work/0", "head": None, "branch": None, "detached": False, "bare": False}]}
    assert rows[1] == {"cwd": "/work/1", "state": "not-a-repository", "source": portfolio.OBSERVER_SOURCE,
                       "observed_at": 43.0}
    assert rows[2] == {"cwd": "/work/10", "state": "invalid-output", "source": portfolio.OBSERVER_SOURCE,
                       "observed_at": 43.0}
    assert all(path.parent == tmp_path / "_opam" / "bin" for path, _ in calls)


def test_observer_contract_is_closed_and_rejects_extra_or_private_fields():
    assert portfolio.parse_observer_output('{"state":"not-a-repository"}') == {"state": "not-a-repository"}
    assert portfolio.parse_observer_output('{"state":"observed","worktrees":[{"path":"/x","head":null,"branch":"main","detached":false,"bare":false}]}') == {
        "state": "observed", "worktrees": [{"path": "/x", "head": None, "branch": "main", "detached": False, "bare": False}]}
    assert portfolio.parse_observer_output('{"state":"observed","worktrees":[],"stderr":"secret"}') == {"state": "invalid-output"}
    assert portfolio.parse_observer_output('{"state":"observed","worktrees":[{"path":"/x","head":null,"branch":null,"detached":false,"bare":false,"status":"dirty"}]}') == {"state": "invalid-output"}


def test_diff_selector_is_opaque_signed_short_lived_and_revalidates_exact_incarnation_and_cwd():
    portfolio._diff_selectors.clear()
    key = b"test-selector-key"
    inventory = portfolio.observed_inventory([session("diff", 7.0, "/only/observed")], listed=True, observed_at=10)
    inventory["worktrees"] = {"state": "observed", "directories": [
        {"cwd": "/only/observed", "state": "observed"}]}
    portfolio.attach_diff_selectors(inventory, key=key, now=10)
    row = inventory["mesh_sessions"]["directories"][0]
    selector = row["diff_selector"]
    assert "/only/observed" not in selector and "diff" not in selector
    assert portfolio.revalidate_diff_selector(selector, [{"name": "diff", "created": 7.0,
                                                            "cwd": "/only/observed"}], key=key, now=11) == "/only/observed"
    assert portfolio.revalidate_diff_selector(selector + "x", [{"name": "diff", "created": 7.0,
                                                                   "cwd": "/only/observed"}], key=key, now=11) is None
    assert portfolio.revalidate_diff_selector(selector, [{"name": "diff", "created": 8.0,
                                                           "cwd": "/only/observed"}], key=key, now=11) is None
    assert portfolio.revalidate_diff_selector(selector, [{"name": "diff", "created": 7.0,
                                                           "cwd": "/changed"}], key=key, now=11) is None
    assert portfolio.resolve_diff_selector(selector, key=key, now=10 + portfolio.DIFF_SELECTOR_TTL_SECONDS + 1) is None


def test_diff_selector_is_not_issued_for_an_unobserved_or_indeterminate_directory():
    portfolio._diff_selectors.clear()
    inventory = portfolio.observed_inventory([session("diff", 7.0, "/only/observed")], listed=True, observed_at=10)
    inventory["worktrees"] = {"state": "observed", "directories": [
        {"cwd": "/only/observed", "state": "unavailable"}]}
    portfolio.attach_diff_selectors(inventory, key=b"test-selector-key", now=10)
    assert "diff_selector" not in inventory["mesh_sessions"]["directories"][0]


def test_contextual_diff_contract_is_closed_and_bounded():
    assert portfolio.parse_contextual_diff_output('{"state":"observed","files":["a.py"],"unified":"<script>"}') == {
        "state": "observed", "files": ["a.py"], "unified": "<script>"}
    assert portfolio.parse_contextual_diff_output('{"state":"observed","files":[],"unified":"","stderr":"secret"}') == {
        "state": "invalid-output"}
    assert portfolio.parse_contextual_diff_output('{"state":"observed","files":[7],"unified":""}') == {"state": "invalid-output"}
    assert portfolio.parse_contextual_diff_output('{"state":"observed","files":["\\ud800"],"unified":""}') == {"state": "invalid-output"}
    assert portfolio.parse_contextual_diff_output('{"state":"observed","files":[],"unified":"\\ud800"}') == {"state": "invalid-output"}
    assert portfolio.parse_contextual_diff_output('{"state":"clean"}') == {"state": "clean"}
    assert portfolio.parse_contextual_diff_output('{"state":"over-limit"}') == {"state": "over-limit"}
    assert portfolio.parse_contextual_diff_output('{"state":"clean","files":[]}') == {"state": "invalid-output"}
    assert portfolio.parse_contextual_diff_output('{"state":"unavailable","files":[]}') == {"state": "invalid-output"}


class _Stream:
    def __init__(self, result=None, wait=False):
        self.result, self.wait = result, wait

    async def read(self, _limit):
        if self.wait:
            await asyncio.Event().wait()
        return self.result


class _Process:
    def __init__(self, output=b"", code=0, never_reap=False):
        self.stdout = _Stream(output)
        self.code, self.never_reap = code, never_reap
        self.returncode = None
        self.terminated = self.killed = False

    async def wait(self):
        if self.never_reap:
            await asyncio.Event().wait()
        self.returncode = self.code
        return self.code

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


async def test_observer_executes_only_fixed_binary_with_one_cwd_and_closed_stdio(tmp_path, monkeypatch):
    executable = portfolio.observer_path(tmp_path)
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/false")
    executable.chmod(0o700)
    proc = _Process(b'{"state":"not-a-repository"}\n')
    called = {}

    async def create(*args, **kwargs):
        called["args"], called["kwargs"] = args, kwargs
        return proc

    monkeypatch.setattr(portfolio.asyncio, "create_subprocess_exec", create)
    assert await portfolio._run_observer(executable, "/only/observed/cwd") == {"state": "not-a-repository"}
    assert called["args"] == (str(executable), "/only/observed/cwd")
    assert called["kwargs"]["stdin"] is asyncio.subprocess.DEVNULL
    assert called["kwargs"]["stderr"] is asyncio.subprocess.DEVNULL
    assert called["kwargs"]["stdout"] is asyncio.subprocess.PIPE
    assert "shell" not in called["kwargs"]


async def test_contextual_diff_executes_only_fixed_binary_with_one_cwd_and_closed_stdio(tmp_path, monkeypatch):
    executable = portfolio.contextual_diff_path(tmp_path)
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/false")
    executable.chmod(0o700)
    proc = _Process(b'{"state":"observed","files":["a.py"],"unified":"diff --git"}')
    called = {}

    async def create(*args, **kwargs):
        called["args"], called["kwargs"] = args, kwargs
        return proc

    monkeypatch.setattr(portfolio.asyncio, "create_subprocess_exec", create)
    assert await portfolio._run_contextual_diff(executable, "/only/revalidated/cwd") == {
        "state": "observed", "files": ["a.py"], "unified": "diff --git"}
    assert called["args"] == (str(executable), "/only/revalidated/cwd")
    assert called["kwargs"]["stdin"] is asyncio.subprocess.DEVNULL
    assert called["kwargs"]["stderr"] is asyncio.subprocess.DEVNULL
    assert called["kwargs"]["stdout"] is asyncio.subprocess.PIPE
    assert "shell" not in called["kwargs"]


async def test_contextual_diff_never_returns_partial_output_after_budget_or_decoding_failure(tmp_path, monkeypatch):
    executable = portfolio.contextual_diff_path(tmp_path)
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/false")
    executable.chmod(0o700)
    oversized = _Process(b'{"state":"observed","files":["secret.py"],"unified":"' +
                         b"x" * portfolio.MAX_OUTPUT_BYTES)
    timed_out = _Process()
    timed_out.stdout = _Stream(wait=True)
    cases = iter([_Process(b'\xff'), oversized, timed_out])

    async def create(*_args, **_kwargs):
        return next(cases)

    monkeypatch.setattr(portfolio.asyncio, "create_subprocess_exec", create)
    assert await portfolio._run_contextual_diff(executable, "/cwd") == {"state": "invalid-output"}
    assert await portfolio._run_contextual_diff(executable, "/cwd") == {"state": "unavailable"}
    monkeypatch.setattr(portfolio, "OBSERVER_TIMEOUT_SECONDS", 0.001)
    assert await portfolio._run_contextual_diff(executable, "/cwd") == {"state": "unavailable"}
    assert timed_out.terminated


async def test_observer_treats_invalid_utf8_nonzero_and_oversized_output_as_nonfacts(tmp_path, monkeypatch):
    executable = portfolio.observer_path(tmp_path)
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/false")
    executable.chmod(0o700)
    cases = iter([
        _Process(b"\xff"),
        _Process(b'{"state":"observed","worktrees":[]}', code=2),
        _Process(b"x" * (portfolio.MAX_OUTPUT_BYTES + 1)),
    ])

    async def create(*_args, **_kwargs):
        return next(cases)

    monkeypatch.setattr(portfolio.asyncio, "create_subprocess_exec", create)
    assert await portfolio._run_observer(executable, "/cwd") == {"state": "invalid-output"}
    assert await portfolio._run_observer(executable, "/cwd") == {"state": "unavailable"}
    assert await portfolio._run_observer(executable, "/cwd") == {"state": "unavailable"}


async def test_observer_timeout_is_bounded_and_unavailable(tmp_path, monkeypatch):
    executable = portfolio.observer_path(tmp_path)
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/false")
    executable.chmod(0o700)
    proc = _Process()
    proc.stdout = _Stream(wait=True)

    async def create(*_args, **_kwargs):
        return proc

    monkeypatch.setattr(portfolio.asyncio, "create_subprocess_exec", create)
    monkeypatch.setattr(portfolio, "OBSERVER_TIMEOUT_SECONDS", 0.001)
    assert await portfolio._run_observer(executable, "/cwd") == {"state": "unavailable"}
    assert proc.terminated


async def test_stop_process_never_waits_indefinitely_after_kill():
    proc = _Process(never_reap=True)
    await portfolio._stop_process(proc)
    assert proc.terminated and proc.killed
