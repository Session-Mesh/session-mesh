# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Session-capability boundary for explicit, non-terminal agent messages."""

import asyncio
import json
import os
from pathlib import Path
import shutil

import pytest
from aiohttp import web

import agentmail
import agentmcp
import piwake
import server
import session_helpers
from session_helpers import OTHER_NONCE, add_session


@pytest.fixture
def mail_file(tmp_path, monkeypatch):
    path = tmp_path / "conf" / "agent-mail.json"
    monkeypatch.setattr(agentmail, "FILE", path)
    return path


@pytest.fixture
def mesh_listing(monkeypatch):
    return session_helpers.listing.__wrapped__(monkeypatch)


def agents(sessions):
    alpha = add_session(sessions, "alpha")
    beta = add_session(sessions, "beta", OTHER_NONCE)
    sessions[0]["meta"]["known_agent"] = "codex"
    sessions[1]["meta"]["known_agent"] = "claude"
    for index, session in enumerate(sessions, 1):
        session.update(pid=index, activity=float(index), attached=0)
    return alpha, beta


def test_mail_peers_include_pi_but_not_unintegrated_agents(mesh_listing):
    agents(mesh_listing)
    extra = dict(mesh_listing[0])
    extra["name"] = "unknown-peer"
    extra["created"] = 3.0
    extra["meta"] = {**extra["meta"], "known_agent": "unlisted"}
    mesh_listing.append(extra)
    pi = dict(extra)
    pi.update(name="pi-peer", created=4.0, meta={**extra["meta"], "known_agent": "pi"})
    mesh_listing.append(pi)
    assert [item["id"] for item in server._agent_mail_live(mesh_listing)] == ["alpha", "beta", "pi-peer"]


async def test_pi_mailbox_does_not_advertise_untested_wake(mesh_listing, monkeypatch):
    agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"
    mesh_listing[0]["pty_capabilities"] = ["agent_wake_v1", "human_input_lease_v1"]

    async def host(_request):
        return mesh_listing

    monkeypatch.setattr(server, "host", host)
    assert (await server._agent_wake_live())[0]["wake_capable"] is False


async def test_pi_wake_stream_auth_incarnation_and_confirmation(client, mesh_listing, monkeypatch):
    pi, other = agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"

    async def host(request):
        assert request["op"] == "list"
        return mesh_listing

    monkeypatch.setattr(server, "host", host)
    path = "/api/agent-mail/@self/pi-wakes"
    assert (await client.get(path)).status == 401
    assert (await client.get(path, headers=other)).status == 403
    stream = await client.get(path, headers=pi)
    try:
        assert json.loads(await stream.content.readline()) == {"ready": True}
        identities = await server._agent_wake_live(client.app["pi_wakes"])
        assert identities[0]["wake_capable"] is True
        assert (await client.get(path, headers=pi)).status == 409
        notice = {"name": "alpha", "created": 1.0, "notification_id": "a" * 32,
                  "count": 2, "agent": "pi"}
        assert await client.app["pi_wakes"].notify(notice) == {"reason": "not_confirmed"}
        assert json.loads(await stream.content.readline()) == {
            "notification_id": "a" * 32, "count": 2}
        another = {**notice, "notification_id": "c" * 32}
        assert await client.app["pi_wakes"].notify(another) == {"reason": "not_confirmed"}
        assert json.loads(await stream.content.readline()) == {
            "notification_id": "c" * 32, "count": 2}
        ack = "/api/agent-mail/@self/pi-wake-ack"
        assert (await client.post(ack, headers=other, json={"notification_id": "a" * 32})).status == 403
        assert (await client.post(ack, headers=pi, json={"notification_id": "b" * 32})).status == 409
        assert (await client.post(ack, headers=pi, json={"notification_id": "c" * 32})).status == 200
        assert await client.app["pi_wakes"].notify(another) == {"ok": True, "accepted": True}
        assert (await client.post(ack, headers=pi, json={"notification_id": "a" * 32})).status == 200
        assert await client.app["pi_wakes"].notify(notice) == {"ok": True, "accepted": True}
        stale = {**notice, "created": 999.0}
        assert await client.app["pi_wakes"].notify(stale) == {"reason": "not_connected"}
        during_shutdown = {**notice, "notification_id": "d" * 32}
        assert await client.app["pi_wakes"].notify(during_shutdown) == {"reason": "not_confirmed"}
        assert json.loads(await stream.content.readline())["notification_id"] == "d" * 32
        await client.app["pi_wakes"].close()
        await asyncio.wait_for(stream.content.read(), 3)
        assert await client.app["pi_wakes"].notify(during_shutdown) == {"reason": "not_connected"}
        assert (await client.get(path, headers=pi)).status == 503
    finally:
        stream.close()


async def test_pi_unconfirmed_wake_does_not_block_mail_operations(
        client, mesh_listing, mail_file, monkeypatch):
    sender, pi = agents(mesh_listing)
    mesh_listing[1]["meta"]["known_agent"] = "pi"
    async def host(request):
        assert request["op"] == "list"
        return mesh_listing
    monkeypatch.setattr(server, "host", host)
    stream = await client.get("/api/agent-mail/@self/pi-wakes", headers=pi)
    try:
        await stream.content.readline()
        url = "/api/agent-mail/@self/send"
        first = {"target": "beta", "target_created": 2.0, "kind": "task", "text": "one"}
        assert (await client.post(url, headers=sender, json=first)).status == 200
        notice = json.loads(await asyncio.wait_for(stream.content.readline(), 3))
        assert "notification_id" in notice
        # Pi deliberately does not acknowledge. The mailbox lock must already
        # be released so another agent can send without waiting for timeout.
        second = {**first, "text": "two"}
        result = await asyncio.wait_for(client.post(url, headers=sender, json=second), 1)
        assert result.status == 200
        inbox = await client.get("/api/agent-mail/@self/inbox", headers=pi)
        assert len((await inbox.json())["messages"]) == 2
    finally:
        stream.close()


async def test_orphaned_pi_confirmation_expires_without_blocking_new_wake(
        client, mesh_listing, monkeypatch):
    pi, _ = agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"
    async def host(request):
        return mesh_listing
    monkeypatch.setattr(server, "host", host)
    monkeypatch.setattr(piwake, "WAKE_TTL_SECONDS", 0.05)
    stream = await client.get("/api/agent-mail/@self/pi-wakes", headers=pi)
    try:
        await stream.content.readline()
        target = {"id": "alpha", "created": 1.0}
        notice = {"name": "alpha", "created": 1.0, "notification_id": "a" * 32,
                  "count": 1, "agent": "pi"}
        assert await client.app["pi_wakes"].notify(notice) == {"reason": "not_confirmed"}
        await stream.content.readline()
        # ACK is received, then the corresponding mailbox wake is removed
        # before dispatch consumes it: the orphan must expire on its own.
        assert client.app["pi_wakes"].acknowledge(target, "a" * 32)
        await asyncio.sleep(0.1)
        assert client.app["pi_wakes"]._connections[("alpha", 1.0)]["pending"] == {}
        assert await client.app["pi_wakes"].notify({**notice, "notification_id": "b" * 32}) == {
            "reason": "not_confirmed"}
        assert json.loads(await stream.content.readline())["notification_id"] == "b" * 32
    finally:
        stream.close()


async def test_real_pi_extension_replays_persisted_notice(client, mesh_listing, monkeypatch, tmp_path):
    pi_bin = shutil.which("pi")
    if not pi_bin:
        pytest.skip("Pi not installed")
    pi, _ = agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"

    async def host(request):
        assert request["op"] == "list"
        return mesh_listing

    monkeypatch.setattr(server, "host", host)
    transcript = tmp_path / "session.jsonl"
    marker = "[Mesh notification " + "a" * 32 + "]"
    transcript.write_text("\n".join(json.dumps(entry) for entry in [
        {"type": "session", "version": 3, "id": "123e4567-e89b-12d3-a456-426614174000",
         "timestamp": "2026-10-31T00:00:00.000Z", "cwd": str(tmp_path)},
        {"type": "message", "id": "12345678", "parentId": None,
         "timestamp": "2026-10-31T00:00:01.000Z", "message": {
             "role": "user", "content": marker, "timestamp": 1793404801000}},
    ]) + "\n")
    env = {"HOME": str(tmp_path), "PATH": os.environ["PATH"],
           "PI_CODING_AGENT_DIR": str(tmp_path / "pi-config"), "PI_OFFLINE": "1",
           "MESH_PORT": str(client.server.port),
           "MESH_SESSION_TOKEN": pi["Authorization"].removeprefix("MeshSession ")}
    process = await asyncio.create_subprocess_exec(
        pi_bin, "--mode", "rpc", "--session", str(transcript), "--offline", "--no-mcp",
        "--no-skills", "--no-context-files", "--no-extensions", "--extension",
        str(Path(server.__file__).with_name("pi_mesh_wake.mjs")), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env, cwd=tmp_path)
    try:
        async def connected():
            while not client.app["pi_wakes"].connected({"id": "alpha", "created": 1.0}):
                if process.returncode is not None:
                    pytest.fail(f"Pi exited: {(await process.stderr.read()).decode()}")
                await asyncio.sleep(0.05)
        await asyncio.wait_for(connected(), 15)
        notice = {"name": "alpha", "created": 1.0, "notification_id": "a" * 32,
                  "count": 1, "agent": "pi"}
        async def confirmed(notice):
            while True:
                result = await client.app["pi_wakes"].notify(notice)
                if result.get("accepted"):
                    return result
                await asyncio.sleep(0.05)
        assert await asyncio.wait_for(confirmed(notice), 15) == {"ok": True, "accepted": True}
        assert transcript.read_text().count(marker) == 1
    finally:
        process.terminate()
        await asyncio.wait_for(process.wait(), 10)


@pytest.mark.parametrize("mode", ["rpc", "tui"])
async def test_real_pi_receives_new_notice_with_local_fake_model(
        client, mesh_listing, monkeypatch, tmp_path, aiohttp_server, mode):
    pi_bin = shutil.which("pi")
    if not pi_bin:
        pytest.skip("Pi not installed")
    pi, _ = agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"
    async def host(request):
        assert request["op"] == "list"
        return mesh_listing
    monkeypatch.setattr(server, "host", host)
    model_requested = asyncio.Event()
    release_model = asyncio.Event()
    async def fake_model(request):
        await request.read()
        model_requested.set()
        await release_model.wait()
        return web.Response(text="data: [DONE]\n\n", content_type="text/event-stream")
    model_app = web.Application()
    model_app.router.add_post("/v1/chat/completions", fake_model)
    model = await aiohttp_server(model_app)
    config = tmp_path / "pi-config"
    config.mkdir()
    (config / "models.json").write_text(json.dumps({"providers": {"test-local": {
        "baseUrl": f"http://127.0.0.1:{model.port}/v1", "api": "openai-completions",
        "apiKey": "test-only", "models": [{"id": "fake"}]}}}))
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({"type": "session", "version": 3,
        "id": "123e4567-e89b-12d3-a456-426614174001",
        "timestamp": "2026-10-31T00:00:00.000Z", "cwd": str(tmp_path)}) + "\n")
    env = {"HOME": str(tmp_path), "PATH": os.environ["PATH"], "PI_CODING_AGENT_DIR": str(config),
           "PI_OFFLINE": "1", "MESH_PORT": str(client.server.port),
           "TERM": "xterm-256color", "MESH_SESSION_TOKEN": pi["Authorization"].removeprefix("MeshSession ")}
    master = slave = None
    if mode == "tui":
        master, slave = os.openpty()
        os.set_blocking(master, False)
        def drain():
            try:
                os.read(master, 65536)
            except (BlockingIOError, OSError):
                pass
        asyncio.get_running_loop().add_reader(master, drain)
    process = await asyncio.create_subprocess_exec(
        pi_bin, *(["--mode", "rpc"] if mode == "rpc" else []), "--session", str(transcript), "--provider", "test-local",
        "--model", "fake", "--offline", "--no-mcp", "--no-skills", "--no-context-files",
        "--no-extensions", "--extension", str(Path(server.__file__).with_name("pi_mesh_wake.mjs")),
        stdin=asyncio.subprocess.PIPE if slave is None else slave,
        stdout=asyncio.subprocess.PIPE if slave is None else slave,
        stderr=asyncio.subprocess.PIPE if slave is None else slave, env=env, cwd=tmp_path)
    if slave is not None:
        os.close(slave)
    try:
        async def connected():
            while not client.app["pi_wakes"].connected({"id": "alpha", "created": 1.0}):
                if process.returncode is not None:
                    pytest.fail("Pi exited before connecting")
                await asyncio.sleep(0.05)
        await asyncio.wait_for(connected(), 15)
        if mode == "tui":
            await asyncio.sleep(0.3)
            os.write(master, b"human input")  # a draft, deliberately not submitted
            await asyncio.sleep(0.2)
        notice = {"name": "alpha", "created": 1.0, "notification_id": "b" * 32,
                  "count": 2, "agent": "pi"}
        async def confirmed(notice):
            while True:
                result = await client.app["pi_wakes"].notify(notice)
                if result.get("accepted"):
                    return result
                await asyncio.sleep(0.05)
        assert await asyncio.wait_for(confirmed(notice), 15) == {"ok": True, "accepted": True}
        contents = transcript.read_text()
        assert contents.count("[Mesh notification " + "b" * 32 + "]") == 1
        assert "yes/no/always" in contents
        await asyncio.wait_for(model_requested.wait(), 10)
        second = asyncio.create_task(confirmed({**notice, "notification_id": "c" * 32}))
        if mode == "rpc":
            process.stdin.write((json.dumps({"type": "prompt", "message": "human input",
                                             "streamingBehavior": "steer"}) + "\n").encode())
            await process.stdin.drain()
        else:
            os.write(master, b"\r")  # submit the pre-existing draft after the wake
        await asyncio.sleep(0.2)
        assert not second.done()  # queued, not yet persisted or acknowledged
        release_model.set()
        assert await asyncio.wait_for(second, 15) == {"ok": True, "accepted": True}
        contents = transcript.read_text()
        assert contents.count("[Mesh notification " + "c" * 32 + "]") == 1
        assert "human input" in contents
    finally:
        release_model.set()
        process.terminate()
        await asyncio.wait_for(process.wait(), 10)
        if master is not None:
            asyncio.get_running_loop().remove_reader(master)
            os.close(master)


async def test_pi_can_send_and_receive_agent_messages(client, mesh_listing, mail_file):
    pi, claude = agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"
    peers = await client.get("/api/agent-mail/@self/peers", headers=pi)
    assert peers.status == 200
    assert (await peers.json())["peers"][0]["id"] == "beta"
    sent = await client.post("/api/agent-mail/@self/send", headers=pi, json={
        "target": "beta", "target_created": 2.0, "kind": "task", "text": "hello from pi"})
    assert sent.status == 200
    inbox = await client.get("/api/agent-mail/@self/inbox", headers=claude)
    messages = (await inbox.json())["messages"]
    assert messages[0]["source"]["agent"] == "pi"
    sent_back = await client.post("/api/agent-mail/@self/send", headers=claude, json={
        "target": "alpha", "target_created": 1.0, "kind": "task", "text": "hello pi"})
    assert sent_back.status == 200
    assert (await (await client.get("/api/agent-mail/@self/inbox", headers=pi)).json())["messages"]


async def test_real_mcp_sends_authenticated_pi_message(client, mesh_listing, mail_file):
    binary = Path(agentmcp.BOARD_MCP)
    if not binary.is_file():
        pytest.skip(f"mesh-board-mcp is not installed at {binary}: scripts/bootstrap.sh installs it, and "
                    "scripts/test-local.sh runs the bootstrap after this suite, so a first run skips this case")
    pi, claude = agents(mesh_listing)
    mesh_listing[0]["meta"]["known_agent"] = "pi"
    env = {**os.environ, "MESH_PORT": str(client.server.port),
           "MESH_SESSION_TOKEN": pi["Authorization"].removeprefix("MeshSession ")}
    process = await asyncio.create_subprocess_exec(
        str(binary), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=env)

    async def send(message):
        process.stdin.write((json.dumps(message) + "\n").encode())
        await process.stdin.drain()

    async def receive():
        return json.loads(await asyncio.wait_for(process.stdout.readline(), timeout=10))

    try:
        await send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "pi-test", "version": "1"}}})
        assert "result" in await receive()
        await send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        await send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "agent_message_send", "arguments": {
                "target": "beta", "target_created": 2.0, "kind": "task", "text": "hello from real mcp"}}})
        response = await receive()
        assert not response.get("result", {}).get("isError", True), response
        inbox = await client.get("/api/agent-mail/@self/inbox", headers=claude)
        messages = (await inbox.json())["messages"]
        assert messages[0]["source"]["agent"] == "pi"
    finally:
        process.stdin.close()
        await asyncio.wait_for(process.wait(), timeout=10)


@pytest.mark.parametrize("capabilities", [
    None,
    "agent_wake_v1",
    ["agent_wake_v1"],
    ["agent_wake_v1", "agent_wake_v1", "human_input_lease_v1"],
    ["agent_wake_v1", 7, "human_input_lease_v1"],
    ["agent_wake_v1", {}, "human_input_lease_v1"],
])
async def test_wake_capability_absence_or_malformation_fails_closed(
        mesh_listing, monkeypatch, capabilities):
    agents(mesh_listing)
    if capabilities is not None:
        for session in mesh_listing:
            session["pty_capabilities"] = capabilities

    async def host(_request):
        return mesh_listing

    monkeypatch.setattr(server, "host", host)
    assert [item["wake_capable"] for item in await server._agent_wake_live()] == [False, False]


async def test_wake_capability_is_bound_to_each_listed_incarnation(mesh_listing, monkeypatch):
    agents(mesh_listing)
    mesh_listing[1]["pty_capabilities"] = [
        "agent_wake_v1", "human_input_lease_v1", "future_extension"]

    async def host(_request):
        return mesh_listing

    monkeypatch.setattr(server, "host", host)
    live = await server._agent_wake_live()
    assert [(item["id"], item["wake_capable"]) for item in live] == [
        ("alpha", False), ("beta", True)]


async def test_mailbox_hides_text_until_owner_grants_once(
        client, mesh_listing, mail_file, auth_cookie, auth_bearer):
    alpha, beta = agents(mesh_listing)
    peers = await client.get("/api/agent-mail/@self/peers", headers=alpha)
    assert peers.status == 200 and await peers.json() == {
        "peers": [{"id": "beta", "created": 2.0, "agent": "claude"}]}

    sent = await client.post("/api/agent-mail/@self/send", headers=alpha, json={
        "target": "beta", "target_created": 2.0, "kind": "task", "text": "untrusted work request"})
    assert sent.status == 200
    receipt = (await sent.json())["receipt"]
    assert set(receipt) == {"id", "conversation_id", "target", "kind", "created", "seq"}

    inbox = await client.get("/api/agent-mail/@self/inbox", headers=beta)
    assert inbox.status == 200
    metadata = (await inbox.json())["messages"]
    assert metadata[0]["source"] == {"id": "alpha", "created": 1.0, "agent": "codex"}
    assert "untrusted" not in str(metadata)

    opened = await client.post("/api/agent-mail/@self/read", headers=beta,
                               json={"message_id": receipt["id"]})
    assert opened.status == 202
    pending = (await opened.json())["pending"]
    assert "untrusted work request" not in str(pending)

    owner_view = await client.get("/api/agent-mail/consent", headers=auth_cookie)
    assert owner_view.status == 200
    assert (await owner_view.json())["requests"] == [pending]
    assert (await client.get("/api/agent-mail/consent", headers=auth_bearer)).status == 401
    assert (await client.post(f"/api/agent-mail/consent/{pending['id']}/decision",
                              headers=beta, json={"decision": "yes"})).status == 401
    granted = await client.post(f"/api/agent-mail/consent/{pending['id']}/decision",
                                headers=auth_cookie, json={"decision": "yes"})
    assert granted.status == 200
    opened = await client.post("/api/agent-mail/@self/read", headers=beta,
                               json={"message_id": receipt["id"]})
    assert opened.status == 200
    assert (await opened.json())["message"]["text"] == "untrusted work request"

    replied = await client.post("/api/agent-mail/@self/reply", headers=beta, json={
        "message_id": receipt["id"], "kind": "message", "text": "I can take this."})
    assert replied.status == 200
    response_receipt = (await replied.json())["receipt"]
    assert response_receipt["conversation_id"] == receipt["conversation_id"]
    shown = await client.get("/api/agent-mail/@self/inbox", headers=alpha)
    assert (await shown.json())["messages"][0]["source"]["id"] == "beta"


async def test_owner_always_policy_is_exact_persistent_and_revocable(
        client, mesh_listing, mail_file, auth_cookie, auth_bearer):
    alpha, beta = agents(mesh_listing)
    sent = await client.post("/api/agent-mail/@self/send", headers=alpha, json={
        "target": "beta", "target_created": 2.0, "kind": "message", "text": "first"})
    receipt = (await sent.json())["receipt"]
    pending_response = await client.post("/api/agent-mail/@self/read", headers=beta,
                                         json={"message_id": receipt["id"]})
    pending = (await pending_response.json())["pending"]
    decided = await client.post(f"/api/agent-mail/consent/{pending['id']}/decision",
                                headers=auth_cookie, json={"decision": "always"})
    policy = (await decided.json())["consent"]["policy"]

    overview = await client.get("/api/agent-mail/overview", headers=auth_cookie)
    assert overview.status == 200
    projections = {row["identity"]["id"]: row for row in (await overview.json())["sessions"]}
    assert projections["alpha"]["outbox_count"] == 1
    assert projections["beta"]["inbox_count"] == 1
    assert projections["alpha"]["always"] == [policy] == projections["beta"]["always"]
    assert "first" not in json.dumps(projections)
    before = mail_file.read_bytes()
    assert agentmail.owner_overview([]) == []
    assert mail_file.read_bytes() == before  # an inventory gap is never a delete
    assert (await client.get("/api/agent-mail/overview", headers=alpha)).status == 401
    assert (await client.get("/api/agent-mail/overview", headers=auth_bearer)).status == 401
    assert (await client.get("/api/agent-mail/overview?name=beta", headers=auth_cookie)).status == 400

    second = await client.post("/api/agent-mail/@self/send", headers=alpha, json={
        "target": "beta", "target_created": 2.0, "kind": "message", "text": "second"})
    second_id = (await second.json())["receipt"]["id"]
    opened = await client.post("/api/agent-mail/@self/read", headers=beta,
                               json={"message_id": second_id})
    assert opened.status == 200 and (await opened.json())["message"]["text"] == "second"

    revoked = await client.post("/api/agent-mail/consent/revoke", headers=auth_cookie,
                                json={"policy_id": policy["id"]})
    assert revoked.status == 200
    pending_again = await client.post("/api/agent-mail/@self/read", headers=beta,
                                      json={"message_id": second_id})
    assert pending_again.status == 202


async def test_owner_no_removes_message_without_revealing_it(
        client, mesh_listing, mail_file, auth_cookie):
    alpha, beta = agents(mesh_listing)
    sent = await client.post("/api/agent-mail/@self/send", headers=alpha, json={
        "target": "beta", "target_created": 2.0, "kind": "task", "text": "never reveal"})
    receipt = (await sent.json())["receipt"]
    attempted = await client.post("/api/agent-mail/@self/read", headers=beta,
                                  json={"message_id": receipt["id"]})
    pending = (await attempted.json())["pending"]
    rejected = await client.post(f"/api/agent-mail/consent/{pending['id']}/decision",
                                 headers=auth_cookie, json={"decision": "no"})
    assert rejected.status == 200
    inbox = await client.get("/api/agent-mail/@self/inbox", headers=beta)
    assert (await inbox.json())["messages"] == []


async def test_mailbox_is_agent_only_token_only_and_exactly_incarnation_bound(
        client, mesh_listing, mail_file, auth_cookie, auth_bearer):
    alpha, beta = agents(mesh_listing)
    for credentials in (auth_cookie, auth_bearer):
        assert (await client.get("/api/agent-mail/@self/inbox", headers=credentials)).status == 401
    assert (await client.get("/api/agent-mail/@self/inbox?x=1", headers=alpha)).status == 400
    assert (await client.post("/api/agent-mail/@self/send", headers=alpha, json={
        "target": "beta", "target_created": 999.0, "kind": "message", "text": "x"})).status == 404

    # A live shell possesses a MeshSession token for board/document work but
    # cannot use that fact to turn itself into a cross-session message source.
    shell = add_session(mesh_listing, "shell", "a" * 32)
    mesh_listing[-1].update(pid=3, activity=3.0, attached=0)
    assert (await client.get("/api/agent-mail/@self/inbox", headers=shell)).status == 403

    mesh_listing[1]["created"] = 3.0
    assert (await client.post("/api/agent-mail/@self/send", headers=alpha, json={
        "target": "beta", "target_created": 2.0, "kind": "message", "text": "x"})).status == 404


async def test_malformed_mail_values_are_bounded_400_responses(
        client, mesh_listing, mail_file, auth_cookie):
    alpha, beta = agents(mesh_listing)

    agent_requests = [
        (beta, "/api/agent-mail/@self/read", {"message_id": "not-an-id"}),
        (beta, "/api/agent-mail/@self/reply", {
            "message_id": "not-an-id", "kind": "message", "text": "x"}),
        (beta, "/api/agent-mail/@self/ack", {"message_ids": ["not-an-id"]}),
        (alpha, "/api/agent-mail/@self/send", {
            "target": "beta", "target_created": 2.0,
            "kind": "not-a-kind", "text": "x"}),
    ]
    for headers, path, body in agent_requests:
        assert (await client.post(path, headers=headers, json=body)).status == 400

    assert (await client.post(
        "/api/agent-mail/consent/not-an-id/decision", headers=auth_cookie,
        json={"decision": "yes"})).status == 400
    assert (await client.post(
        "/api/agent-mail/consent/revoke", headers=auth_cookie,
        json={"policy_id": "not-an-id"})).status == 400


@pytest.mark.parametrize(("backend", "credentials", "path", "body"), [
    ("read", "beta", "/api/agent-mail/@self/read", {"message_id": "0" * 32}),
    ("reply", "beta", "/api/agent-mail/@self/reply",
     {"message_id": "0" * 32, "kind": "message", "text": "x"}),
    ("acknowledge", "beta", "/api/agent-mail/@self/ack", {"message_ids": ["0" * 32]}),
    ("send", "alpha", "/api/agent-mail/@self/send",
     {"target": "beta", "target_created": 2.0, "kind": "message", "text": "x"}),
    ("decide_consent", "owner", "/api/agent-mail/consent/" + "0" * 32 + "/decision",
     {"decision": "yes"}),
    ("revoke_consent", "owner", "/api/agent-mail/consent/revoke",
     {"policy_id": "0" * 32}),
])
async def test_internal_value_error_is_not_misreported_as_bad_request(
        client, mesh_listing, mail_file, auth_cookie, monkeypatch,
        backend, credentials, path, body):
    alpha, beta = agents(mesh_listing)

    def broken(*_args, **_kwargs):
        raise ValueError("simulated internal invariant failure")

    monkeypatch.setattr(agentmail, backend, broken)
    headers = {"alpha": alpha, "beta": beta, "owner": auth_cookie}[credentials]
    response = await client.post(path, headers=headers, json=body)
    assert response.status == 500
