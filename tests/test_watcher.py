# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The resume-when-idle watcher survives bad tabs (R7)."""

import asyncio

import server


async def test_an_error_on_one_tab_does_not_stop_the_watcher(monkeypatch):
    monkeypatch.setattr(server, "save_pending", lambda: None)
    monkeypatch.setattr(server, "PENDING", {1: {"agent_pid": 11}, 2: {"agent_pid": 22}})
    resumed = []

    async def fake_sessions(*_args, **_kwargs):
        return {"external": [
            {"pid": 1, "cwd": "/tmp", "agent": {"pid": 11, "type": "claude", "status": "idle"}},
            {"pid": 2, "cwd": "/tmp", "agent": {"pid": 22, "type": "claude", "status": "idle"}}]}

    async def fake_resume(target):
        if target["pid"] == 1:
            raise ProcessLookupError(3, "No such process")
        resumed.append(target["pid"])
        return "mesh-2"

    monkeypatch.setattr(server, "sessions", fake_sessions)
    monkeypatch.setattr(server, "resume_target", fake_resume)
    real_sleep = asyncio.sleep
    monkeypatch.setattr(server.asyncio, "sleep", lambda _s: real_sleep(0))
    task = asyncio.ensure_future(server.idle_watcher(None))
    for _ in range(50):
        await real_sleep(0.01)
        if resumed:
            break
    task.cancel()
    assert resumed == [2]
    assert server.PENDING == {}


async def test_wait_dead_handles_a_vanished_process(monkeypatch):
    monkeypatch.setattr(server.discover, "read_stat", lambda pid: None)
    assert await server._wait_dead(999999, timeout=1)


async def test_resume_checks_before_stopping_the_agent(monkeypatch, tmp_path):
    import os
    import pytest
    from aiohttp import web
    killed = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: killed.append(pid))
    target = {"cwd": str(tmp_path / "gone"), "agent": {"pid": 4242, "type": "claude", "session_id": "S", "argv": ["claude"]}}
    with pytest.raises(web.HTTPConflict):
        await server.resume_target(target)
    async def down(_req):
        raise web.HTTPServiceUnavailable(text="ptyhost is not responding")
    monkeypatch.setattr(server, "host", down)
    target["cwd"] = str(tmp_path)
    with pytest.raises(web.HTTPServiceUnavailable):
        await server.resume_target(target)
    assert killed == []


async def test_two_concurrent_resumes_launch_once(monkeypatch, tmp_path):
    import os
    from aiohttp import web
    monkeypatch.setattr(os, "kill", lambda pid, sig: None)
    launched = []

    async def ok_host(_req):
        return []

    async def slow_new(*args, **kwargs):
        launched.append(args)
        await asyncio.sleep(0.05)
        return "mesh"
    monkeypatch.setattr(server, "host", ok_host)
    monkeypatch.setattr(server, "new_session", slow_new)
    async def dead(pid, timeout=10):
        return True
    monkeypatch.setattr(server, "_wait_dead", dead)
    target = {"cwd": str(tmp_path), "agent": {"pid": 77, "type": "claude", "session_id": "S", "argv": ["claude"]}}
    results = await asyncio.gather(server.resume_target(target), server.resume_target(target), return_exceptions=True)
    assert len(launched) == 1
    assert sum(isinstance(r, web.HTTPConflict) for r in results) == 1


async def test_pi_reserves_resume_before_preparing_runtime(monkeypatch, tmp_path):
    from aiohttp import web

    entered = asyncio.Event()
    release = asyncio.Event()
    launched = []
    monkeypatch.setattr(server, "_resume_argv", lambda agent: ["pi"])

    async def runtime():
        entered.set()
        await release.wait()
        return ("pi", tmp_path)

    async def relaunch(*args):
        launched.append(args)
        return "mesh"

    monkeypatch.setattr(server, "_pi_runtime", runtime)
    monkeypatch.setattr(server, "_stop_and_relaunch", relaunch)
    target = {"cwd": str(tmp_path), "agent": {"pid": 98765, "type": "pi"}}
    first = asyncio.create_task(server.resume_target(target))
    await entered.wait()
    try:
        result = await asyncio.gather(server.resume_target(target), return_exceptions=True)
        assert isinstance(result[0], web.HTTPConflict)
    finally:
        release.set()
        await first
    assert len(launched) == 1


async def test_a_failed_resume_keeps_the_request(monkeypatch):
    from aiohttp import web
    monkeypatch.setattr(server, "save_pending", lambda: None)
    monkeypatch.setattr(server, "PENDING", {1: {"agent_pid": 11}})

    async def failing(target):
        raise web.HTTPServiceUnavailable(text="ptyhost is not responding")
    monkeypatch.setattr(server, "resume_target", failing)
    data = {"external": [{"pid": 1, "cwd": "/tmp", "agent": {"pid": 11, "type": "claude", "status": "idle"}}]}
    streak = {1: 5}
    await server._watch_one(1, data, streak)
    assert 1 in server.PENDING


async def test_a_lasting_failure_drops_the_request(monkeypatch):
    from aiohttp import web
    monkeypatch.setattr(server, "save_pending", lambda: None)
    monkeypatch.setattr(server, "PENDING", {1: {"agent_pid": 11}})

    async def stuck(target):
        raise web.HTTPConflict(text="The process did not stop; nothing was restarted")
    monkeypatch.setattr(server, "resume_target", stuck)
    data = {"external": [{"pid": 1, "cwd": "/tmp", "agent": {"pid": 11, "type": "claude", "status": "idle"}}]}
    await server._watch_one(1, data, {1: 5})
    assert 1 not in server.PENDING
