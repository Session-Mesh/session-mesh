# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The optional launch-settings file is narrow, versioned and fail-closed."""

import json
from pathlib import Path

import pytest

import launchsettings
import server


def value(root, agents=("claude", "codex")):
    return {"v": 1, "workspace_roots": [str(root)], "enabled_agents": list(agents)}


def test_valid_v1_settings_restrict_real_cwds_and_report_without_launching(tmp_path):
    home = tmp_path / "home"
    root, child = home / "dev", home / "dev" / "mesh"
    child.mkdir(parents=True)
    settings = launchsettings.parse(value(root), home=home)
    assert settings.configured
    assert settings.allows_cwd(child)
    assert not settings.allows_cwd(tmp_path / "outside")
    assert settings.doctor() == {"v": 1, "configured": True,
                                 "workspace_roots": [str(root.resolve())],
                                 "enabled_agents": ["claude", "codex"]}


@pytest.mark.parametrize("mutate", [
    lambda current: {**current, "extra": True},
    lambda current: {**current, "v": 2},
    lambda current: {**current, "workspace_roots": ["relative"]},
    lambda current: {**current, "enabled_agents": ["claude", "unknown"]},
    lambda current: {**current, "enabled_agents": ["claude", "claude"]},
])
def test_parse_rejects_unknown_or_unsafe_settings(tmp_path, mutate):
    home = tmp_path / "home"
    root = home / "dev"
    root.mkdir(parents=True)
    with pytest.raises(launchsettings.InvalidLaunchSettings):
        launchsettings.parse(mutate(value(root)), home=home)


def test_parse_rejects_root_outside_home_and_a_symlink_escape(tmp_path):
    home, outside = tmp_path / "home", tmp_path / "outside"
    home.mkdir()
    outside.mkdir()
    escaped = home / "escape"
    escaped.symlink_to(outside, target_is_directory=True)
    for root in (outside, escaped):
        with pytest.raises(launchsettings.InvalidLaunchSettings):
            launchsettings.parse(value(root), home=home)


def test_absent_environment_is_legacy_mode_and_file_load_is_all_or_nothing(tmp_path):
    home = tmp_path / "home"
    root = home / "dev"
    root.mkdir(parents=True)
    assert launchsettings.load_from_env({}, home=home).configured is False
    path = tmp_path / "launch.json"
    path.write_text(json.dumps(value(root)))
    assert launchsettings.load_from_env({launchsettings.ENV: str(path)}, home=home).allows_cwd(root)
    path.write_text("[]")
    with pytest.raises(launchsettings.InvalidLaunchSettings):
        launchsettings.load_from_env({launchsettings.ENV: str(path)}, home=home)


async def test_new_session_applies_workspace_and_enabled_agent_boundaries(client, auth_cookie, monkeypatch):
    """The server consults the immutable startup policy before it contacts ptyhost."""
    home = Path.home()
    allowed, outside = home / "allowed-launch-root", home / "outside-launch-root"
    allowed.mkdir(exist_ok=True)
    outside.mkdir(exist_ok=True)
    settings = launchsettings.parse(value(allowed, ("claude",)), home=home)
    monkeypatch.setattr(server, "LAUNCH_SETTINGS", settings)
    monkeypatch.setattr(server, "AGENT_PRESETS", {"claude": server.AGENT_PRESETS["claude"]})

    disabled = await client.post("/api/new", json={"preset": "codex", "cwd": str(allowed)},
                                 headers=auth_cookie)
    assert disabled.status == 400
    assert "disabled" in await disabled.text()

    rejected = await client.post("/api/new", json={"preset": "shell", "cwd": str(outside)},
                                 headers=auth_cookie)
    assert rejected.status == 403
    assert "allowed" in await rejected.text()


@pytest.fixture
def confined(monkeypatch):
    """workspace_roots = one folder; ptyhost replaced by a recorder. Returns (allowed, outside, calls)."""
    home = Path.home()
    allowed, outside = home / "allowed-launch-root", home / "outside-launch-root"
    allowed.mkdir(exist_ok=True)
    outside.mkdir(exist_ok=True)
    monkeypatch.setattr(server, "LAUNCH_SETTINGS", launchsettings.parse(value(allowed, ("claude",)), home=home))
    calls = []

    async def recorder(request):
        calls.append(request)
        return []

    monkeypatch.setattr(server, "host", recorder)
    return allowed, outside, calls


def started(calls):
    return [call["cwd"] for call in calls if call["op"] == "new"]


async def test_no_session_starts_outside_the_workspace_roots_whatever_asks(confined):
    allowed, outside, calls = confined
    with pytest.raises(server.web.HTTPForbidden) as refused:
        await server.new_session("anything", str(outside))
    assert "allowed" in refused.value.text and started(calls) == []
    assert await server.new_session("inside", str(allowed)) == "inside"
    assert started(calls) == [str(allowed)]


async def test_resuming_from_the_history_applies_workspace_roots(confined, monkeypatch):
    _, outside, calls = confined

    async def nowhere(*_args):
        return None

    async def detail(*_args):
        return {"cwd": str(outside), "resumable": True}

    monkeypatch.setattr(server, "live_where", nowhere)
    monkeypatch.setattr(server, "history_detail", detail)
    with pytest.raises(server.web.HTTPForbidden):
        await server._resume_history("claude", "abcdefgh-0000")
    assert started(calls) == []


async def test_restoring_a_lost_session_applies_workspace_roots(confined, monkeypatch):
    _, outside, calls = confined
    server.respawn.update([{"name": "lost", "cwd": str(outside), "agent": None, "created": 1.0}], listed=True)
    server.respawn.update([], listed=True)
    dropped = []
    monkeypatch.setattr(server.respawn, "drop_lost", dropped.append)
    outcome = await server.restore_one("lost", set(), server.asyncio.Lock())
    assert outcome["ok"] is False and "allowed" in outcome["error"]
    assert started(calls) == [] and dropped == []          # still offered: the owner decides


async def test_adopting_an_outside_agent_applies_workspace_roots_before_stopping_it(confined, monkeypatch):
    _, outside, calls = confined
    signals = []
    monkeypatch.setattr(server, "_resume_argv", lambda agent: ["claude", "--resume", "abcdefgh-0000"])
    monkeypatch.setattr(server.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    target = {"pid": 4242, "cwd": str(outside), "agent": {"pid": 4243, "type": "claude", "session_id": "abcdefgh-0000"}}
    with pytest.raises(server.web.HTTPForbidden) as refused:
        await server.resume_target(target)
    assert refused.value.text == server.OUTSIDE_WORKSPACE_ROOTS
    assert signals == [] and calls == []
