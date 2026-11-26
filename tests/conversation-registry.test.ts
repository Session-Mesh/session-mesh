// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {SIDS, withHistoryLab} from './history-resume-name-lib.ts';
import {REPO} from './mesh-server-lib.ts';

type Binding = {name: string; created: number; seen: number; label: string; aliases: string[];
  agent: string | null; sid: string | null; closed_at: number | null};
const file = 'conversation-names.json';
const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');

test('the registry helper accepts exactly one frame within its byte limit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-conversation-frame-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const request = '{"version":1,"op":"snapshot"}';
  const limit = 32 * 1024 * 1024;
  const frame = request.padEnd(limit - 1) + '\n';
  const run = (input: string) => spawnSync(helper, ['--conversation-names'], {
    encoding: 'utf8', env: {MESH_CONF_DIR: dir}, input, timeout: 10000,
  });
  const accepted = run(frame);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), {version: 1, result: []});
  for (const malformed of [frame.slice(0, -1) + ' \n', request, request + '\n\n']) {
    const rejected = run(malformed);
    assert.equal(rejected.status, 64, rejected.stderr);
    assert.equal(rejected.stdout, '');
  }
});

test('reused names, switched conversations and aggregate aliases survive separate helper invocations', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-conversation-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const registry = path.join(dir, file);
  let now = 100;
  function request(op: string, fields: object = {}) {
    const reply = JSON.parse(execFileSync(helper, ['--conversation-names'], {encoding: 'utf8',
      env: {MESH_CONF_DIR: dir}, input: JSON.stringify({version: 1, op, clock_now: now++, ...fields}) + '\n'}));
    assert.deepEqual(Object.keys(reply).sort(), ['result', 'version']);
    assert.equal(reply.version, 1);
    return reply.result;
  }
  const session = (created: number, sid: string | null, label = '', source = 'open_rollout') =>
    ({name: 'audit', created, label, agent: {type: 'codex', session_id: sid, identity_source: source}});
  const active = session(1, SIDS.codex, 'Prior');
  request('observe', {sessions: [active]});
  const before = fs.statSync(registry, {bigint: true});
  request('observe', {sessions: [active]});
  assert.equal(fs.statSync(registry, {bigint: true}).mtimeNs, before.mtimeNs);
  request('observe', {listed: false, sessions: []});
  assert.equal(request('snapshot')[0].closed_at, null);
  request('observe', {sessions: [session(1, 'abcdefgh-2222')]});
  request('close', {name: 'audit', created: 1});
  const closed: Binding[] = request('snapshot');
  assert.deepEqual(closed.map(row => row.sid), ['abcdefgh-2222', SIDS.codex]);
  assert.ok(closed[0].closed_at);
  assert.equal(closed[1].closed_at, closed[0].closed_at);

  const guess = session(2, SIDS.codex, '', 'cwd_unique');
  assert.deepEqual(request('observe', {sessions: [guess]}), [['audit']]);
  const fresh = (request('snapshot') as Binding[]).find(row => row.created === 2)!;
  assert.equal(fresh.sid, null);
  assert.equal(fresh.label, '');
  request('observe', {sessions: [session(3, null)]});
  const reused: Binding[] = request('snapshot');
  assert.ok(reused.find(row => row.created === 2)!.closed_at);
  assert.deepEqual(reused.find(row => row.created === 3)!.aliases, ['audit']);

  const aliases = Array.from({length: 50}, (_, i) => 'alias-' + i);
  fs.writeFileSync(registry, JSON.stringify(aliases.map((alias, i) =>
    ({...closed[1], seen: i + 1, aliases: [alias]}))));
  assert.deepEqual(request('enrich', {agent: 'codex', id: SIDS.codex}).mesh_aliases, aliases.slice(-20));
  assert.deepEqual(request('observe', {listed: false, sessions: [active]}), [aliases.slice(-20)]);
});

test('conditional stop captures exact identity before the host answers and History tracks name changes independently', async () => {
  let reject = true;
  let registry = '';
  const beforeKill: Binding[][] = [];
  await withHistoryLab(async lab => {
    const session = await lab.create('claude');
    registry = path.join(lab.where.confDir, file);
    await lab.rename(session.name, 'Prior label');
    const history = async (query = '') => {
      const answer = await lab.call('GET', '/api/history' + query);
      assert.equal(answer.status, 200, answer.text);
      return answer.json;
    };
    const initial = await history();
    const same = await history(`?gen=${initial.gen}&names_gen=${initial.names_gen}`);
    assert.equal(same.unchanged, true);
    assert.equal(same.names_unchanged, true);
    assert.ok(!('mesh_names' in same));
    await lab.rename(session.name, 'Review');
    const changed = await history(`?gen=${initial.gen}&names_gen=${initial.names_gen}`);
    assert.equal(changed.unchanged, true);
    assert.equal(changed.names_unchanged, false);
    assert.notEqual(changed.names_gen, initial.names_gen);
    const lookup = (rows: Binding[]) => rows.find(row => row.sid === SIDS.claude)!;
    assert.equal(lookup(changed.mesh_names).label, 'Review');
    assert.deepEqual(lookup(changed.mesh_names).aliases, [session.name, 'Prior label', 'Review']);
    const wrongAgent = await lab.call('POST', '/api/history/resume', {agent: 'codex', id: SIDS.claude});
    assert.equal(wrongAgent.status, 404, wrongAgent.text);
    assert.equal((await lab.resume('claude')).id, session.name);
    fs.unlinkSync(registry);
    const stop = () => lab.call('POST', '/api/kill/' + session.name, {created: session.created});
    assert.equal((await stop()).status, 409);
    const refused = lookup(JSON.parse(fs.readFileSync(registry, 'utf8')));
    assert.equal(refused.closed_at, null);
    assert.equal(refused.label, 'Review');
    await lab.rename(session.name, 'Final review');
    reject = false;
    assert.equal((await stop()).status, 200);
    assert.deepEqual(beforeKill.map(rows => lookup(rows).closed_at), [null, null]);
    const ended = await history(`?gen=${initial.gen}&names_gen=${changed.names_gen}`);
    assert.equal(ended.unchanged, true);
    const row = lookup(ended.mesh_names);
    assert.ok(row.closed_at);
    assert.deepEqual(row.aliases, [session.name, 'Review', 'Final review']);
    assert.deepEqual(Object.keys(row).sort(), ['agent', 'aliases', 'closed_at', 'created', 'label', 'name', 'seen', 'sid']);
    assert.equal(fs.statSync(registry).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(registry, 'utf8').includes(lab.where.home));
    const detail = await lab.call('GET', '/api/history/claude/' + SIDS.claude);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.mesh_name, session.name);
    assert.equal(detail.json.mesh_label, row.label);
    assert.deepEqual(detail.json.mesh_aliases, row.aliases);
  }, request => {
    if (request.op === 'kill_if') {
      beforeKill.push(JSON.parse(fs.readFileSync(registry, 'utf8')));
      if (reject) return {reply: {ok: false}};
    }
  });
});

test('large rename frames preserve Unicode and legacy timestamps across helper calls', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-registry-wire-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const registry = path.join(dir, file);
  function invoke(request: object) {
    return JSON.parse(execFileSync(helper, ['--conversation-names'], {encoding: 'utf8',
      env: {MESH_CONF_DIR: dir}, input: JSON.stringify({version: 1, ...request}) + '\n'}));
  }
  const prefix = 'é'.repeat(59) + '🍐';
  const created = -315619200;
  assert.deepEqual(invoke({op: 'rename', name: 'audit', created, now: 100.25, old: '',
    new: prefix + 'x'.repeat(16 * 1024 * 1024)}), {version: 1, result: null});
  assert.deepEqual(invoke({op: 'close', name: 'audit', created, now: 101.5}), {version: 1, result: null});
  const rows = JSON.parse(fs.readFileSync(registry, 'utf8'));
  assert.equal(rows[0].label, prefix);
  assert.equal(rows[0].created, created);
  assert.equal(rows[0].closed_at, 101.5);
  assert.deepEqual(invoke({op: 'snapshot', now: 102}), {version: 1, result: rows});
});

test('the server limits identity disclosure and reports incompatible or missing helpers', () =>
  withHistoryLab(async lab => {
    const session = await lab.create('claude');
    const witness = path.join(lab.where.scratch, 'witness.cjs');
    const log = path.join(lab.where.scratch, 'calls');
    // Forward the original frame to the real helper. For close, replace its successful
    // response after the commit so a retry would show up as a second call in the journal.
    fs.writeFileSync(witness, `#!${process.execPath}
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const input = fs.readFileSync(0);
const frame = JSON.parse(input);
const args = process.argv.slice(2);
const entry = {frame, args, cwd: process.cwd(), env: process.env, parent: process.ppid};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const fd = Number(process.env.MESH_CONVERSATION_LIFELINE.split(':')[0]);
const stdio = ['pipe', 'pipe', 'pipe'];
stdio[fd] = fd;
const reply = execFileSync(${JSON.stringify(helper)}, args, {input, stdio, env: process.env});
process.stdout.write(frame.op === 'close' ? '{"version":2,"result":null}\\n' : reply);
`, {mode: 0o700});
    lab.where.env.MESH_MESH_HISTORY_CMD = witness;
    lab.where.env.MESH_SESSION_TOKEN = 'private-server-env';
    await lab.restartServer();
    const kill = await lab.call('POST', '/api/kill/' + session.name, {created: session.created});
    assert.equal(kill.status, 500, kill.text);
    assert.match(lab.serverOutput(), /RuntimeError: incompatible mesh-history conversation-name response/);
    const journal = fs.readFileSync(log, 'utf8');
    const calls = journal.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(entry => entry.frame.op === 'close').length, 1);
    const beforeKill = calls.find(entry => entry.frame.op === 'observe' && entry.frame.project === false);
    assert.ok(beforeKill);
    const row = beforeKill.frame.sessions.find((s: Binding) => s.name === session.name);
    assert.deepEqual(Object.keys(row).sort(), ['agent', 'created', 'label', 'name']);
    assert.deepEqual(row.agent, {type: 'claude', session_id: SIDS.claude, identity_source: 'pid_metadata'});
    const token = fs.readFileSync(path.join(lab.bin, 'token-' + session.name), 'utf8').trim();
    assert.ok(token.length > 0);
    for (const value of [lab.workDir('claude'), token, 'private-server-env']) assert.ok(!journal.includes(value));
    for (const entry of calls) {
      assert.deepEqual(entry.args, ['--conversation-names']);
      assert.equal(entry.cwd, '/');
      const keys = Object.keys(entry.env).filter(key => process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING').sort();
      assert.deepEqual(keys, ['MESH_CONF_DIR', 'MESH_CONVERSATION_LIFELINE', 'PATH']);
      assert.match(entry.env.MESH_CONVERSATION_LIFELINE, /^[0-9]+:-?[0-9]+:-?[0-9]+$/);
    }
    const registry = path.join(lab.where.confDir, file);
    const closed = (JSON.parse(fs.readFileSync(registry, 'utf8')) as Binding[]).find(row => row.sid === SIDS.claude);
    assert.ok(closed?.closed_at);
    const malformed = '[{"name":"incomplete"';
    fs.writeFileSync(registry, malformed);
    const history = await lab.call('GET', '/api/history');
    assert.equal(history.status, 200, history.text);
    assert.deepEqual(history.json.mesh_names, []);
    assert.equal(fs.readFileSync(registry, 'utf8'), malformed);
    // The new explicit override remains authoritative when both are present.
    lab.where.env.MESH_HISTORY_CMD = helper;
    lab.where.env.MESH_MESH_HISTORY_CMD = path.join(lab.where.scratch, 'missing');
    await lab.restartServer();
    assert.equal((await lab.call('GET', '/api/history')).status, 500);
    assert.match(lab.serverOutput(), /RuntimeError: mesh-history with conversation-name support is required/);
  }));
