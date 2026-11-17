// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Regression tests for the fifth History review that need the native helper (history_db.py, mesh-history):
// M1 a transcript line nested 200 000 levels deep, M3 a transcript rewritten while the JSON cache was lost (the
// lineage token stored with the database cursor is what is compared), m2 a deleted conversation is not a hit.
// (The Python-only cases are in tests/test_history.py.) Every fixture is synthetic and lives under a temporary
// HOME; every variable that could move an agent's data is pointed there or absent. Skipped without the helper
// (MESH_HISTORY_CMD, or a dune build in ocaml/_build); MESH_REQUIRE_NATIVE_HISTORY=1 makes that a failure.
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

const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

let home: string;

function confinedEnv(): NodeJS.ProcessEnv {
  const at = (...parts: string[]): string => path.join(home, ...parts);
  return {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    CODEX_HOME: at('.codex'), CLAUDE_CONFIG_DIR: at('.claude'), OPENCODE_DB: at('data', 'opencode', 'opencode.db'), TMPDIR: home,
    MESH_HISTORY_CMD: BIN};
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-review5-'));
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

/** Run a Python script against history.py with the confined environment; its last stdout line is JSON. */
function python(code: string, timeout = 90000): any {
  const script = `import sys, json, os, time; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history, history_db as hdb\n${code}`;
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script],
    {cwd: REPO, env: confinedEnv(), encoding: 'utf8', timeout});
  return JSON.parse(output.trim().split('\n').pop()!);
}

const PY_CLAUDE = `
proj = os.path.join(os.environ["HOME"], ".claude", "projects", "-w")
os.makedirs(proj, exist_ok=True)
line = lambda c: json.dumps({"type": "user", "cwd": "/w", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": c}}) + "\\n"
def conv(sid, *texts, mode="w"):
    with open(os.path.join(proj, sid + ".jsonl"), mode) as f:
        for t in texts:
            f.write(line(t))
`;

describe('M1: a line nested far too deep makes neither the parser nor the database raise', () => {
  test('the scan finishes, both scans, and the other lines are searchable', {skip}, () => {
    const out = python(`${PY_CLAUDE}
conv("${SID}", "zanzibar first")
with open(os.path.join(proj, "${SID}.jsonl"), "a") as f:
    f.write('{"type":"user","message":{"content":' + "[" * 200000 + "]" * 200000 + "}}\\n")
conv("${SID}", "second prompt", mode="a")
conv("${OTHER}", "another conversation")
raised = []
for i in range(2):
    try:
        history.refresh()
    except BaseException as e:
        raised.append(type(e).__name__)
print(json.dumps({"raised": raised, "ready": hdb._db["ready"], "refused": len(hdb._db["refused"]),
                  "found": hdb.search("zanzibar"), "second": hdb.search("second")}))
history.flush()`);
    assert.deepEqual(out, {raised: [], ready: true, refused: 0, found: [`claude:${SID}`], second: [`claude:${SID}`]});
  });
});

describe('M3: the lineage is identified by a token stored with the cursor, not by a counter of the cache', () => {
  const phase = (first: boolean): string => `
import secrets
d = os.path.join(os.environ["HOME"], ".gemini", "antigravity", "brain", "abcdefgh1234", ".system_generated", "logs")
os.makedirs(d, exist_ok=True)
step = lambda t: json.dumps({"type": "USER_INPUT", "content": t, "created_at": "2026-01-01T00:00:00Z"}) + "\\n"
with open(d + "/transcript.jsonl", "w") as f:
    ${first ? 'f.write(step("oldword alpha prompt"))' : 'f.write(step("newword beta prompt, rewritten by the agent")); f.write(step("second newword"))'}
${first ? '' : 'os.unlink(os.path.join(os.environ["MESH_CACHE_DIR"], "history.json"))   # the JSON cache is lost'}
conv("11111111-2222-3333-4444-555555555555", "claude ${first ? 1 : 2}", mode="a")
history.refresh()
print(json.dumps({"old": hdb.search("oldword"), "new": hdb.search("newword"), "ready": hdb._db["ready"]}))
history.flush()`;

  test('a transcript rewritten while the cache was lost is stored again (no stale text)', {skip}, () => {
    const first = python(`${PY_CLAUDE}${phase(true)}`);
    assert.deepEqual(first, {old: ['agy:abcdefgh1234'], new: [], ready: true});
    const second = python(`${PY_CLAUDE}${phase(false)}`);
    assert.deepEqual(second, {old: [], new: ['agy:abcdefgh1234'], ready: true});
  });

  test('the first file after a start is decided from the stored cursors, deterministically', {skip}, () => {
    const out = python(`${PY_CLAUDE}
conv("${SID}", "alphaword")
history.refresh()
history.flush()
sent = []
real = hdb._db_send
def spy(path, s, g, chunks, cursor, replace, last=True):
    sent.append(replace)
    return real(path, s, g, chunks, cursor, replace, last)
hdb._db_send = spy
history._files.clear(); history._keys.clear(); history._loaded = False   # a new process: the cache is read again
history.refresh()
print(json.dumps({"replaced": [r for r in sent if r], "found": hdb.search("alphaword")}))
history.flush()`);
    assert.deepEqual(out, {replaced: [], found: [`claude:${SID}`]});
  });

  test('an old counter (a cache or a database from before the token) is re-verified, never trusted', {skip}, () => {
    const out = python(`${PY_CLAUDE}
conv("${SID}", "alphaword")
history.refresh()
history.flush()
cache = os.path.join(os.environ["MESH_CACHE_DIR"], "history.json")
raw = json.load(open(cache))
for e in raw["files"].values():
    e["epoch"] = 0                                    # what a cache of the counter era holds
json.dump(raw, open(cache, "w"))
history._files.clear(); history._keys.clear(); history._loaded = False
conv("${SID}", "betaword", mode="w")                  # rewritten, longer than nothing: same length is the worst case
os.utime(os.path.join(proj, "${SID}.jsonl"), (time.time() + 5, time.time() + 5))
history.refresh()
print(json.dumps({"old": hdb.search("alphaword"), "new": hdb.search("betaword")}))
history.flush()`);
    assert.deepEqual(out, {old: [], new: [`claude:${SID}`]});
  });
});

describe('m2: a deleted conversation is not a hit while its forget is pending', () => {
  test('search drops ids the index no longer holds', {skip}, () => {
    const out = python(`${PY_CLAUDE}
conv("${SID}", "alphaword")
history.refresh()
with history._lock:
    for path in list(history._files):
        history._drop(path)                              # deleted; the database has not forgotten it yet
hdb._db["live"] = True
print(json.dumps({"hits": hdb.search("alphaword")}))
history.flush()`);
    assert.deepEqual(out, {hits: []});
  });
});
