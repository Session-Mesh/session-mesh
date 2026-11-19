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

describe('conversation names are serialised only to be written', () => {
  test('an unchanged listing serialises and writes nothing; a change is written once, as before', () => {
    const home = tempHome();
    try {
      const result = python(`
import json, os, time, conversation_names as names
T = float(int(time.time()) - 100)   # in the past: _load keeps only entries seen before now
real, dumps = json.dumps, []
def counted(*args, **kwargs):
    dumps.append(1)
    return real(*args, **kwargs)
names.json.dumps = counted
sessions = [{"name": f"s{i}", "created": 100 + i, "label": f"L{i}",
             "agent": {"type": "claude", "session_id": f"abcdefgh-{i:04d}", "identity_source": "pid_metadata"}}
            for i in range(30)]
names.observe(sessions, now=T)
first = len(dumps)
mtime = os.stat(names.FILE).st_mtime_ns
del dumps[:]
names.observe(sessions, now=T + 1)
unchanged = {"dumps": len(dumps), "written": os.stat(names.FILE).st_mtime_ns != mtime}
seen = sorted({e["seen"] - T for e in names.snapshot()})
del dumps[:]
sessions[3] = dict(sessions[3], label="Renamed")
names.observe(sessions, now=T + 2)
changed = [e for e in names.snapshot() if e["name"] == "s3"][0]
later = [e for e in names.snapshot() if e["name"] == "s4"][0]
print(json.dumps({"first": first, "unchanged": unchanged, "seen": seen, "changed_dumps": len(dumps),
                  "s3": [changed["label"], changed["aliases"], changed["seen"] - T], "s4_seen": later["seen"] - T}))
`, home);
      assert.equal(result.first, 1, 'the first listing writes the file: one serialisation');
      assert.deepEqual(result.unchanged, {dumps: 0, written: false});
      assert.deepEqual(result.seen, [0], 'an unchanged entry keeps its time');
      assert.equal(result.changed_dumps, 1);
      assert.deepEqual(result.s3, ['Renamed', ['s3', 'L3', 'Renamed'], 2]);
      // As before: once an entry changed in this listing, the entries handled after it are stamped too.
      assert.equal(result.s4_seen, 2);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});

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
