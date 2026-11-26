// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Without the board bridge (`mesh-board-mcp`) a Claude session has no `mail.inbox` tool, so a wake on its
// socket could never be confirmed and would stay "unconfirmed" for ever: the session is launched without a
// socket and keeps the typed notice. A real server, a real PTY host and a fake Claude.
// Nothing in this file writes outside its own scratch directories.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {hostArgv, installFakeClaude, fakeAgentShell, MANAGED} from './claude-wake-lib.ts';
import {REPO, runServer, scratchHome, stopServer} from './mesh-server-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

const hosts: ChildProcess[] = [];
const servers: ChildProcess[] = [];
const scratches: string[] = [];

after(async () => {
  for (const host of hosts) host.kill('SIGKILL');
  for (const server of servers) await stopServer(server);
  for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true});
});

async function launched(bridge: boolean): Promise<string[]> {
  const {bin, PATH} = installFakeClaude();
  scratches.push(bin);
  // MESH_BIN_DIR is authoritative: an empty directory is an installation without the bridge.
  const binDir = bridge ? bin : fs.mkdtempSync(path.join(os.tmpdir(), 'skw-nobridge-'));
  scratches.push(binDir);
  const where = await scratchHome('skw-bridge-', {PATH, MESH_BIN_DIR: binDir});
  scratches.push(where.scratch);
  const run = await runServer(where);
  assert.equal(run.result.listened, true, run.result.output);
  servers.push(run.child);
  const hostSocket = path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock');
  hosts.push(spawn(hostArgv()[0], hostArgv().slice(1), {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: where.home, XDG_RUNTIME_DIR: path.join(where.home, 'run'), LANG: 'C', SHELL: fakeAgentShell(bin)}}));
  await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));
  const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
  const cwd = path.join(where.home, 'agent');
  fs.mkdirSync(cwd);
  const response = await fetch(`http://127.0.0.1:${where.port}/api/new`, {method: 'POST',
    headers: {Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${where.port}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({preset: 'claude', cwd, name: 'agent'})});
  assert.equal(response.status, 200, await response.clone().text());
  await waitFor('fake claude', 20000, () => fs.existsSync(path.join(cwd, 'argv.json')));
  return JSON.parse(fs.readFileSync(path.join(cwd, 'argv.json'), 'utf8')) as string[];
}

describe('the socket needs the board bridge', {skip: MANAGED.length > 0 && `managed Claude settings at ${MANAGED[0]}`}, () => {
  test('control: with the bridge installed the session gets a socket', async () => {
    assert.ok((await launched(true)).includes('--messaging-socket-path'));
  });

  test('without the bridge the session gets no socket and keeps the typed notice', async () => {
    assert.equal((await launched(false)).includes('--messaging-socket-path'), false);
  });
});
