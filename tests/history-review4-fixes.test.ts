// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Regression tests for the fourth History review that need the native helper (history_db.py, mesh-history):
// m1 a transcript rewritten while the helper was unavailable (or across a restart) is stored again, not resumed
// at an old offset; m2 a reconcile must not forget a path that a scan published after it took its snapshot;
// m4 a cleared custom name is no longer searchable. (The Python-only cases are in tests/test_history.py.)
// Every fixture is synthetic and lives under a temporary HOME; every variable that could move an agent's data is
// pointed there or absent. Skipped without the helper (MESH_HISTORY_CMD, or a dune build in ocaml/_build);
// MESH_REQUIRE_NATIVE_HISTORY=1 makes that a failure.
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
const PI_SID = 'bbbbbbbb-0000-4000-8000-000000000002';

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-review4-'));
});
afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

/** Run a Python script against history.py with the confined environment; its last stdout line is JSON. */
function python(code: string, timeout = 90000): any {
  const script = `import sys, json, os, time; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport history, history_db as hdb\n${code}`;
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script],
    {cwd: REPO, env: confinedEnv(), encoding: 'utf8', timeout});
  return JSON.parse(output.trim().split('\n').pop()!);
}

/** A one-line-per-word Claude transcript. */
const PY_CLAUDE = `
p = os.path.join(os.environ["HOME"], ".claude", "projects", "-w", "${SID}.jsonl")
os.makedirs(os.path.dirname(p), exist_ok=True)
line = lambda word, i: json.dumps({"type": "user", "timestamp": f"2026-01-01T00:00:{i:02d}Z", "cwd": "/w",
                                   "message": {"content": f"{word} number {i}"}}) + "\\n"
def write(mode, words):
    with open(p, mode) as f:
        for i, word in enumerate(words, 1):
            f.write(line(word, i))
`;

describe('m1: a rewritten line transcript is stored again (the epoch is kept with the cursor)', () => {
  const rewritten = (restart: string): string => `${PY_CLAUDE}
write("w", ["alphaword"])
history.refresh()
hdb._db["retry_at"] = time.monotonic() + 1000   # the helper is unavailable for a while
write("a", ["betaword"] * 4)
os.utime(p, (time.time() - 5, time.time() - 5))
history.refresh()
write("w", ["gammaword"] * 3)                  # rewritten in place, shorter than the index cursor
os.utime(p, (time.time() - 3, time.time() - 3))
${restart}
history.refresh()
print(json.dumps({"epoch": history._files[p]["epoch"] >= 2**61, "ready": hdb._db["ready"],
                  "alpha": hdb.search("alphaword"), "beta": hdb.search("betaword"), "gamma": hdb.search("gammaword")}))
history.flush()`;

  test('while the helper was unavailable', {skip}, () => {
    const out = python(rewritten('hdb._db["retry_at"] = 0'));
    assert.deepEqual(out, {epoch: true, ready: true, alpha: [], beta: [], gamma: [`claude:${SID}`]});
  });

  test('across a restart of the helper (the stored epoch is what is compared)', {skip}, () => {
    const out = python(rewritten('hdb.close()'));
    assert.deepEqual(out, {epoch: true, ready: true, alpha: [], beta: [], gamma: [`claude:${SID}`]});
  });
});

describe('m2: a reconcile does not forget a path a scan published after its snapshot', () => {
  const synced = `${PY_CLAUDE}
write("w", ["alphaword"])
history.refresh()
entry = history._files[p]
`;

  test('a path published after the snapshot is not forgotten', {skip}, () => {
    const out = python(`${synced}
del history._files[p]                                   # the snapshot of reconcile() does not hold it ...
real = hdb._db_started
def started(wait):                                      # ... and the scan publishes it before the forget
    history._files[p] = entry
    return real(wait)
hdb._db_started = started
hdb.reconcile()
print(json.dumps({"known": p in hdb._db["known"], "found": hdb.search("alphaword")}))
history.flush()`);
    assert.deepEqual(out, {known: true, found: [`claude:${SID}`]});
  });

  test('a path published while the helper forgets it is stored again before the scan declares the database ready', {skip}, () => {
    const out = python(`${synced}
del history._files[p]
real = hdb._db_forget_path
def forget(path, *args, **kwargs):
    done = real(path, *args, **kwargs)
    history._files[p] = entry                           # published meanwhile
    return done
hdb._db_forget_path = forget
hdb.finish()
hdb._db_forget_path = real
print(json.dumps({"ready": hdb._db["ready"], "found": hdb.search("alphaword")}))
history.flush()`);
    assert.deepEqual(out, {ready: true, found: [`claude:${SID}`]});
  });
});

describe('m4: a cleared custom name is no longer searchable', () => {
  test('Pi session_info with an empty name removes the name from the full-text index', {skip}, () => {
    const out = python(`
p = os.path.join(os.environ["PI_CODING_AGENT_DIR"], "sessions", "--w--", "a.jsonl")
os.makedirs(os.path.dirname(p))
def add(*items):
    with open(p, "a") as f:
        for item in items:
            f.write(json.dumps(item) + "\\n")
add({"type": "session", "version": 3, "id": "${PI_SID}", "cwd": "/w", "timestamp": "2026-11-01T10:00:00Z"},
    {"type": "message", "message": {"role": "user", "content": "hello pi"}},
    {"type": "session_info", "name": "zephyrname"})
history.refresh()
named = hdb.search("zephyrname")
add({"type": "session_info", "name": ""})
os.utime(p, (time.time() - 5, time.time() - 5))
history.refresh()
print(json.dumps({"named": named, "cleared": hdb.search("zephyrname"), "text": hdb.search("hello")}))
history.flush()`);
    assert.deepEqual(out, {named: [`pi:${PI_SID}`], cleared: [], text: [`pi:${PI_SID}`]});
  });
});
