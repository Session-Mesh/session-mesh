# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""history.py and the /api/history routes, on transcripts written into a temporary home."""

import json
import shlex
import shutil
from pathlib import Path

import pytest

import agentmcp
import conversation_names
import history
import resumeargs
import server

SID = "0a1b2c3d-1111-2222-3333-444455556666"
CODEX_SID = "019a0000-aaaa-bbbb-cccc-ddddeeeeffff"


def _claude_lines(sid, cwd, text="hello there"):
    return [
        {"type": "user", "timestamp": "2026-10-01T10:00:00Z", "cwd": cwd, "gitBranch": "main",
         "version": "2.0", "message": {"content": text}},
        {"type": "assistant", "timestamp": "2026-10-01T10:00:05Z",
         "message": {"id": "m1", "model": "claude-x", "content": [{"type": "text", "text": "hi"}],
                     "usage": {"input_tokens": 3, "output_tokens": 4}}},
        {"type": "ai-title", "aiTitle": "A title"},
    ]


@pytest.fixture
def hist(tmp_path, monkeypatch):
    """history.py pointed at an empty fake ~/.claude, ~/.codex and cache, with a fresh index."""
    claude, codex = tmp_path / ".claude", tmp_path / ".codex"
    (claude / "projects").mkdir(parents=True)
    (codex / "sessions").mkdir(parents=True)
    monkeypatch.setattr(history, "CLAUDE", claude)
    monkeypatch.setattr(history, "CODEX", codex)
    monkeypatch.setattr(history, "CACHE_FILE", tmp_path / "cache" / "history.json")
    monkeypatch.setattr(history, "_files", {})
    monkeypatch.setattr(history, "_keys", {})
    monkeypatch.setattr(history, "_loaded", False)
    monkeypatch.setattr(history, "_titles", {"key": None, "map": {}, "gen": 0})
    monkeypatch.setattr(history, "_gone", [])
    history._hdb.close()   # a mesh-history helper of an earlier test points at that test's database

    class H:
        root = tmp_path

        @staticmethod
        def claude(sid=SID, cwd=None, lines=None, project="-home-x"):
            d = claude / "projects" / project
            d.mkdir(exist_ok=True)
            p = d / f"{sid}.jsonl"
            body = lines if lines is not None else _claude_lines(sid, cwd or str(tmp_path))
            p.write_text("".join(json.dumps(x) + "\n" for x in body))
            return p

        @staticmethod
        def codex(sid=CODEX_SID, cwd=None, text="codex prompt"):
            d = codex / "sessions" / "2026" / "10" / "01"
            d.mkdir(parents=True, exist_ok=True)
            p = d / f"rollout-2026-10-01T10-00-00-{sid}.jsonl"
            body = [{"type": "session_meta", "timestamp": "2026-10-01T10:00:00Z",
                     "payload": {"id": sid, "cwd": cwd or str(tmp_path), "cli_version": "0.1", "source": "cli"}},
                    {"type": "event_msg", "timestamp": "2026-10-01T10:00:01Z",
                     "payload": {"type": "user_message", "message": text}}]
            p.write_text("".join(json.dumps(x) + "\n" for x in body))
            return p

    return H


# ---------------------------------------------------------------- full-text search

def test_search_argv_searches_directories_not_files(hist):
    for i in range(50):
        hist.claude(sid=f"{i:08d}-0000-0000-0000-000000000000")
    argv = history.search_argv("needle")
    assert argv[0] in ("rg", "grep")
    assert str(history.CLAUDE / "projects") in argv and str(history.CODEX / "sessions") in argv
    assert not any(a.endswith(".jsonl") and "/" in a for a in argv)


@pytest.mark.parametrize("q", ["", "a\nb", "a\rb"])
def test_search_argv_refuses_empty_and_multiline(hist, q):
    assert history.search_argv(q) is None


def test_search_ids_keeps_indexed_transcripts_only(hist):
    p = hist.claude()
    history.refresh()
    sub = p.parent / SID / "subagents" / "agent-1.jsonl"
    assert history.search_ids([str(p), str(sub), "/elsewhere.jsonl"]) == [f"claude:{SID}"]


@pytest.mark.parametrize("tool", ["rg", "grep"])
async def test_search_route_finds_literal_text(hist, client, auth_cookie, monkeypatch, tool):
    if tool == "grep":
        monkeypatch.setattr(history.shutil, "which", lambda name: None)
    elif not shutil.which("rg"):
        pytest.skip("ripgrep not installed")
    hist.claude(lines=_claude_lines(SID, str(hist.root), "look for Needle.* here"))
    hist.claude(sid="99999999-0000-0000-0000-000000000000")
    hist.codex(text="the needle.* too")
    history.refresh()
    resp = await client.get("/api/history/search", params={"q": "needle.*"}, headers=auth_cookie)
    assert resp.status == 200
    assert sorted(await resp.json()) == sorted([f"claude:{SID}", f"codex:{CODEX_SID}"])


async def test_search_route_ignores_short_and_multiline_queries(hist, client, auth_cookie):
    hist.claude()
    history.refresh()
    for q in ("he", "hello\nthere"):
        resp = await client.get("/api/history/search", params={"q": q}, headers=auth_cookie)
        assert resp.status == 200 and await resp.json() == []


async def test_search_route_kills_the_previous_search(hist, client, auth_cookie, monkeypatch):
    hist.claude()
    history.refresh()
    monkeypatch.setattr(history, "search_argv", lambda q: ["sleep", "30"] if q == "slow" else ["true"])
    import asyncio
    slow = asyncio.create_task(client.get("/api/history/search", params={"q": "slow"}, headers=auth_cookie))
    for _ in range(100):
        if server._search["proc"]:
            break
        await asyncio.sleep(0.02)
    fast = await client.get("/api/history/search", params={"q": "fast"}, headers=auth_cookie)
    assert fast.status == 200
    assert (await asyncio.wait_for(slow, 5)).status == 409


async def test_search_route_requires_auth(hist, client):
    resp = await client.get("/api/history/search", params={"q": "hello"})
    assert resp.status in (302, 401)


# ---------------------------------------------------------------- index and cache

def test_codex_response_messages_are_visible_and_searchable(hist):
    path = hist.codex(text="placeholder")
    lines = [json.loads(path.read_text().splitlines()[0]),
             {"type": "response_item", "payload": {"type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "recover my audit"}]}},
             {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "audit recovered"}]}}]
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))
    history.refresh()
    [item] = history.listing()[0]
    assert item["id"] == CODEX_SID
    assert (item["n_user"], item["n_assistant"]) == (1, 1)
    assert item["first"] == "recover my audit"
    assert item["last_assistant"] == "audit recovered"


@pytest.mark.parametrize("event_first", [True, False])
def test_codex_dual_message_formats_count_each_message_once(hist, event_first):
    path = hist.codex(text="same prompt")
    lines = [json.loads(path.read_text().splitlines()[0])]
    for _ in range(2):
        event = {"type": "event_msg", "payload": {"type": "user_message", "message": "same prompt"}}
        response = {"type": "response_item", "payload": {"type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": "same prompt"}]}}
        lines.extend([event, response] if event_first else [response, event])
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))
    history.refresh()
    [item] = history.listing()[0]
    assert item["n_user"] == 2


def test_codex_message_pair_survives_incremental_cache_reload(hist, monkeypatch):
    path = hist.codex(text="same prompt")
    history.refresh()
    history.flush()
    monkeypatch.setattr(history, "_files", {})
    monkeypatch.setattr(history, "_keys", {})
    monkeypatch.setattr(history, "_loaded", False)
    with path.open("a") as stream:
        stream.write(json.dumps({"type": "response_item", "payload": {"type": "message",
            "role": "user", "content": [{"type": "input_text", "text": "same prompt"}]}}) + "\n")
    history.refresh()
    assert history.listing()[0][0]["n_user"] == 1


def test_old_codex_cache_is_reparsed_even_when_file_is_unchanged(hist, monkeypatch):
    path = hist.codex()
    history.refresh()
    history.flush()
    cached = json.loads(history.CACHE_FILE.read_text())
    cached["v"] = 3
    cached["files"][str(path)]["s"]["n_user"] = 0
    history.CACHE_FILE.write_text(json.dumps(cached))
    monkeypatch.setattr(history, "_files", {})
    monkeypatch.setattr(history, "_keys", {})
    monkeypatch.setattr(history, "_loaded", False)
    history.refresh()
    assert history.listing()[0][0]["n_user"] == 1


def test_embedded_parent_metadata_cannot_promote_a_subagent_to_root(hist):
    path = hist.codex()
    lines = [json.loads(line) for line in path.read_text().splitlines()]
    lines[0]["payload"]["source"] = {"subagent": {"parent_thread_id": SID}}
    parent = {"type": "session_meta", "payload": {"id": SID, "source": "cli", "cwd": "/parent"}}
    lines.insert(1, parent)
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))
    history.refresh()
    assert history.listing()[0] == []
    _, state = history.find("codex", CODEX_SID)
    assert state["sub"] is True
    assert history.find("codex", SID) == (None, None)

def test_refresh_indexes_and_reads_only_appended_lines(hist):
    p = hist.claude()
    assert history.refresh() is True
    [d] = history.listing()[0]
    assert (d["id"], d["title"], d["n_user"], d["n_assistant"], d["tin"], d["tout"]) == (SID, "A title", 1, 1, 3, 4)
    assert history.refresh() is False
    g = history.gen
    with p.open("a") as f:
        f.write(json.dumps({"type": "user", "timestamp": "2026-10-01T11:00:00Z",
                            "message": {"content": "second"}}) + "\n")
        f.write('{"type": "user", "message": {"content": "half')   # still being written
    assert history.refresh() is True and history.gen > g
    [d] = history.listing()[0]
    assert (d["n_user"], d["last_user"]) == (2, "second")


def test_refresh_survives_malformed_lines(hist):
    hist.claude(lines=["not json", [1, 2], {"type": "user", "message": "x"}, *_claude_lines(SID, "/")])
    history.refresh()
    assert [d["id"] for d in history.listing()[0]] == [SID]


def test_cache_is_private_and_reloaded(hist, monkeypatch):
    hist.claude()
    history.refresh()
    history.flush()
    assert history.CACHE_FILE.stat().st_mode & 0o777 == 0o600
    assert history.CACHE_FILE.parent.stat().st_mode & 0o077 == 0
    monkeypatch.setattr(history, "_files", {})
    monkeypatch.setattr(history, "_keys", {})
    monkeypatch.setattr(history, "_loaded", False)
    assert history.refresh() is False
    assert [d["id"] for d in history.listing()[0]] == [SID]


def test_cache_write_failure_does_not_break_refresh(hist, monkeypatch):
    hist.claude()
    monkeypatch.setattr(history.fsutil, "atomic_write", lambda *a, **k: (_ for _ in ()).throw(OSError("full")))
    assert history.refresh() is True


def test_flush_stops_a_scan_and_allows_the_next(hist, monkeypatch):
    hist.claude()
    history._stop.set()
    assert history.refresh() is False   # stopped before the first file
    history.flush()
    assert history.refresh() is True


async def test_history_route_reports_generation(hist, aiohttp_client, auth_cookie):
    # ``make_app`` starts the asynchronous first scan.  Write the transcript
    # before starting it: otherwise this test races a scan of the deliberately
    # empty fixture root against the write below, rather than testing the
    # route's generation response.
    hist.claude()
    client = await aiohttp_client(server.make_app())
    resp = await client.get("/api/history", headers=auth_cookie)
    body = await resp.json()
    assert [d["id"] for d in body["sessions"]] == [SID] and body["indexing"] is False
    resp = await client.get("/api/history", params={"gen": body["gen"]}, headers=auth_cookie)
    assert (await resp.json())["unchanged"] is True


async def test_history_route_answers_during_a_long_scan(hist, client, auth_cookie, monkeypatch):
    import threading
    release = threading.Event()
    monkeypatch.setattr(history, "refresh", lambda: release.wait(10))
    monkeypatch.setattr(server, "_hist_scan", None)
    try:
        resp = await client.get("/api/history", headers=auth_cookie)
        body = await resp.json()
        assert body["indexing"] is True and body["sessions"] == []
        sessions = await client.get("/api/sessions", headers=auth_cookie)
        assert sessions.status == 200
    finally:
        release.set()


def test_history_scan_survives_startup_loop_teardown(monkeypatch):
    """A discarded startup wrapper cannot cancel the process-wide scan."""
    import asyncio
    import gc
    import threading

    started, release = threading.Event(), threading.Event()

    def slow_refresh():
        started.set()
        release.wait(5)

    monkeypatch.setattr(history, "refresh", slow_refresh)
    monkeypatch.setattr(server, "_hist_scan", None)
    try:
        first_loop = asyncio.new_event_loop()
        try:
            first_loop.run_until_complete(server.start_history(None))
        finally:
            first_loop.close()
        gc.collect()
        assert started.wait(1)
        source = server._hist_scan
        assert source is not None and not source.cancelled()

        async def second_loop():
            scan = server.history_scan()
            release.set()
            await asyncio.wait_for(asyncio.shield(scan), 1)

        second = asyncio.new_event_loop()
        try:
            second.run_until_complete(second_loop())
        finally:
            second.close()
        assert not source.cancelled()
    finally:
        release.set()


# ---------------------------------------------------------------- resume

@pytest.fixture
def resume_env(hist, monkeypatch):
    started = []

    async def fake_new_session(base, cwd, command=None, agent=None, known_agent=None, conversation=None):
        started.append((base, cwd, command, agent, known_agent))
        return f"mesh-{len(started)}"

    async def nowhere(sid, agent=None):
        return None

    monkeypatch.setattr(server, "new_session", fake_new_session)
    monkeypatch.setattr(server, "live_where", nowhere)
    monkeypatch.setattr(server, "HIST_RESUMING", set())
    return started


@pytest.mark.parametrize("body", ["not json", "[]", '"x"', "{}", '{"agent": "claude", "id": "--evil-option"}',
                                  '{"agent": "sh", "id": "0a1b2c3d"}'])
async def test_resume_rejects_bad_bodies(resume_env, client, auth_cookie, body):
    resp = await client.post("/api/history/resume", data=body,
                             headers={**auth_cookie, "Content-Type": "application/json"})
    assert resp.status == 400


async def test_resume_starts_once_with_the_mesh_argv(hist, resume_env, client, auth_cookie):
    hist.claude(cwd=str(hist.root))
    hist.codex(cwd=str(hist.root))
    history.refresh()
    for agent, sid in (("claude", SID), ("codex", CODEX_SID)):
        resp = await client.post("/api/history/resume", json={"agent": agent, "id": sid}, headers=auth_cookie)
        assert resp.status == 200, await resp.text()
        again = await client.post("/api/history/resume", json={"agent": agent, "id": sid}, headers=auth_cookie)
        assert again.status == 409
    assert [shlex.split(c[2]) for c in resume_env] == [
        agentmcp.inject("claude", ["claude", "--resume", SID, *resumeargs.CLAUDE_INLINE]),
        agentmcp.inject("codex", ["codex", "resume", CODEX_SID, *resumeargs.codex_args()]),
    ]
    assert all(c[1] == str(hist.root) for c in resume_env)
    # The launch (messaging socket of a Claude session) keys on known_agent, like every other path.
    assert [c[3:] for c in resume_env] == [("claude", "claude"), ("codex", "codex")]


async def test_resume_failure_allows_a_retry(hist, resume_env, client, auth_cookie):
    resp = await client.post("/api/history/resume", json={"agent": "claude", "id": SID}, headers=auth_cookie)
    assert resp.status == 404
    hist.claude()
    history.refresh()
    resp = await client.post("/api/history/resume", json={"agent": "claude", "id": SID}, headers=auth_cookie)
    assert resp.status == 200


async def test_resume_requires_same_origin(hist, resume_env, client, auth_cookie):
    resp = await client.post("/api/history/resume", json={"agent": "claude", "id": SID},
                             headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403


# ---------------------------------------------------------------- delete

def _age(path, seconds=3600):
    import os
    import time
    t = time.time() - seconds
    os.utime(path, (t, t))


async def test_delete_removes_transcript_and_claude_extras(hist, client, auth_cookie, monkeypatch):
    async def nowhere(sid, agent=None):
        return None
    monkeypatch.setattr(server, "live_where", nowhere)
    p = hist.claude()
    (p.parent / SID / "subagents").mkdir(parents=True)
    fh = history.CLAUDE / "file-history" / SID
    fh.mkdir(parents=True)
    keep = history.CLAUDE / "file-history" / "other"
    keep.mkdir()
    _age(p)
    history.refresh()
    monkeypatch.setattr(conversation_names, "FILE", hist.root / "conversation-names.json")
    conversation_names.observe([
        {"name": "delete-fixture", "created": 1, "label": "Named before delete",
         "agent": {"type": "claude", "session_id": SID, "identity_source": "pid_metadata"}},
        {"name": "keep-other-agent", "created": 2,
         "agent": {"type": "codex", "session_id": SID, "identity_source": "open_rollout"}},
    ])
    conversation_names.close("delete-fixture", 1)
    resp = await client.delete(f"/api/history/claude/{SID}", headers=auth_cookie)
    assert resp.status == 200, await resp.text()
    assert not p.exists() and not (p.parent / SID).exists() and not fh.exists() and keep.exists()
    assert history.listing()[0] == []
    bindings = conversation_names.snapshot()
    assert len(bindings) == 1 and bindings[0]["agent"] == "codex"
    resp = await client.delete(f"/api/history/claude/{SID}", headers=auth_cookie)
    assert resp.status == 404


async def test_delete_refuses_a_recently_written_transcript(hist, client, auth_cookie, monkeypatch):
    async def nowhere(sid, agent=None):
        return None
    monkeypatch.setattr(server, "live_where", nowhere)
    p = hist.codex()
    history.refresh()
    resp = await client.delete(f"/api/history/codex/{CODEX_SID}", headers=auth_cookie)
    assert resp.status == 409 and p.exists()


async def test_delete_refuses_a_live_session(hist, client, auth_cookie, monkeypatch):
    async def here(sid, agent=None):
        return {"kind": "external", "host": "Terminator"}
    monkeypatch.setattr(server, "live_where", here)
    p = hist.claude()
    _age(p)
    history.refresh()
    resp = await client.delete(f"/api/history/claude/{SID}", headers=auth_cookie)
    assert resp.status == 409 and p.exists()


def test_delete_of_a_vanished_file_is_not_found(hist):
    p = hist.claude()
    history.refresh()
    p.unlink()
    with pytest.raises(LookupError):
        history.delete("claude", SID)
    assert history.listing()[0] == []


@pytest.mark.parametrize("path", ["/api/history/claude/..", "/api/history/sh/0a1b2c3d-1111",
                                  "/api/history/claude/-rf-------"])
async def test_history_key_is_validated(hist, client, auth_cookie, path):
    resp = await client.delete(path, headers=auth_cookie)
    assert resp.status in (400, 404)
    assert history.CLAUDE.exists()


async def test_delete_requires_same_origin(hist, client, auth_cookie):
    resp = await client.delete(f"/api/history/claude/{SID}", headers={**auth_cookie, "Origin": "https://evil.example"})
    assert resp.status == 403


# ---------------------------------------------------------------- codex titles

def test_codex_titles_tolerate_odd_databases(hist):
    import sqlite3
    good = sqlite3.connect(history.CODEX / "state_1.sqlite")
    good.execute("create table threads (id text, title blob)")
    good.executemany("insert into threads values (?, ?)", [(CODEX_SID, "Fix the parser"), ("x", 42), ("y", "")])
    good.commit()
    good.close()
    (history.CODEX / "state_0.sqlite").write_bytes(b"not a database")
    sqlite3.connect(history.CODEX / "state_2.sqlite").close()   # no threads table
    hist.codex()
    history.refresh()
    assert history.listing()[0][0]["title"] == "Fix the parser"
    assert history._codex_titles()["x"] == "42"


def test_listing_since_a_generation_sends_changes_and_removals(hist):
    a = hist.claude()
    hist.claude(sid="99999999-0000-0000-0000-000000000000")
    history.refresh()
    items, gone, full = history.listing()
    assert full and len(items) == 2
    seen = history.gen
    assert history.listing(seen) == ([], [], False)
    a.unlink()
    hist.codex()
    history.refresh()
    items, gone, full = history.listing(seen)
    assert not full and [d["id"] for d in items] == [CODEX_SID] and gone == [f"claude:{SID}"]
    assert history.listing(history._floor - 1)[2] is True   # from before this process


async def test_history_route_sends_deltas(hist, aiohttp_client, auth_cookie):
    hist.claude()
    client = await aiohttp_client(server.make_app())
    body = await (await client.get("/api/history", headers=auth_cookie)).json()
    assert body["full"] is True
    assert [d["id"] for d in body["sessions"]] == [SID]
    hist.codex()
    resp = await client.get("/api/history", params={"gen": body["gen"]}, headers=auth_cookie)
    delta = await resp.json()
    assert delta["full"] is False and [d["id"] for d in delta["sessions"]] == [CODEX_SID]
    resp = await client.get("/api/history", params={"gen": "junk"}, headers=auth_cookie)
    assert (await resp.json())["full"] is True


def test_a_client_polling_before_the_cache_loads_gets_it_whole(hist, monkeypatch):
    hist.claude()
    history.refresh()
    history.flush()
    monkeypatch.setattr(history, "_files", {})
    monkeypatch.setattr(history, "_keys", {})
    monkeypatch.setattr(history, "_loaded", False)
    early = history.listing()     # answered before the cache was read
    seen = history.gen
    assert early[0] == []
    history.refresh()             # loads the cache; nothing to re-parse
    items, _, full = history.listing(seen)
    assert full and [d["id"] for d in items] == [SID]


def test_a_generation_from_the_future_gets_everything(hist):
    hist.claude()
    history.refresh()
    assert history.listing(history.gen + 10**9)[2] is True


def test_a_file_deleted_during_its_parse_is_not_published(hist, monkeypatch):
    p = hist.claude()
    real = history._parse

    def parse_then_delete(path, agent, entry):
        out = real(path, agent, entry)
        p.unlink()
        return out
    monkeypatch.setattr(history, "_parse", parse_then_delete)
    history.refresh()
    assert history.listing()[0] == []


async def test_detail_waits_for_a_scan_in_progress(hist, client, auth_cookie, monkeypatch):
    import threading
    hist.claude()
    release = threading.Event()
    real = history.refresh

    def slow_refresh():
        release.wait(5)
        return real()
    monkeypatch.setattr(history, "refresh", slow_refresh)
    monkeypatch.setattr(server, "_hist_scan", None)
    import asyncio
    req = asyncio.create_task(client.get(f"/api/history/claude/{SID}", headers=auth_cookie))
    await asyncio.sleep(0.3)
    release.set()
    resp = await asyncio.wait_for(req, 10)
    assert resp.status == 200 and (await resp.json())["id"] == SID


def test_pi_v3_transcript_is_indexed_without_treating_tool_output_as_dialogue(hist, monkeypatch):
    root = hist.root / 'pi'
    monkeypatch.setenv('PI_CODING_AGENT_DIR', str(root))
    folder = root / 'sessions' / '--test--'
    folder.mkdir(parents=True)
    transcript = folder / 'session.jsonl'
    transcript.write_text('\n'.join(json.dumps(e) for e in [
        {'type': 'session', 'version': 3, 'id': SID, 'cwd': str(hist.root), 'timestamp': '2026-11-10T10:00:00Z'},
        {'type': 'message', 'timestamp': '2026-11-10T10:00:01Z', 'message': {'role': 'user', 'content': 'Pi question'}},
        {'type': 'message', 'timestamp': '2026-11-10T10:00:02Z', 'message': {'role': 'toolResult', 'content': 'private tool'}},
        {'type': 'message', 'timestamp': '2026-11-10T10:00:03Z', 'message': {'role': 'assistant', 'model': 'offline', 'content': [{'type': 'text', 'text': 'Pi answer'}]}},
    ]) + '\n')
    history.refresh()
    d = history.detail('pi', SID)
    assert (d['id'], d['cwd'], d['last_user'], d['last_assistant']) == (SID, str(hist.root), 'Pi question', 'Pi answer')
    assert (d['n_user'], d['n_assistant']) == (1, 1)
    assert history.search_ids([str(transcript)]) == ['pi:' + SID]


async def test_pi_resume_resolves_existing_unique_transcript_before_launch(client, auth_cookie, hist, monkeypatch):
    import discover
    root = hist.root / 'pi'
    monkeypatch.setenv('PI_CODING_AGENT_DIR', str(root))
    folder = root / 'sessions' / '--test--'
    folder.mkdir(parents=True)
    transcript = folder / 'session.jsonl'
    transcript.write_text(json.dumps({'type': 'session', 'version': 3, 'id': SID,
                                     'cwd': str(hist.root), 'timestamp': '2026-11-10T10:00:00Z'}) + '\n')
    history.refresh()
    async def absent(*args):
        return None
    calls = []
    async def launch(*args, **kwargs):
        calls.append((args, kwargs))
        return 'pi-resumed'
    monkeypatch.setattr(server, 'live_where', absent)
    monkeypatch.setattr(server, 'new_session', launch)
    response = await client.post('/api/history/resume', json={'agent': 'pi', 'id': SID}, headers=auth_cookie)
    assert response.status == 200, await response.text()
    assert shlex.split(calls[0][0][2]) == ['pi', '--session', str(transcript)]
    assert calls[0][1] == {'known_agent': 'pi', 'conversation': ('pi', SID, 'launch:history')}
    server.HIST_RESUMING.discard(('pi', SID))
    client.app['recent_conversations'].clear()   # a successful resume also holds the conversation for 120 s
    # A stale pin must not cause Pi to silently create a new conversation.
    transcript.unlink()
    response = await client.post('/api/history/resume', json={'agent': 'pi', 'id': SID}, headers=auth_cookie)
    assert response.status == 404
    assert len(calls) == 1


# ---------------------------------------------------------------- fourth review: one malformed file, a gone store, quarantines

UUID_A, UUID_B, UUID_C = ("c0ffee00-1111-4222-8333-44445555666%d" % i for i in (1, 2, 3))
_BYTES = b"\xff\xfe not utf-8 \xff\n"


def _lines(*items):
    return "".join(json.dumps(item) + "\n" for item in items).encode()


@pytest.fixture
def agents(hist, monkeypatch):
    """Every agent's store under the test directory, empty; helpers write files into them."""
    root = hist.root
    for name in ("XDG_DATA_HOME", "OPENCODE_DB"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(root / "data"))
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(root / "pi"))
    monkeypatch.setenv("COPILOT_HOME", str(root / "copilot"))
    monkeypatch.setenv("VIBE_HOME", str(root / "vibe"))
    monkeypatch.setenv("GEMINI_CLI_HOME", str(root / "gem"))
    monkeypatch.setattr(history, "_agy_roots", lambda: [root / "agy"])

    def put(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        return path

    def vibe(name, meta, manifest=None):
        d = root / "vibe" / "logs" / "session" / "unified" / name
        put(d / "meta.json", meta if isinstance(meta, bytes) else json.dumps(meta))
        if manifest is not None:
            put(d / "generations" / "0000000000000001" / "manifest.json", json.dumps(manifest))

    class A:
        pass

    A.root, A.put, A.vibe = root, staticmethod(put), staticmethod(vibe)
    return A


def _good_of_every_agent(hist, agents):
    """One valid conversation per file-based agent; returns {agent: id}."""
    root, put = agents.root, agents.put
    hist.claude()
    hist.codex()
    put(root / "pi" / "sessions" / "--w--" / "a.jsonl", _lines(
        {"type": "session", "version": 3, "id": UUID_A, "cwd": "/w", "timestamp": "2026-11-01T10:00:00Z"},
        {"type": "message", "timestamp": "2026-11-01T10:00:01Z", "message": {"role": "user", "content": "hi pi"}}))
    put(root / "gem" / ".gemini" / "tmp" / "good" / "chats" / "session-1.jsonl", _lines(
        {"sessionId": UUID_B, "directories": ["/w"]}, {"type": "user", "id": "u1", "content": "hi gem"}))
    put(root / "copilot" / "session-state" / UUID_C / "events.jsonl", _lines(
        {"type": "user.message", "id": "m1", "data": {"content": "hi copilot"}}))
    put(root / "agy" / "brain" / "agyagy00-1111" / ".system_generated" / "logs" / "transcript.jsonl", _lines(
        {"type": "USER_INPUT", "content": "hi agy", "created_at": "2026-11-01T10:00:00Z"}))
    agents.vibe("good", {"session_id": "vibegood0001", "title": "good one"})
    return {"claude": SID, "codex": CODEX_SID, "pi": UUID_A, "gemini": UUID_B, "copilot": UUID_C,
            "agy": "agyagy00-1111", "vibe": "vibegood0001"}


def _listed(items):
    return {f"{d['agent']}:{d['id']}" for d in items}


@pytest.mark.parametrize("case", ["vibe-environment", "vibe-checkpoint", "copilot-yaml", "gemini-root"])
async def test_one_malformed_agent_file_does_not_fail_the_history_api(hist, agents, client, auth_cookie, case):
    await server.history_scan()   # the scan the app started at startup (it saw no file): the request below starts its own
    good = _good_of_every_agent(hist, agents)
    expect = set()
    if case == "vibe-environment":
        agents.vibe("bad", {"session_id": "vibebad00001", "environment": "oops", "title": "x"})
        expect.add("vibe:vibebad00001")
    elif case == "vibe-checkpoint":
        agents.vibe("bad", {"session_id": "vibebad00001", "title": "x"}, {"checkpoint": ["x"]})
        expect.add("vibe:vibebad00001")
    elif case == "copilot-yaml":
        bad = agents.root / "copilot" / "session-state" / "5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22"
        agents.put(bad / "events.jsonl", _lines({"type": "user.message", "id": "m1", "data": {"content": "hi"}}))
        agents.put(bad / "workspace.yaml", b"name: \xff\xfe bad\n")
        expect.add("copilot:5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22")
    else:
        chats = agents.root / "gem" / ".gemini" / "tmp" / "bad"
        agents.put(chats / "chats" / "session-1.jsonl", _lines({"sessionId": "c0ffee00-1111-4222-8333-444455556677"},
                                                               {"type": "user", "id": "u1", "content": "hi gem"}))
        agents.put(chats / ".project_root", b"/w\xff\n")
        expect.add("gemini:c0ffee00-1111-4222-8333-444455556677")
    resp = await client.get("/api/history", headers=auth_cookie)
    assert resp.status == 200, await resp.text()
    ids = {f"{d['agent']}:{d['id']}" for d in (await resp.json())["sessions"]}
    assert ids >= {f"{agent}:{sid}" for agent, sid in good.items()} | expect


def test_a_scan_with_a_malformed_file_of_every_agent_indexes_the_good_ones(hist, agents):
    good = _good_of_every_agent(hist, agents)
    root, put = agents.root, agents.put
    deep = b"[" * 200000 + b"\n"   # RecursionError in the JSON parser: a line the readers must not die on
    put(root / ".claude" / "projects" / "-bad" / "bbbbbbbb-0000-4000-8000-000000000001.jsonl", _BYTES + deep + b'{"type": "user"')
    put(root / ".codex" / "sessions" / "2026" / "10" / "02" / "rollout-2026-10-02T10-00-00-bad.jsonl",
        _BYTES + _lines({"type": "session_meta", "payload": ["x"]}, {"type": "event_msg", "payload": "x"}))
    put(root / "pi" / "sessions" / "--bad--" / "b.jsonl", _BYTES + deep)
    put(root / "gem" / ".gemini" / "tmp" / "bad" / "chats" / "session-9.jsonl", _BYTES + _lines([1], {"messages": 3}))
    put(root / "copilot" / "session-state" / "5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22" / "events.jsonl", _BYTES + deep)
    put(root / "agy" / "brain" / "agybad00-2222" / ".system_generated" / "logs" / "transcript.jsonl", _BYTES + deep)
    agents.vibe("bad-utf8", _BYTES)
    agents.vibe("bad-list", [1, 2])
    agents.vibe("bad-env", {"session_id": "vibeenv00001", "environment": [1], "config": "x", "title": "t"}, [1, 2])
    history.refresh()
    assert {f"{agent}:{sid}" for agent, sid in good.items()} <= _listed(history.listing()[0])


def test_a_file_whose_parse_raises_is_skipped_logged_once_and_kept(hist, monkeypatch, capsys):
    path = hist.claude()
    hist.claude(sid="99999999-0000-0000-0000-000000000000")
    history.refresh()
    entry = history._files[str(path)]
    real, calls = history._parse, []

    def parse(file, agent, old):
        if file == str(path):
            calls.append(file)
            raise KeyError("shape nobody expected")
        return real(file, agent, old)

    monkeypatch.setattr(history, "_parse", parse)
    with path.open("a") as f:
        f.write(json.dumps({"type": "user", "message": {"content": "more"}}) + "\n")
    history.refresh()
    history.refresh()
    assert len(calls) == 1, "a file that did not change is not read again"
    assert capsys.readouterr().out.count(str(path)) == 1, "logged once, with the path and no content"
    assert history._files[str(path)] is entry, "the entry it had is kept (not dropped)"
    assert len(history.listing()[0]) == 2
    with path.open("a") as f:
        f.write(json.dumps({"type": "user", "message": {"content": "again"}}) + "\n")
    history.refresh()
    assert len(calls) == 2, "read again once it changes"
    monkeypatch.setattr(history, "_parse", real)
    with path.open("a") as f:
        f.write(json.dumps({"type": "user", "message": {"content": "fine now"}}) + "\n")
    history.refresh()
    assert history._files[str(path)]["s"]["last_user"] == "fine now" and not history._broken


def _opencode_store(agents):
    import sqlite3
    db = agents.root / "data" / "opencode" / "opencode.db"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.executescript("""
        create table session (id text, directory text, title text, version text, time_created int, time_updated int, parent_id text);
        create table message (id text, session_id text, data text);
        create table part (id text, message_id text, session_id text, data text, time_created int);""")
    con.execute("insert into session values ('ses_abcdefgh12345', '/w', 't', '1', 1000, 1000, NULL)")
    con.execute("insert into message values ('m1', 'ses_abcdefgh12345', ?)", (json.dumps({"role": "user"}),))
    con.execute("insert into part values ('p1', 'm1', 'ses_abcdefgh12345', ?, 1)", (json.dumps({"type": "text", "text": "zanzibar"}),))
    con.commit()
    con.close()
    return db


def test_a_deleted_opencode_store_empties_its_conversations_but_an_unreadable_one_keeps_them(hist, agents):
    db = _opencode_store(agents)
    history.refresh()
    assert _listed(history.listing()[0]) == {"opencode:ses_abcdefgh12345"}
    saved = db.read_bytes()
    db.write_bytes(b"this is not a database" * 100)   # present, unreadable: keeps what is indexed
    history.refresh()
    assert _listed(history.listing()[0]) == {"opencode:ses_abcdefgh12345"}
    db.unlink()   # gone: nothing is left to list
    history.refresh()
    assert history.listing()[0] == []
    db.write_bytes(saved)
    history.refresh()
    assert _listed(history.listing()[0]) == {"opencode:ses_abcdefgh12345"}


def test_only_the_newest_quarantined_database_is_kept(hist, monkeypatch):
    import os
    import history_db
    base = history.CACHE_FILE.with_name("history.sqlite")
    base.parent.mkdir(parents=True, exist_ok=True)
    for stamp in ("20261101-100000", "20261102-100000"):
        for suffix in ("", "-wal", "-shm"):
            (base.parent / f"history.sqlite.corrupt-{stamp}{suffix}").write_text("private prompts")
    base.write_text("corrupt")
    os.chmod(base, 0o600)
    (base.parent / "history.sqlite-wal").write_text("w")
    monkeypatch.setattr(history_db.time, "strftime", lambda fmt, *rest: "20261116-120000")
    with history_db._db_lock:
        history_db._db_fail("test", quarantine=True)
    left = sorted(p.name for p in base.parent.glob("history.sqlite*"))
    assert left == ["history.sqlite.corrupt-20261116-120000", "history.sqlite.corrupt-20261116-120000-wal"]
    assert (base.parent / left[0]).stat().st_mode & 0o777 == 0o600


# ---------------------------------------------------------------- fifth review: one bad input never fails the scan

def _raise(exc):
    def fail(*args, **kwargs):
        raise exc
    return fail


def test_a_database_sync_that_raises_does_not_stop_the_scan(hist, monkeypatch, capsys):
    hist.claude()
    other = hist.claude(sid="99999999-0000-0000-0000-000000000000")
    finished = []
    monkeypatch.setattr(history._hdb, "sync_one", _raise(RecursionError()))
    monkeypatch.setattr(history._hdb, "finish", lambda: finished.append(True))
    assert history.refresh() is True
    assert len(history.listing()[0]) == 2 and finished == [True]
    assert capsys.readouterr().out.count("database sync") == 2
    other.unlink()
    assert history.refresh() is True   # the drop of a vanished file still runs
    assert len(history.listing()[0]) == 1


def test_a_failing_step_is_logged_once_and_the_rest_of_the_scan_runs(hist, monkeypatch, capsys):
    hist.claude()
    monkeypatch.setattr(history, "_codex_titles", _raise(OSError("x")))
    saved = []
    monkeypatch.setattr(history, "_save_cache", lambda: saved.append(True))
    monkeypatch.setattr(history, "_dirty", True)
    monkeypatch.setattr(history, "_saved", -10**9)
    history.refresh()
    history.refresh()
    assert len(history.listing()[0]) == 1 and saved
    assert capsys.readouterr().out.count("scan step codex titles failed") == 1


def test_a_listing_that_fails_does_not_drop_what_is_indexed(hist, monkeypatch):
    hist.claude()
    history.refresh()
    monkeypatch.setattr(history, "_sources", _raise(OSError("x")))
    history.refresh()
    assert len(history.listing()[0]) == 1


def test_a_line_nested_far_too_deep_is_skipped_by_the_parser_and_the_database(hist):
    p = hist.claude()
    with p.open("a") as f:
        f.write('{"type":"user","message":{"content":' + "[" * 200000 + "]" * 200000 + "}}\n")
        f.write(json.dumps({"type": "user", "message": {"content": "after the deep one"}}) + "\n")
    history.refresh()
    assert history._files[str(p)]["s"]["last_user"] == "after the deep one"
    assert history.skipped_count() == 0
    assert history._hdb._db["refused"] == set()


def test_an_opencode_row_with_mistyped_columns_is_listed_and_does_not_fail_the_scan(hist, agents):
    import sqlite3
    db = _opencode_store(agents)
    con = sqlite3.connect(db)
    con.execute("insert into session values ('ses_badbadbad1234', 7, X'00', 3.5, 'x', 'yesterday', NULL)")
    con.execute("insert into message values ('m2', 'ses_badbadbad1234', ?)", (json.dumps({"role": "user"}),))
    con.execute("insert into part values ('p2', 'm2', 'ses_badbadbad1234', ?, 1)", (json.dumps({"type": "text", "text": "hello"}),))
    con.commit()
    con.close()
    history.refresh()
    assert {"opencode:ses_abcdefgh12345", "opencode:ses_badbadbad1234"} <= _listed(history.listing()[0])


def test_an_opencode_conversation_whose_read_raises_is_skipped_counted_and_kept(hist, agents, monkeypatch, capsys):
    import sqlite3
    db = _opencode_store(agents)
    history.refresh()
    real = history._oc_state

    def touch(updated):
        con = sqlite3.connect(db)
        con.execute("update session set time_updated = ?", (updated,))
        con.commit()
        con.close()

    monkeypatch.setattr(history, "_oc_state", _raise(KeyError("x")))
    touch(2000)
    history.refresh()
    history.refresh()
    assert history.skipped_count() == 1 and history.db_stats()["skipped"] == 1
    assert capsys.readouterr().out.count("opencode conversation skipped") == 1
    assert _listed(history.listing()[0]) == {"opencode:ses_abcdefgh12345"}
    monkeypatch.setattr(history, "_oc_state", real)
    touch(3000)
    history.refresh()
    assert history.skipped_count() == 0


async def test_history_route_survives_a_failing_scan_and_serves_the_last_index(hist, aiohttp_client, auth_cookie, monkeypatch):
    hist.claude()
    client = await aiohttp_client(server.make_app())
    first = await (await client.get("/api/history", headers=auth_cookie)).json()
    assert [d["id"] for d in first["sessions"]] == [SID] and first["degraded"] is False
    monkeypatch.setattr(history, "refresh", _raise(RuntimeError("scan broke")))
    monkeypatch.setattr(server, "_hist_scan", None)
    resp = await client.get("/api/history", headers=auth_cookie)
    body = await resp.json()
    assert resp.status == 200 and body["degraded"] is True
    resp = await client.get("/api/history", params={"gen": first["gen"] - 1}, headers=auth_cookie)
    body = await resp.json()
    assert resp.status == 200 and [d["id"] for d in body["sessions"]] == [SID]
    monkeypatch.setattr(history, "refresh", lambda: False)
    monkeypatch.setattr(server, "_hist_scan", None)
    assert (await (await client.get("/api/history", headers=auth_cookie)).json())["degraded"] is False


async def test_history_route_reports_the_files_skipped(hist, aiohttp_client, auth_cookie, monkeypatch):
    hist.claude()
    monkeypatch.setattr(history, "_parse", _raise(KeyError("shape nobody expected")))
    client = await aiohttp_client(server.make_app())
    body = await (await client.get("/api/history", headers=auth_cookie)).json()
    assert body["skipped"] == 1


def test_the_refused_set_is_read_from_a_snapshot(hist):
    import history_db
    history_db._db["refused"].update({("/p%d" % i, 1) for i in range(1000)})
    assert history_db.refused_count() == 0   # none of those paths is indexed
    history_db._db["refused"].clear()


def test_the_quarantine_stamp_is_utc(hist, monkeypatch):
    import calendar
    import time
    import history_db
    base = history.CACHE_FILE.with_name("history.sqlite")
    base.parent.mkdir(parents=True, exist_ok=True)
    base.write_text("corrupt")
    monkeypatch.setenv("TZ", "Pacific/Auckland")
    time.tzset()
    try:
        with history_db._db_lock:
            history_db._db_fail("test", quarantine=True)
        stamp = next(base.parent.glob("history.sqlite.corrupt-*")).name.split("corrupt-")[1]
        assert abs(calendar.timegm(time.strptime(stamp, "%Y%m%d-%H%M%S")) - time.time()) < 120
    finally:
        monkeypatch.undo()
        time.tzset()


@pytest.mark.parametrize("q,ok", [("a b c", False), ("ab cd", False), ("alpha b", False), ("alpha beta", True), ("x alpha", False)])
def test_a_short_term_is_not_sent_to_the_database(q, ok):
    import history_db
    assert history_db._searchable(q) is ok


def test_an_opencode_conversation_whose_date_is_text_is_read_again_when_that_text_changes(hist, agents):
    import sqlite3
    db = _opencode_store(agents)
    con = sqlite3.connect(db)
    con.execute("update session set time_updated = 'yesterday'")
    con.commit()
    history.refresh()
    assert history._files["opencode:ses_abcdefgh12345"]["s"]["last_user"] == "zanzibar"
    con.execute("insert into message values ('m2', 'ses_abcdefgh12345', ?)", (json.dumps({"role": "user"}),))
    con.execute("insert into part values ('p2', 'm2', 'ses_abcdefgh12345', ?, 2)", (json.dumps({"type": "text", "text": "tanganyika"}),))
    con.execute("update session set time_updated = 'today'")
    con.commit()
    con.close()
    history.refresh()
    s = history._files["opencode:ses_abcdefgh12345"]["s"]
    assert s["last_user"] == "tanganyika" and s["updated"] is None   # displayed fields are normalised, the key is not


async def test_a_failing_listing_neither_advances_the_generation_nor_empties_the_client(hist, aiohttp_client, auth_cookie, monkeypatch):
    hist.claude()
    client = await aiohttp_client(server.make_app())
    first = await (await client.get("/api/history", headers=auth_cookie)).json()
    monkeypatch.setattr(history, "listing", _raise(RuntimeError("listing broke")))
    for params in ({"gen": first["gen"] - 1}, {}):
        body = await (await client.get("/api/history", params=params, headers=auth_cookie)).json()
        assert body["listing_failed"] is True and body["degraded"] is True
        assert "gen" not in body and "sessions" not in body and "full" not in body   # the client keeps its state


def test_a_failed_non_file_step_degrades_the_scan_and_failed_files_are_only_counted(hist, monkeypatch):
    hist.claude()
    monkeypatch.setattr(history, "_failed_steps", set())
    real = history._codex_titles
    monkeypatch.setattr(history, "_codex_titles", _raise(RuntimeError("x")))
    history.refresh()
    assert history.scan_degraded() is True
    monkeypatch.setattr(history, "_codex_titles", real)
    history.refresh()
    assert history.scan_degraded() is False
    monkeypatch.setattr(history, "_refresh_file", _raise(RuntimeError("file step")))
    history.refresh()
    assert history.scan_degraded() is False and history.failed_file_count() >= 1
    assert not any(label.startswith("file ") for label in history._failed_steps)


async def test_history_route_is_degraded_while_a_non_file_step_fails(hist, aiohttp_client, auth_cookie, monkeypatch):
    hist.claude()
    monkeypatch.setattr(history, "_failed_steps", set())
    monkeypatch.setattr(history, "_sources", _raise(RuntimeError("glob broke")))
    client = await aiohttp_client(server.make_app())
    assert (await (await client.get("/api/history", headers=auth_cookie)).json())["degraded"] is True
