// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Regression tests for the second History review (history.py, history_db.py, server.py, static/app.js):
// M-A the conversation is not lost from the database when one copy of it is ineligible, M-B an id guessed from
// the folder's history is display-only, M-C /api/sessions never waits on the history pool, m1 a partly
// unreadable Vibe source is retried, m3 refused conversations are counted and logged, m6 the identity is
// applied off the event loop.
// Every fixture is synthetic and lives under a temporary HOME; every variable that could move an agent's data
// is pointed there or absent (the child gets an explicit environment, not the developer's), so no real
// conversation is opened. The tests that need the native helper are skipped without it (MESH_HISTORY_CMD, or a
// dune build in ocaml/_build); MESH_REQUIRE_NATIVE_HISTORY=1 makes that a failure. The tests that import
// server.py need its dependencies (MESH_PYTHON).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const BUILT = path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const BIN = process.env.MESH_HISTORY_CMD || (fs.existsSync(BUILT) ? BUILT : '');
const skip = !BIN && !process.env.MESH_REQUIRE_NATIVE_HISTORY ? 'mesh-history is not built' : false;

const SID = '11111111-2222-4333-8444-555555555555';
const GUESSED_SID = '33333333-2222-4333-8444-555555555555';

let home: string;
let work: string;

/** The environment that confines a process to `home`; `helper`: the mesh-history executable, or null for the in-memory index alone. */
function confinedEnv(helper: string | null): NodeJS.ProcessEnv {
  const at = (...parts: string[]): string => path.join(home, ...parts);
  const base: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    CODEX_HOME: at('.codex'), CLAUDE_CONFIG_DIR: at('.claude'), OPENCODE_DB: at('data', 'opencode', 'opencode.db'), TMPDIR: home,
    MESH_MESH_HISTORY_CMD: process.env.MESH_MESH_HISTORY_CMD};
  if (process.env.MESH_PTYHOST_CMD) base.MESH_PTYHOST_CMD = process.env.MESH_PTYHOST_CMD;
  return helper ? {...base, MESH_HISTORY_CMD: helper} : {...base, MESH_HISTORY_DB_DISABLE: '1'};
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-review2-'));
  work = path.join(home, 'work');
  fs.mkdirSync(work, {recursive: true});
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

/** Run a Python script against history.py (and server.py when `server`) with the confined environment; its last stdout line is JSON. */
function python(code: string, options: {helper?: boolean; server?: boolean; timeout?: number} = {}): any {
  const script = `import sys, json, os, time, threading, asyncio; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history\n`
    + `${options.server ? 'import server\n' : ''}${code}`;
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script],
    {cwd: REPO, env: confinedEnv(options.helper === false ? null : BIN || null), encoding: 'utf8', timeout: options.timeout ?? 90000});
  return JSON.parse(output.trim().split('\n').pop()!);
}

const jsonl = (file: string, lines: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join(''));
};

const claudePath = (dir: string, sid: string): string => path.join(home, '.claude', 'projects', dir, `${sid}.jsonl`);

describe('M-A: two copies of one conversation, the first in path order ineligible', {skip}, () => {
  const copies = (first: string, second: string): void => {
    // an assistant line only: no user prompt, so the copy is not a conversation the database holds
    jsonl(claudePath(first, SID), [{type: 'assistant', timestamp: '2026-11-01T10:00:00Z', message: {role: 'assistant', content: 'hi'}}]);
    jsonl(claudePath(second, SID), [{type: 'user', cwd: work, timestamp: '2026-11-01T10:00:00Z',
      message: {role: 'user', content: 'zebracorn question'}}]);
  };
  const state = `
history.refresh(); history.refresh()
db = history._hdb._db
ready = db["ready"]
listed_db = [i["id"] for i in history.listing()[0]]
db["ready"] = False
listed_memory = [i["id"] for i in history.listing()[0]]
db["ready"] = ready
print(json.dumps({"ready": ready, "listed_db": listed_db, "listed_memory": listed_memory,
                  "hits": history.db_search("zebracorn"), "detail": bool(history.detail("claude", ${JSON.stringify(SID)}))}))
history.flush()`;

  for (const [first, second] of [['-tmp-a', '-tmp-b'], ['-tmp-b', '-tmp-a']] as const) {
    test(`the ineligible copy (${first}) does not forget the row the eligible one (${second}) holds`, () => {
      // the ineligible copy is always the sorted-first one: its folder name sorts before the eligible one's
      const [ineligible, eligible] = first < second ? [first, second] : [second, first];
      copies(ineligible, eligible);
      const out = python(state);
      assert.equal(out.ready, true);
      assert.deepEqual(out.listed_memory, [SID], 'the in-memory index holds it');
      assert.deepEqual(out.listed_db, [SID], 'and so does the database listing');
      assert.deepEqual(out.hits, [`claude:${SID}`], 'and the search');
      assert.equal(out.detail, true);
    });
  }

  test('the ineligible copy sorted last changes nothing, and a conversation with no eligible copy is not stored', () => {
    copies('-tmp-b', '-tmp-a');   // the eligible copy first, the ineligible last
    const kept = python(state);
    assert.deepEqual([kept.listed_db, kept.hits], [[SID], [`claude:${SID}`]]);
    fs.rmSync(claudePath('-tmp-a', SID));
    fs.rmSync(claudePath('-tmp-b', SID));
    jsonl(claudePath('-tmp-c', SID), [{type: 'assistant', timestamp: '2026-11-01T10:00:00Z', message: {role: 'assistant', content: 'hi'}}]);
    const none = python(state);
    assert.deepEqual([none.listed_db, none.hits], [[], []]);
  });
});

describe('M-B: an id guessed from the folder history is display-only', () => {
  test('a restart or a restore cannot relaunch a guessed id, and one the agent reported still can', () => {
    const out = python(`
from aiohttp import web
def attempt(source):
    info = {"type": "claude", "session_id": ${JSON.stringify(GUESSED_SID)}, "identity_source": source, "argv": []}
    try:
        return {"argv": server._resume_argv(info)}
    except web.HTTPException as e:
        return {"refused": e.status, "text": e.text}
print(json.dumps({"guessed": attempt("history_cwd"), "hooks": attempt("claude_hook"), "argv": attempt("argv_resume")}))`,
    {helper: false, server: true});
    assert.equal(out.guessed.refused, 400);
    assert.equal(out.guessed.text, 'Session ID not found');
    assert.ok(Array.isArray(out.hooks.argv) && out.hooks.argv.includes(GUESSED_SID), JSON.stringify(out.hooks));
    assert.ok(Array.isArray(out.argv.argv), JSON.stringify(out.argv));
  });

  test('a History resume of a conversation only a guessing session holds is a 409 with the message, as a delete; a reported id routes', () => {
    const out = python(`
from aiohttp import web
class Reached(Exception):
    pass
async def fake_detail(agent, sid):
    raise Reached()
async def run(source):
    async def listing():
        return {"mesh": [{"agent": {"type": "claude", "session_id": ${JSON.stringify(GUESSED_SID)}, "identity_source": source, "argv": []},
                          "id": "s1", "kind": "mesh"}], "external": []}
    server.sessions = listing
    server.history_detail = fake_detail
    where = await server.live_where(${JSON.stringify(GUESSED_SID)}, "claude")
    try:
        resumed = await server._resume_history("claude", ${JSON.stringify(GUESSED_SID)})
    except Reached:
        resumed = "continued"
    except web.HTTPConflict as e:
        resumed = {"status": e.status, "text": e.text}
    return {"delete_sees": bool(where), "resumed": resumed}
print(json.dumps({"guessed": asyncio.run(run("history_cwd")), "hooks": asyncio.run(run("claude_hook"))}))`,
    {helper: false, server: true});
    assert.equal(out.guessed.delete_sees, true);
    assert.equal(out.guessed.resumed.status, 409, 'a second agent must not start on a conversation a session may be running');
    assert.match(out.guessed.resumed.text, /^claude may still be running in the mesh: its conversation id is only a guess/);
    assert.deepEqual(out.hooks, {delete_sees: true, resumed: 's1'}, 'a reported id still routes to the session');
  });

  test('that message is translated: a row of server-messages.json and the en and fr catalogues', () => {
    const table = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'i18n', 'server-messages.json'), 'utf8')) as {pattern: string; key: string}[];
    const text = 'claude may still be running in the mesh: its conversation id is only a guess, check that terminal first';
    const row = table.find(r => new RegExp(r.pattern).test(text));
    assert.equal(row?.key, 'server.agentMaybeRunning');
    for (const lang of ['en', 'fr']) {
      const catalogue = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
      assert.match(catalogue['server.agentMaybeRunning'] ?? '', /\{agent\}.*\{host\}/, lang);
    }
  });
});

describe('M-C: /api/sessions does not wait on the history pool', () => {
  test('the listing returns promptly while four searches fill HISTORY_READS and a delete waits', () => {
    const out = python(`
import server
release = threading.Event()
def blocked(*a):
    release.wait(30)
    return []
class Stub:   # the hook state of the running app, reduced to what a listing calls
    def expose(self, mesh, raw, *, prune=True): pass
    def report(self): return {}
async def main():
    async def host_identity(): return "h"
    async def request(msg): return []
    server.ptyhost.host_identity = host_identity
    server.ptyhost.request = request
    fillers = [server.run_history(blocked) for _ in range(4)]   # the four workers, all stuck
    queued = server.run_history(blocked)                         # one more: queued behind them
    await asyncio.sleep(0.5)
    began = time.monotonic()
    data = await asyncio.wait_for(server.sessions(event_state=Stub()), 15)
    took = time.monotonic() - began
    release.set()
    await asyncio.gather(*fillers, queued)
    return {"took": took, "mesh": data["mesh"]}
print(json.dumps(asyncio.run(main())))`, {helper: false, server: true});
    assert.ok(out.took < 5, `the listing took ${out.took}s with the history pool full`);
    assert.deepEqual(out.mesh, []);
  });

  test('a newer OpenCode store search cancels the one running, and one that was queued returns at once', () => {
    const out = python(`
import sqlite3
# a store the search finds a match in, to see a search that is not cancelled still answers
db = os.environ["OPENCODE_DB"]
os.makedirs(os.path.dirname(db), exist_ok=True)
con = sqlite3.connect(db)
con.execute("CREATE TABLE session (id TEXT, title TEXT, directory TEXT)")
con.execute("CREATE TABLE part (session_id TEXT, data TEXT)")
con.execute("INSERT INTO part VALUES ('ses_aaaaaaaaaaaa', 'a zebracorn here')")
con.commit(); con.close()
seen = []
def slow(q, cancel=None):
    seen.append((q, "start"))
    cancelled = cancel.wait(20)
    seen.append((q, "cancelled" if cancelled else "timeout"))
    return []
real_search_db = history.search_db
server.history.search_db = slow
async def main():
    first = asyncio.ensure_future(server._search_store("first"))
    await asyncio.sleep(0.3)
    began = time.monotonic()
    second = asyncio.ensure_future(server._search_store("second"))
    await asyncio.wait_for(first, 5)
    first_after = time.monotonic() - began
    third = asyncio.ensure_future(server._search_store("third"))   # supersedes the second, still running
    await asyncio.sleep(0.2)
    await asyncio.wait_for(second, 5)
    third.cancel()
    return {"first_after": first_after, "seen": seen}
out = asyncio.run(main())
event = threading.Event(); event.set()
out["precancelled"] = real_search_db("zebracorn", event)
out["uncancelled"] = real_search_db("zebracorn")
out["workers"] = server.HISTORY_STORE_SEARCH._max_workers
print(json.dumps(out))`, {helper: false, server: true});
    assert.equal(out.workers, 1);
    assert.ok(out.first_after < 3, `the superseded search stopped after ${out.first_after}s`);
    assert.deepEqual(out.seen.slice(0, 2), [['first', 'start'], ['first', 'cancelled']]);
    assert.deepEqual(out.precancelled, [], 'a cancelled search that has not started returns at once');
    assert.deepEqual(out.uncancelled, [], 'the match is not an indexed conversation, so none is listed');
  });

  test('a delete does not wait longer than its bound for a helper busy with a scan', () => {
    const out = python(`
hdb = history._hdb
db = hdb._db
db["known"]["/gone/path"] = ("claude", ${JSON.stringify(SID)})
db["owner"][("claude", ${JSON.stringify(SID)})] = "/gone/path"
db["ready"] = True
held, release = threading.Event(), threading.Event()
def hold():
    with hdb._db_lock:
        held.set()
        release.wait(30)
thread = threading.Thread(target=hold); thread.start(); held.wait(5)
began = time.monotonic()
mirrored = hdb.reconcile(wait=0.3)
took = time.monotonic() - began
release.set(); thread.join()
print(json.dumps({"mirrored": mirrored, "took": took, "ready": db["ready"], "bound": hdb.DB_DELETE_WAIT}))`, {helper: false});
    assert.equal(out.mirrored, false);
    assert.ok(out.took < 3, `the reconcile waited ${out.took}s`);
    assert.equal(out.ready, false, 'the database stops mirroring the index: readers use the index until the scan reconciles');
    assert.ok(out.bound <= 5);
  });
});

describe('m6: the history identity is applied off the event loop', () => {
  test('the identity function runs in a worker thread of its own, never on the loop, and not in HISTORY_READS', () => {
    const out = python(`
seen = {}
def spy(mesh):
    seen["thread"] = threading.current_thread().name
    seen["on_loop"] = threading.current_thread() is seen["loop_thread"]
server._apply_history_identity = spy
class Stub:
    def expose(self, mesh, raw, *, prune=True): pass
    def report(self): return {}
async def main():
    seen["loop_thread"] = threading.current_thread()
    async def host_identity(): return "h"
    async def request(msg): return []
    server.ptyhost.host_identity = host_identity
    server.ptyhost.request = request
    await server.sessions(event_state=Stub())
asyncio.run(main())
print(json.dumps({"thread": seen["thread"], "on_loop": seen["on_loop"]}))`, {helper: false, server: true});
    assert.equal(out.on_loop, false);
    assert.match(out.thread, /^history-identity/);
  });
});

describe('m1: a Vibe conversation with unreadable chunks is tried again at the next scan', () => {
  test('no generation is recorded for a path whose plan skipped a chunk, and it is when all are read', () => {
    const out = python(`
hdb = history._hdb
db = hdb._db
path = "/v/meta.json"
s = {"agent": "vibe", "id": ${JSON.stringify(SID)}, "cwd": "/w", "title": "t", "started": 1, "updated": 2, "tin": 0, "tout": 0,
     "summary": "", "name": "", "recap": ""}
entry = {"s": s, "g": 7, "inc": {"hashes": ["h1", "h2"]}}
hdb._db_call = lambda request, read=False, wait=None: {"ok": True}
plan = {"value": (False, [("user", "x")], 1, {"hashes": ["h1"], "partial": True})}
hdb._WHOLE_TEXTS["vibe"] = lambda p, e, aux: plan["value"]
first = hdb._db_sync_whole(path, entry, 7)
after_partial = db["gens"].get(path)
plan["value"] = (False, [("user", "y")], 2, {"hashes": ["h1", "h2"], "partial": False})
second = hdb._db_sync_whole(path, entry, 7)
print(json.dumps({"first": first, "after_partial": after_partial, "second": second, "after_full": db["gens"].get(path)}))`,
    {helper: false});
    assert.deepEqual(out, {first: true, after_partial: null, second: true, after_full: 7});
  });

  test('the Vibe planner marks a skipped chunk as partial', () => {
    const session = path.join(home, '.vibe', 'logs', 'session', 'unified', 's1');
    fs.mkdirSync(session, {recursive: true});
    const out = python(`
from pathlib import Path
hdb = history._hdb
read = {"h1": [("user", "text")]}
history._vibe_chunk = lambda directory, digest: read.get(digest)
entry = {"inc": {"hashes": ["h1", "h2"]}}
plan = hdb._vibe_db_plan(${JSON.stringify(path.join(session, 'meta.json'))}, entry, None)
print(json.dumps({"hashes": plan[3]["hashes"], "partial": plan[3]["partial"]}))`, {helper: false});
    assert.deepEqual(out, {hashes: ['h1'], partial: true});
  });
});

describe('m3: refused conversations are counted and logged where they block readiness', {skip}, () => {
  test('the adapter stats count the refusal and the scan logs it once', () => {
    jsonl(claudePath('-tmp-a', SID), [{type: 'user', cwd: work, timestamp: '2026-11-01T10:00:00Z',
      message: {role: 'user', content: 'zebracorn question'}}]);
    const refusing = path.join(home, 'refusing-helper');
    fs.writeFileSync(refusing, `#!/usr/bin/env node
require('readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const reply = request.op === 'cursors' ? {ok: true, cursors: []}
    : request.op === 'ingest' ? {ok: false, error: {code: 'bad_request', message: 'refused for the test'}} : {ok: true};
  process.stdout.write(JSON.stringify(reply) + '\\n');
});
`, {mode: 0o755});
    const stdout = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history\nhistory.refresh()\n`
      + 'print(json.dumps({"stats": history.db_stats()}))\nhistory.flush()'],
    {cwd: REPO, env: {...confinedEnv(refusing)}, encoding: 'utf8', timeout: 60000}).trim().split('\n');
    const stats = JSON.parse(stdout.pop()!).stats;
    assert.equal(stats.refused, 1);
    assert.equal(stats.ready, false);
    assert.equal(stdout.filter(line => /1 conversation\(s\) refused by the database/.test(line)).length, 1, stdout.join('\n'));
  });
});

describe('search route: the query guard precedes every backend, with and without the helper', () => {
  for (const helper of [true, false]) {
    test(`short and multiline queries reach no backend (${helper ? 'helper' : 'in-memory index'})`, {skip: helper ? skip : false}, () => {
      const out = python(`
calls = []
history.db_search = lambda q: calls.append(("db", q)) or []
history.search_argv = lambda q: calls.append(("argv", q)) or None
history.search_db = lambda q, cancel=None: calls.append(("store", q)) or []
class Req:
    def __init__(self, q): self.query = {"q": q}
async def main():
    bodies = []
    for q in ("he", "hello\\nthere", "hello\\rthere", "  ab  "):
        bodies.append(json.loads((await server.api_history_search(Req(q))).text))
    return {"bodies": bodies, "calls": calls}
print(json.dumps(asyncio.run(main())))`, {helper, server: true});
      assert.deepEqual(out, {bodies: [[], [], [], []], calls: []});
    });
  }
});
