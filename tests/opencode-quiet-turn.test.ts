// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "Resume when idle" SIGTERMs an OpenCode running in another terminal after two idle polls. A turn that writes
// nothing for many minutes (a long tool call) is still a turn: discover._opencode_busy has no time limit for a
// live process, and only drops a busy mark written before the process started (another process left it).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {addConversation, addConversationV2, createStore, createStoreV2} from './helpers/opencode-store.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const QUIET_MS = 360_000;
let scratch: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-quiet-'));
});

after(() => {
  fs.rmSync(scratch, {recursive: true, force: true});
});

/** What the server makes of one conversation: [discover's busy flag, whether the restart would take it as idle]. */
function judged(dataHome: string, sid: string, startedSecondsAgo: number): [boolean, boolean] {
  const code = `
import json, sys, time
sys.path.insert(0, ${JSON.stringify(REPO)})
import discover, server
busy = discover._opencode_busy(${JSON.stringify(sid)}, time.time() - ${startedSecondsAgo})
agent = {"type": "opencode", "status": "busy" if busy else "idle", "updated": time.time() - 360}
print(json.dumps([busy, server.looks_idle(agent)]))`;
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', code],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: scratch, MESH_CONF_DIR: scratch, XDG_DATA_HOME: dataHome}}));
}

function storeDir(name: string): string {
  const data = path.join(scratch, name);
  fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
  return data;
}

describe('an OpenCode turn silent for 360 s', () => {
  test('2.x: busy after time_idle < time_busy, so the restart does not take it for idle', () => {
    const data = storeDir('v2-open');
    const db = createStoreV2(path.join(data, 'opencode', 'opencode.db'));
    addConversationV2(db, 'ses_quietturnv2000001', '/tmp', {updated: Date.now() - QUIET_MS, busy: true});
    db.close();
    assert.deepEqual(judged(data, 'ses_quietturnv2000001', 7200), [true, false]);
  });

  test('2.x: a turn that finished (time_idle after time_busy) is idle and restartable once quiet', () => {
    const data = storeDir('v2-done');
    const db = createStoreV2(path.join(data, 'opencode', 'opencode.db'));
    addConversationV2(db, 'ses_quietdonev2000002', '/tmp', {updated: Date.now() - QUIET_MS, busy: false});
    db.close();
    assert.deepEqual(judged(data, 'ses_quietdonev2000002', 7200), [false, true]);
  });

  test('2.x: a busy mark written before this process started is a leftover of another process', () => {
    const data = storeDir('v2-leftover');
    const db = createStoreV2(path.join(data, 'opencode', 'opencode.db'));
    addConversationV2(db, 'ses_leftoverv20000003', '/tmp', {updated: Date.now() - QUIET_MS, busy: true});
    db.close();
    assert.deepEqual(judged(data, 'ses_leftoverv20000003', 60), [false, true]);
  });

  test('1.x: an assistant message not completed is a turn however old it is', () => {
    const data = storeDir('v1-open');
    const db = createStore(path.join(data, 'opencode', 'opencode.db'));
    addConversation(db, 'ses_quietturnv1000004', '/tmp', {open: true, updated: Date.now() - QUIET_MS});
    db.close();
    assert.deepEqual(judged(data, 'ses_quietturnv1000004', 7200), [true, false]);
  });
});
