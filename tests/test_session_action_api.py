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


def test_options_projection_keeps_options_and_revision_from_same_save(monkeypatch):
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    class PausedOptions(dict):
        def items(self):
            entered.set()
            assert release.wait(timeout=2)
            return super().items()
    monkeypatch.setattr(server, "AGENT_OPTIONS", PausedOptions({"codex": ("--before",)}))
    monkeypatch.setattr(server, "AGENT_OPTIONS_REVISION", "before")
    monkeypatch.setattr(server, "AGENT_OPTIONS_ERROR", None)
    result = []
    reader = threading.Thread(target=lambda: result.append(server.launch_projection()))
    writer = threading.Thread(target=lambda: (server.apply_agent_options({"codex": ("--after",)}, "after"), done.set()))
    reader.start()
    try:
        assert entered.wait(timeout=2)
        writer.start()
        assert not done.wait(timeout=0.05)
    finally:
        release.set()
        reader.join(timeout=2)
        if writer.ident is not None:
            writer.join(timeout=2)
    assert not reader.is_alive() and not writer.is_alive()
    assert result[0]["agent_options"] == {"codex": "--before"}
    assert result[0]["agent_options_revision"] == "before"
    projection = server.launch_projection()
    assert projection["agent_options"] == {"codex": "--after"}
    assert projection["agent_options_revision"] == "after"


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

    async def execute(item):
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


async def test_startup_worker_recovers_approved_but_not_uncertain_work(tmp_path, monkeypatch):
    requests = sessionrequests.Requests(tmp_path / "actions.sqlite3", clock=lambda: 10.0)
    made = requests.create({"id": "alpha", "created": 1.0, "agent": "codex", "cwd": "/work"},
                           {"action": "create", "preset": "codex"},
                           enabled_agents={"codex"}, resumable={"codex"})
    claim = requests.claim(made["id"], "a" * 32)
    requests.decide(made["id"], True, claim["claim_nonce"], approved_options=[], options_revision="rev")
    calls = []

    async def execute(item):
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

    async def new_session(base, cwd, command=None, agent=None, known_agent=None, keep=32, conversation=None):
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

    async def new_session(base, cwd, command=None, agent=None, known_agent=None, keep=32, conversation=None):
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

    async def prepared(*_args, **_kwargs):
        calls.append(("prepare", _args))
        return "old-2"

    async def host(request):
        calls.append((request["op"], request))
        if request["op"] == "list":
            if sum(call[0] == "list" for call in calls) == 1:
                return [{"name": "old-2", "created": 2.0}]
            return [{"name": "old-2", "created": 2.0}]
        return {"ok": True}

    monkeypatch.setattr(server, "new_session", prepared)
    monkeypatch.setattr(server, "host", host)
    assert await server.replace_session("old", 1.0, "old", str(Path.home()),
                                        "codex resume sid", "codex", "codex") == "old-2"
    assert [call[0] for call in calls] == ["prepare", "list", "kill_if", "list", "start_if"]
    assert calls[-1][1]["command"] == "codex resume sid"


async def test_restart_never_starts_replacement_before_source_exit(monkeypatch):
    calls = []

    async def prepared(*_args, **_kwargs):
        return "old-2"

    async def host(request):
        calls.append(request["op"])
        if request["op"] == "list":
            return [{"name": "old-2", "created": 2.0},
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

    async def preflight(_command, _cwd, *, fresh=False):
        seen.append(fresh)
        raise server.web.HTTPConflict(text="preflight stopped")

    monkeypatch.setattr(server, "unique_name", unique)
    monkeypatch.setattr(server, "_opencode_command", preflight)
    with pytest.raises(server.web.HTTPConflict):
        await server.new_session("created", str(Path.home()), "opencode --model a/b", "opencode", "opencode",
                                 account_env={}, fresh=True)
    assert seen == [True]
