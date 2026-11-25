// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {REPO} from './mesh-server-lib.ts';

const helper = process.env.MESH_MESH_HISTORY_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const skip = fs.existsSync(helper) ? false : `flow helper not built: ${helper}`;
const identity = (id: string, created: number) => ({id, created, agent: 'claude'});
const event = (id: string, kind = 'message') => ({id, kind, time: 100, source: identity('alpha', 1),
  target: identity('beta', 2)});
function invoke(dir: string, mode: string, input = '') {
  return spawnSync(helper, [`--flow-${mode}`], {input, encoding: 'utf8',
    env: {MESH_CONF_DIR: dir, PATH: process.env.PATH}});
}

describe('flow journal helper', {skip}, () => {
  test('retains bounded metadata, including session incarnations, and rejects bodies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-flow-'));
    try {
      const old = Array.from({length: 1024}, (_, i) => event(`id${i}`));
      fs.writeFileSync(path.join(dir, 'flow-events.json'), JSON.stringify({events: old, truncated: false}), {mode: 0o600});
      assert.equal(invoke(dir, 'write', JSON.stringify(event('new', 'create'))).status, 0);
      const result = invoke(dir, 'read');
      assert.equal(result.status, 0, result.stderr);
      const state = JSON.parse(result.stdout);
      assert.equal(state.truncated, true);
      assert.equal(state.events.length, 1024);
      assert.equal(state.events[0].id, 'id1');
      assert.deepEqual(state.events.at(-1), event('new', 'create'));
      assert.notEqual(invoke(dir, 'write', JSON.stringify({...event('bad'), text: 'secret'})).status, 0);
      assert.doesNotMatch(fs.readFileSync(path.join(dir, 'flow-events.json'), 'utf8'), /secret/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });

  test('refuses a symlink journal without changing its target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-flow-link-'));
    try {
      const target = path.join(dir, 'target');
      fs.writeFileSync(target, 'untouched', {mode: 0o600});
      fs.symlinkSync(target, path.join(dir, 'flow-events.json'));
      assert.notEqual(invoke(dir, 'write', JSON.stringify(event('one'))).status, 0);
      assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });

  test('refuses a FIFO in place of its lock without waiting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-flow-fifo-'));
    try {
      const made = spawnSync('mkfifo', [path.join(dir, 'flow-events.lock')], {encoding: 'utf8'});
      assert.equal(made.status, 0, made.stderr);
      const result = spawnSync(helper, ['--flow-read'], {timeout: 2000, encoding: 'utf8',
        env: {MESH_CONF_DIR: dir, PATH: process.env.PATH}});
      assert.notEqual(result.status, 0);
      assert.notEqual((result.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT',
        'unsafe lock must not block');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });

  test('concurrent writers preserve every distinct event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-flow-race-'));
    try {
      await Promise.all(Array.from({length: 24}, (_, i) => new Promise<void>((resolve, reject) => {
        const proc = spawn(helper, ['--flow-write'], {env: {MESH_CONF_DIR: dir, PATH: process.env.PATH}});
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
        proc.stdin.end(JSON.stringify(event(`race${i}`)));
      })));
      const output = invoke(dir, 'read');
      assert.equal(output.status, 0, output.stderr);
      const state = JSON.parse(output.stdout);
      assert.equal(state.events.length, 24);
      assert.equal(new Set(state.events.map((item: {id: string}) => item.id)).size, 24);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
});

describe('owner flow endpoint', {skip}, () => {
  let lab: AgentMesh;
  before(async () => {
    process.env.MESH_MESH_HISTORY_CMD = helper;
    lab = await AgentMesh.start('flow-', ['alpha', 'beta']);
  });
  after(async () => { await lab?.stop(); });

  test('owner-only projections survive acknowledgement without the message text', async () => {
    const alpha = lab.agents.alpha!, beta = lab.agents.beta!;
    const url = `${lab.mesh.base}/api/flow/events`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, {headers: {Authorization: `Bearer ${lab.mesh.token()}`}})).status, 401);
    assert.equal((await fetch(url, {headers: lab.agentHeaders(alpha)})).status, 401);
    assert.equal((await fetch(url, {headers: {Cookie: lab.cookie, Authorization: `Bearer ${lab.mesh.token()}`}})).status, 401);
    const secret = 'never-store-this-message-body';
    await lab.send(alpha, beta, secret);
    const [messageId] = await lab.inbox(beta);
    const ack = await fetch(`${lab.mesh.base}/api/agent-mail/@self/ack`, {method: 'POST',
      headers: lab.agentHeaders(beta), body: JSON.stringify({message_ids: [messageId]})});
    assert.equal(ack.status, 200, await ack.text());
    const response = await fetch(url, {headers: {Cookie: lab.cookie}});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await response.text();
    assert.doesNotMatch(raw, /never-store-this-message-body/);
    const state = JSON.parse(raw);
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.events[0].source, identity('alpha', alpha.created));
    assert.deepEqual(state.events[0].target, identity('beta', beta.created));
    assert.equal(state.events[0].id, messageId);
    assert.equal((await fetch(`${url}?x=1`, {headers: {Cookie: lab.cookie}})).status, 400);
  });

  test('a refused consent leaves the accepted deposit as metadata, without revealing its body', async () => {
    const alpha = lab.agents.alpha!, beta = lab.agents.beta!;
    const secret = 'refused-consent-private-message';
    const url = `${lab.mesh.base}/api/flow/events`;
    await lab.send(alpha, beta, secret);
    const [messageId] = await lab.inbox(beta);
    assert.ok(messageId);
    const before = await fetch(url, {headers: {Cookie: lab.cookie}});
    assert.equal(before.status, 200);
    const beforeText = await before.text();
    assert.doesNotMatch(beforeText, /refused-consent-private-message/);
    const beforeEvent = (JSON.parse(beforeText) as {events: Array<{id: string; kind: string}>}).events
      .find(event => event.id === messageId);
    assert.ok(beforeEvent, 'the accepted deposit is visible while consent is pending');
    assert.equal(beforeEvent.kind, 'message');
    const consent = (await lab.consent()).requests.find(item => item.message_id === messageId);
    assert.ok(consent, 'the deposit awaits owner consent');
    const pending = await lab.readAs(beta, messageId);
    assert.equal(pending.status, 202);
    assert.doesNotMatch(await pending.text(), /refused-consent-private-message/);
    const refused = await lab.decide(consent.id, 'no');
    assert.equal(refused.status, 200, await refused.clone().text());
    assert.equal((await lab.readAs(beta, messageId)).status, 404, 'refusal removes the unread message');
    const after = await fetch(url, {headers: {Cookie: lab.cookie}});
    assert.equal(after.status, 200);
    const afterText = await after.text();
    assert.doesNotMatch(afterText, /refused-consent-private-message/);
    const afterEvent = (JSON.parse(afterText) as {events: Array<{id: string}>}).events
      .find(event => event.id === messageId);
    assert.deepEqual(afterEvent, beforeEvent, 'the event records the accepted deposit, not consent or delivery');
  });

  test('approved session creation records the actual new incarnation', async () => {
    const alpha = lab.agents.alpha!;
    const made = await fetch(`${lab.mesh.base}/api/session-actions/@self/request`, {method: 'POST',
      headers: lab.agentHeaders(alpha), body: JSON.stringify({action: 'create', preset: 'claude', name: 'gamma'})});
    assert.equal(made.status, 202, await made.clone().text());
    const {request} = await made.json() as {request: {id: string}};
    const claimed = await fetch(`${lab.mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST',
      headers: lab.ownerJson(), body: JSON.stringify({tab_nonce: 'a'.repeat(32)})});
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const {claim_nonce} = await claimed.json() as {claim_nonce: string};
    const decided = await fetch(`${lab.mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST',
      headers: lab.ownerJson(), body: JSON.stringify({approve: true, claim_nonce})});
    assert.equal(decided.status, 200, await decided.clone().text());
    const outcome = await decided.json() as {request: {result: {id?: string; error?: string}}};
    assert.ok(outcome.request.result.id, JSON.stringify(outcome));
    const response = await fetch(`${lab.mesh.base}/api/flow/events`, {headers: {Cookie: lab.cookie}});
    const state = await response.json() as {events: Array<{id: string; kind: string; time: number; source: {id: string};
      target: {id: string; created: number; agent: string}}>};
    const create = state.events.find(item => item.id === request.id);
    assert.ok(create, `${JSON.stringify(state)} ${lab.mesh.output()}`);
    assert.equal(create.kind, 'create');
    assert.equal(create.source.id, 'alpha');
    assert.equal(create.target.id, 'gamma');
    assert.ok(create.target.created > 0);
    assert.equal(create.target.agent, 'claude');
    assert.equal(create.time, create.target.created, 'creation uses the PTY incarnation timestamp');
    await lab.send(alpha, {name: 'gamma', created: create.target.created, dir: '', token: ''}, 'immediate message');
    const later = await (await fetch(`${lab.mesh.base}/api/flow/events`, {headers: {Cookie: lab.cookie}})).json() as
      {events: Array<{kind: string; time: number; target: {id: string}}>};
    const sent = later.events.find(item => item.kind === 'message' && item.target.id === 'gamma');
    assert.ok(sent);
    assert.ok(create.time <= sent.time, 'a message sent immediately after creation follows it on the timeline');
  });

  test('a short-lived session never gets an invented incarnation', async () => {
    const alpha = lab.agents.alpha!;
    const fakeBin = (lab as unknown as {scratches: string[]}).scratches[0]!;
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    const before = Date.now() / 1000;
    const made = await fetch(`${lab.mesh.base}/api/session-actions/@self/request`, {method: 'POST',
      headers: lab.agentHeaders(alpha), body: JSON.stringify({action: 'create', preset: 'claude', name: 'brief'})});
    assert.equal(made.status, 202, await made.clone().text());
    const {request} = await made.json() as {request: {id: string}};
    const claimed = await fetch(`${lab.mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST',
      headers: lab.ownerJson(), body: JSON.stringify({tab_nonce: 'b'.repeat(32)})});
    const {claim_nonce} = await claimed.json() as {claim_nonce: string};
    const decided = await fetch(`${lab.mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST',
      headers: lab.ownerJson(), body: JSON.stringify({approve: true, claim_nonce})});
    assert.equal(decided.status, 200, await decided.clone().text());
    const after = Date.now() / 1000;
    const state = await (await fetch(`${lab.mesh.base}/api/flow/events`, {headers: {Cookie: lab.cookie}})).json() as
      {events: Array<{id: string; target: {id: string; created: number; agent: string}}>};
    const recorded = state.events.find(item => item.id === request.id);
    if (recorded) {
      assert.equal(recorded.target.id, 'brief');
      assert.equal(recorded.target.agent, 'claude');
      assert.ok(recorded.target.created >= before && recorded.target.created <= after);
    }
  });

  test('a journal failure does not turn an accepted message into a failed send', async () => {
    const filename = path.join(lab.mesh.confDir, 'flow-events.json');
    fs.rmSync(filename);
    fs.symlinkSync('/dev/null', filename);
    const alpha = lab.agents.alpha!, beta = lab.agents.beta!;
    await lab.send(alpha, beta, 'accepted despite journal failure');
    assert.equal((await lab.inbox(beta)).length, 1);
    assert.equal((await fetch(`${lab.mesh.base}/api/flow/events`, {headers: {Cookie: lab.cookie}})).status, 503);
  });
});
