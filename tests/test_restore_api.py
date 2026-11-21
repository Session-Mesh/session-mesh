# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""POST /api/restore and the `restorable` list of GET /api/sessions (RS-2, RS-3)."""

import asyncio
from pathlib import Path
import shlex

import pytest

import agentmcp
import ptyhost
import respawn
import resumeargs
import server
import sessiontoken
from respawn_helpers import SID, SID2, claude, codex, mesh_item, snapshot_file  # noqa: F401


class FakeHost:
    """A ptyhost that lists, creates and kills sessions in memory and remembers every request."""

    def __init__(self):
        self.sessions = []
        self.new_requests = []
        self.down = False
        self.new_error = None
        self.delay = 0

    async def request(self, req):
        if self.down:
            raise ConnectionRefusedError()
        if req["op"] == "list":
            return [dict(s) for s in self.sessions]
        if req["op"] == "new":
            return await self._new(req)
        if req["op"] == "kill_if":
            prior = next((s for s in self.sessions if s["name"] == req["name"]
                          and s["created"] == req["created"]), None)
            if prior is None:
                return {"ok": False}
            self.sessions.remove(prior)
            return {"ok": True}
        if req["op"] == "processes":
            # ptyhost.host_identity off Linux, where the host names itself: an unknown host, as
            # on Linux, where it reads the peer of a socket that does not exist here.
            return {}
        raise AssertionError(req)

    async def _new(self, req):
        await asyncio.sleep(self.delay)
        if self.new_error:
            return {"error": self.new_error}
        self.new_requests.append(req)
        self.sessions.append({"name": req["name"], "pid": 999999, "cwd": req["cwd"], "created": 5000.0 + len(self.sessions),
                              "activity": 0, "attached": 0, "meta": req["meta"]})
        return {"ok": True, "name": req["name"]}


@pytest.fixture
def fake_host(monkeypatch, snapshot_file):
    host = FakeHost()
    # These core REST tests model no artifact data explicitly, rather than
    # assuming a missing optional catalogue proves that on a real installation.
    # Native knowledge/absence/repair behavior is covered by the TS integration tests.
    async def confirmed_empty(op, *args, **kwargs):
        if op == "restore-probe":
            return {"required": False}
        if op == "restore-transfer":
            return {"complete": True}
        if op == "list":
            return {"references": [], "catalogue_present": True, "source_present": True}
        return {"transferred": False, "catalogue_present": True, "transfer_status": "source-empty"}
    monkeypatch.setattr(server, "artifact_lifecycle", confirmed_empty)
    monkeypatch.setattr(ptyhost, "request", host.request)
    monkeypatch.setattr(server, "_conversation_missing", lambda kind, sid, account=None: False)   # no transcript files here
    return host


def lose(tmp_path, *items):
    """The snapshot of a mesh that has just been wiped by a ptyhost restart: ``items`` are offered."""
    respawn.update(list(items), listed=True)
    respawn.update([], listed=True)


async def restore(client, headers, *names):
    resp = await client.post("/api/restore", json={"names": list(names)}, headers=headers)
    return resp.status, await resp.json()


async def test_the_lost_sessions_are_listed_as_restorable(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude(argv=["claude", "prompt"])), mesh_item("b", tmp_path, 2.0, None, "vim x"))
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    got = {e["name"]: e for e in data["restorable"]}
    assert got["a"] == {"name": "a", "cwd": str(tmp_path), "created": 1.0, "agent": "claude",
                        "resumable": True, "running": None}
    assert got["b"]["running"] == "vim x" and got["b"]["agent"] is None
    assert "prompt" not in repr(data["restorable"])


async def test_nothing_is_restorable_while_ptyhost_is_down(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    fake_host.down = True
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert data["restorable"] == []
    fake_host.down = False
    assert [e["name"] for e in (await (await client.get("/api/sessions", headers=auth_cookie)).json())["restorable"]] == ["a"]


async def test_restoring_a_claude_session_sends_exactly_the_resume_command(client, auth_cookie, fake_host, tmp_path):
    argv = ["claude", "--model", "opus", "--resume", "oldsession-id", "do the thing"]
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude(argv=argv)))
    status, body = await restore(client, auth_cookie, "a")
    assert status == 200 and body["results"] == {"a": {"ok": True, "id": "a", "resumed": True}}
    [req] = fake_host.new_requests
    expected = shlex.join(agentmcp.inject("claude", ["claude", "--resume", SID, "--model", "opus", *resumeargs.CLAUDE_INLINE]))
    assert req["command"] == expected
    assert req["command"].count("--resume") == 1 and "do the thing" not in req["command"]
    assert (req["name"], req["cwd"], req["meta"]["agent"]) == ("a", str(tmp_path), "claude")
    assert req["env"]["MESH_SESSION"] == "a"
    assert sessiontoken.verify(req["env"]["MESH_SESSION_TOKEN"], [{"name": "a", "meta": req["meta"]}]) == "a"


async def test_restoring_a_codex_session_resumes_without_duplicating_the_subcommand(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("c", tmp_path, 1.0, codex(argv=["codex", "resume", "oldid-1234", "--yolo", "-m", "gpt"])))
    status, body = await restore(client, auth_cookie, "c")
    assert status == 200 and body["results"]["c"]["ok"]
    [req] = fake_host.new_requests
    assert shlex.split(req["command"]) == agentmcp.inject("codex", ["codex", "resume", SID2, *resumeargs.codex_args(["--yolo", "-m", "gpt"])])
    assert shlex.split(req["command"]).count("resume") == 1 and req["meta"]["agent"] == "codex"


async def test_a_shell_session_comes_back_as_a_plain_shell(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("sh", tmp_path, 1.0, None, "make -j8 all"))
    status, body = await restore(client, auth_cookie, "sh")
    assert body["results"]["sh"] == {"ok": True, "id": "sh", "resumed": False}
    [req] = fake_host.new_requests
    assert req["command"] is None and req["meta"]["agent"] is None and req["cwd"] == str(tmp_path)


async def test_an_agent_without_a_conversation_id_is_never_relaunched_fresh(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, codex(sid=None, argv=["codex", "--yolo"])))
    status, body = await restore(client, auth_cookie, "a")
    [req] = fake_host.new_requests
    assert shlex.split(req["command"])[0] == "printf" and req["meta"]["agent"] is None   # a shell that says why
    assert body["results"]["a"]["ok"] and body["results"]["a"]["resumed"] is False
    assert "conversation" in body["results"]["a"]["note"]


async def test_new_pi_session_uses_private_mcp_runtime(client, auth_cookie, fake_host, tmp_path, monkeypatch):
    async def runtime():
        return "/opt/pi", tmp_path / "overlay"

    monkeypatch.setattr(server, "_pi_runtime", runtime)
    response = await client.post("/api/new", json={"preset": "pi", "cwd": str(tmp_path), "name": "pi"},
                                 headers=auth_cookie)
    assert response.status == 200, await response.text()
    [request] = fake_host.new_requests
    assert shlex.split(request["command"]) == [f"PI_CODING_AGENT_DIR={tmp_path / 'overlay'}", "/opt/pi",
                                                 "--extension", str(Path(server.__file__).with_name("pi_mesh_wake.mjs")),
                                                 "-e", "builtin:mcp"]
    assert request["meta"]["known_agent"] == "pi"
    assert request["meta"]["agent"] == "pi"


async def test_a_taken_name_gets_a_suffix(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    fake_host.sessions.append({"name": "a", "pid": 999998, "cwd": str(tmp_path), "created": 9.0, "activity": 0,
                               "attached": 0, "meta": {}})
    status, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["id"] == "a-2"


async def test_a_long_name_is_kept_and_its_suffix_stays_valid(client, auth_cookie, fake_host, tmp_path):
    long_name = "n" * 48
    lose(tmp_path, mesh_item(long_name, tmp_path, 1.0))
    _, body = await restore(client, auth_cookie, long_name)
    assert body["results"][long_name]["id"] == long_name
    lose(tmp_path, mesh_item(long_name, tmp_path, 2.0))        # the name is taken now
    _, body = await restore(client, auth_cookie, long_name)
    again = body["results"][long_name]["id"]
    assert again == "n" * 46 + "-2" and respawn.NAME_RE.fullmatch(again)


async def test_a_second_restore_does_not_duplicate_the_session(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    await restore(client, auth_cookie, "a")
    _, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["ok"] is False
    assert len(fake_host.new_requests) == 1
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert data["restorable"] == []


async def test_two_simultaneous_restores_start_one_session(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    fake_host.delay = 0.2
    first, second = await asyncio.gather(restore(client, auth_cookie, "a"), restore(client, auth_cookie, "a"))
    assert len(fake_host.new_requests) == 1
    assert sorted(r[1]["results"]["a"]["ok"] for r in (first, second)) == [False, True]


@pytest.mark.parametrize("where", ["mesh", "external"])
async def test_a_conversation_already_running_is_never_started_twice(client, auth_cookie, fake_host, tmp_path,
                                                                     monkeypatch, where):
    """Never two agents on one conversation: the old agent may have outlived its ptyhost, or the owner resumed it by hand meanwhile."""
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude()), mesh_item("b", tmp_path, 2.0, None))
    live = {"mesh": [], "external": [], "restorable": []}
    live[where].append({"agent": {"session_id": SID}})

    async def fake_sessions(*_args, **_kwargs):
        return live
    monkeypatch.setattr(server, "sessions", fake_sessions)
    _, body = await restore(client, auth_cookie, "a", "b")
    assert body["results"]["a"]["ok"] is False and "already running" in body["results"]["a"]["error"]
    assert body["results"]["b"]["ok"] is True
    assert [r["name"] for r in fake_host.new_requests] == ["b"]
    assert respawn.lost_entry("a") is not None


async def test_two_lost_sessions_of_one_conversation_resume_it_once(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude()), mesh_item("b", tmp_path, 2.0, claude()))
    _, body = await restore(client, auth_cookie, "a", "b")
    assert sorted(r["ok"] for r in body["results"].values()) == [False, True]
    assert len(fake_host.new_requests) == 1


async def test_an_unknown_name_starts_nothing(client, auth_cookie, fake_host, tmp_path):
    _, body = await restore(client, auth_cookie, "ghost")
    assert body["results"]["ghost"]["ok"] is False and not fake_host.new_requests


async def test_a_failed_creation_keeps_the_offer(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    fake_host.new_error = "Could not create the session: boom"
    _, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["ok"] is False and "boom" in body["results"]["a"]["error"]
    fake_host.new_error = None
    _, body = await restore(client, auth_cookie, "a")
    assert body["results"]["a"]["ok"] is True


async def test_a_vanished_directory_is_refused_per_name(client, auth_cookie, fake_host, tmp_path):
    gone = tmp_path / "gone"
    gone.mkdir()
    lose(tmp_path, mesh_item("a", gone, 1.0), mesh_item("b", tmp_path, 2.0))
    gone.rmdir()
    _, body = await restore(client, auth_cookie, "a", "b")
    assert (body["results"]["a"]["ok"], body["results"]["b"]["ok"]) == (False, True)


async def test_ptyhost_down_is_503_and_keeps_the_offer(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    fake_host.down = True
    resp = await client.post("/api/restore", json={"names": ["a"]}, headers=auth_cookie)
    assert resp.status == 503
    fake_host.down = False
    assert respawn.lost_entry("a") is not None


async def test_the_command_is_one_quoted_word_per_argument(client, auth_cookie, fake_host, tmp_path):
    hostile = 'x"; touch /tmp/pwned; $(id) `id` \'q\''
    argv = ["claude", "--append-system-prompt", hostile, "--add-dir", "a b;c"]
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude(argv=argv)))
    await restore(client, auth_cookie, "a")
    [req] = fake_host.new_requests
    words = shlex.split(req["command"])
    assert words == agentmcp.inject("claude", resumeargs.resume_argv("claude", argv, SID))
    assert hostile in words and "a b;c" in words


# ---------------------------------------------------------------- who may restore

async def test_a_bearer_token_may_restore(client, auth_bearer, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    status, _ = await restore(client, auth_bearer, "a")
    assert status == 200


async def test_no_credentials_is_401(client, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    resp = await client.post("/api/restore", json={"names": ["a"]})
    assert resp.status == 401 and not fake_host.new_requests


async def test_a_session_token_is_refused(client, fake_host, tmp_path):
    nonce = sessiontoken.new_nonce()
    fake_host.sessions.append({"name": "shell", "pid": 999997, "cwd": str(tmp_path), "created": 1.0, "activity": 0,
                               "attached": 0, "meta": {"nonce": nonce}})
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    headers = {"Authorization": "MeshSession " + sessiontoken.issue("shell", nonce)}
    for path in ("/api/restore", "/api/restore/discard"):
        resp = await client.post(path, json={"names": ["a"]}, headers=headers)
        assert resp.status == 401
    assert not fake_host.new_requests and respawn.lost_entry("a") is not None


async def test_a_foreign_origin_is_refused(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    for path in ("/api/restore", "/api/restore/discard"):
        resp = await client.post(path, json={"names": ["a"]}, headers={**auth_cookie, "Origin": "https://evil.example"})
        assert resp.status == 403
    assert not fake_host.new_requests and respawn.lost_entry("a") is not None


async def test_the_same_origin_is_accepted(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0))
    headers = {**auth_cookie, "Origin": f"http://{client.host}:{client.port}"}
    resp = await client.post("/api/restore", json={"names": ["a"]}, headers=headers)
    assert resp.status == 200


@pytest.mark.parametrize("body", [{}, {"names": "a"}, {"names": [1]}, {"names": ["../x"]}, {"names": ["a b"]},
                                  {"names": ["a\n"]}, {"names": ["a"] * 51}, [], "x"])
async def test_a_malformed_body_is_400(client, auth_cookie, fake_host, body):
    for path in ("/api/restore", "/api/restore/discard"):
        resp = await client.post(path, json=body, headers=auth_cookie)
        assert resp.status == 400, path
    assert not fake_host.new_requests


# ---------------------------------------------------------------- the rest of the lifecycle

async def test_discard_removes_the_offer_without_starting_anything(client, auth_cookie, fake_host, tmp_path):
    lose(tmp_path, mesh_item("a", tmp_path, 1.0), mesh_item("b", tmp_path, 2.0))
    resp = await client.post("/api/restore/discard", json={"names": ["a"]}, headers=auth_cookie)
    assert resp.status == 200
    assert [e["name"] for e in (await (await client.get("/api/sessions", headers=auth_cookie)).json())["restorable"]] == ["b"]
    assert not fake_host.new_requests


async def test_killing_a_session_through_the_mesh_means_it_is_never_offered(client, auth_cookie, fake_host, tmp_path):
    respawn.update([mesh_item("a", tmp_path, 1.0)], listed=True)
    fake_host.sessions.append({"name": "a", "pid": 999996, "cwd": str(tmp_path), "created": 1.0, "activity": 0,
                               "attached": 0, "meta": {}})
    assert (await client.post("/api/kill/a", json={"created": 1.0}, headers=auth_cookie)).status == 200
    data = await (await client.get("/api/sessions", headers=auth_cookie)).json()
    assert data["mesh"] == [] and data["restorable"] == []


async def test_the_background_loop_writes_the_snapshot_without_any_browser(client, fake_host, snapshot_file,
                                                                           tmp_path, monkeypatch):
    monkeypatch.setattr(server, "list_sessions", lambda raw, listed=True: {"mesh": [mesh_item("a", tmp_path, 1.0)]})
    monkeypatch.setattr(server, "SNAPSHOT_EVERY", 0.01)
    task = asyncio.create_task(server.snapshot_loop(None))
    try:
        for _ in range(200):
            if snapshot_file.exists():
                break
            await asyncio.sleep(0.01)
    finally:
        task.cancel()
    assert snapshot_file.exists()


# ---------------------------------------------------------------- wrapped agents

NODE_CLI = "/home/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"


async def test_restoring_a_node_wrapped_claude_keeps_its_options(client, auth_cookie, fake_host, tmp_path):
    argv = ["node", NODE_CLI, "--model", "opus", "--allow-dangerously-skip-permissions",
            "--settings", '{"tui":"default"}', "--resume", "oldsession-id"]
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude(argv=argv)))
    status, _ = await restore(client, auth_cookie, "a")
    assert status == 200
    [req] = fake_host.new_requests
    assert shlex.split(req["command"]) == agentmcp.inject("claude", resumeargs.resume_argv("claude", argv, SID))
    assert req["command"].split()[0] == "claude" and "cli.js" not in req["command"]


async def test_restoring_behind_an_unknown_wrapper_falls_back_to_the_bare_resume(client, auth_cookie, fake_host, tmp_path):
    argv = ["/bin/sh", "/home/u/bin/claude-work", "--model", "opus", "$(touch /tmp/pwned)"]
    lose(tmp_path, mesh_item("a", tmp_path, 1.0, claude(argv=argv)))
    await restore(client, auth_cookie, "a")
    [req] = fake_host.new_requests
    assert shlex.split(req["command"]) == agentmcp.inject("claude", ["claude", "--resume", SID, *resumeargs.CLAUDE_INLINE])
    assert "claude-work" not in req["command"] and "pwned" not in req["command"]


async def test_restoring_a_wrapped_codex_keeps_yolo(client, auth_cookie, fake_host, tmp_path):
    argv = ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "--yolo", "resume", "oldid-1234"]
    lose(tmp_path, mesh_item("c", tmp_path, 1.0, codex(argv=argv)))
    await restore(client, auth_cookie, "c")
    [req] = fake_host.new_requests
    assert shlex.split(req["command"]) == agentmcp.inject("codex", ["codex", "resume", SID2, *resumeargs.codex_args(["--yolo"])])


def test_resume_in_the_mesh_reads_a_wrapped_external_agent():
    agent = {"type": "claude", "session_id": SID, "argv": ["node", NODE_CLI, "--model", "opus"]}
    assert server._resume_argv(agent) == agentmcp.inject("claude", ["claude", "--resume", SID, "--model", "opus", *resumeargs.CLAUDE_INLINE])


@pytest.mark.parametrize("reply", [
    {"error": "invalid request"},          # an older host
    {"ok": True},                          # no field
    {"ok": True, "update": "garbage"},     # wrong type
    {"ok": False, "update": {"tag": "v9"}},
    "garbage", None, [], 7,
])
async def test_the_update_notice_ignores_any_reply_that_is_not_an_update(monkeypatch, reply):
    async def request(req):
        return reply
    monkeypatch.setattr(ptyhost, "request", request)
    assert await server._update_notice() is None


async def test_the_update_notice_is_relayed_from_a_good_reply(monkeypatch):
    async def request(req):
        return {"ok": True, "update": {"tag": "v9"}}
    monkeypatch.setattr(ptyhost, "request", request)
    assert await server._update_notice() == {"tag": "v9"}


@pytest.mark.parametrize("exc", [ConnectionResetError(), EOFError(), ValueError(), RecursionError(),
                                 asyncio.IncompleteReadError(b"", 5), AssertionError("op")])
async def test_the_update_notice_swallows_any_failure(monkeypatch, exc):
    async def request(req):
        raise exc
    monkeypatch.setattr(ptyhost, "request", request)
    assert await server._update_notice() is None


async def test_a_silent_host_gives_no_update_when_the_request_times_out(monkeypatch):
    async def request(req):
        await asyncio.wait_for(asyncio.sleep(3600), 0.05)
    monkeypatch.setattr(ptyhost, "request", request)
    assert await server._update_notice() is None
