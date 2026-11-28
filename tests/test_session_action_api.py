# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Owner-approved session lifecycle requests never grant mutation to MCP."""

import pytest
import asyncio
import shlex
import threading
from pathlib import Path
from types import SimpleNamespace

import resumeargs
import launchsettings
import session_helpers
import sessionrequests
import server
from session_helpers import add_session


def agent(sessions):
    headers = add_session(sessions, "alpha")
    sessions[0].update(pid=1, activity=1.0, attached=0, cwd=str(Path.home()))
    sessions[0]["meta"]["known_agent"] = "codex"
    return headers


@pytest.mark.parametrize("reader_kind", ["configuration", "approval"])
@pytest.mark.parametrize("guarded", [True, False], ids=["real-lock", "lock-bypassed-mutant"])
def test_options_projection_keeps_options_and_revision_from_same_save(monkeypatch, reader_kind, guarded):
    entered, release, attempted, done = threading.Event(), threading.Event(), threading.Event(), threading.Event()

    class ObservedLock:
        def __init__(self):
            self.lock = threading.Lock()

        def __enter__(self):
            if threading.current_thread().name == "options-writer":
                attempted.set()
            if guarded:
                self.lock.acquire()

        def __exit__(self, *_args):
            if guarded:
                self.lock.release()

    class PausedOptions(dict):
        def items(self):
            entered.set()
            assert release.wait(timeout=2)
            return super().items()
    monkeypatch.setattr(server, "AGENT_OPTIONS_LOCK", ObservedLock())
    monkeypatch.setattr(server, "AGENT_OPTIONS", PausedOptions({"codex": ("--before",)}))
    monkeypatch.setattr(server, "AGENT_OPTIONS_REVISION", "before")
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", None)
    if reader_kind == "approval":
        original = server.stored_options
        def paused(kind):
            entered.set()
            assert release.wait(timeout=2)
            return original(kind)
        monkeypatch.setattr(server, "stored_options", paused)
    result = []
    def read():
        if reader_kind == "configuration":
            projection = server.launch_projection()
            result.append((projection["agent_options"]["codex"], projection["agent_options_revision"]))
        else:
            projection = server._with_launch_options({"action": "create", "preset": "codex"})
            result.append((projection["options"], projection["options_revision"]))
    reader = threading.Thread(target=read)
    def write():
        server.apply_agent_options({"codex": ("--after",)}, "after")
        done.set()
    writer = threading.Thread(target=write, name="options-writer")
    reader.start()
    try:
        assert entered.wait(timeout=2)
        writer.start()
        assert attempted.wait(timeout=2)
        if guarded:
            assert not done.wait(timeout=0.05)
        else:
            assert done.wait(timeout=2)
    finally:
        release.set()
        reader.join(timeout=2)
        if writer.ident is not None:
            writer.join(timeout=2)
    assert not reader.is_alive() and not writer.is_alive()
    if guarded:
        assert result == [("--before", "before")]
    else:
        assert result == ([("--before", "after")] if reader_kind == "configuration" else [("--after", "before")])


def test_options_save_without_launch_settings_file(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LAUNCH_REVISION", None)
    monkeypatch.setattr(server, "AGENT_OPTIONS", {})
    monkeypatch.setattr(server, "AGENT_OPTIONS_REVISION", None)
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", None)
    projection = server.launch_projection()
    assert projection["editable"] is False and projection["agent_options_editable"] is True
    path = tmp_path / "options.json"
    changes = server._agent_option_changes({"codex": "--search"})
    stored, revision = launchsettings.write_agent_options(path, changes, projection["agent_options_revision"] or None)
    assert stored == {"codex": ("--search",)} and revision
    with pytest.raises(launchsettings.ConflictError):
        launchsettings.write_agent_options(path, changes, None)


async def test_create_approval_binds_options_across_save_and_repeated_decision(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    monkeypatch.setattr(server, "AGENT_OPTIONS", {"codex": ("--before",)})
    monkeypatch.setattr(server, "AGENT_OPTIONS_REVISION", "before")
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", None)
    entered, release = asyncio.Event(), asyncio.Event()
    observed = []

    async def execute(item, create_nonce=None):
        entered.set()
        await release.wait()
        observed.append(item["_approved_options"])
        return {"id": "created"}

    monkeypatch.setattr(server, "_execute_session_action", execute)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    claimed = await client.post(f"/api/session-actions/{request_id}/claim", headers=auth_cookie,
                                json={"tab_nonce": "a" * 32})
    nonce = (await claimed.json())["claim_nonce"]
    url = f"/api/session-actions/{request_id}/decision"
    assert (await client.post(url, headers=auth_cookie,
                              json={"approve": True, "claim_nonce": nonce})).status == 400
    pending = asyncio.create_task(client.post(url, headers=auth_cookie,
                                  json={"approve": True, "claim_nonce": nonce,
                                        "options_revision": "before"}))
    await asyncio.wait_for(entered.wait(), timeout=5)
    monkeypatch.setattr(server, "AGENT_OPTIONS", {"codex": ("--after",)})
    monkeypatch.setattr(server, "AGENT_OPTIONS_REVISION", "after")
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", "unreadable")
    retry = await client.post(url, headers=auth_cookie,
                              json={"approve": True, "claim_nonce": nonce, "options_revision": "before"})
    assert retry.status == 202
    release.set()
    assert (await pending).status == 200
    assert observed == [["--before"]]


@pytest.mark.parametrize("legacy, options_error", [(False, None), (True, None), (False, "unreadable")])
async def test_recovered_create_executes_approved_options_not_current_options(
        tmp_path, monkeypatch, legacy, options_error):
    path = tmp_path / "actions.sqlite3"
    first = sessionrequests.Requests(path, clock=lambda: 10.0)
    source = {"id": "alpha", "created": 1.0, "agent": "codex", "cwd": str(Path.home())}
    made = first.create(source, {"action": "create", "preset": "codex"},
                        enabled_agents={"codex"}, resumable={"codex"})
    claim = first.claim(made["id"], "a" * 32)
    first.decide(made["id"], True, claim["claim_nonce"], approved_options=["--search"],
                 options_revision="approved-revision")
    if legacy:
        first._db.execute("UPDATE session_requests SET approved_options_json = NULL WHERE id = ?", (made["id"],))
    first.close()
    recovered = sessionrequests.Requests(path, clock=lambda: 11.0)
    monkeypatch.setattr(server, "AGENT_OPTIONS", {"codex": ("--different",)})
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", options_error)
    monkeypatch.setattr(server, "LAUNCH_SETTINGS", SimpleNamespace(allows_cwd=lambda _cwd: True))
    calls = []

    async def host(_request):
        return [{"name": "alpha", "created": 1.0, "cwd": str(Path.home())}]

    async def create(_base, _cwd, command=None, *_args, **_kwargs):
        calls.append(shlex.split(command))
        return "created"

    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(server, "new_session", create)
    app = {"session_requests": recovered, "session_action_tasks": {}}
    result = await server._run_session_action(app, made["id"])
    if options_error:
        assert result["state"] == "failed" and calls == []
        assert "The stored launch options cannot be read" in result["result"]["error"]
    elif legacy:
        assert result["state"] == "failed" and calls == []
        assert "Approved launch options unavailable" in result["result"]["error"]
    else:
        assert result["state"] == "completed"
        assert "--search" in calls[0] and "--different" not in calls[0]
    recovered.close()


def test_fence_retention_check_fails_closed_on_inaccessible_storage(monkeypatch):
    def denied(_path): raise PermissionError('denied')
    monkeypatch.setattr(server.os, 'lstat', denied)
    with pytest.raises(PermissionError):
        server._native_fence_exists('request')


@pytest.mark.parametrize('outcome', [
    {'switch_phase': 'not_stopped', 'target_copy_remains': False, 'target_copy_uncertain': False},
    {'switch_phase': 'target_start_accepted', 'id': 'alpha', 'target_copy_remains': True, 'target_copy_uncertain': False},
    None,
])
async def test_fence_release_failure_reports_known_switch_outcome_without_retry(monkeypatch, outcome):
    class Requests:
        def begin_execution(self, _request_id): return {'action': 'switch_account', 'source': {'agent': 'codex'}}
        def finish(self, _request_id, *, error, detail): return {'error': error, 'result': detail}
    async def execute(_item, nonce):
        assert nonce is None
        error = server.NativeFenceRecoveryRequired({'fence_id': 'private'}, 'Release outcome uncertain')
        error.switch_outcome = outcome
        raise error
    monkeypatch.setattr(server, '_execute_session_action', execute)
    result = await server._run_session_action({'session_requests': Requests()}, 'request')
    detail = result['result']
    assert detail['retryable'] is False and detail['operator_action'] is True
    assert detail['switch_phase'] == (outcome or {'switch_phase': 'unknown'})['switch_phase']
    assert detail['target_copy_uncertain'] == (outcome or {'target_copy_uncertain': True})['target_copy_uncertain']
    assert 'fence_id' not in str(detail)


@pytest.mark.parametrize('copied', [False, True])
async def test_failed_switch_recovery_retains_original_error_and_never_claims_rollback(monkeypatch, copied):
    class Requests:
        def begin_execution(self, _request_id):
            return {'action': 'switch_account', 'source': {'agent': 'codex'}, 'from_account': 'default'}
        def finish(self, _request_id, *, error, detail):
            return {'error': error, 'result': detail}
    async def execute(_item, nonce):
        assert nonce is None
        raise server.AccountSwitchRecoveryFailed('session', server.AccountsUnavailable('original failure', 'carry_failed'),
                                                 target_copy_remains=copied)
    monkeypatch.setattr(server, '_execute_session_action', execute)
    result = await server._run_session_action({'session_requests': Requests()}, 'request')
    assert 'original failure' in result['error']
    assert 'could not be verified' in result['error']
    assert result['result']['code'] == 'carry_failed'
    assert result['result']['rolled_back'] is False
    assert result['result']['target_copy_remains'] is copied
    assert result['result']['operator_action'] is True
    assert result['result']['retryable'] is False


@pytest.mark.parametrize('code', ['helper-unavailable', None, 'carry_rollback_incomplete', 'carry_restore_failed', 'unexpected-code'])
@pytest.mark.parametrize('restart_succeeds', [True, False])
async def test_uncertain_carry_never_claims_target_cleanup(monkeypatch, code, restart_succeeds):
    class Requests:
        def begin_execution(self, _request_id):
            return {'action': 'switch_account', 'source': {'agent': 'codex'}, 'from_account': 'default'}
        def finish(self, _request_id, *, error, detail):
            return {'error': error, 'result': detail}
    async def execute(_item, nonce):
        assert nonce is None
        failure = server.AccountsUnavailable('carry outcome unavailable', code)
        if restart_succeeds:
            raise server.AccountSwitchUndone('session', failure.code, str(failure))
        raise server.AccountSwitchRecoveryFailed('session', failure)
    monkeypatch.setattr(server, '_execute_session_action', execute)
    result = await server._run_session_action({'session_requests': Requests()}, 'request')
    assert result['result']['target_copy_remains'] is True
    assert result['result']['target_copy_uncertain'] is True
    assert result['result']['rolled_back'] is False
    assert result['result']['operator_action'] is True
    assert result['result']['retryable'] is False
    assert 'may remain' in result['error']


async def test_unconfirmed_target_start_retains_copy_and_requires_inspection(monkeypatch):
    class Requests:
        def begin_execution(self, _request_id): return {'action': 'switch_account', 'source': {'agent': 'codex'}, 'from_account': 'default'}
        def finish(self, _request_id, *, error, detail): return {'error': error, 'result': detail}
    async def execute(_item, nonce):
        assert nonce is None
        raise server.AccountSwitchTargetStartUnconfirmed('session')
    monkeypatch.setattr(server, '_execute_session_action', execute)
    result = await server._run_session_action({'session_requests': Requests()}, 'request')
    assert result['result']['target_copy_remains'] is True
    assert result['result']['target_copy_uncertain'] is False
    assert result['result']['rolled_back'] is False
    assert result['result']['retryable'] is False and result['result']['operator_action'] is True
    assert 'may be running' in result['error']


async def test_startup_worker_recovers_approved_but_not_uncertain_work(tmp_path, monkeypatch):
    requests = sessionrequests.Requests(tmp_path / "actions.sqlite3", clock=lambda: 10.0)
    made = requests.create({"id": "alpha", "created": 1.0, "agent": "codex", "cwd": "/work"},
                           {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    claim = requests.claim(made["id"], "a" * 32)
    requests.decide(made["id"], True, claim["claim_nonce"], approved_options=[], options_revision="rev")
    calls = []

    async def execute(item, create_nonce=None):
        assert create_nonce is not None
        calls.append(item["id"])
        return {"id": "created"}

    monkeypatch.setattr(server, "_execute_session_action", execute)
    app = {"session_requests": requests, "session_action_tasks": {}}
    await server.start_session_actions(app)
    await __import__("asyncio").gather(*tuple(app["session_action_tasks"].values()))
    assert calls == [made["id"]]
    assert requests.status(made["id"])["state"] == "completed"
    await server.start_session_actions(app)
    assert calls == [made["id"]]


@pytest.fixture
def mesh_listing(monkeypatch):
    return session_helpers.listing.__wrapped__(monkeypatch)


async def test_native_binding_stays_internal_on_all_request_responses(client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    binding = {'backend': 'codex', 'conversation': '12345678-abcd', 'agent_pid': 123, 'agent_start': '456',
               'source': {'id': 'default', 'context_revision': 'a' * 64},
               'target': {'id': 'work', 'context_revision': 'b' * 64}}
    async def switch(_source, body):
        return body, 'default', binding
    monkeypatch.setattr(server, '_switch_request', switch)
    made = await client.post('/api/session-actions/@self/request', headers=headers,
                             json={'action': 'switch_account', 'account': 'work'})
    assert made.status == 202
    item = (await made.json())['request']
    assert 'switch_binding' not in item
    stored = client.server.app['session_requests'].status(item['id'])
    assert stored['switch_binding'] == binding
    read = await client.get('/api/session-actions/@self/request', params={'id': item['id']}, headers=headers)
    assert 'switch_binding' not in (await read.json())['request']
    claim = await client.post(f"/api/session-actions/{item['id']}/claim", headers=auth_cookie,
                              json={'tab_nonce': 'a' * 32})
    claimed = await claim.json()
    assert 'switch_binding' not in claimed['request']
    rejected = await client.post(f"/api/session-actions/{item['id']}/decision", headers=auth_cookie,
                                 json={'approve': False, 'claim_nonce': claimed['claim_nonce']})
    assert 'switch_binding' not in (await rejected.json())['request']
    assert client.server.app['session_requests'].status(item['id'])['switch_binding'] == binding


async def test_session_token_only_records_intent_and_owner_rejects_it(
        client, mesh_listing, auth_cookie):
    headers = agent(mesh_listing)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "claude",
                                   "name": "review", "model": "sonnet"})
    assert made.status == 202
    request = (await made.json())["request"]
    assert request["state"] == "pending" and request["source"]["cwd"] == str(Path.home())

    status = await client.get("/api/session-actions/@self/request",
                              params={"id": request["id"]}, headers=headers)
    assert status.status == 200 and (await status.json())["request"] == request
    assert (await client.post(f"/api/session-actions/{request['id']}/decision",
                              headers=headers, json={"approve": False})).status == 401

    claimed = await client.post(f"/api/session-actions/{request['id']}/claim",
                                headers=auth_cookie, json={"tab_nonce": "a" * 32})
    claim_nonce = (await claimed.json())["claim_nonce"]
    rejected = await client.post(f"/api/session-actions/{request['id']}/decision",
                                 headers=auth_cookie,
                                 json={"approve": False, "claim_nonce": claim_nonce})
    assert rejected.status == 200
    body = (await rejected.json())["request"]
    assert body["state"] == "rejected" and body["result"] is None
    assert (await client.post(f"/api/session-actions/{request['id']}/decision",
                              headers=auth_cookie,
                              json={"approve": False, "claim_nonce": "b" * 24})).status == 409


async def test_two_owner_pages_get_one_claim_and_one_stable_decision(
        client, mesh_listing, auth_cookie):
    headers = agent(mesh_listing)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    first, second = await __import__("asyncio").gather(*(
        client.post(f"/api/session-actions/{request_id}/claim", headers=auth_cookie,
                    json={"tab_nonce": nonce * 32}) for nonce in ("a", "b")))
    assert sorted((first.status, second.status)) == [200, 409]
    winner = first if first.status == 200 else second
    loser = second if winner is first else first
    claim_nonce = (await winner.json())["claim_nonce"]
    assert (await loser.json())["request"]["state"] == "claimed"
    rejected = await client.post(f"/api/session-actions/{request_id}/decision",
                                 headers=auth_cookie,
                                 json={"approve": False, "claim_nonce": claim_nonce})
    assert rejected.status == 200
    assert (await client.post(f"/api/session-actions/{request_id}/decision",
                              headers=auth_cookie,
                              json={"approve": True, "claim_nonce": "z" * 24,
                                    "options_revision": server.AGENT_OPTIONS_REVISION or ""})).status == 409
    assert (await rejected.json())["request"]["state"] == "rejected"


async def test_two_pages_with_same_tab_nonce_cannot_recover_winner_secret(
        client, mesh_listing, auth_cookie):
    headers = agent(mesh_listing)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    first, duplicate = await __import__("asyncio").gather(*(
        client.post(f"/api/session-actions/{request_id}/claim",
                    headers=auth_cookie, json={"tab_nonce": "a" * 32})
        for _ in range(2)))
    if duplicate.status == 200:
        first, duplicate = duplicate, first
    assert first.status == 200
    secret = (await first.json())["claim_nonce"]
    assert duplicate.status == 409
    assert "claim_nonce" not in await duplicate.json()
    renewed = await client.post(f"/api/session-actions/{request_id}/claim",
                                headers=auth_cookie,
                                json={"tab_nonce": "a" * 32, "claim_nonce": secret})
    assert renewed.status == 200 and (await renewed.json())["claim_nonce"] == secret


async def test_lost_decision_response_is_status_replay_not_second_execution(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    calls = []

    async def new_session(*args, **kwargs):
        calls.append((args, kwargs))
        return "created-once"

    monkeypatch.setattr(server, "new_session", new_session)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    claim = await client.post(f"/api/session-actions/{request_id}/claim", headers=auth_cookie,
                              json={"tab_nonce": "a" * 32})
    secret = (await claim.json())["claim_nonce"]
    payload = {"approve": True, "claim_nonce": secret, "options_revision": server.AGENT_OPTIONS_REVISION or ""}
    first = await client.post(f"/api/session-actions/{request_id}/decision",
                              headers=auth_cookie, json=payload)
    replay = await client.post(f"/api/session-actions/{request_id}/decision",
                               headers=auth_cookie, json=payload)
    assert first.status == replay.status == 200
    assert (await replay.json())["request"]["state"] == "completed"
    assert len(calls) == 1


async def test_request_cannot_select_a_command_directory_or_other_restart_target(client, mesh_listing):
    headers = agent(mesh_listing)
    for body in (
        {"action": "create", "preset": "custom", "command": "sh"},
        {"action": "create", "preset": "codex", "cwd": "/tmp"},
        {"action": "restart", "name": "other"},
    ):
        assert (await client.post("/api/session-actions/@self/request",
                                  headers=headers, json=body)).status == 400


async def test_request_is_exactly_incarnation_bound(client, mesh_listing):
    headers = agent(mesh_listing)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    mesh_listing[0]["created"] = 2.0
    assert (await client.get("/api/session-actions/@self/request",
                             params={"id": request_id}, headers=headers)).status == 404


async def test_owner_approval_uses_current_directory_closed_preset_and_model(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    calls, chosen = [], []

    async def new_session(base, cwd, command=None, agent=None, known_agent=None, keep=32, conversation=None, nonce=None):
        assert nonce is not None
        calls.append((base, cwd, shlex.split(command), agent, known_agent, keep))
        chosen.append(conversation)
        return "review-codex"

    monkeypatch.setattr(server, "new_session", new_session)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex",
                                   "name": "review", "model": "gpt-6.1-sol"})
    request_id = (await made.json())["request"]["id"]
    claimed = await client.post(f"/api/session-actions/{request_id}/claim",
                                headers=auth_cookie, json={"tab_nonce": "a" * 32})
    claim_nonce = (await claimed.json())["claim_nonce"]
    approved = await client.post(f"/api/session-actions/{request_id}/decision",
                                 headers=auth_cookie,
                                 json={"approve": True, "claim_nonce": claim_nonce, "options_revision": server.AGENT_OPTIONS_REVISION or ""})
    assert approved.status == 200
    assert (await approved.json())["request"]["result"] == {"id": "review-codex"}
    base, cwd, argv, agent_kind, known_agent, _keep = calls[0]
    assert (base, cwd, agent_kind, known_agent) == ("review", str(Path.home()), "codex", "codex")
    assert argv[-2:] == ["--model", "gpt-6.1-sol"]
    assert argv.count("--model") == 1


async def test_claude_opus_baker_unlock_uses_the_exact_catalogue_argv(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    calls, chosen = [], []

    async def new_session(base, cwd, command=None, agent=None, known_agent=None, keep=32, conversation=None, nonce=None):
        assert nonce is not None
        calls.append((base, cwd, shlex.split(command), agent, known_agent, keep))
        chosen.append(conversation)
        return "baker-unlock"

    monkeypatch.setattr(server, "new_session", new_session)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "claude",
                                   "name": "baker-unlock", "model": "opus"})
    request_id = (await made.json())["request"]["id"]
    claimed = await client.post(f"/api/session-actions/{request_id}/claim",
                                headers=auth_cookie, json={"tab_nonce": "a" * 32})
    claim_nonce = (await claimed.json())["claim_nonce"]
    approved = await client.post(f"/api/session-actions/{request_id}/decision",
                                 headers=auth_cookie,
                                 json={"approve": True, "claim_nonce": claim_nonce, "options_revision": server.AGENT_OPTIONS_REVISION or ""})
    assert approved.status == 200
    [(_, sid, _)] = chosen      # a new Claude: the conversation id the mesh chose, appended to the catalogue argv
    assert calls == [("baker-unlock", str(Path.home()),
                      [*server._model_argv(server.AGENT_PRESETS["claude"], "opus"), "--session-id", sid],
                      "claude", "claude", 32)]


async def test_replaced_source_incarnation_cannot_execute_an_approved_request(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    spawned = False

    async def forbidden(*_args, **_kwargs):
        nonlocal spawned
        spawned = True

    monkeypatch.setattr(server, "new_session", forbidden)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    claimed = await client.post(f"/api/session-actions/{request_id}/claim",
                                headers=auth_cookie, json={"tab_nonce": "a" * 32})
    claim_nonce = (await claimed.json())["claim_nonce"]
    mesh_listing[0]["created"] = 2.0
    decided = await client.post(f"/api/session-actions/{request_id}/decision",
                                headers=auth_cookie,
                                json={"approve": True, "claim_nonce": claim_nonce, "options_revision": server.AGENT_OPTIONS_REVISION or ""})
    request = (await decided.json())["request"]
    assert decided.status == 200 and request["state"] == "failed" and not spawned
    assert "replaced" in request["result"]["error"]


async def test_restart_approval_revalidates_self_then_resumes_with_replaced_model(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    calls = []
    agent_info = {"type": "codex", "session_id": "0199aa00-0000-7000-8000-000000000001",
                  "argv": ["codex", "-m", "old-model"], "pid": 44}

    async def replace_session(old_name, old_created, base, cwd, command, agent, known_agent, account=None,
                              source=None):
        calls.append((old_name, old_created, base, cwd, shlex.split(command), agent, known_agent))
        return "alpha-2"

    def described(_listed, _observed, _read_at=None):
        # "name" too: the hook state is applied to a real listing, whose entries all have one
        return {"mesh": [{"id": "alpha", "name": "alpha", "created": 1.0, "agent": agent_info}], "external": []}

    monkeypatch.setattr(server, "replace_session", replace_session)
    monkeypatch.setattr(server, "list_sessions", described)
    monkeypatch.setattr(server.respawn, "forget_live", lambda *_args: None)

    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "restart", "model": "gpt-6.1-sol"})
    request_id = (await made.json())["request"]["id"]
    claimed = await client.post(f"/api/session-actions/{request_id}/claim",
                                headers=auth_cookie, json={"tab_nonce": "a" * 32})
    claim_nonce = (await claimed.json())["claim_nonce"]
    approved = await client.post(f"/api/session-actions/{request_id}/decision",
                                 headers=auth_cookie,
                                 json={"approve": True, "claim_nonce": claim_nonce, "options_revision": server.AGENT_OPTIONS_REVISION or ""})
    assert approved.status == 200
    assert (await approved.json())["request"]["result"] == {"id": "alpha-2"}
    assert calls[0][:4] == ("alpha", 1.0, "alpha", str(Path.home()))
    argv = calls[0][4]
    assert argv[-2:] == ["--model", "gpt-6.1-sol"] and "old-model" not in argv


async def test_approval_rechecks_workspace_policy_before_any_spawn(
        client, mesh_listing, auth_cookie, monkeypatch):
    headers = agent(mesh_listing)
    spawned = False
    monkeypatch.setattr(server, "LAUNCH_SETTINGS", SimpleNamespace(allows_cwd=lambda _cwd: False))

    async def forbidden(*_args, **_kwargs):
        nonlocal spawned
        spawned = True
        raise AssertionError("spawn must not run")

    monkeypatch.setattr(server, "new_session", forbidden)
    made = await client.post("/api/session-actions/@self/request", headers=headers,
                             json={"action": "create", "preset": "codex"})
    request_id = (await made.json())["request"]["id"]
    claimed = await client.post(f"/api/session-actions/{request_id}/claim",
                                headers=auth_cookie, json={"tab_nonce": "a" * 32})
    claim_nonce = (await claimed.json())["claim_nonce"]
    decided = await client.post(f"/api/session-actions/{request_id}/decision",
                                headers=auth_cookie,
                                json={"approve": True, "claim_nonce": claim_nonce, "options_revision": server.AGENT_OPTIONS_REVISION or ""})
    assert decided.status == 200 and not spawned
    request = (await decided.json())["request"]
    assert request["state"] == "failed" and "workspace roots" in request["result"]["error"]


async def test_restart_preparation_failure_never_stops_source(monkeypatch):
    calls = []

    async def failed_spawn(*_args, **_kwargs):
        raise server.web.HTTPServiceUnavailable(text="spawn failed")

    async def host(request):
        calls.append(request)
        return {"ok": True}

    monkeypatch.setattr(server, "new_session", failed_spawn)
    monkeypatch.setattr(server, "host", host)
    with pytest.raises(server.web.HTTPServiceUnavailable) as failure:
        await server.replace_session("old", 1.0, "old", str(Path.home()),
                                     "codex resume sid", "codex", "codex")
    assert failure.value.text == "spawn failed"
    assert calls == []


async def test_restart_starts_deferred_command_only_after_exact_source_is_stopped(monkeypatch):
    calls = []
    nonce = None

    async def prepared(*_args, **_kwargs):
        nonlocal nonce
        nonce = _kwargs["nonce"]
        calls.append(("prepare", _args))
        return "old-2"

    async def host(request):
        calls.append((request["op"], request))
        if request["op"] == "list":
            return [{"name": "old-2", "created": 2.0, "meta": {"nonce": nonce}}]
        return {"ok": True}

    monkeypatch.setattr(server, "new_session", prepared)
    monkeypatch.setattr(server, "host", host)
    assert await server.replace_session("old", 1.0, "old", str(Path.home()),
                                        "codex resume sid", "codex", "codex") == "old-2"
    assert [call[0] for call in calls] == ["prepare", "list", "list", "kill_if", "list", "list", "start_if"]
    assert calls[-1][1]["command"] == "codex resume sid"


async def test_restart_never_starts_replacement_before_source_exit(monkeypatch):
    calls = []
    nonce = None

    async def prepared(*_args, **_kwargs):
        nonlocal nonce
        nonce = _kwargs["nonce"]
        return "old-2"

    async def host(request):
        calls.append(request["op"])
        if request["op"] == "list":
            return [{"name": "old-2", "created": 2.0, "meta": {"nonce": nonce}},
                    {"name": "old", "created": 1.0}]
        return {"ok": True}

    class Clock:
        value = 0.0

        def time(self):
            self.value += 3.0
            return self.value

    async def no_wait(_delay):
        return None

    monkeypatch.setattr(server, "new_session", prepared)
    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(server.asyncio, "get_running_loop", lambda: Clock())
    monkeypatch.setattr(server.asyncio, "sleep", no_wait)
    with pytest.raises(server.web.HTTPServiceUnavailable) as failure:
        await server.replace_session("old", 1.0, "old", str(Path.home()),
                                     "codex resume sid", "codex", "codex")
    assert "still active" in failure.value.text
    assert "start_if" not in calls


@pytest.mark.parametrize("option", ["--model provider/model", "-m provider/model", "--model=provider/model",
                                    "-m=provider/model"])
async def test_opencode2_fresh_model_is_refused_before_preflight(monkeypatch, option):
    monkeypatch.setattr(server.agentmcp, "opencode_resolved", lambda _env: ("/usr/bin/opencode", 2))

    with pytest.raises(server.web.HTTPConflict) as refused:
        await server._opencode_command(f"opencode {option}", fresh=True)
    assert "model option" in refused.value.text


async def test_opencode2_resume_keeps_existing_conversion(monkeypatch):
    monkeypatch.setattr(server.agentmcp, "opencode_resolved", lambda _env: ("/usr/bin/opencode", 2))
    observed = []

    async def adapt(words, _cwd, _env):
        observed.extend(words)
        return "adapted"

    monkeypatch.setattr(server, "_opencode_v2_command", adapt)
    assert await server._opencode_command("opencode --model provider/model") == ("adapted", None)
    assert observed[-2:] == ["--model", "provider/model"]
    assert resumeargs.opencode2_command(["opencode", "--model", "provider/model"]) == ["opencode", "--standalone"]


def test_opencode2_fresh_prompt_can_contain_model_option_text():
    assert resumeargs.opencode2_command(["opencode", "--prompt", "--model"], fresh=True) == [
        "opencode", "--standalone", "--prompt", "--model"]


def test_opencode2_session_preflight_ignores_prompt_values():
    assert server._opencode_resumed_id(
        ["opencode", "--standalone", "--prompt", "--session=other", "-s=target"]
    ) == "target"


def test_opencode2_session_preflight_refuses_multiple_selectors():
    with pytest.raises(server.web.HTTPConflict) as refused:
        server._opencode_resumed_id(["opencode", "--session", "first", "-s=second"])
    assert refused.value.text == "Multiple OpenCode session selectors"


async def test_opencode1_fresh_keeps_model(monkeypatch):
    monkeypatch.setattr(server.agentmcp, "opencode_resolved", lambda _env: ("/usr/bin/opencode", 1))
    monkeypatch.setattr(server.agentmcp, "opencode_config", lambda **_kwargs: "config")
    command, _notice = await server._opencode_command("opencode --model provider/model", fresh=True)
    assert "--model provider/model" in command


async def test_direct_create_marks_opencode_as_fresh(client, auth_cookie, monkeypatch):
    monkeypatch.setitem(server.AGENT_PRESETS, "opencode", ["opencode"])
    monkeypatch.setitem(server.PRESETS, "opencode", "opencode")
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", None)
    calls = []

    async def create(*args, **kwargs):
        calls.append((args, kwargs))
        return "created"

    async def record(*_args):
        return None

    monkeypatch.setattr(server, "new_session", create)
    monkeypatch.setattr(server, "_record_recent_folder", record)
    response = await client.post("/api/new", headers=auth_cookie,
                                 json={"preset": "opencode", "cwd": str(Path.home())})
    assert response.status == 200
    assert calls[0][1]["fresh"] is True


async def test_approved_create_marks_opencode_as_fresh(monkeypatch):
    monkeypatch.setitem(server.AGENT_PRESETS, "opencode", ["opencode"])
    calls = []

    async def host(_request):
        return [{"name": "alpha", "created": 1.0, "cwd": str(Path.home())}]

    async def create(*args, **kwargs):
        calls.append((args, kwargs))
        return "created"

    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(server, "new_session", create)
    item = {"source": {"id": "alpha", "created": 1.0}, "action": "create",
            "preset": "opencode", "_approved_options": [], "model": None, "name": None}
    assert await server._execute_session_action(item) == {"id": "created"}
    assert calls[0][1]["fresh"] is True


async def test_new_session_passes_fresh_context_to_opencode_preflight(monkeypatch):
    seen = []

    async def unique(*_args):
        return "created"

    async def preflight(_command, _cwd, environ=None, *, fresh=False, require_v2=False):
        seen.append((fresh, environ, require_v2))
        raise server.web.HTTPConflict(text="preflight stopped")

    monkeypatch.setattr(server, "unique_name", unique)
    monkeypatch.setattr(server, "_opencode_command", preflight)
    with pytest.raises(server.web.HTTPConflict):
        await server.new_session("created", str(Path.home()), "opencode --model a/b", "opencode", "opencode",
                                 account_env={}, fresh=True)
    assert seen == [(True, None, False)]


async def test_new_profiled_opencode_keeps_profile_and_fresh_preflight(monkeypatch):
    async def context(*_args):
        return {"env": {"HOME": "/profile"}}

    async def unique(*_args):
        return "created"

    seen = []

    async def preflight(_command, _cwd, environ=None, *, fresh=False, require_v2=False):
        seen.append((environ, fresh, require_v2))
        raise server.web.HTTPConflict(text="preflight stopped")

    monkeypatch.setattr(server, "_profile_launch_context", context)
    monkeypatch.setattr(server, "_profile_environ", lambda ctx, _agent: ctx["env"])
    monkeypatch.setattr(server, "unique_name", unique)
    monkeypatch.setattr(server, "_opencode_command", preflight)
    with pytest.raises(server.web.HTTPConflict):
        await server.new_session("created", str(Path.home()), "opencode", "opencode", "opencode",
                                 account="profile", fresh=True)
    assert seen == [({"HOME": "/profile"}, True, True)]


async def test_fenced_target_start_failure_preserves_copy_outcome(monkeypatch):
    async def host(req):
        if req['op'] == 'list_bound':
            return [{'name': 'alpha', 'created': 1, 'creation_receipt': 'receipt'}]
        assert req['op'] == 'switch_input_acquire'
        return {'ok': True}
    async def relaunch(*_args, fence_state=None, **_kwargs):
        fence_state['stop_started'] = True
        raise server.AccountSwitchTargetStartUnconfirmed('alpha')
    monkeypatch.setattr(server, 'host', host)
    monkeypatch.setattr(server, '_save_native_fence', lambda *_args: None)
    monkeypatch.setattr(server, '_relaunch_in_place', relaunch)
    with pytest.raises(server.NativeFenceRecoveryRequired) as exc:
        await server.relaunch_in_place({'name':'alpha','created':1}, '/tmp', 'codex', 'codex', 'codex',
                                       switch=('a', 'b', 'c', 'd', 'request'))
    assert exc.value.switch_outcome == {'switch_phase':'target_start_unconfirmed', 'id':'alpha',
                                        'target_copy_remains':True, 'target_copy_uncertain':False}


@pytest.mark.parametrize('account', ['work', None])
async def test_restart_refuses_missing_bound_transcript_before_replacement(monkeypatch, tmp_path, account):
    raw = {'name':'alpha', 'created':1, 'cwd':str(tmp_path), 'meta':{'account':account}}
    described = {'agent': {'type':'codex', 'session_id':'12345678-abcd', 'argv':['codex']}, 'cwd':str(tmp_path)}
    async def host(_req): return [raw]
    async def context(*_args): return {'roots':{'config':str(tmp_path / 'selected')}}
    async def replace(*_args, **_kwargs): pytest.fail('must not stop the source')
    monkeypatch.setattr(server, 'host', host)
    monkeypatch.setattr(server, 'LAUNCH_SETTINGS', SimpleNamespace(allows_cwd=lambda _cwd: True))
    monkeypatch.setattr(server, '_describe_with_hooks', lambda *_args: {})
    monkeypatch.setattr(server, '_session_action_entry', lambda *_args: described)
    monkeypatch.setattr(server, 'session_account', lambda *_args: account)
    monkeypatch.setattr(server, '_restart_profile_context', context)
    monkeypatch.setattr(server, 'replace_session', replace)
    item = {'source':{'id':'alpha', 'created':1, 'agent':'codex'}, 'action':'restart', 'model':None}
    with pytest.raises(server.web.HTTPConflict):
        await server._execute_session_action(item)

@pytest.mark.parametrize("failure,expected", [("list", False), ("not-sent", False), ("lost-ack", True)])
async def test_standby_marks_only_possible_creation(monkeypatch, failure, expected):
    phase = {"effect_started": False}
    sent = []

    async def unique(*_args):
        if failure == "list":
            raise server.HostNotReached(text="no list")
        return "standby"

    async def send(*_args):
        sent.append(phase["effect_started"])
        if failure == "not-sent":
            raise server.HostNotReached(text="not sent")
        raise server.CreationUncertain(text="reply lost")

    monkeypatch.setattr(server, "unique_name", unique)
    monkeypatch.setattr(server, "_send_launch", send)
    with pytest.raises(server.web.HTTPServiceUnavailable):
        await server.new_session("standby", str(Path.home()), None, "codex", "codex", account_env={},
                                 standby_phase=phase)
    assert phase["effect_started"] is expected
    assert sent == ([] if failure == "list" else [True])

@pytest.mark.parametrize('mode', ['source-refused', 'carry-failed'])
async def test_standby_refusal_never_launches_replacement(monkeypatch, mode):
    async def context(*_args): return None
    async def env(*_args): return {}
    async def prepared(_kind, command, _cwd, _context): return command, None, None
    async def noop(*_args): return None
    created = []
    async def create(*_args, **_kwargs):
        created.append('standby')
        return 'standby'
    async def carry(): raise server.AccountsUnavailable('carry failed', 'carry_failed')
    async def host(req):
        if req['op'] == 'list':
            return [{'name':'standby','created':2,'meta':{'nonce':'nonce'}}]
        if req['name'] == 'source':
            return {'ok': mode != 'source-refused'}
        return {'ok': False}
    for name, value in [('_restart_profile_context', context), ('account_environment', env), ('_prepared_launch', prepared),
                        ('_confirm_standby', noop), ('_arrangement_of', noop), ('_carry_arrangement', noop),
                        ('_wait_source_gone', noop), ('new_session', create), ('host', host)]:
        monkeypatch.setattr(server, name, value)
    monkeypatch.setattr(server.sessiontoken, 'new_nonce', lambda: 'nonce')
    expected = server.web.HTTPServiceUnavailable if mode == 'source-refused' else server.AccountSwitchRecoveryFailed
    with pytest.raises(expected):
        await server._replace_with_new_session('source', 1, 'source', '/tmp', 'codex', 'codex', 'codex', None,
                                                ('work', carry))
    assert created == ['standby'], 'unconfirmed standby retirement must never launch another session'


async def test_native_acquire_unreachable_discards_unsent_receipt(monkeypatch):
    saved, forgotten = [], []
    async def host(req):
        if req['op'] == 'list_bound':
            return [{'name':'alpha','created':1,'creation_receipt':'receipt'}]
        raise server.HostNotReached(text='no host connection')
    monkeypatch.setattr(server, 'host', host)
    monkeypatch.setattr(server, '_save_native_fence', lambda *args: saved.append(args))
    monkeypatch.setattr(server, '_forget_native_fence', lambda ident: forgotten.append(ident))
    with pytest.raises(server.HostNotReached):
        await server.relaunch_in_place({'name':'alpha','created':1}, '/tmp', 'codex', 'codex', 'codex',
                                       switch=('a','b','c','d','request'))
    assert len(saved) == 1 and forgotten == ['request']


@pytest.mark.parametrize('code,remains,uncertain', [('carry_failed', False, False), ('carry_rollback_incomplete', True, True)])
async def test_native_fence_recovery_preserves_failed_carry_evidence(monkeypatch, code, remains, uncertain):
    async def host(req):
        if req['op'] == 'list_bound':
            return [{'name':'alpha','created':1,'creation_receipt':'receipt'}]
        return {'ok': True}
    async def relaunch(*_args, fence_state=None, **_kwargs):
        fence_state['stop_started'] = True
        raise server.AccountSwitchRecoveryFailed('alpha', server.AccountsUnavailable('failure', code))
    monkeypatch.setattr(server, 'host', host)
    monkeypatch.setattr(server, '_save_native_fence', lambda *_args: None)
    monkeypatch.setattr(server, '_relaunch_in_place', relaunch)
    with pytest.raises(server.NativeFenceRecoveryRequired) as exc:
        await server.relaunch_in_place({'name':'alpha','created':1}, '/tmp', 'codex', 'codex', 'codex',
                                       switch=('a','b','c','d','request'))
    assert exc.value.switch_outcome == {'switch_phase':'source_recovery_unconfirmed',
                                        'target_copy_remains':remains, 'target_copy_uncertain':uncertain}

@pytest.mark.parametrize('source_reply,standby_reply,clear', [
    ({'ok':False}, {'ok':True}, True),
    ({'ok':0}, {'ok':True}, False),
    ({'ok':False, 'reason':'changed'}, {'ok':True}, False),
    ({'ok':False}, {'ok':1}, False),
    ({'ok':False}, {'ok':True, 'extra':1}, False),
])
async def test_legacy_barrier_clears_only_on_exact_refusal_and_cleanup(monkeypatch, source_reply, standby_reply, clear):
    async def context(*_args): return None
    async def env(*_args): return {}
    async def prepared(_kind, command, _cwd, _context): return command, None, None
    async def noop(*_args): return None
    async def create(*_args, **_kwargs): return 'standby'
    async def host(req):
        if req['op'] == 'list':
            return [{'name':'standby','created':2,'meta':{'nonce':'nonce'}}]
        return source_reply if req['name'] == 'source' else standby_reply
    for name, value in [('_restart_profile_context', context), ('account_environment', env), ('_prepared_launch', prepared),
                        ('_confirm_standby', noop), ('_arrangement_of', noop), ('new_session', create), ('host', host)]:
        monkeypatch.setattr(server, name, value)
    monkeypatch.setattr(server.sessiontoken, 'new_nonce', lambda: 'nonce')
    monkeypatch.setattr(server, '_legacy_check_active', lambda: None)
    phase = {'effect_started': True}
    token = server._LEGACY_SWITCH_PHASE.set(phase)
    try:
        with pytest.raises(server.web.HTTPException):
            await server._replace_with_new_session('source', 1, 'source', '/tmp', 'codex', 'codex', 'codex', None, ('work', noop))
        assert phase['effect_started'] is not clear
    finally:
        server._LEGACY_SWITCH_PHASE.reset(token)

async def test_native_uncertain_carry_never_attempts_source_or_target_start(monkeypatch):
    starts = []
    async def host(req):
        if req['op'] == 'list_bound':
            return [{'name':'alpha','created':1,'creation_receipt':'receipt'}]
        return {'ok': True}
    async def noop(*_args, **_kwargs): return None
    async def prepared(_agent, command, _cwd, _context): return command, None, None
    async def stop(*_args, fence_state=None, **_kwargs):
        fence_state['stop_started'] = True
        return 2
    async def carry(): raise server.AccountsUnavailable('unknown carry', 'carry_rollback_incomplete')
    async def start(*_args, **_kwargs): starts.append('started')
    for name, value in [('host', host), ('_prepared_launch', prepared), ('_arrangement_of', noop),
                        ('_validate_native_switch', noop), ('_stop_agent', stop), ('_carry_arrangement', noop),
                        ('_start_in_place', start)]:
        monkeypatch.setattr(server, name, value)
    monkeypatch.setattr(server, '_save_native_fence', lambda *_args: None)
    monkeypatch.setattr(server, '_switch_root_identity', lambda context: context['id'])
    source = {'name':'alpha', 'created':1, 'pty_capabilities':['agent_relaunch_bound_v1']}
    origin, target = {'id':'default','env':{}}, {'id':'work','env':{}}
    with pytest.raises(server.NativeFenceRecoveryRequired) as exc:
        await server.relaunch_in_place(source, '/tmp', 'codex', 'codex', 'codex',
                                       switch=('work', carry, origin, target, 'request'))
    assert starts == []
    assert exc.value.switch_outcome == {'switch_phase':'source_recovery_unconfirmed',
                                        'target_copy_remains':True, 'target_copy_uncertain':True}


@pytest.mark.parametrize('previous', [False, True])
async def test_unsent_stop_restores_prior_effect_evidence(monkeypatch, previous):
    async def unreachable(*_args, **_kwargs): raise server.HostNotReached(text='no connection')
    monkeypatch.setattr(server, 'host', unreachable)
    monkeypatch.setattr(server, '_legacy_check_active', lambda: None)
    phase = {'effect_started': previous}
    fence_state = {'stop_started': previous}
    token = server._LEGACY_SWITCH_PHASE.set(phase)
    try:
        with pytest.raises(server.HostNotReached):
            await server._stop_agent({'name':'alpha','created':1}, 'codex', fence_state=fence_state)
        assert phase['effect_started'] is previous
        assert fence_state['stop_started'] is previous
    finally:
        server._LEGACY_SWITCH_PHASE.reset(token)


async def test_legacy_recovery_does_not_launch_into_new_native_registry(monkeypatch):
    async def context(*_args): return None
    async def env(*_args): return {}
    async def prepared(_kind, command, _cwd, _context): return command, None, None
    async def noop(*_args): return None
    calls = []
    async def create(*_args, **_kwargs):
        calls.append('new')
        return 'standby'
    async def carry(): raise server.AccountsUnavailable('carry failed', 'carry_failed')
    async def host(req):
        if req['op'] == 'list':
            return [{'name':'standby','created':2,'meta':{'nonce':'nonce'}}]
        return {'ok':True}
    for name, value in [('_restart_profile_context', context), ('account_environment', env), ('_prepared_launch', prepared),
                        ('_confirm_standby', noop), ('_arrangement_of', noop), ('_carry_arrangement', noop),
                        ('_wait_source_gone', noop), ('new_session', create), ('host', host)]:
        monkeypatch.setattr(server, name, value)
    monkeypatch.setattr(server.sessiontoken, 'new_nonce', lambda: 'nonce')
    monkeypatch.setattr(server, '_native_profile_mode', lambda: True)
    with pytest.raises(server.AccountSwitchRecoveryFailed):
        await server._replace_with_new_session('source', 1, 'source', '/tmp', 'codex', 'codex', 'codex', None,
                                                ('work', carry))
    assert calls == ['new'], 'the stopped source must not be launched with a newly introduced native profile'


async def test_legacy_recovery_rechecks_mode_inside_session_launch(monkeypatch):
    async def context(*_args): return None
    async def env(*_args): return {}
    async def prepared(_kind, command, _cwd, _context): return command, None, None
    async def noop(*_args): return None
    checks, sends = [], []
    async def create(*_args, **kwargs):
        if not sends:
            sends.append('standby')
            return 'standby'
        assert kwargs['account_revision'] == 'legacy'
        checks.append('revalidate')
        await server._profile_launch_context('work', 'codex', kwargs['account_revision'])
        sends.append('recovery')
    async def carry(): raise server.AccountsUnavailable('carry failed', 'carry_failed')
    async def host(req):
        if req['op'] == 'list':
            return [{'name':'standby','created':2,'meta':{'nonce':'nonce'}}]
        return {'ok':True}
    for name, value in [('_restart_profile_context', context), ('account_environment', env), ('_prepared_launch', prepared),
                        ('_confirm_standby', noop), ('_arrangement_of', noop), ('_carry_arrangement', noop),
                        ('_wait_source_gone', noop), ('new_session', create), ('host', host)]:
        monkeypatch.setattr(server, name, value)
    monkeypatch.setattr(server.sessiontoken, 'new_nonce', lambda: 'nonce')
    reads = iter([False, True])
    monkeypatch.setattr(server, '_native_profile_mode', lambda: next(reads))
    with pytest.raises(server.AccountSwitchRecoveryFailed):
        await server._replace_with_new_session('source', 1, 'source', '/tmp', 'codex', 'codex', 'codex', 'work',
                                                ('target', carry))
    assert checks == ['revalidate'] and sends == ['standby']
