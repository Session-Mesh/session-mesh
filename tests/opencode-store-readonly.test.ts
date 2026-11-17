// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Mesh reads OpenCode's SQLite store for an OpenCode it did not start (discover.opencode_info). That file also
// holds the user's provider credentials, so the read must stay a read: the file is not changed, a missing one is
// not created, and only the tables session, message and part are ever read.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {addConversation, createStore, startFakeOpencode} from './helpers/opencode-store.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const CONVERSATION = 'ses_readonlyconversation01';
let scratch: string;
let work: string;
let fake: ChildProcess;

type Observed = {info: {session_id?: string}; uris: string[]; reads: string[]; refused: string[]};

// discover.opencode_info for `pid`, with sqlite3.connect wrapped to record the URI it opens and, through an
// authorizer, every table read and every action that is not a read (which it refuses).
function observe(pid: number, dataHome: string): Observed {
  const code = `
import sys, json, sqlite3
sys.path.insert(0, ${JSON.stringify(REPO)})
import discover
uris, reads, refused = [], set(), []
real = sqlite3.connect
READ, SELECT, FUNCTION, RECURSIVE = 20, 21, 31, 33
def authorize(action, arg1, arg2, database, source):
    if action == READ:
        reads.add(arg1)
        return sqlite3.SQLITE_OK
    if action in (SELECT, FUNCTION, RECURSIVE):
        return sqlite3.SQLITE_OK
    refused.append([action, arg1, arg2])
    return sqlite3.SQLITE_DENY
def connect(*args, **kwargs):
    uris.append(args[0])
    con = real(*args, **kwargs)
    con.set_authorizer(authorize)
    return con
sqlite3.connect = connect
info = discover.opencode_info(${pid})
print(json.dumps({"info": info, "uris": uris, "reads": sorted(reads), "refused": refused}))`;
  return JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', code],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: scratch, XDG_DATA_HOME: dataHome}}));
}

const snapshot = (dir: string): Record<string, {size: number; mtimeNs: bigint}> => Object.fromEntries(
  fs.readdirSync(dir, {recursive: true, encoding: 'utf8'}).sort().map(name => {
    const stat = fs.statSync(path.join(dir, name), {bigint: true});
    return [name, {size: Number(stat.size), mtimeNs: stat.mtimeNs}];
  }));

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-readonly-'));
  work = fs.mkdtempSync(path.join(scratch, 'work-'));
  fs.mkdirSync(path.join(scratch, 'bin'));
  fs.writeFileSync(path.join(scratch, 'bin', 'opencode'), '#!/bin/sh\nsleep 300\n', {mode: 0o755});
  fake = await startFakeOpencode(path.join(scratch, 'bin', 'opencode'), work, ['--session', CONVERSATION]);
});

after(() => {
  fake?.kill('SIGKILL');
  fs.rmSync(scratch, {recursive: true, force: true});
});

describe('OpenCode store is read, never written', () => {
  test('an existing store is unchanged, opened read-only, and only session, message and part are read', () => {
    const data = path.join(scratch, 'data-present');
    fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
    const db = createStore(path.join(data, 'opencode', 'opencode.db'));
    db.prepare('INSERT INTO credential VALUES (?, ?)').run('c1', 'SECRET-PROVIDER-KEY');
    addConversation(db, CONVERSATION, work, {open: true, updated: Date.now() - 1000});
    db.close();
    const before = snapshot(data);
    const seen = observe(fake.pid!, data);
    assert.equal(seen.info.session_id, CONVERSATION, 'the store was read');
    assert.deepEqual(snapshot(data), before, 'no file created or changed: same names, sizes and mtimes');
    assert.ok(seen.uris.length > 0 && seen.uris.every(uri => /[?&]mode=ro(&|$)/.test(uri)), `read-only URIs: ${seen.uris}`);
    assert.deepEqual(seen.refused, [], 'nothing but reads was attempted');
    assert.deepEqual(seen.reads, ['message', 'part', 'session'], 'never account, credential or any other table');
  });

  test('a missing store is not created, nor its directory', () => {
    const data = path.join(scratch, 'data-absent');
    fs.mkdirSync(data);
    const seen = observe(fake.pid!, data);
    assert.equal((seen.info as {type: string}).type, 'opencode');
    assert.equal((seen.info as {session_id?: string}).session_id, undefined);
    assert.deepEqual(fs.readdirSync(data), [], 'nothing was created in the data home');
    assert.ok(seen.uris.every(uri => /[?&]mode=ro(&|$)/.test(uri)), `read-only URIs: ${seen.uris}`);
  });
});
