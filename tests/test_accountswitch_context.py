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
    selected = accountswitch.default_context("codex", {"HOME": "/tmp/alice"})
    monkeypatch.setattr(accountswitch, "process_default_context", lambda kind, pid: selected)
    context = asyncio.run(server._switch_profile_context("default", "codex", observed_agent=observed))
    assert context["env"] == {"CODEX_HOME": "/tmp/alice/.codex"}
    assert context["context_revision"] == selected["context_revision"]
    with pytest.raises(web.HTTPConflict):
        asyncio.run(server._switch_profile_context("default", "codex", "0" * 64, observed))
    with pytest.raises(web.HTTPConflict):
        asyncio.run(server._switch_profile_context("default", "codex", observed_agent={**observed, "foreground": False}))


@pytest.mark.parametrize("fail_carry", [False, True])
def test_in_place_switch_starts_only_bound_target_or_bound_source(monkeypatch, fail_carry):
    source_context = {"id": "default", "env": {"CODEX_HOME": "/tmp/source"}, "context_revision": "a" * 64}
    target_context = {"id": "work", "env": {"CODEX_HOME": "/tmp/target"}, "context_revision": "b" * 64}
    source = {"name": "session", "created": 1, "meta": {}}
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
        if fail_carry:
            raise server.AccountsUnavailable("failed", "carry_failed")

    async def context(*_args):
        events.append("target-check")
        return target_context

    async def start(*_args, context=None):
        events.append(("start", context["id"], context["env"]["CODEX_HOME"]))

    monkeypatch.setattr(server, "_validate_native_switch", validate)
    monkeypatch.setattr(server, "_switch_root_identity", lambda context: context["id"])
    monkeypatch.setattr(server, "_prepared_launch", prepared)
    monkeypatch.setattr(server, "_arrangement_of", arrangement)
    monkeypatch.setattr(server, "_carry_arrangement", arrangement)
    monkeypatch.setattr(server, "_stop_agent", stop)
    monkeypatch.setattr(server, "_switch_profile_context", context)
    monkeypatch.setattr(server, "_start_in_place", start)
    switch = ("work", carry, source_context, target_context)
    if fail_carry:
        with pytest.raises(server.AccountSwitchUndone):
            asyncio.run(server.relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert events == ["validate", "stop", "carry", ("start", "default", "/tmp/source")]
    else:
        assert asyncio.run(server.relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch)) == "session"
        assert events == ["validate", "stop", "carry", "target-check", ("start", "work", "/tmp/target")]
