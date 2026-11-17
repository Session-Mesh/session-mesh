// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Events of a sender that numbers them (detail.seq, the OpenCode plugin) are ordered by that number alone: an equal
// number is the same event again (or a late duplicate) and never replaces the one held, an older one is stale, a
// newer one wins whatever the dates say.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function applied(sequence: (number | null)[], types: string[]): boolean[] {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'event-seq-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
state = server.EventState()
sequence, types = json.loads(${JSON.stringify(JSON.stringify(sequence))}), json.loads(${JSON.stringify(JSON.stringify(types))})
out = []
for index, (seq, kind) in enumerate(zip(sequence, types)):
    event = {"type": kind, "at": 100.0 + index, "received": 0.0, "received_steady": 0.0, "id": None,
             "detail": None if seq is None else {"seq": seq}}
    out.append(state.apply("s", "n", event))
print(json.dumps(out))`],
    {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, TMPDIR: conf}});
    return JSON.parse(output) as boolean[];
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

describe('numbered events', () => {
  test('an equal number never replaces the event held, even a later one that says something else', () => {
    assert.deepEqual(applied([5, 5], ['done', 'working']), [true, false]);
    assert.deepEqual(applied([5, 5], ['working', 'done']), [true, false]);
  });

  test('an older number is stale, a newer one wins', () => {
    assert.deepEqual(applied([5, 4, 6], ['done', 'working', 'working']), [true, false, true]);
  });

  test('without numbers the dates decide as before: a working after a done replaces it', () => {
    assert.deepEqual(applied([null, null], ['done', 'working']), [true, true]);
  });
});
