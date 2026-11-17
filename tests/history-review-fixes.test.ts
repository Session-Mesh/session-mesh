// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Regression tests for the History review (history.py, history_db.py, server.py, respawn.py, mesh-history):
// B1 a lone surrogate must not lose a conversation, M1 two copies of one conversation, M2 the conversation
// guessed for a pin, M4 search keeps the literal scan, M5 a slow helper never stalls a read, N1..N5.
// Every fixture is synthetic and lives under a temporary HOME; every location a client or Mesh could read is
// pointed there (HOME, XDG_*, PI_CODING_AGENT_DIR, COPILOT_HOME, VIBE_HOME, GEMINI_CLI_HOME, OPENCODE_DB, MESH_*),
// so no real conversation is opened. The tests that need the native helper are skipped without it
// (MESH_HISTORY_CMD, or a dune build in ocaml/_build); MESH_REQUIRE_NATIVE_HISTORY=1 makes that a failure.
// The ones that import server.py need its dependencies (MESH_PYTHON).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {AGENT_DATA_ENV, scratchHome, removeScratch, startMesh} from './mesh-server-lib.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const BUILT = path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const BIN = process.env.MESH_HISTORY_CMD || (fs.existsSync(BUILT) ? BUILT : '');
const skip = !BIN && !process.env.MESH_REQUIRE_NATIVE_HISTORY ? 'mesh-history is not built' : false;

const SID = '11111111-2222-4333-8444-555555555555';
const SURROGATE_SID = '22222222-2222-4333-8444-555555555555';
const COPILOT_ID = '5d3a1c52-0c3e-4f7e-9b61-3a7d8c0f1e22';
const COPILOT_OTHER = '6e4b2d63-1d4f-4a8f-8c72-4b8e9d1a2f33';
const GEMINI_USER_ID = 'c0ffee00-1111-4222-8333-444455556666';
const GEMINI_MESH_ID = 'c0ffee00-1111-4222-8333-777788889999';

let home: string;
let work: string;
let env: NodeJS.ProcessEnv;

/** The environment that confines a process to `home`; `helper`: the mesh-history executable, or null for the in-memory index alone. */
function confinedEnv(helper: string | null): NodeJS.ProcessEnv {
  const at = (...parts: string[]): string => path.join(home, ...parts);
  const base: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    OPENCODE_DB: at('data', 'opencode', 'opencode.db')};
  return helper ? {...base, MESH_HISTORY_CMD: helper} : {...base, MESH_HISTORY_DB_DISABLE: '1'};
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-review-'));
  work = path.join(home, 'work');
  fs.mkdirSync(work, {recursive: true});
  env = confinedEnv(BIN || null);
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

/** Run a Python script against history.py with the confined environment; its last stdout line is JSON. */
function python(code: string, options: {env?: NodeJS.ProcessEnv; timeout?: number} = {}): any {
  const script = `import sys, json, os, time, threading; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history\n${code}`;
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script],
    {cwd: REPO, env: options.env ?? env, encoding: 'utf8', timeout: options.timeout ?? 60000});
  return JSON.parse(output.trim().split('\n').pop()!);
}

const jsonl = (file: string, lines: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join(''));
};

const claudeFile = (dir: string, sid: string, text: string, extra: unknown[] = []): string => {
  const file = path.join(home, '.claude', 'projects', dir, `${sid}.jsonl`);
  jsonl(file, [
    {type: 'user', cwd: work, timestamp: '2026-11-01T10:00:00Z', message: {role: 'user', content: `${text} question`}},
    {type: 'assistant', timestamp: '2026-11-01T10:00:05Z', message: {role: 'assistant', content: [{type: 'text', text: `${text} answer`}]}},
    ...extra,
  ]);
  const old = (Date.now() - 3600_000) / 1000;
  fs.utimesSync(file, old, old);
  return file;
};

/** An executable standing in for mesh-history: `body` is a Node program reading the JSON lines of stdin. */
function fakeHelper(name: string, body: string): string {
  const file = path.join(home, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, {mode: 0o755});
  return file;
}

const REFUSING = `require('readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const reply = request.op === 'cursors' ? {ok: true, cursors: []}
    : request.op === 'ingest' ? {ok: false, error: {code: 'bad_request', message: 'refused for the test'}} : {ok: true};
  process.stdout.write(JSON.stringify(reply) + '\\n');
});`;

describe('B1: a lone UTF-16 surrogate in a transcript', {skip}, () => {
  test('the conversation is still indexed, searchable and listed across a restart', () => {
    // JSON.stringify escapes the lone surrogate as \ud83d, which Python's json.loads turns back into one.
    claudeFile('-tmp-a', SURROGATE_SID, 'quokkafish', [
      {type: 'user', timestamp: '2026-11-01T10:00:09Z', message: {role: 'user', content: 'cut emoji \ud83d in two'}}]);
    const scan = `
history.refresh()
db = history._hdb._db
print(json.dumps({"ready": db["ready"], "live": db["live"], "known": len(db["known"]),
  "listed": [[i["agent"], i["id"]] for i in history.listing()[0]], "hits": history.db_search("quokkafish")}))
history.flush()`;
    for (const process of ['first run', 'after a restart']) {
      const result = python(scan);
      assert.equal(result.ready, true, `${process}: the database mirrors the index`);
      assert.deepEqual(result.listed, [['claude', SURROGATE_SID]], process);
      assert.deepEqual(result.hits, [`claude:${SURROGATE_SID}`], `${process}: found by its words, not lost with the row`);
    }
  });
});

describe('B1: a refused ingest is not a synced conversation', () => {
  test('cursors, generation and readiness stay unset, the listing comes from memory, and the refusal is logged once', () => {
    claudeFile('-tmp-a', SID, 'zebracorn');
    const result = python(`
history.refresh()
history.refresh()
db = history._hdb._db
print(json.dumps({"ready": db["ready"], "live": db["live"], "gens": len(db["gens"]), "cursors": len(db["cursors"]),
  "listed": [i["id"] for i in history.listing()[0]], "search": history.db_search("zebracorn")}))
history.flush()`, {env: confinedEnv(fakeHelper('refusing-helper', REFUSING))});
    assert.equal(result.ready, false);
    assert.equal(result.live, false);
    assert.deepEqual([result.gens, result.cursors], [0, 0], 'no cursor or generation recorded for what the database does not hold');
    assert.deepEqual(result.listed, [SID], 'the in-memory index answers');
    assert.equal(result.search, null);
  });

  test('the refusal is logged once, however many scans retry', () => {
    claudeFile('-tmp-a', SID, 'zebracorn');
    const lines = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history\nhistory.refresh()\nhistory.refresh()\nhistory.flush()`],
    {cwd: REPO, env: confinedEnv(fakeHelper('refusing-helper-2', REFUSING)), encoding: 'utf8'}).split('\n');
    assert.equal(lines.filter(l => l.startsWith('history: database refused')).length, 1);
  });
});

describe('M1: two live copies of one conversation (agy has two roots, a project folder may be copied)', {skip}, () => {
  const script = (steps: string): string => `
sent = []
real = history._hdb._db_call
def spy(request, read=False, wait=None):
    if request.get("op") in ("ingest", "forget"):
        sent.append(request["op"] + ":" + request.get("path", request["id"]))
    return real(request, read, wait)
history._hdb._db_call = spy
def state():
    db = history._hdb._db
    listed = [i["id"] for i in history.listing()[0]]
    detail = history.detail("claude", ${JSON.stringify(SID)})
    out = {"ready": db["ready"], "listed": listed, "hits": history.db_search("zebracorn"),
           "path": detail and detail["path"], "sent": list(sent)}
    del sent[:]
    return out
def append(path, text):
    with open(path, "a") as fh:
        fh.write(json.dumps({"type": "user", "timestamp": "2026-11-01T11:00:00Z", "message": {"role": "user", "content": text}}) + "\\n")
out = {}
${steps}
print(json.dumps(out))
history.flush()`;

  test('deleting the copy the row does not follow keeps the row; touching it does not rewrite the row', () => {
    const a = claudeFile('-tmp-a', SID, 'zebracorn');
    const b = claudeFile('-tmp-b', SID, 'zebracorn');
    const out = python(script(`
history.refresh(); out["both"] = state()
append(${JSON.stringify(b)}, "more words"); history.refresh(); out["touch_other"] = state()
os.remove(${JSON.stringify(b)}); history.refresh(); out["remove_other"] = state()`));
    // While the first scan is still discovering files, the first copy met may feed the row for a moment; the
    // row then settles on the first copy in path order, and stays there (the steps below).
    assert.equal(out.both.sent.at(-1), `ingest:${a}`, 'the first copy (in path order) feeds the row');
    assert.deepEqual(out.touch_other.sent, [], 'the other copy changing sends nothing');
    assert.deepEqual(out.remove_other.sent, [], 'the row is not forgotten: a live copy holds it');
    for (const step of [out.both, out.touch_other, out.remove_other]) {
      assert.equal(step.ready, true);
      assert.deepEqual(step.listed, [SID]);
      assert.deepEqual(step.hits, [`claude:${SID}`]);
    }
  });

  test('deleting the copy the row follows moves the row to the other one; the last one forgets it', () => {
    const a = claudeFile('-tmp-a', SID, 'zebracorn');
    const b = claudeFile('-tmp-b', SID, 'zebracorn');
    const out = python(script(`
history.refresh(); out["both"] = state()
os.remove(${JSON.stringify(a)}); history.refresh(); out["after_first"] = state()
os.remove(${JSON.stringify(b)}); history.refresh(); out["after_last"] = state()`));
    assert.deepEqual(out.after_first.sent, [`ingest:${b}`], 'stored again from the surviving copy, not forgotten');
    assert.equal(out.after_first.path, b);
    assert.deepEqual([out.after_first.ready, out.after_first.listed, out.after_first.hits], [true, [SID], [`claude:${SID}`]]);
    assert.deepEqual(out.after_last.sent, [`forget:${SID}`]);
    assert.deepEqual([out.after_last.listed, out.after_last.hits], [[], []]);
  });
});

/** A Copilot conversation: session.start at `start`, a message at `last`, in `cwd`. */
function copilotFile(id: string, start: string, last: string, cwd = work): void {
  jsonl(path.join(home, '.copilot', 'session-state', id, 'events.jsonl'), [
    {id: 'a', type: 'session.start', timestamp: start, data: {sessionId: id, startTime: start, context: {cwd}}},
    {id: 'b', type: 'user.message', timestamp: last, data: {content: 'hello there'}}]);
}

const epoch = (iso: string): number => Date.parse(iso) / 1000;

describe('M2: the conversation guessed for a session', () => {
  const ask = (agent: string, since: number, exclude = '[]'): unknown =>
    python(`history.refresh()\nprint(json.dumps(history.newest_for(${JSON.stringify(agent)}, ${JSON.stringify(work)}, ${since}, ${exclude})))`,
      {env: confinedEnv(null)});

  test('a conversation only updated since the agent started is not a candidate; one started since is', () => {
    copilotFile(COPILOT_ID, '2026-11-02T09:00:00.000Z', '2026-11-02T09:20:00.000Z');
    assert.equal(ask('copilot', epoch('2026-11-02T09:10:00Z')), null, 'written to since, but started before the agent: another session\'s');
    assert.equal(ask('copilot', epoch('2026-11-02T08:50:00Z')), COPILOT_ID);
  });

  test('an id another live session holds is excluded', () => {
    copilotFile(COPILOT_ID, '2026-11-02T09:00:00.000Z', '2026-11-02T09:20:00.000Z');
    assert.equal(ask('copilot', epoch('2026-11-02T08:50:00Z'), JSON.stringify([COPILOT_ID])), null);
  });

  test('Gemini: only Mesh\'s private overlay home is searched, never the user\'s own ~/.gemini', () => {
    const chat = (root: string, id: string): void => {
      jsonl(path.join(root, 'tmp', 'proj', 'chats', `session-2026-11-02T09-00-${id.slice(0, 8)}.jsonl`), [
        {sessionId: id, startTime: '2026-11-02T09:00:00.000Z', lastUpdated: '2026-11-02T09:00:00.000Z', kind: 'main'},
        {id: 'm1', timestamp: '2026-11-02T09:00:01.000Z', type: 'user', content: 'hello there'}]);
      fs.writeFileSync(path.join(root, 'tmp', 'proj', '.project_root'), work + '\n');
    };
    const since = epoch('2026-11-02T08:50:00Z');
    chat(path.join(home, '.gemini'), GEMINI_USER_ID);
    assert.equal(ask('gemini', since), null, 'a conversation of the user\'s own store is not guessed');
    chat(path.join(env.MESH_CONF_DIR!, 'gemini-home', '.gemini'), GEMINI_MESH_ID);
    assert.equal(ask('gemini', since), GEMINI_MESH_ID);
  });

  test('the server names none for two agents of one kind in one folder, nor one that another session holds', () => {
    copilotFile(COPILOT_ID, '2026-11-02T09:00:00.000Z', '2026-11-02T09:20:00.000Z');
    const t0 = epoch('2026-11-02T08:50:00Z');
    const out = python(`
import server
history.refresh()
def agent(sid=None, started=${t0}):
    return {"cwd": ${JSON.stringify(work)}, "agent": {"type": "copilot", "session_id": sid, "started": started}}
alone, pair, held = [agent()], [agent(), agent()], [agent(${JSON.stringify(COPILOT_ID)}), agent()]
for mesh in (alone, pair, held):
    server._apply_history_identity(mesh)
ids = lambda mesh: [[e["agent"]["session_id"], e["agent"].get("identity_source")] for e in mesh]
print(json.dumps({"alone": ids(alone), "pair": ids(pair), "held": ids(held)}))`);
    assert.deepEqual(out.alone, [[COPILOT_ID, 'history_cwd']]);
    assert.deepEqual(out.pair, [[null, null], [null, null]], 'which agent owns the conversation cannot be told');
    assert.deepEqual(out.held, [[COPILOT_ID, null], [null, null]], 'the held conversation is not given to a second session');
  });

  test('a guessed id is not stored in the restore snapshot, and cannot override a later ambiguous listing', () => {
    const out = python(`
import respawn
def session(sid, source):
    return {"name": "a1", "cwd": ${JSON.stringify(work)}, "created": 1.0,
            "agent": {"type": "copilot", "session_id": sid, "identity_source": source, "argv": ["copilot"], "started": 100.0}}
guessed = respawn.entry_of(session(${JSON.stringify(COPILOT_OTHER)}, "history_cwd"))
hooked = respawn.entry_of(session(${JSON.stringify(COPILOT_ID)}, "copilot_hooks"))
stored_guess = guessed["agent"]["session_id"]
live = [guessed]
respawn._keep_hooked_conversation({"live": [hooked]}, live)
print(json.dumps({"stored_guess": stored_guess, "stored_hook": hooked["agent"]["session_id"],
                  "kept": live[0]["agent"]["session_id"]}))`, {env: confinedEnv(null)});
    assert.deepEqual(out, {stored_guess: null, stored_hook: COPILOT_ID, kept: COPILOT_ID});
  });
});

describe('M4: search merges the literal scan into the database hits', {skip}, () => {
  test('ranked hits come first, then what only a substring scan finds (a tool output the index does not hold)', async () => {
    const testHome = home;
    const mesh = await startMesh('hist-m4-', {MESH_HISTORY_CMD: BIN}, where => {
      home = where.home;   // the fixtures go under the throwaway server's HOME
      claudeFile('-tmp-a', SID, 'the café pineapple harvest');
      jsonl(path.join(home, '.claude', 'projects', '-tmp-b', `${SURROGATE_SID}.jsonl`), [
        {type: 'user', cwd: work, timestamp: '2026-11-01T10:00:00Z', message: {role: 'user', content: 'an unrelated question'}},
        {type: 'user', timestamp: '2026-11-01T10:00:02Z', toolUseResult: {stdout: 'x'},
          message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't', content: 'superpineapplejuice'}]}}]);
      home = testHome;
    });
    try {
      const get = async (q: string): Promise<string[]> => {
        const response = await fetch(`${mesh.base}/api/history/search?q=${encodeURIComponent(q)}`, {headers: {Authorization: `Bearer ${mesh.token()}`}});
        assert.equal(response.status, 200);
        return response.json() as Promise<string[]>;
      };
      await fetch(`${mesh.base}/api/history`, {headers: {Authorization: `Bearer ${mesh.token()}`}});   // starts the first scan
      let live = false;
      for (let attempt = 0; attempt < 100 && !live; attempt += 1) {
        // "cafe" finds "café" only through the database (accents folded): it is how the test knows the database is live
        live = (await get('cafe')).includes(`claude:${SID}`);
        if (!live) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(live, 'the database became live');
      assert.deepEqual(await get('pineapple'), [`claude:${SID}`, `claude:${SURROGATE_SID}`]);
      assert.deepEqual(await get('perpineapplejui'), [`claude:${SURROGATE_SID}`], 'a substring: only the literal scan finds it');
    } finally {
      await mesh.stop();
    }
  });
});

describe('M5: a slow or silent helper never stalls a read', {skip}, () => {
  test('a read gives up on a helper busy with a write, and the in-memory index answers', () => {
    claudeFile('-tmp-a', SID, 'zebracorn');
    const out = python(`
history.refresh()
db = history._hdb._db
assert db["ready"] and db["live"]
held, release = threading.Event(), threading.Event()
def hold():
    with history._hdb._db_lock:
        held.set()
        release.wait(20)
threading.Thread(target=hold, daemon=True).start()
held.wait()
began = time.monotonic()
items = [i["id"] for i in history.listing()[0]]
search = history.db_search("zebracorn")
detail = history.detail("claude", ${JSON.stringify(SID)})
elapsed = time.monotonic() - began
release.set()
print(json.dumps({"items": items, "search": search, "detail": detail and detail["id"], "elapsed": elapsed}))
history.flush()`);
    assert.deepEqual(out.items, [SID], 'the listing falls back to the in-memory index');
    assert.equal(out.search, null);
    assert.equal(out.detail, SID);
    assert.ok(out.elapsed < 3, `three reads took ${out.elapsed}s: each should give up after a fraction of a second`);
  });

  test('a helper that never reads its input is killed at the deadline, and the listing is still served', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(40_000);   // far more than a pipe buffer holds
    claudeFile('-tmp-a', SID, 'zebracorn', [{type: 'user', timestamp: '2026-11-01T10:00:09Z', message: {role: 'user', content: big}}]);
    const silent = fakeHelper('silent-helper', 'setTimeout(() => {}, 300000);');
    const out = python(`
history._hdb.DB_TIMEOUT = 1
began = time.monotonic()
history.refresh()
elapsed = time.monotonic() - began
db = history._hdb._db
print(json.dumps({"elapsed": elapsed, "ready": db["ready"], "proc": db["proc"] is None,
                  "listed": [i["id"] for i in history.listing()[0]]}))
history.flush()`, {env: confinedEnv(silent), timeout: 30000});
    assert.ok(out.elapsed < 15, `the scan took ${out.elapsed}s: the write has a deadline`);
    assert.equal(out.ready, false);
    assert.equal(out.proc, true, 'the stuck helper was killed');
    assert.deepEqual(out.listed, [SID]);
  });

  test('server: history reads run in their own small executor, not asyncio\'s default one', () => {
    const out = python(`
import asyncio, server
async def main():
    name = await server.run_history(lambda: threading.current_thread().name)
    return name
print(json.dumps({"thread": asyncio.run(main()), "workers": server.HISTORY_READS._max_workers}))`, {env: confinedEnv(null)});
    assert.match(out.thread, /^history-read/);
    assert.ok(out.workers <= 8);
  });
});

describe('N1: the helper list carries the transcript path', {skip}, () => {
  test('listing a Gemini row from the database does not scan the index for its path', () => {
    const root = path.join(env.MESH_CONF_DIR!, 'gemini-home', '.gemini');
    jsonl(path.join(root, 'tmp', 'proj', 'chats', `session-2026-11-02T09-00-${GEMINI_MESH_ID.slice(0, 8)}.jsonl`), [
      {sessionId: GEMINI_MESH_ID, startTime: '2026-11-02T09:00:00.000Z', lastUpdated: '2026-11-02T09:00:00.000Z', kind: 'main'},
      {id: 'm1', timestamp: '2026-11-02T09:00:01.000Z', type: 'user', content: 'hello there'}]);
    fs.writeFileSync(path.join(root, 'tmp', 'proj', '.project_root'), work + '\n');
    const out = python(`
history.refresh()
assert history._hdb._db["ready"]
calls = []
real = history.find
history.find = lambda *a: (calls.append(a), real(*a))[1]
rows = history.listing()[0]
print(json.dumps({"find_calls": len(calls), "resumable": [r["resumable"] for r in rows]}))
history.flush()`);
    assert.equal(out.find_calls, 0);
    assert.deepEqual(out.resumable, [true], 'the overlay home is still recognised from the path the database returned');
  });
});

// N2 (the identity is applied off the event loop) is tested by behaviour in history-review2-fixes.test.ts (m6).

describe('N3: the scratch server environment drops the variables that move agent data', () => {
  test('a developer\'s XDG_DATA_HOME, OPENCODE_DB, COPILOT_HOME, VIBE_HOME, GEMINI_CLI_HOME and PI_CODING_AGENT_DIR do not reach the server', async () => {
    const saved = AGENT_DATA_ENV.map(name => [name, process.env[name]] as const);
    for (const name of AGENT_DATA_ENV) process.env[name] = path.join(os.tmpdir(), 'not-the-real-one');
    let where;
    try {
      where = await scratchHome('hist-n3-', {VIBE_HOME: 'explicit-override'});
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    try {
      for (const name of AGENT_DATA_ENV.filter(n => n !== 'VIBE_HOME')) assert.equal(where.env[name], undefined, name);
      assert.equal(where.env.VIBE_HOME, 'explicit-override', 'a value the test passes itself is kept');
      assert.equal(where.env.HOME, where.home);
    } finally {
      removeScratch(where.scratch);
    }
  });
});

describe('N4: both modes agree', {skip}, () => {
  test('the listing and the search find the same conversations with and without the helper', () => {
    claudeFile('-tmp-a', SID, 'zebracorn');
    copilotFile(COPILOT_ID, '2026-11-02T09:00:00.000Z', '2026-11-02T09:20:00.000Z');
    const scan = `
history.refresh()
print(json.dumps({"listed": sorted([i["agent"], i["id"], i["title"] or "", i["n_user"]] for i in history.listing()[0]),
                  "db": history._hdb._db["ready"]}))
history.flush()`;
    const memory = python(scan, {env: confinedEnv(null)});
    const database = python(scan, {env: confinedEnv(BIN)});
    assert.equal(memory.db, false);
    assert.equal(database.db, true);
    assert.deepEqual(database.listed, memory.listed);
  });
});

describe('N5: a helper that refuses to open the database is a failed helper', {skip}, () => {
  test('a newer schema: not ready, one log line, the in-memory index answers', () => {
    claudeFile('-tmp-a', SID, 'zebracorn');
    fs.mkdirSync(path.join(home, 'cache'), {recursive: true});
    const db = new DatabaseSync(path.join(home, 'cache', 'history.sqlite'));
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (99, 0)');
    db.close();
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)})
import history
history.refresh()
history.refresh()
db = history._hdb._db
print(json.dumps({"ready": db["ready"], "live": db["live"], "proc": db["proc"] is None, "listed": [i["id"] for i in history.listing()[0]]}))
history.flush()`], {cwd: REPO, env, encoding: 'utf8'});
    const lines = output.trim().split('\n');
    const result = JSON.parse(lines.pop()!);
    assert.deepEqual(result, {ready: false, live: false, proc: true, listed: [SID]});
    assert.equal(lines.filter(l => l.startsWith('history: database helper stopped')).length, 1, lines.join('\n'));
    assert.match(lines.join('\n'), /newer than this build/);
  });
});
