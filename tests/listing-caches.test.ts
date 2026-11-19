// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session listing reuses what it already read: each test proves the answer is the one
// computed without the reuse, and counts the work that is no longer repeated.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function python(code: string, home: string): any {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3',
    ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: home,
      MESH_CONF_DIR: path.join(home, 'conf'), MESH_CACHE_DIR: path.join(home, 'cache'),
    }});
  return JSON.parse(output);
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'listing-caches-'));
}

describe('codex rollouts are listed once per listing', () => {
  test('inside listing_scope the glob runs once and every rule sees the same rollouts', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, os, discover
day = os.path.join(discover.HOME, ".codex", "sessions", "2026", "11", "19")
os.makedirs(day)
for sid in ("aaaaaaaa-1111", "bbbbbbbb-2222"):
    with open(os.path.join(day, f"rollout-{sid}.jsonl"), "w") as out:
        out.write(json.dumps({"type": "session_meta", "payload": {"id": sid, "cwd": "/w"}}) + "\\n")
real, calls = discover.recent_rollouts, []
def counted(days=30):
    calls.append(days)
    return real(days)
discover.recent_rollouts = counted
def answers():
    return [os.path.basename(discover._rollout_of(sid) or "") for sid in ("aaaaaaaa-1111", "bbbbbbbb-2222", "cccccccc-3333")]
outside = answers()
outside_calls = len(calls)
del calls[:]
with discover.listing_scope():
    inside = answers()
print(json.dumps({"outside": outside, "inside": inside, "outside_calls": outside_calls, "inside_calls": len(calls)}))
`, home);
      assert.deepEqual(result.inside, result.outside);
      assert.deepEqual(result.outside, ['rollout-aaaaaaaa-1111.jsonl', 'rollout-bbbbbbbb-2222.jsonl', '']);
      assert.equal(result.outside_calls, 3);
      assert.equal(result.inside_calls, 1);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});
