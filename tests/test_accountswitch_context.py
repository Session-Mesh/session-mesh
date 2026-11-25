# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import hashlib
import os
import asyncio
from types import SimpleNamespace

import pytest
from aiohttp import web

import accountswitch
import respawn
import server


def test_account_signature_changes_when_configuration_directory_permissions_change(tmp_path, monkeypatch):
    conf = tmp_path / "mesh"
    conf.mkdir(mode=0o700)
    (conf / "backend-profiles.json").write_text("{}")
    monkeypatch.setattr(server, "CONF_DIR", conf)
    monkeypatch.setattr(server, "ACCOUNTS_FILE", conf / "accounts.json")
    before = server._accounts_signature()
    conf.chmod(0o770)
    assert server._accounts_signature() != before


async def test_account_cache_recovers_after_only_directory_permissions_are_repaired(tmp_path, monkeypatch):
    conf = tmp_path / "mesh"
    conf.mkdir(mode=0o770)
    conf.chmod(0o770)
    (conf / "backend-profiles.json").write_text("{}")
    monkeypatch.setattr(server, "CONF_DIR", conf)
    monkeypatch.setattr(server, "ACCOUNTS_FILE", conf / "accounts.json")
    monkeypatch.setattr(server, "_ACCOUNTS", {"signature": "not read yet", "accounts": [],
                                               "launch_profiles": None, "protected": None, "file": "absent"})
    monkeypatch.setattr(server, "_ACCOUNTS_REFRESH", (None, None))
    monkeypatch.setattr(server, "_protected_folders", lambda *_args: [])
    monkeypatch.setattr(server.view, "deny_account_files", lambda *_args: None)
    calls = []

    async def helper(*_args, **_kwargs):
        calls.append(conf.stat().st_mode & 0o777)
        if calls[-1] & 0o077:
            raise server.AccountsUnavailable("unsafe root", "unsafe-root")
        return {"accounts": [], "protected_roots": [], "launch_profiles": []}

    monkeypatch.setattr(server, "_accounts_program", helper)
    await server.declared_accounts()
    assert server._ACCOUNTS["file"] == "refused"
    conf.chmod(0o700)
    await server.declared_accounts()
    assert server._ACCOUNTS["file"] == "ok"
    assert calls == [0o770, 0o700]


def test_profiled_pi_is_refused_before_lookup_but_default_pi_is_unchanged(monkeypatch):
    monkeypatch.setattr(server, "_native_profile_mode", lambda: False)
    assert asyncio.run(server._profile_launch_context(None, "pi")) is None
    with pytest.raises(web.HTTPConflict) as launch:
        asyncio.run(server._profile_launch_context("work", "pi", "a" * 64))
    assert launch.value.text == server.PI_PROFILE_UNAVAILABLE
    with pytest.raises(web.HTTPConflict) as restart:
        asyncio.run(server._restart_profile_context({"meta": {}}, "work", "pi", None))
    assert restart.value.text == server.PI_PROFILE_UNAVAILABLE
    assert asyncio.run(server._restart_profile_context({"meta": {}}, None, "pi", None)) is None


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


def test_approved_native_switch_does_not_fall_back_when_registry_disappears(monkeypatch):
    events = []
    item = {"source": {"agent": "codex"}, "from_account": "default", "account": "work",
            "switch_binding": {"backend": "codex", "conversation": "12345678-abcd", "agent_pid": 123,
                               "agent_start": "1234", "source": {"id": "default", "context_revision": "a" * 64},
                               "target": {"id": "work", "context_revision": "b" * 64}}}
    raw = {"name": "synthetic", "created": 1, "cwd": "/tmp", "meta": {}}
    monkeypatch.setattr(server, "_native_profile_mode", lambda: False)

    async def replace(*args, **kwargs):
        events.append("stopped-or-carried")
        return "synthetic"

    monkeypatch.setattr(server, "replace_session", replace)
    monkeypatch.setattr(respawn, "forget_live", lambda *args: None)
    with pytest.raises(web.HTTPConflict):
        asyncio.run(server._switch_session(item, raw, "synthetic-conversation", ["codex"]))
    assert events == []


def test_helper_snapshot_works_without_python_311_file_digest(monkeypatch, tmp_path):
    path = tmp_path / 'helper'
    path.write_bytes(b'fixture')
    monkeypatch.delattr(server.hashlib, 'file_digest', raising=False)
    assert server._carry_helper_snapshot(str(path))[2] == server.hashlib.sha256(b'fixture').digest()


def test_helper_snapshot_rejects_oversized_file(tmp_path):
    path = tmp_path / 'helper'
    with path.open('wb') as output:
        output.truncate(128 * 1024 * 1024 + 1)
    with pytest.raises(server.AccountsUnavailable):
        server._carry_helper_snapshot(str(path))


def test_helper_snapshot_refuses_fifo_without_waiting(tmp_path):
    path = tmp_path / 'helper'
    os.mkfifo(path)
    with pytest.raises(server.AccountsUnavailable):
        server._carry_helper_snapshot(str(path))


def test_legacy_switch_requires_legacy_resolver_at_carry(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(server, '_native_profile_mode', lambda: False)
    executable = tmp_path / 'mesh-platform'
    executable.write_bytes(b'fixture')
    monkeypatch.setattr(server, 'work_command', lambda _name: str(executable))
    monkeypatch.setattr(respawn, 'forget_live', lambda *args: None)
    async def helper(*args, **kwargs):
        calls.append(args)
        if args == ('carry-capabilities',):
            return {'version': 1, 'legacy_only': True}
        return {'carried': {'replaced': 0}}
    async def replace(*args, switch, **kwargs):
        await switch[1]()
        return 'synthetic'
    monkeypatch.setattr(server, '_accounts_program', helper)
    monkeypatch.setattr(server, 'replace_session', replace)
    item = {'source': {'agent': 'codex'}, 'from_account': 'default', 'account': 'work'}
    raw = {'name': 'synthetic', 'created': 1, 'cwd': '/tmp', 'meta': {}}
    assert asyncio.run(server._switch_session(item, raw, '12345678-abcd', ['codex']))['account'] == 'work'
    assert calls[0] == ('carry-capabilities',)
    assert calls[1][0] == 'carry' and calls[1][-1] == '--legacy-only'


@pytest.mark.parametrize('reply', [None, {}, {'version': 1, 'legacy_only': False},
                                   {'version': True, 'legacy_only': True}])
def test_legacy_switch_refuses_old_or_invalid_helper_before_stop(monkeypatch, reply, tmp_path):
    calls = []
    monkeypatch.setattr(server, '_native_profile_mode', lambda: False)
    executable = tmp_path / 'mesh-platform'
    executable.write_bytes(b'fixture')
    monkeypatch.setattr(server, 'work_command', lambda _name: str(executable))
    async def helper(*args, **kwargs):
        if reply is None:
            raise server.AccountsUnavailable('old helper')
        return reply
    async def replace(*args, **kwargs):
        calls.append('stopped')
    monkeypatch.setattr(server, '_accounts_program', helper)
    monkeypatch.setattr(server, 'replace_session', replace)
    item = {'source': {'agent': 'codex'}, 'from_account': 'default', 'account': 'work'}
    raw = {'name': 'synthetic', 'created': 1, 'cwd': '/tmp', 'meta': {}}
    with pytest.raises(web.HTTPConflict) as error:
        asyncio.run(server._switch_session(item, raw, '12345678-abcd', ['codex']))
    assert 'nothing was stopped' in error.value.text
    assert calls == []


@pytest.mark.parametrize('replacement', ['rename', 'in_place'])
def test_legacy_switch_refuses_changed_helper_before_carry(monkeypatch, tmp_path, replacement):
    executable = tmp_path / 'mesh-platform'
    executable.write_bytes(b'new-helper')
    monkeypatch.setattr(server, 'work_command', lambda _name: str(executable))
    monkeypatch.setattr(server, '_native_profile_mode', lambda: False)
    calls = []
    async def helper(*args, **kwargs):
        calls.append(args)
        assert args == ('carry-capabilities',)
        return {'version': 1, 'legacy_only': True}
    async def replace(*args, switch, **kwargs):
        if replacement == 'rename':
            other = tmp_path / 'replacement'
            other.write_bytes(b'old-helper')
            other.replace(executable)
        else:
            executable.write_bytes(b'old-helper')
        await switch[1]()
    monkeypatch.setattr(server, '_accounts_program', helper)
    monkeypatch.setattr(server, 'replace_session', replace)
    item = {'source': {'agent': 'codex'}, 'from_account': 'default', 'account': 'work'}
    raw = {'name': 'synthetic', 'created': 1, 'cwd': '/tmp', 'meta': {}}
    with pytest.raises(server.AccountsUnavailable) as error:
        asyncio.run(server._switch_session(item, raw, '12345678-abcd', ['codex']))
    assert error.value.code == 'profile-context-changed'
    assert calls == [('carry-capabilities',)]


def test_legacy_switch_keeps_versioned_helper_after_current_link_moves(monkeypatch, tmp_path):
    first, second, current = tmp_path / 'first', tmp_path / 'second', tmp_path / 'current'
    first.write_bytes(b'first-helper')
    second.write_bytes(b'second-helper')
    current.symlink_to(first)
    monkeypatch.setattr(server, 'work_command', lambda _name: str(current))
    monkeypatch.setattr(server, '_native_profile_mode', lambda: False)
    monkeypatch.setattr(respawn, 'forget_live', lambda *args: None)
    calls = []
    async def helper(*args, **kwargs):
        calls.append((args, kwargs['program']))
        if args == ('carry-capabilities',):
            current.unlink()
            current.symlink_to(second)
            return {'version': 1, 'legacy_only': True}
        return {'carried': {'replaced': 0}}
    async def replace(*args, switch, **kwargs):
        await switch[1]()
        return 'synthetic'
    monkeypatch.setattr(server, '_accounts_program', helper)
    monkeypatch.setattr(server, 'replace_session', replace)
    item = {'source': {'agent': 'codex'}, 'from_account': 'default', 'account': 'work'}
    raw = {'name': 'synthetic', 'created': 1, 'cwd': '/tmp', 'meta': {}}
    asyncio.run(server._switch_session(item, raw, '12345678-abcd', ['codex']))
    assert len(calls) == 2 and all(program == str(first) for _, program in calls)


def test_legacy_switch_never_runs_replaced_real_helper(monkeypatch, tmp_path):
    executable, marker = tmp_path / 'mesh-platform', tmp_path / 'ran-old'
    executable.write_text('#!/bin/sh\nprintf \'{"version":1,"legacy_only":true}\\n\'\n')
    executable.chmod(0o700)
    monkeypatch.setattr(server, 'work_command', lambda _name: str(executable))
    monkeypatch.setattr(server, '_native_profile_mode', lambda: False)
    async def replace(*args, switch, **kwargs):
        old = tmp_path / 'old-helper'
        old.write_text(f'#!/bin/sh\nprintf ran > {marker}\n')
        old.chmod(0o700)
        old.replace(executable)
        await switch[1]()
    monkeypatch.setattr(server, 'replace_session', replace)
    item = {'source': {'agent': 'codex'}, 'from_account': 'default', 'account': 'work'}
    raw = {'name': 'synthetic', 'created': 1, 'cwd': '/tmp', 'meta': {}}
    with pytest.raises(server.AccountsUnavailable) as error:
        asyncio.run(server._switch_session(item, raw, '12345678-abcd', ['codex']))
    assert error.value.code == 'profile-context-changed'
    assert not marker.exists()


@pytest.mark.parametrize('scenario', ['carry_failure', 'target_refused', 'target_timeout'])
def test_legacy_carry_and_start_failures_keep_the_outcome(monkeypatch, scenario):
    async def no_context(*_args, **_kwargs): return None
    async def environment(*_args, **_kwargs): return {}
    async def prepared(_agent, command, _cwd, _context): return command, None, None
    async def no_op(*_args, **_kwargs): return None
    async def host(request):
        if request['op'] == 'list':
            return [{'name': 'standby', 'created': 2, 'meta': {'nonce': 'nonce'}}]
        return {'ok': True}
    calls = []
    async def new_session(*_args, **_kwargs):
        calls.append('new')
        if len(calls) == 1:
            return 'standby'
        raise web.HTTPServiceUnavailable(text='restart failed')
    async def carry():
        if scenario == 'carry_failure':
            raise server.AccountsUnavailable('original carry failure', 'carry_failed')
    async def start(*_args, **_kwargs):
        if scenario == 'target_timeout':
            raise asyncio.TimeoutError()
        raise web.HTTPServiceUnavailable(text='target start refused')
    monkeypatch.setattr(server, '_restart_profile_context', no_context)
    monkeypatch.setattr(server, 'account_environment', environment)
    monkeypatch.setattr(server, '_prepared_launch', prepared)
    monkeypatch.setattr(server.sessiontoken, 'new_nonce', lambda: 'nonce')
    monkeypatch.setattr(server, 'new_session', new_session)
    monkeypatch.setattr(server, '_start_replacement', start)
    monkeypatch.setattr(server, 'host', host)
    for name in ('_confirm_standby', '_arrangement_of', '_carry_arrangement', '_wait_source_gone'):
        monkeypatch.setattr(server, name, no_op)
    expected = server.AccountSwitchRecoveryFailed if scenario == 'carry_failure' else server.AccountSwitchTargetStartUnconfirmed
    with pytest.raises(expected) as failure:
        asyncio.run(server._replace_with_new_session('original', 1, 'original', '/tmp', 'codex', 'codex',
                                                     'codex', None, ('work', carry), None))
    if scenario == 'carry_failure':
        assert failure.value.code == 'carry_failed'
        assert str(failure.value) == 'original carry failure'
        assert failure.value.target_copy_remains is False
        assert len(calls) == 2
    else:
        assert failure.value.name == 'standby'
        assert len(calls) == 1, 'do not automatically restart the source after an uncertain target start'


@pytest.mark.parametrize("scenario", ["success", "carry_failure", "target_changed", "source_changed", "target_changed_during_launch", "restart_fails_after_carry_failure", "restart_fails_after_copy", "uncertain_carry", "uncertain_carry_restart_fails", "target_start_refused", "target_start_timeout"])
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

    async def stop(*_args, **_kwargs):
        events.append("stop")
        return 2

    async def carry():
        events.append("carry")
        if scenario in ("carry_failure", "restart_fails_after_carry_failure"):
            raise server.AccountsUnavailable("failed", "carry_failed")
        if scenario in ("uncertain_carry", "uncertain_carry_restart_fails"):
            raise server.AccountsUnavailable("invalid helper reply", None)

    async def context(*_args):
        events.append("target-check")
        if scenario in ("target_changed", "restart_fails_after_copy"):
            raise web.HTTPConflict(text="changed")
        return target_context

    async def start(*_args, context=None, expected_identity=None, validate_default_target=False, **_kwargs):
        events.append(("start", context["id"], context["env"]["CODEX_HOME"]))
        if scenario in ("restart_fails_after_carry_failure", "restart_fails_after_copy", "uncertain_carry_restart_fails") and context["id"] == "default":
            raise web.HTTPServiceUnavailable(text="restart unavailable")
        if scenario == "target_changed_during_launch" and context["id"] == "work":
            raise server.AccountContextChanged()
        if scenario == 'target_start_refused' and context['id'] == 'work':
            raise web.HTTPServiceUnavailable(text='host refused')
        if scenario == 'target_start_timeout' and context['id'] == 'work':
            raise asyncio.TimeoutError()

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
    if scenario in ('target_start_refused', 'target_start_timeout'):
        with pytest.raises(server.AccountSwitchTargetStartUnconfirmed):
            asyncio.run(server._relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert events == ['validate', 'stop', 'carry', 'target-check', ('start', 'work', '/tmp/target')]
    elif scenario == "source_changed":
        with pytest.raises(server.AccountSwitchRecoveryFailed) as error:
            asyncio.run(server._relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert error.value.code == 'profile-context-changed'
        assert events == ["validate", "stop"]
    elif scenario in ('uncertain_carry', 'uncertain_carry_restart_fails'):
        with pytest.raises(server.AccountSwitchRecoveryFailed) as error:
            asyncio.run(server._relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert error.value.target_copy_uncertain is True and error.value.target_copy_remains is True
        assert events == ['validate', 'stop', 'carry'], 'an uncertain carry must not trigger a source or target launch'
    elif scenario in ("restart_fails_after_carry_failure", "restart_fails_after_copy"):
        with pytest.raises(server.AccountSwitchRecoveryFailed) as error:
            asyncio.run(server._relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert error.value.code == ('profile-context-changed' if scenario == 'restart_fails_after_copy' else 'carry_failed')
        assert error.value.target_copy_remains is (scenario != 'restart_fails_after_carry_failure')
        assert error.value.target_copy_uncertain is False
        assert ('start', 'default', '/tmp/source') in events
    elif scenario != "success":
        with pytest.raises(server.AccountSwitchUndone) as error:
            asyncio.run(server._relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch))
        assert error.value.target_copy_remains is (scenario in ("target_changed", "target_changed_during_launch"))
        if error.value.target_copy_remains:
            assert "target copy remains" in server._switch_undone_text("default", error.value)
        assert events == ["validate", "stop", "carry", *(["target-check"] if scenario in ("target_changed", "target_changed_during_launch") else []),
                          *([("start", "work", "/tmp/target")] if scenario == "target_changed_during_launch" else []),
                          ("start", "default", "/tmp/source")]
    else:
        assert asyncio.run(server._relaunch_in_place(source, "/tmp", "codex", "codex", "codex", None, switch)) == "session"
        assert events == ["validate", "stop", "carry", "target-check", ("start", "work", "/tmp/target")]


def test_default_context_survives_snapshot_and_refuses_changed_default(monkeypatch):
    monkeypatch.setenv("HOME", "/tmp/account-one")
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    revision = accountswitch.default_context("codex", os.environ)["context_revision"]
    fields = server._account_fields({"meta": {"known_agent": "codex", "account_context_revision": revision}})
    assert fields == {"default_context_revision": revision}
    agent = {"type": "codex", "session_id": "0a1b2c3d-1111-2222-3333-444444444444", "argv": ["codex"]}
    session = {"name": "sample", "cwd": "/tmp", "created": 1, "agent": agent, **fields}
    snapshot = respawn.entry_of(session)
    assert snapshot["default_context_revision"] == revision
    assert snapshot["agent"]["session_id"] == agent["session_id"]
    assert respawn.valid_entry({**snapshot, "default_context_revision": "invalid"}) is None
    assert respawn.valid_entry({**snapshot, "account": "work"}) is None
    entry = snapshot
    assert asyncio.run(server._restore_launch_context(entry)) is None
    monkeypatch.setenv("HOME", "/tmp/account-two")
    with pytest.raises(web.HTTPConflict) as error:
        asyncio.run(server._restore_launch_context(entry))
    assert "Default account context changed" in error.value.text


@pytest.mark.parametrize("change_before_send", [False, True])
def test_restored_default_is_pinned_and_rechecked_before_launch(monkeypatch, change_before_send):
    monkeypatch.setenv("HOME", "/tmp/account-one")
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    revision = accountswitch.default_context("codex", os.environ)["context_revision"]
    sent = []

    async def unique(*_args):
        if change_before_send:
            monkeypatch.setenv("HOME", "/tmp/account-two")
        return "sample"

    async def send(request, _conversation):
        sent.append(request)

    monkeypatch.setattr(server, "LAUNCH_SETTINGS", SimpleNamespace(allows_cwd=lambda _cwd: True))
    monkeypatch.setattr(server, "unique_name", unique)
    monkeypatch.setattr(server, "_send_launch", send)
    monkeypatch.setattr(server, "_mesh_reach_env", lambda: {})
    monkeypatch.setattr(server.sessiontoken, "issue", lambda *_args: "synthetic")
    args = ("sample", "/tmp", "codex", "codex", "codex")
    if change_before_send:
        with pytest.raises(web.HTTPConflict):
            asyncio.run(server.new_session(*args, default_context_revision=revision))
        assert sent == []
    else:
        assert asyncio.run(server.new_session(*args, default_context_revision=revision)) == "sample"
        assert sent[0]["meta"]["account_context_revision"] == revision
        assert "/tmp/account-one/.codex" in sent[0]["command"]


def test_profile_restart_revalidates_the_identity_captured_before_stop(monkeypatch):
    context = {"id": "work", "context_revision": "a" * 64, "env": {"CODEX_HOME": "/tmp/work"}}
    events = []

    async def restart_context(*_args):
        return context

    async def profile(*_args):
        return context

    async def prepared(_agent, command, _cwd, _context):
        return command, None, None

    async def arrangement(*_args):
        return None

    async def stop(*_args, **_kwargs):
        events.append("stop")
        return 2

    async def start(*_args, expected_identity=None, **_kwargs):
        events.append(("start", expected_identity))
        raise server.AccountContextChanged()

    monkeypatch.setattr(server, "_restart_profile_context", restart_context)
    monkeypatch.setattr(server, "_profile_launch_context", profile)
    monkeypatch.setattr(server, "_switch_root_identity", lambda _context: (1, 2))
    monkeypatch.setattr(server, "_prepared_launch", prepared)
    monkeypatch.setattr(server, "_arrangement_of", arrangement)
    monkeypatch.setattr(server, "_carry_arrangement", arrangement)
    monkeypatch.setattr(server, "_stop_agent", stop)
    monkeypatch.setattr(server, "_start_in_place", start)
    with pytest.raises(web.HTTPServiceUnavailable) as error:
        asyncio.run(server.relaunch_in_place({"name": "session", "created": 1}, "/tmp", "codex",
                                             "codex", "codex", "work"))
    assert "could not be started again" in error.value.text
    assert events == ["stop", ("start", (1, 2))]


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


@pytest.mark.parametrize('reason', ['agent_stop_uncertain', 'agent_still_running', 'stale_incarnation'])
def test_partial_stop_is_reported_as_uncertain(monkeypatch, reason):
    async def host(*_args, **_kwargs):
        return {"ok": False, "reason": reason}
    monkeypatch.setattr(server, "host", host)
    with pytest.raises(web.HTTPServiceUnavailable) as error:
        asyncio.run(server._stop_agent({"name": "session", "created": 1}, "codex"))
    assert "uncertain" in error.value.text


def test_launch_rechecks_profile_revision_after_preparation(monkeypatch):
    calls = []
    async def changed(*_args):
        calls.append("revision")
        raise web.HTTPConflict(text="changed")
    async def host(*_args, **_kwargs):
        calls.append("host")
        return {"ok": True}
    monkeypatch.setattr(server, "_switch_profile_context", changed)
    monkeypatch.setattr(server, "host", host)
    context = {"id": "work", "context_revision": "a" * 64, "env": {"CODEX_HOME": "/tmp/work"},
               "roots": {"config": "/tmp/work"}, "unset": []}
    with pytest.raises(server.AccountContextChanged):
        asyncio.run(server._start_in_place({"name": "session", "meta": {}}, 2, "/tmp", "codex",
                    "codex", "codex", None, None, "work", context["env"], context=context,
                    expected_identity=(1, 2), validate_default_target=True))
    assert calls == ["revision"]


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
    monkeypatch.setattr(server, "_describe_with_hooks", lambda _items, _prune=True: {
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
    assert server._native_switch_available(agent, {"meta": {}, "pty_capabilities": capabilities}) is expected


def test_unqualified_platform_refuses_even_a_capable_host(monkeypatch):
    monkeypatch.setattr(server, "NATIVE_SWITCH_QUALIFIED", False)
    monkeypatch.setattr(server, "_native_profile_mode", lambda: True)
    raw = {"meta": {}, "pty_capabilities": ["agent_relaunch_v1", "agent_relaunch_bound_v1"]}
    assert server._native_switch_available("codex", raw) is False
    monkeypatch.setattr(server, "NATIVE_SWITCH_QUALIFIED", True)
    assert server._native_switch_available("codex", raw) is True


def test_profile_qualification_uses_live_host_and_supported_backend(monkeypatch):
    monkeypatch.setattr(server, "NATIVE_SWITCH_QUALIFIED", True)
    monkeypatch.setattr(server, "_native_profile_mode", lambda: True)
    profiles = [{"backend": backend, "enabled": enabled, "switch_qualified": False}
                for backend, enabled in (("codex", True), ("codex", False), ("pi", True), ("claude", True))]
    base = {"name": "s", "pid": 42, "cwd": "/tmp", "created": 1, "activity": 1, "attached": 0}
    sessions = [{**base, "meta": {"known_agent": "codex"},
                 "pty_capabilities": ["agent_relaunch_v1", "agent_relaunch_bound_v1"]},
                {**base, "meta": {"known_agent": "pi"},
                 "pty_capabilities": ["agent_relaunch_v1", "agent_relaunch_bound_v1"]},
                {**base, "meta": {"known_agent": "claude"}, "pty_capabilities": ["agent_relaunch_v1"]}]
    assert [p["switch_qualified"] for p in server._qualify_profiles(profiles, sessions)] == [True, False, False, False]
