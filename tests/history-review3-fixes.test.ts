// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Regression tests for the third History review (history_db.py, history.py, static/app.js):
// M1 a helper that fails between two ingest batches of one transcript must not leave the tail unindexed forever,
// m5 liveOf prefers a session with a reported id, m6 an unreadable source is not "synced", m7 a slow read does not
// kill the helper, m8 a shutdown is not held by a long ingest, m9 the Vibe size counts meta.json once.
// Every fixture is synthetic and lives under a temporary HOME; every variable that could move an agent's data is
// pointed there or absent. The tests that need the native helper are skipped without it (MESH_HISTORY_CMD, or a dune
// build in ocaml/_build); MESH_REQUIRE_NATIVE_HISTORY=1 makes that a failure.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {afterEach, beforeEach, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const BUILT = path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const BIN = process.env.MESH_HISTORY_CMD || (fs.existsSync(BUILT) ? BUILT : '');
const skip = !BIN && !process.env.MESH_REQUIRE_NATIVE_HISTORY ? 'mesh-history is not built' : false;

const SID = '11111111-2222-4333-8444-555555555555';

let home: string;

function confinedEnv(helper: string | null): NodeJS.ProcessEnv {
  const at = (...parts: string[]): string => path.join(home, ...parts);
  const base: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    CODEX_HOME: at('.codex'), CLAUDE_CONFIG_DIR: at('.claude'), OPENCODE_DB: at('data', 'opencode', 'opencode.db'), TMPDIR: home};
  return helper ? {...base, MESH_HISTORY_CMD: helper} : {...base, MESH_HISTORY_DB_DISABLE: '1'};
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-review3-'));
  fs.mkdirSync(path.join(home, 'work'), {recursive: true});
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

/** Run a Python script against history.py with the confined environment; its last stdout line is JSON. */
function python(code: string, helper: string | null = null, timeout = 90000): any {
  const script = `import sys, json, os, time, threading; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history\n${code}`;
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script],
    {cwd: REPO, env: confinedEnv(helper), encoding: 'utf8', timeout});
  return JSON.parse(output.trim().split('\n').pop()!);
}

describe('M1: a helper failure between the batches of one transcript', () => {
  const transcript = (): string => {
    const dir = path.join(home, '.claude', 'projects', '-tmp-a');
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${SID}.jsonl`);
    const lines = Array.from({length: 30}, (_, i) => JSON.stringify({type: 'user', cwd: path.join(home, 'work'),
      timestamp: `2026-11-01T10:00:${String(i).padStart(2, '0')}Z`,
      message: {role: 'user', content: `${i === 0 ? 'zebracorn' : i === 29 ? 'tailmarker' : `filler${i}`} question`}}) + '\n');
    fs.writeFileSync(file, lines.join(''));
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(file, old, old);
    return file;
  };
  const scenario = (afterRestart: string): string => `
hdb = history._hdb
hdb.DB_BATCH = 5
real_send, calls = hdb._db_send, {"n": 0}
def failing_send(*args, **kwargs):
    calls["n"] += 1
    if calls["n"] == 2:   # the helper dies after the first batch was committed
        with hdb._db_lock:
            hdb._db_fail("simulated failure between batches")
        return False
    return real_send(*args, **kwargs)
hdb._db_send = failing_send
history.refresh()
hdb._db_send = real_send
hdb._db["retry_at"] = 0.0
${afterRestart}
history.refresh()
print(json.dumps({"ready": hdb._db["ready"], "head": hdb.search("zebracorn"), "tail": hdb.search("tailmarker")}))
history.flush()`;

  test('the tail is stored by the next scan when the new helper reports the generation of the failed one', {skip}, () => {
    transcript();
    const out = python(scenario(''), BIN);
    assert.deepEqual(out, {ready: true, head: [`claude:${SID}`], tail: [`claude:${SID}`]});
  });

  test('also when the helper is started by another call than the scan (a stats request)', {skip}, () => {
    transcript();
    const out = python(scenario('hdb._db_call({"op": "stats"})'), BIN);
    assert.deepEqual(out, {ready: true, head: [`claude:${SID}`], tail: [`claude:${SID}`]});
  });

  test('only the last request of an entry stores its generation', () => {
    const file = transcript();
    const out = python(`
hdb = history._hdb
hdb.DB_BATCH = 5
sent = []
hdb._db_call = lambda request, read=False, wait=None: sent.append((request["gen"], request["cursor"]["offset"])) or {"ok": True}
s = {"agent": "claude", "id": ${JSON.stringify(SID)}, "cwd": "/w", "title": "t", "started": 1, "updated": 2, "tin": 0, "tout": 0,
     "summary": "", "name": "", "recap": "", "sub": False, "n_user": 30}
entry = {"s": s, "g": 7, "offset": os.path.getsize(${JSON.stringify(file)}), "epoch": "e"}
result = hdb._db_sync_lines(${JSON.stringify(file)}, entry, 7)
print(json.dumps({"result": result, "gens": [g for g, _ in sent], "stored": hdb._db["gens"]}))`);
    assert.equal(out.result, true);
    assert.ok(out.gens.length >= 6, JSON.stringify(out.gens));
    assert.deepEqual(out.gens.slice(0, -1).filter((g: number) => g === 7), [], 'an intermediate batch does not carry g');
    assert.equal(out.gens.at(-1), 7);
    assert.equal(Object.values(out.stored)[0], 7);
  });
});

describe('m6: a known conversation whose source cannot be read is not synced', () => {
  test('the sync of a Vibe or OpenCode conversation says so (None) and keeps its older generation, so the next scan tries again', () => {
    const out = python(`
hdb = history._hdb
db = hdb._db
path = "/v/meta.json"
s = {"agent": "vibe", "id": ${JSON.stringify(SID)}, "cwd": "/w", "title": "t", "started": 1, "updated": 2, "tin": 0, "tout": 0,
     "summary": "", "name": "", "recap": ""}
db["known"][path] = ("vibe", ${JSON.stringify(SID)})
db["gens"][path] = 3
hdb._WHOLE_TEXTS["vibe"] = lambda p, e, aux: None
hdb._db_call = lambda request, read=False, wait=None: {"ok": True}
result = hdb._db_sync_whole(path, {"s": s, "g": 7, "inc": {"hashes": ["h"]}}, 7)
print(json.dumps({"result": result, "gen": db["gens"].get(path)}))`);
    assert.deepEqual(out, {result: null, gen: 3});
  });
});

/** A stand-in for mesh-history: answers each request with its op; a "search" is answered late, after \`delay\` seconds. */
const slowHelper = (delay: number): string => {
  const file = path.join(home, 'slow-helper');
  fs.writeFileSync(file, `#!/usr/bin/env node
require('readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const reply = request.op === 'cursors' ? {ok: true, cursors: []} : {ok: true, op: request.op, results: []};
  setTimeout(() => process.stdout.write(JSON.stringify(reply) + '\\n'), request.op === 'search' ? ${delay * 1000} : 0);
});
`, {mode: 0o755});
  return file;
};

describe('m7: a read that overruns DB_READ_TIMEOUT abandons the read, not the helper', () => {
  test('the helper keeps running, its late answer is not taken for the answer to the next request', () => {
    const out = python(`
hdb = history._hdb
hdb.DB_READ_TIMEOUT = 0.3
slow = hdb._db_call({"op": "search", "q": "x", "mode": "text", "limit": 1}, read=True)
proc = hdb._db["proc"]
alive = proc is not None and proc.poll() is None
time.sleep(0.6)   # the late answer is on the pipe by now
after = hdb._db_call({"op": "stats"})
read_again = hdb._db_call({"op": "stats"}, read=True)
print(json.dumps({"slow": slow, "alive": alive, "retry_at": hdb._db["retry_at"], "after": after, "read_again": read_again,
                  "late": hdb._db["late"]}))
hdb.close()`, slowHelper(0.5));
    assert.equal(out.slow, null);
    assert.equal(out.alive, true, 'the helper was not killed');
    assert.equal(out.retry_at, 0.0, 'no back-off: the next read goes to the same helper');
    assert.equal(out.after.op, 'stats', 'the late search answer was dropped, not returned here');
    assert.equal(out.read_again.op, 'stats');
    assert.equal(out.late, 0);
  });

  test('a write that is not answered in time still kills the helper', () => {
    const out = python(`
hdb = history._hdb
hdb.DB_TIMEOUT = 0.3
reply = hdb._db_call({"op": "search", "q": "x", "mode": "text", "limit": 1})
print(json.dumps({"reply": reply, "proc": hdb._db["proc"] is None}))`, slowHelper(2));
    assert.deepEqual(out, {reply: null, proc: true});
  });
});

describe('m8: a shutdown is not held by a long ingest', () => {
  test('the stop flag ends the sync between two batches; the cursor of what was stored is kept', () => {
    const dir = path.join(home, '.claude', 'projects', '-tmp-a');
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(file, Array.from({length: 30}, (_, i) => JSON.stringify({type: 'user', message: {role: 'user', content: `q${i}`}}) + '\n').join(''));
    const out = python(`
hdb = history._hdb
hdb.DB_BATCH = 5
sent = []
def send(request, read=False, wait=None):
    sent.append(request["cursor"]["offset"])
    history._stop.set()   # shutdown is requested while the first batch is being stored
    return {"ok": True}
hdb._db_call = send
s = {"agent": "claude", "id": ${JSON.stringify(SID)}, "cwd": "/w", "title": "t", "started": 1, "updated": 2, "tin": 0, "tout": 0,
     "summary": "", "name": "", "recap": "", "sub": False, "n_user": 30}
entry = {"s": s, "g": 7, "offset": os.path.getsize(${JSON.stringify(file)}), "epoch": "e"}
result = hdb._db_sync_lines(${JSON.stringify(file)}, entry, 7)
print(json.dumps({"result": result, "requests": len(sent), "gen": hdb._db["gens"].get(${JSON.stringify(file)}),
                  "cursor": hdb._db["cursors"].get(${JSON.stringify(file)})[0] == sent[0]}))`);
    assert.deepEqual(out, {result: false, requests: 1, gen: null, cursor: true});
  });
});

describe('m9: the size of a Vibe conversation counts meta.json once', () => {
  test('meta.json and the chunk store are summed, not meta.json twice', () => {
    const session = path.join(home, 'vibe-s');
    fs.mkdirSync(path.join(session, 'chunks'), {recursive: true});
    fs.writeFileSync(path.join(session, 'meta.json'), 'x'.repeat(100));
    fs.writeFileSync(path.join(session, 'chunks', 'h1'), 'y'.repeat(25));
    const out = python(`print(json.dumps(history._size(${JSON.stringify(path.join(session, 'meta.json'))}, "sid", "vibe")))`);
    assert.equal(out, 125);
  });
});

describe('m5: liveOf prefers a session whose id was reported over one whose id was guessed', () => {
  test('the first match of the list is not taken when a later one has a reported id', () => {
    const source = fs.readFileSync(path.join(REPO, 'static', 'app.js'), 'utf8');
    const match = /function liveOf\(sid, agent = null\) \{[\s\S]*?\n\}\n/.exec(source);
    assert.ok(match, 'liveOf is in app.js');
    const guessing = {id: 'a', agent: {type: 'claude', session_id: SID, identity_source: 'history_cwd'}};
    const reported = {id: 'b', agent: {type: 'claude', session_id: SID, identity_source: 'claude_hook'}};
    const other = {id: 'c', agent: {type: 'codex', session_id: SID, identity_source: 'codex_process'}};
    const run = (mesh: unknown[], external: unknown[], ...args: unknown[]): string | null => {
      const context = vm.createContext({data: {mesh, external}, args});
      return vm.runInContext(`${match[0]}\n(() => liveOf(...args))()?.id ?? null`, context) as string | null;
    };
    assert.equal(run([guessing, reported], [], SID, 'claude'), 'b');
    assert.equal(run([guessing], [reported], SID, 'claude'), 'b');
    assert.equal(run([guessing], [], SID, 'claude'), 'a', 'a guess alone still shows the conversation as live');
    assert.equal(run([guessing, other], [], SID, 'codex'), 'c');
    assert.equal(run([], [], SID, 'claude'), null);
    assert.equal(run([guessing], [], '', 'claude'), null);
  });
});
