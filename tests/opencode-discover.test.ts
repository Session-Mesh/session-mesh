// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How Mesh reads OpenCode's SQLite store (discover.opencode_info): the conversation a process runs, its
// state and its last texts, from a store with OpenCode 1.18.35's real table shapes and no OpenCode binary.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {addConversation, createStore, startFakeOpencode} from './helpers/opencode-store.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const NOW = Date.now();
let scratch: string;
let work: string;
const children: ChildProcess[] = [];

function info(pid: number, dataHome: string): {type: string; session_id?: string; identity_source?: string; status?: string;
  last?: string; said?: string} {
  const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)}); import discover; print(json.dumps(discover.opencode_info(${pid})))`;
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', code],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: scratch, XDG_DATA_HOME: dataHome}}));
}

/** A process named opencode in `directory` (argv words after the script path are the fake's own arguments). */
async function fakeOpencode(directory: string, ...args: string[]): Promise<number> {
  const child = await startFakeOpencode(path.join(scratch, 'bin', 'opencode'), directory, args);
  children.push(child);
  return child.pid!;
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-discover-'));
  work = fs.mkdtempSync(path.join(scratch, 'work-'));
  fs.mkdirSync(path.join(scratch, 'bin'));
  fs.writeFileSync(path.join(scratch, 'bin', 'opencode'), '#!/bin/sh\nsleep 300\n', {mode: 0o755});
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(scratch, {recursive: true, force: true});
});

describe('OpenCode conversation identity', () => {
  test('a process started with --session names that conversation, idle once its last answer is complete', async () => {
    const data = path.join(scratch, 'data-named');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const db = createStore(path.join(data, 'opencode', 'opencode.db'));
    db.prepare('INSERT INTO credential VALUES (?, ?)').run('c1', 'SECRET-PROVIDER-KEY');
    addConversation(db, 'ses_namedconversation0001', work, {open: false, updated: NOW - 60_000});
    addConversation(db, 'ses_otherconversation00002', work, {open: false, updated: NOW - 30_000});
    db.close();
    const pid = await fakeOpencode(work, '--session', 'ses_namedconversation0001');
    const got = info(pid, data);
    assert.equal(got.session_id, 'ses_namedconversation0001');
    assert.equal(got.identity_source, 'argv_session');
    assert.equal(got.status, 'idle');
    assert.equal(got.last, 'question of ses_namedconversation0001');
    assert.equal(got.said, 'answer of ses_namedconversation0001');
    assert.ok(!JSON.stringify(got).includes('SECRET-PROVIDER-KEY'), 'the credential table is never read');
  });

  test('a lone process takes the single conversation written since it started, busy while a turn is open', async () => {
    const data = path.join(scratch, 'data-lone');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const alone = fs.mkdtempSync(path.join(scratch, 'alone-'));
    const pid = await fakeOpencode(alone);
    const db = createStore(path.join(data, 'opencode', 'opencode.db'));
    addConversation(db, 'ses_loneconversation000003', alone, {open: true, updated: Date.now() + 1000});
    addConversation(db, 'ses_olderconversation000004', alone, {open: false, updated: NOW - 3_600_000});
    addConversation(db, 'ses_subagentconversation005', alone, {open: true, updated: Date.now() + 1000, parent: 'ses_loneconversation000003'});
    db.close();
    const got = info(pid, data);
    assert.equal(got.session_id, 'ses_loneconversation000003');
    assert.equal(got.identity_source, 'unique_opencode_session');
    assert.equal(got.status, 'busy');
  });

  test('two processes in one directory name no conversation', async () => {
    const data = path.join(scratch, 'data-two');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const shared = fs.mkdtempSync(path.join(scratch, 'shared-'));
    const first = await fakeOpencode(shared);
    await fakeOpencode(shared);
    const db = createStore(path.join(data, 'opencode', 'opencode.db'));
    addConversation(db, 'ses_sharedconversation00006', shared, {open: false, updated: Date.now() + 1000});
    db.close();
    assert.equal(info(first, data).session_id, undefined);
  });

  test('a missing store is no conversation, not an error', async () => {
    const pid = await fakeOpencode(work);
    assert.equal(info(pid, path.join(scratch, 'no-such-data-home')).session_id, undefined);
  });
});
