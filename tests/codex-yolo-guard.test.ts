// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "codex" and "codex-yolo" are separate launch presets of the same agent:
// - launch settings enable each one separately, both for the owner's /api/new and for the
//   session requests agents make;
// - an agent can never request a "codex-yolo" session (no approvals, no sandbox): only the owner
//   starts one;
// - the owner's confirmation dialog names a preset by its form label, not its internal id.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {REPO, runServer, scratchHome, stopServer} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {waitFor} from './ptyhost-wire-lib.ts';
import {createSessionRequestGate, setTranslator} from '../static/pane-actions.ts';

type Running = {output: () => string; base: string; home: string; scratch: string; server: ChildProcess; host: ChildProcess; token: () => string};
const running: Running[] = [];
const bins: string[] = [];

after(async () => {
  for (const mesh of running) {
    mesh.host.kill('SIGKILL');
    await stopServer(mesh.server);
    fs.rmSync(mesh.scratch, {recursive: true, force: true});
  }
  for (const bin of bins) fs.rmSync(bin, {recursive: true, force: true});
});

/** A mesh whose launch settings enable only `enabled`, with a fake `codex` that records its token. */
async function meshWith(enabled: string[]): Promise<Running> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-guard-'));
  bins.push(bin);
  fs.writeFileSync(path.join(bin, 'codex'),
    '#!/bin/sh\nprintf "%s" "$MESH_SESSION_TOKEN" > ./token.tmp && mv ./token.tmp ./token\nexec sleep 60\n', {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  const where = await scratchHome('codex-guard-', {PATH});
  const settings = path.join(where.scratch, 'launch-settings.json');
  fs.writeFileSync(settings, JSON.stringify({v: 1, workspace_roots: [where.home], enabled_agents: enabled}));
  where.env.MESH_LAUNCH_SETTINGS = settings;
  const {child, result, output} = await runServer(where);
  assert.equal(result.listened, true, result.output);
  const [hostCommand, ...hostArguments] = ptyhostArgv();
  const host = spawn(hostCommand, hostArguments, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: where.home, XDG_RUNTIME_DIR: path.join(where.home, 'run'), LANG: 'C'}});
  await waitFor('ptyhost socket', 10000, () => fs.existsSync(path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock')));
  const mesh = {output, base: `http://127.0.0.1:${where.port}`, home: where.home, scratch: where.scratch, server: child, host,
    token: () => fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim()};
  running.push(mesh);
  return mesh;
}

const owner = (mesh: Running) => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});

async function create(mesh: Running, preset: string, name: string): Promise<Response> {
  const cwd = path.join(mesh.home, name);
  fs.mkdirSync(cwd, {recursive: true});
  return await fetch(`${mesh.base}/api/new`, {method: 'POST', headers: owner(mesh), body: JSON.stringify({preset, cwd, name})});
}

/** Start an agent session and return its session token once the fake Codex wrote it. */
async function agentToken(mesh: Running, preset: string, name: string): Promise<string> {
  const response = await create(mesh, preset, name);
  assert.equal(response.status, 200, await response.text());
  const file = path.join(mesh.home, name, 'token');
  await waitFor(`fake codex ${name}`, 15000, () => fs.existsSync(file));
  return fs.readFileSync(file, 'utf8').trim();
}

async function knownAgent(mesh: Running, name: string): Promise<string | null> {
  const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: owner(mesh)})).json() as {mesh: {id: string; known_agent: string | null}[]};
  return data.mesh.find(item => item.id === name)?.known_agent ?? null;
}

async function requestCreate(mesh: Running, token: string, preset: unknown): Promise<{status: number; text: string}> {
  const response = await fetch(`${mesh.base}/api/session-actions/@self/request`, {method: 'POST',
    headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'create', preset})});
  return {status: response.status, text: await response.text()};
}

describe('launch settings enable codex and codex-yolo separately', () => {
  test('["codex"]: codex-yolo is refused to the owner and to agents', async () => {
    const mesh = await meshWith(['codex']);
    const refused = await create(mesh, 'codex-yolo', 'refused');
    assert.equal(refused.status, 400, await refused.clone().text());
    const token = await agentToken(mesh, 'codex', 'requester');
    assert.equal(await knownAgent(mesh, 'requester'), 'codex');
    const yolo = await requestCreate(mesh, token, 'codex-yolo');
    assert.equal(yolo.status, 400, `${yolo.text}\n${mesh.output().slice(-3000)}`);
    assert.match(yolo.text, /cannot request a codex-yolo session/);
    // A preset that is not a string is a bad request, not a server error.
    for (const odd of [['codex-yolo'], {codex: true}, 7]) {
      const malformed = await requestCreate(mesh, token, odd);
      assert.equal(malformed.status, 400, `${JSON.stringify(odd)}: ${malformed.text}`);
      assert.match(malformed.text, /Unknown or disabled agent preset/);
    }
    assert.equal((await requestCreate(mesh, token, 'codex')).status, 202);
  });

  test('["codex-yolo"]: codex is refused; codex-yolo starts the agent codex but agents cannot request it', async () => {
    const mesh = await meshWith(['codex-yolo']);
    const refused = await create(mesh, 'codex', 'refused');
    assert.equal(refused.status, 400, await refused.clone().text());
    const token = await agentToken(mesh, 'codex-yolo', 'unconfined');
    assert.equal(await knownAgent(mesh, 'unconfined'), 'codex');
    const plain = await requestCreate(mesh, token, 'codex');
    assert.equal(plain.status, 400);
    assert.match(plain.text, /Unknown or disabled agent preset/);
    const yolo = await requestCreate(mesh, token, 'codex-yolo');
    assert.equal(yolo.status, 400, `${yolo.text}\n${mesh.output().slice(-3000)}`);
    assert.match(yolo.text, /only the owner can start one/);
  });
});

describe('owner confirmation dialog', () => {
  test('names a preset by its form label', async () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
    setTranslator((key, params = {}) => (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name])));
    const shown: string[] = [];
    const gate = createSessionRequestGate({
      claim: async () => ({kind: 'claimed', claimNonce: 'n'.repeat(32)}),
      confirm: message => { shown.push(message); return false; },
      decide: async () => 'settled',
      notify: () => {},
    });
    await gate.consider([
      {id: 'yolo', action: 'create', state: 'pending', preset: 'codex-yolo', model: null, source: {id: 'agent'}},
      {id: 'plain', action: 'create', state: 'pending', preset: 'codex', model: null, source: {id: 'agent'}},
    ]);
    assert.match(shown[0], /new Codex \(no approvals\) session/);
    assert.doesNotMatch(shown[0], /codex-yolo/);
    assert.match(shown[1], /new codex session/);
  });
});
