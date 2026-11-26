// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The two Codex presets of "New session": "codex" keeps Codex's own approvals, "codex-yolo" is the
// explicit no-approvals choice. Both launch the agent "codex", so the mesh treats them alike
// (known_agent, resume, restore). A fake `codex` on PATH records the argv it was started with.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {fakeAgentShell} from './helpers/fake-agent.ts';

let mesh: Mesh;
let argvLog: string;
let host: ChildProcess | undefined;
const seen = new Set<string>();

before(async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
  argvLog = path.join(bin, 'argv.log');
  fs.writeFileSync(path.join(bin, 'codex'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec sleep 20\n`, {mode: 0o755});
  const path_ = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('codex-presets-', {PATH: path_});
  // the server needs a PTY host in the same home; it runs the sessions the fake Codex records
  const [hostCommand, ...hostArguments] = ptyhostArgv();
  host = spawn(hostCommand, hostArguments, {
    cwd: REPO, stdio: 'ignore',
    env: {PATH: path_, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: fakeAgentShell(bin)}});
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (argvLog) fs.rmSync(path.dirname(argvLog), {recursive: true, force: true});
});

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});

/** Start a session from a preset and return the argv the fake Codex recorded for it. */
async function launch(preset: string, name: string): Promise<string> {
  const response = await fetch(`${mesh.base}/api/new`, {
    method: 'POST', headers: headers(), body: JSON.stringify({preset, cwd: mesh.home, name})});
  assert.equal(response.status, 200, await response.clone().text());
  // The PTY host may wait up to ten seconds for the shell to become quiet
  // before sending the launch command. Allow time for the command to start
  // after that documented wait, especially on a busy machine.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const lines = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean) : [];
    const line = lines.find(item => !seen.has(item));
    if (line) { seen.add(line); return line; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`fake codex never started for ${preset}`);
}

async function knownAgent(name: string): Promise<string | null> {
  const response = await fetch(`${mesh.base}/api/sessions`, {headers: headers()});
  const data = await response.json() as {mesh: {id: string; known_agent: string | null}[]};
  return data.mesh.find(item => item.id === name)?.known_agent ?? null;
}

describe('Codex presets', () => {
  test('the default Codex preset keeps Codex approvals: no --yolo', async () => {
    const argv = await launch('codex', 'safe');
    assert.doesNotMatch(argv, /--yolo|dangerously-bypass/);
    assert.equal(await knownAgent('safe'), 'codex');
  });

  test('the no-approvals preset passes --yolo and is still the agent codex', async () => {
    const argv = await launch('codex-yolo', 'risky');
    assert.match(argv, /(^|\s)--yolo(\s|$)/);
    assert.equal(await knownAgent('risky'), 'codex');
  });

  test('an unknown preset is refused', async () => {
    const response = await fetch(`${mesh.base}/api/new`, {
      method: 'POST', headers: headers(), body: JSON.stringify({preset: 'codex-other', cwd: mesh.home})});
    assert.equal(response.status, 400);
  });
});
