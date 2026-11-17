# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

import asyncio

import pytest

import agentmail
import agentwake


def identity(name, created, agent="codex", wake_capable=None):
    result = {"id": name, "created": created, "agent": agent}
    if wake_capable is not None:
        result["wake_capable"] = wake_capable
    return result


async def test_dispatcher_retries_durable_generation_and_marks_only_acceptance(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0, "claude")
    live = [alpha, beta]
    agentmail.send(alpha, beta, "message", "one", live, now=3.0)
    agentmail.send(alpha, beta, "message", "two", live, now=4.0)
    wake_live = [{**item, "wake_capable": True} for item in live]
    requests = []

    async def listed():
        return wake_live

    async def notify(request):
        requests.append(request)
        if len(requests) == 1:
            return {"ok": False, "reason": "human_dirty"}
        return {"ok": True, "accepted": True}

    dispatcher = agentwake.Dispatcher(listed, notify)
    assert await dispatcher.dispatch_once() is True
    assert await dispatcher.dispatch_once() is False
    assert requests[0]["notification_id"] == requests[1]["notification_id"]
    assert requests[1]["count"] == 2
    assert agentmail.claim_wake(beta, live) is None


async def test_dispatcher_treats_host_idempotence_as_delivery(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    agentmail.send(alpha, beta, "task", "work", live, now=3.0)
    wake_live = [{**item, "wake_capable": True} for item in live]

    async def listed():
        return wake_live

    async def notify(_request):
        return {"ok": True, "accepted": False, "reason": "already_notified"}

    dispatcher = agentwake.Dispatcher(listed, notify)
    assert await dispatcher.dispatch_once() is False
    assert agentmail.claim_wake(beta, live) is None


async def test_message_removal_cannot_race_a_claimed_host_transaction(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha, beta = identity("alpha", 1.0), identity("beta", 2.0)
    live = [alpha, beta]
    receipt = agentmail.send(alpha, beta, "message", "ordered", live, now=3.0)
    wake_live = [{**item, "wake_capable": True} for item in live]
    entered, release = asyncio.Event(), asyncio.Event()

    async def listed():
        return wake_live

    async def notify(_request):
        entered.set()
        await release.wait()
        return {"ok": False, "reason": "human_dirty"}

    dispatcher = agentwake.Dispatcher(listed, notify)
    delivery = asyncio.create_task(dispatcher.dispatch_once())
    await entered.wait()
    removal = asyncio.create_task(dispatcher.mutate(
        agentmail.acknowledge, beta, [receipt["id"]], live))
    await asyncio.sleep(0)
    assert not removal.done()
    release.set()
    assert await delivery is True
    assert await removal == [receipt["id"]]
    assert agentmail.claim_wake(beta, live) is None


async def test_old_host_keeps_wake_durable_without_trying_unknown_operation(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0, "claude", wake_capable=False)
    live = [alpha, beta]
    agentmail.send(agentwake.Dispatcher._mail_identity(alpha),
                   agentwake.Dispatcher._mail_identity(beta), "message", "one",
                   [agentwake.Dispatcher._mail_identity(item) for item in live], now=3.0)
    requests = []

    async def listed():
        return live

    async def notify(request):
        requests.append(request)
        return {"error": "Unknown op: notify_if"}

    dispatcher = agentwake.Dispatcher(listed, notify)
    for _ in range(100):
        dispatcher.trigger()
    assert await dispatcher.dispatch_once() is True
    assert requests == []
    claimed = agentmail.claim_wake(
        agentwake.Dispatcher._mail_identity(beta),
        [agentwake.Dispatcher._mail_identity(item) for item in live])
    assert claimed is not None and claimed["state"] == "claimed"


async def test_capability_appearing_delivers_same_durable_generation(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0, "claude", wake_capable=False)
    live = [alpha, beta]
    mail_live = [agentwake.Dispatcher._mail_identity(item) for item in live]
    agentmail.send(mail_live[0], mail_live[1], "task", "work", mail_live, now=3.0)
    requests = []

    async def listed():
        return live

    async def notify(request):
        requests.append(request)
        return {"ok": True, "accepted": True}

    dispatcher = agentwake.Dispatcher(listed, notify)
    assert await dispatcher.dispatch_once() is True
    claimed = agentmail.claim_wake(mail_live[1], mail_live)
    notification_id = claimed["notification_id"]
    beta["wake_capable"] = True
    assert await dispatcher.dispatch_once() is False
    assert requests[0]["notification_id"] == notification_id
    assert agentmail.claim_wake(mail_live[1], mail_live) is None


async def test_mixed_capabilities_only_notify_capable_incarnation(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = identity("alpha", 1.0)
    old = identity("old", 2.0, "claude", wake_capable=False)
    new = identity("new", 3.0, "claude", wake_capable=True)
    live = [alpha, old, new]
    mail_live = [agentwake.Dispatcher._mail_identity(item) for item in live]
    agentmail.send(mail_live[0], mail_live[1], "message", "old", mail_live, now=4.0)
    agentmail.send(mail_live[0], mail_live[2], "message", "new", mail_live, now=5.0)
    requests = []

    async def listed():
        return live

    async def notify(request):
        requests.append(request)
        return {"ok": True, "accepted": True}

    dispatcher = agentwake.Dispatcher(listed, notify)
    assert await dispatcher.dispatch_once() is True
    assert [request["name"] for request in requests] == ["new"]
    assert agentmail.claim_wake(mail_live[1], mail_live) is not None
    assert agentmail.claim_wake(mail_live[2], mail_live) is None


async def test_trigger_storm_cannot_bypass_monotonic_capability_backoff(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0, "claude", wake_capable=False)
    live = [alpha, beta]
    mail_live = [agentwake.Dispatcher._mail_identity(item) for item in live]
    agentmail.send(mail_live[0], mail_live[1], "message", "wake", mail_live, now=3.0)
    listed_count = 0
    first_listed = asyncio.Event()
    delivered = asyncio.Event()

    async def listed():
        nonlocal listed_count
        listed_count += 1
        first_listed.set()
        return live

    async def notify(_request):
        delivered.set()
        return {"ok": True, "accepted": True}

    dispatcher = agentwake.Dispatcher(
        listed, notify, retry_seconds=0.03, max_retry_seconds=0.06)
    await dispatcher.start()
    try:
        await asyncio.wait_for(first_listed.wait(), 0.2)
        for _ in range(100):
            dispatcher.trigger()
        await asyncio.sleep(0.01)
        assert listed_count == 1
        beta["wake_capable"] = True
        await asyncio.wait_for(delivered.wait(), 0.2)
        await dispatcher.mutate(lambda: None)
        assert listed_count == 2
        assert agentmail.claim_wake(mail_live[1], mail_live) is None
    finally:
        await dispatcher.close()


async def test_trigger_storm_cannot_bypass_transport_backoff(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0, "claude", wake_capable=True)
    live = [alpha, beta]
    mail_live = [agentwake.Dispatcher._mail_identity(item) for item in live]
    agentmail.send(mail_live[0], mail_live[1], "message", "wake", mail_live, now=3.0)
    attempts = 0
    first_failed = asyncio.Event()
    delivered = asyncio.Event()

    async def listed():
        return live

    async def notify(_request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            first_failed.set()
            raise ConnectionError("PTY owner reset")
        delivered.set()
        return {"ok": True, "accepted": True}

    dispatcher = agentwake.Dispatcher(
        listed, notify, retry_seconds=0.03, max_retry_seconds=0.06)
    await dispatcher.start()
    try:
        await asyncio.wait_for(first_failed.wait(), 0.2)
        for _ in range(100):
            dispatcher.trigger()
        await asyncio.sleep(0.01)
        assert attempts == 1
        await asyncio.wait_for(delivered.wait(), 0.2)
        await dispatcher.mutate(lambda: None)
        assert attempts == 2
        assert agentmail.claim_wake(mail_live[1], mail_live) is None
    finally:
        await dispatcher.close()


@pytest.mark.parametrize("reason", ["human_dirty", "unsupported_foreground", "input_refused", "not_confirmed"])
async def test_repeated_readiness_refusals_never_inherit_hard_backoff(
        tmp_path, monkeypatch, reason):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    alpha = identity("alpha", 1.0)
    beta = identity("beta", 2.0, "claude", wake_capable=True)
    live = [alpha, beta]
    mail_live = [agentwake.Dispatcher._mail_identity(item) for item in live]
    agentmail.send(mail_live[0], mail_live[1], "message", "wake", mail_live, now=3.0)
    attempts = 0
    refused_seven = asyncio.Event()
    delivered = asyncio.Event()
    allow = False

    async def listed():
        return live

    async def notify(_request):
        nonlocal attempts
        attempts += 1
        if not allow:
            if attempts == 7:
                refused_seven.set()
            return {"ok": False, "reason": reason}
        delivered.set()
        return {"ok": True, "accepted": True}

    dispatcher = agentwake.Dispatcher(
        listed, notify, retry_seconds=0.02, max_retry_seconds=1.0)
    await dispatcher.start()
    try:
        await asyncio.wait_for(refused_seven.wait(), 0.5)
        allow = True
        started = asyncio.get_running_loop().time()
        dispatcher.trigger()  # the clean H boundary
        await asyncio.wait_for(delivered.wait(), 0.1)
        elapsed = asyncio.get_running_loop().time() - started
        await dispatcher.mutate(lambda: None)
        assert attempts == 8
        assert elapsed < 0.08
        assert agentmail.claim_wake(mail_live[1], mail_live) is None
    finally:
        await dispatcher.close()


async def test_pi_unconfirmed_does_not_delay_other_agent(tmp_path, monkeypatch):
    monkeypatch.setattr(agentmail, "FILE", tmp_path / "agent-mail.json")
    source = identity("source", 1.0)
    pi = identity("pi", 2.0, "pi", wake_capable=True)
    claude = identity("claude", 3.0, "claude", wake_capable=True)
    live = [source, pi, claude]
    mail_live = [agentwake.Dispatcher._mail_identity(item) for item in live]
    agentmail.send(mail_live[0], mail_live[1], "message", "pi", mail_live)
    agentmail.send(mail_live[0], mail_live[2], "message", "claude", mail_live)
    calls = []

    async def listed():
        return live

    async def notify(request):
        calls.append(request["agent"])
        return ({"reason": "not_confirmed"} if request["agent"] == "pi"
                else {"ok": True, "accepted": True})

    dispatcher = agentwake.Dispatcher(listed, notify)
    assert await dispatcher.dispatch_once() is True
    assert calls == ["pi", "claude"]
    assert agentmail.claim_wake(mail_live[1], mail_live) is not None
    assert agentmail.claim_wake(mail_live[2], mail_live) is None

