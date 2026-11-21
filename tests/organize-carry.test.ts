// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// organize.carry: a session that continues another incarnation (its agent restarted in the same terminal, so a new
// `created`, or a replacement session) gets that incarnation's label, folder and rank in mesh.json. The end-to-end
// cases are in rename-persistence.test.ts; these pin each rule on the file, under a throwaway configuration folder.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';

type MeshJson = {folders: string[]; order: string[];
  sessions: Record<string, {created: number; label?: string; folder?: string | null; bound_at?: number}>};

const OLD = 100.5;
const NEW = 200.25;

/** Run `organize.<call>(*args)` on mesh.json `before`: [its result, mesh.json after, the file's mode, the
 * conversation names it recorded (conversation-names.json, [] when none)]. */
function organize(before: MeshJson, call: string, args: unknown[]): [unknown, MeshJson, number, {created: number; label: string}[]] {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'organize-carry-'));
  try {
    const file = path.join(conf, 'mesh.json');
    fs.writeFileSync(file, JSON.stringify(before), {mode: 0o600});
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import sys, json; sys.path.insert(0, ${JSON.stringify(REPO)})\nimport organize\n`
      + `print(json.dumps(organize.${call}(*json.loads(sys.argv[1]))))`, JSON.stringify(args)],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf}, encoding: 'utf8'});
    const names = path.join(conf, 'conversation-names.json');
    return [JSON.parse(output), JSON.parse(fs.readFileSync(file, 'utf8')), fs.statSync(file).mode & 0o777,
      fs.existsSync(names) ? JSON.parse(fs.readFileSync(names, 'utf8')) : []];
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

/** mesh.json after `organize.carry(source, target, saved)` ran on `before`, without the time an entry was bound at
 * (checked: the time of the carry); the file's mode too. */
function carried(before: MeshJson, source: [string, number], target: [string, number], saved: unknown): [MeshJson, number] {
  const start = Date.now() / 1000;
  const [, after, mode] = organize(before, 'carry', [source, target, saved]);
  for (const entry of Object.values(after.sessions)) {
    if (entry.bound_at === undefined) continue;
    assert.ok(entry.bound_at >= start - 1 && entry.bound_at <= Date.now() / 1000 + 1, 'bound at the carry');
    delete entry.bound_at;
  }
  return [after, mode];
}

const arranged = (): MeshJson => ({folders: ['Projects'], order: ['first', 'work', 'last'],
  sessions: {first: {created: 1}, work: {created: OLD, label: 'Chosen name', folder: 'Projects'}, last: {created: 2}}});

test('a new incarnation of the same session takes its label, folder and place in the order', () => {
  const [after, mode] = carried(arranged(), ['work', OLD], ['work', NEW], null);
  assert.deepEqual(after.sessions.work, {created: NEW, label: 'Chosen name', folder: 'Projects'});
  assert.deepEqual(after.order, ['first', 'work', 'last']);
  assert.equal(mode, 0o600, 'written as the other organisation files: private');
  const [, raw] = organize(arranged(), 'carry', [['work', OLD], ['work', NEW], null]);
  assert.equal(typeof raw.sessions.work!.bound_at, 'number', 'when it was bound: a listing read before cannot judge it');
});

test('a replacement session under another name takes the place of the one it replaces', () => {
  const [after] = carried(arranged(), ['work', OLD], ['work-2', NEW], null);
  assert.deepEqual(after.sessions['work-2'], {created: NEW, label: 'Chosen name', folder: 'Projects'});
  assert.deepEqual(after.order, ['first', 'work-2', 'last']);
});

test('an entry a listing already pruned comes back from what was read before the restart', () => {
  const pruned = {folders: ['Projects'], order: ['first', 'last'], sessions: {first: {created: 1}, last: {created: 2}}};
  const [after] = carried(pruned, ['work', OLD], ['work', NEW], {label: 'Chosen name', folder: 'Projects', rank: 1});
  assert.deepEqual(after.sessions.work, {created: NEW, label: 'Chosen name', folder: 'Projects'});
  assert.deepEqual(after.order, ['first', 'work', 'last']);
});

test('an arrangement already bound to the new incarnation is the latest word and stays', () => {
  const renamedSince = arranged();
  renamedSince.sessions.work = {created: NEW, label: 'Renamed since', folder: null};
  const [after] = carried(renamedSince, ['work', OLD], ['work', NEW], {label: 'Chosen name', folder: 'Projects', rank: 1});
  assert.deepEqual(after.sessions.work, {created: NEW, label: 'Renamed since', folder: null});
});

test('the entry of another, earlier incarnation is not carried', () => {
  const stale = arranged();
  stale.sessions.work!.created = 50;
  const [after] = carried(stale, ['work', OLD], ['work', NEW], null);
  assert.deepEqual(after, stale, 'nothing to carry: the file is unchanged');
});

test('a saved name is cleaned by the rename rules and a folder that is gone is not recreated', () => {
  const hostile = `\u001b[31m Bad‮\n name ${'x'.repeat(100)}`;
  const [after] = carried({folders: [], order: [], sessions: {}}, ['work', OLD], ['work', NEW],
    {label: hostile, folder: 'Gone', rank: 7});
  const label = after.sessions.work!.label!;
  assert.equal(label.length, 60, 'capped at the rename length');
  assert.match(label, /^\[31m Bad name x+$/, 'no control or bidi character');
  assert.equal(after.sessions.work!.folder, null);
  assert.deepEqual(after.order, ['work'], 'a rank past the end ranks it last');
  assert.deepEqual(after.folders, []);
});

test('what is read before a restart: the arrangement bound to that very incarnation, none for another one', () => {
  assert.deepEqual(organize(arranged(), 'arrangement', ['work', OLD])[0], {label: 'Chosen name', folder: 'Projects', rank: 1});
  assert.equal(organize(arranged(), 'arrangement', ['work', NEW])[0], null);
  assert.equal(organize(arranged(), 'arrangement', ['other', OLD])[0], null);
});

test('a stale place of the replacement name does not shift the place it takes', () => {
  const stale = arranged();
  stale.order.unshift('work-2');
  stale.sessions['work-2'] = {created: 5, label: 'Someone before'};
  const [after] = carried(stale, ['work', OLD], ['work-2', NEW], null);
  assert.deepEqual(after.order, ['first', 'work-2', 'last']);
  assert.equal(after.sessions['work-2']!.label, 'Chosen name');
});

test('a listing read before the restart keeps the arrangement carried to the next incarnation', () => {
  const carriedAlready = arranged();
  carriedAlready.sessions.work!.created = NEW;
  const [shown, after] = organize(carriedAlready, 'view', [[{name: 'work', created: OLD}, {name: 'first', created: 1},
    {name: 'last', created: 2}], true]);
  assert.equal((shown as {sessions: Record<string, {label: string}>}).sessions.work!.label, 'Chosen name');
  assert.deepEqual(after.sessions.work, {created: NEW, label: 'Chosen name', folder: 'Projects'});
  assert.deepEqual(after.order, ['first', 'work', 'last']);
});

test('a listing of unknown read time keeps a replacement bound in the last 30 seconds only', () => {
  const now = Date.now() / 1000;
  for (const [boundAt, kept] of [[now - 5, true], [now - 60, false]] as const) {
    const replaced = arranged();
    replaced.sessions['work-2'] = {created: NEW, label: 'Chosen name', bound_at: boundAt};
    const [, after] = organize(replaced, 'view', [[{name: 'first', created: 1}], true]);
    assert.equal(after.sessions['work-2'] !== undefined, kept, `bound ${Math.round(now - boundAt)} s ago`);
  }
});

test('a listing read before a carry keeps a replacement it does not show; one read after it does not', () => {
  const replaced = arranged();
  replaced.sessions['work-2'] = {created: NEW, label: 'Chosen name', folder: 'Projects', bound_at: 1000};
  replaced.order.push('work-2');
  const listing = [{name: 'first', created: 1}, {name: 'last', created: 2}];
  for (const [readAt, kept] of [[999, true], [1001, false]] as const) {
    const [, after] = organize(replaced, 'view', [listing, true, readAt]);
    assert.equal(after.sessions['work-2'] !== undefined, kept, `read at ${readAt}`);
    assert.equal(after.order.includes('work-2'), kept, `read at ${readAt}`);
    assert.equal(after.sessions.work, undefined, 'an entry bound before the read is judged as before');
  }
});

test('a listing that shows a later incarnation of the name forgets a recently carried entry', () => {
  const carriedRecently = arranged();
  carriedRecently.sessions.work = {created: NEW, label: 'Chosen name', bound_at: Date.now() / 1000};
  const [, after] = organize(carriedRecently, 'view', [[{name: 'work', created: NEW + 100}], true]);
  assert.equal(after.sessions.work, undefined, 'the name now belongs to another session');
});

test('a rename read against the incarnation before the carry changes the carried entry', () => {
  const carriedAlready = arranged();
  carriedAlready.sessions.work!.created = NEW;
  const live = [{name: 'first', created: 1}, {name: 'work', created: OLD}, {name: 'last', created: 2}];
  const [, after, , names] = organize(carriedAlready, 'apply', [{op: 'rename', id: 'work', label: 'Renamed'}, live]);
  assert.deepEqual(after.sessions.work, {created: NEW, label: 'Renamed', folder: 'Projects'});
  assert.deepEqual(after.order, ['first', 'work', 'last']);
  assert.deepEqual(names.map(entry => [entry.created, entry.label]), [[NEW, 'Renamed']],
    'the conversation name is recorded for the incarnation the session is in now');
});

test('a listing of a later incarnation, or without the session, still forgets an earlier entry', () => {
  for (const listing of [[{name: 'work', created: NEW}], []]) {
    const [, after] = organize(arranged(), 'view', [[{name: 'first', created: 1}, {name: 'last', created: 2}, ...listing], true]);
    assert.equal(after.sessions.work, undefined, JSON.stringify(listing));
    assert.deepEqual(after.order, ['first', 'last']);
  }
});
