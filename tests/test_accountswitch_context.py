# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import hashlib
import os
import asyncio

import pytest
from aiohttp import web

import accountswitch
import server


def test_default_context_binds_actual_home():
    result = accountswitch.default_context("codex", {"HOME": "/tmp/alice"})
    assert result == {"root": "/tmp/alice/.codex", "context_revision": hashlib.sha256(
        b"mesh-default-v1\0codex\0/tmp/alice/.codex").hexdigest()}
    assert accountswitch.default_context("codex", {"HOME": "/tmp/alice", "CODEX_HOME": "/other"})["root"] == "/other"


@pytest.mark.parametrize("env", [
    {"HOME": "/tmp/alice", "CODEX_HOME": "relative"},
    {"HOME": "relative"},
    {"HOME": "/tmp/alice", "OPENAI_API_KEY": "secret"},
    {"HOME": "/tmp/alice", "CODEX_HOME": "/bad\0folder"},
])
def test_ambiguous_default_is_refused(env):
    with pytest.raises(accountswitch.UnboundDefault):
        accountswitch.default_context("codex", env)


def test_process_reads_only_selected_variables_and_refuses_duplicates(tmp_path):
    proc = tmp_path / "123"
    proc.mkdir()
    (proc / "stat").write_text("123 (codex test) " + " ".join(["S"] * 19 + ["1234"]))
    environment = proc / "environ"
    environment.write_bytes(b"HOME=/tmp/alice\0IRRELEVANT_SECRET=secret\0")
    result = accountswitch.process_default_context("codex", 123, tmp_path)
    assert result["root"] == "/tmp/alice/.codex"
    assert "secret" not in str(result)
    environment.write_bytes(b"HOME=/tmp/alice\0HOME=/tmp/bob\0")
    with pytest.raises(accountswitch.UnboundDefault):
        accountswitch.process_default_context("codex", 123, tmp_path)


def test_actual_process_home_is_observed():
    # The process environment seen via procfs is the environment at process start.
    if not os.path.isdir("/proc/self"):
        pytest.skip("procfs unavailable")
    try:
        result = accountswitch.process_default_context("codex", os.getpid())
    except accountswitch.UnboundDefault:
        pytest.skip("current process has an ambiguous account environment")
    assert result["root"].startswith("/")


def test_server_binds_default_to_observed_agent(monkeypatch):
    observed = {"type": "codex", "pid": 42, "foreground": True}
    selected = {**accountswitch.default_context("codex", {"HOME": "/tmp/alice"}),
                "process_pid": 42, "process_start": "1234"}
    monkeypatch.setattr(accountswitch, "process_default_context", lambda kind, pid: selected)
    context = asyncio.run(server._switch_profile_context("default", "codex", observed_agent=observed))
    assert context["env"] == {"CODEX_HOME": "/tmp/alice/.codex"}
    assert context["context_revision"] == selected["context_revision"]
    with pytest.raises(web.HTTPConflict):
        asyncio.run(server._switch_profile_context("default", "codex", "0" * 64, observed))
    with pytest.raises(web.HTTPConflict):
        asyncio.run(server._switch_profile_context("default", "codex", observed_agent={**observed, "foreground": False}))


@pytest.mark.parametrize("scenario", ["success", "carry_failure", "target_changed", "source_changed"])
def test_in_place_switch_starts_only_bound_target_or_bound_source(monkeypatch, scenario):
    source_context = {"id": "default", "env": {"CODEX_HOME": "/tmp/source"}, "context_revision": "a" * 64,
                      "process_pid": 123, "process_start": "456"}
    target_context = {"id": "work", "env": {"CODEX_HOME": "/tmp/target"}, "context_revision": "b" * 64}
    source = {"name": "session", "created": 1, "meta": {}, "pty_capabilities": ["agent_relaunch_bound_v1"]}
    events = []

    async def validate(*_args):
        events.append("validate")

    async def prepared(_agent, command, _cwd, _context):
        return command, None, None

    async def arrangement(*_args):
        return None

    async def stop(*_args):
        events.append("stop")
        return 2

    async def carry():
        events.append("carry")
        if scenario == "carry_failure":
            raise server.AccountsUnavailable("failed", "carry_failed")

    async def context(*_args):
        events.append("target-check")
        if scenario == "target_changed":
            raise web.HTTPConflict(text="changed")
        return target_context

    async def start(*_args, context=None):
        events.append(("start", context["id"], context["env"]["CODEX_HOME"]))

    monkeypatch.setattr(server, "_validate_native_switch", validate)
    identities = {"default": 0, "work": 0}

    def identity(context):
        key = context["id"]
        identities[key] += 1
        return "replaced" if scenario == "source_changed" and key == "default" and identities[key] > 1 else key

    monkeypatch.setattr(server, "_switch_root_identity", identity)
    monkeypatch.setattr(server, "_prepared_launch", prepared)
    monkeypatch.setattr(server, "_arrangement_of", arrangement)
    monkeypatch.setattr(server, "_carry_arrangement", arrangement)
    monkeypatch.setattr(server, "_stop_agent", stop)
    monkeypatch.setattr(server, "_switch_profile_context", context)
    monkeypatch.setattr(server, "_start_in_place", start)
    switch = ("work", carry, source_context, target_context)
    if scenario == "source_changed":
        with pytest.raises(web.HTTPServiceUnavailable):
            asyncio.run(server.relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert events == ["validate", "stop"]
    elif scenario != "success":
        with pytest.raises(server.AccountSwitchUndone):
            asyncio.run(server.relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert events == ["validate", "stop", "carry", *(["target-check"] if scenario == "target_changed" else []),
                          ("start", "default", "/tmp/source")]
    else:
        assert asyncio.run(server.relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch)) == "session"
        assert events == ["validate", "stop", "carry", "target-check", ("start", "work", "/tmp/target")]


def test_approval_refuses_another_conversation(monkeypatch):
    monkeypatch.setattr(server, "_native_profile_mode", lambda: True)
    monkeypatch.setattr(server, "NATIVE_SWITCH_QUALIFIED", True)
    item = {"source": {"agent": "codex"}, "from_account": "default", "account": "work",
            "switch_binding": {"backend": "codex", "conversation": "12345678-abcd", "agent_pid": 10,
                "agent_start": "1", "source": {"id": "default", "context_revision": "a" * 64},
                "target": {"id": "work", "context_revision": "b" * 64}}}
    with pytest.raises(web.HTTPConflict) as error:
        asyncio.run(server._switch_session(item, {"meta": {}}, "87654321-abcd", ["codex"]))
    assert "Conversation changed" in error.value.text


def test_named_source_home_must_match_process(monkeypatch):
    selected = {"root": "/tmp/other", "process_pid": 42, "process_start": "1234"}
    monkeypatch.setattr(accountswitch, "process_default_context", lambda *_args: selected)

    async def launch(*_args):
        return {"roots": {"config": "/tmp/work"}, "context_revision": "a" * 64}

    monkeypatch.setattr(server, "_profile_launch_context", launch)
    with pytest.raises(web.HTTPConflict):
        asyncio.run(server._switch_profile_context("work", "codex", "a" * 64,
                     {"type": "codex", "pid": 42, "foreground": True}))


def test_last_check_refuses_changed_conversation(monkeypatch):
    raw = {"name": "session", "created": 1}
    observed = {"type": "codex", "pid": 42, "foreground": True}
    monkeypatch.setattr(server, "_describe_with_hooks", lambda _items: {
        "mesh": [{"id": "session", "created": 1, "agent": observed}]})
    monkeypatch.setattr(server, "_switch_conversation", lambda *_args: "another-conversation")
    with pytest.raises(web.HTTPConflict) as error:
        asyncio.run(server._validate_native_switch(raw, "codex", {"conversation": "original"}, {}))
    assert "Conversation changed" in error.value.text


@pytest.mark.parametrize("agent,capabilities,expected", [
    ("codex", ["agent_relaunch_v1", "agent_relaunch_bound_v1"], True),
    ("claude", ["agent_relaunch_v1", "agent_relaunch_bound_v1"], True),
    ("codex", ["agent_relaunch_v1"], False),
    ("codex", [], False),
    ("pi", ["agent_relaunch_v1", "agent_relaunch_bound_v1"], False),
    ("opencode", ["agent_relaunch_v1", "agent_relaunch_bound_v1"], False),
])
def test_switch_qualification_requires_supported_agent_and_bound_host(monkeypatch, agent, capabilities, expected):
    monkeypatch.setattr(server, "NATIVE_SWITCH_QUALIFIED", True)
    monkeypatch.setattr(server, "_native_profile_mode", lambda: True)
    assert server._native_switch_available(agent, {"pty_capabilities": capabilities}) is expected


def test_profile_qualification_uses_live_host_and_supported_backend(monkeypatch):
    monkeypatch.setattr(server, "NATIVE_SWITCH_QUALIFIED", True)
    monkeypatch.setattr(server, "_native_profile_mode", lambda: True)
    profiles = [{"backend": backend, "enabled": enabled, "switch_qualified": False}
                for backend, enabled in (("codex", True), ("codex", False), ("pi", True), ("claude", True))]
    sessions = [{"meta": {"known_agent": "codex"},
                 "pty_capabilities": ["agent_relaunch_v1", "agent_relaunch_bound_v1"]},
                {"meta": {"known_agent": "pi"},
                 "pty_capabilities": ["agent_relaunch_v1", "agent_relaunch_bound_v1"]},
                {"meta": {"known_agent": "claude"}, "pty_capabilities": ["agent_relaunch_v1"]}]
    assert [p["switch_qualified"] for p in server._qualify_profiles(profiles, sessions)] == [True, False, False, False]
