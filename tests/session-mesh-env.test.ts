// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A terminal session must be handed the port the mesh really serves (and its config directory), so that
// mesh-open, mesh-event and mesh-board-mcp reach this server and not the default one on 7690. This must
// hold with the default config directory too: only MESH_PORT is set, MESH_CONF_DIR is not.
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {ptyhostArgv} from './ptyhost-command.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mesh-env-'));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill('SIGTERM');
  fs.rmSync(scratch, {recursive: true, force: true});
});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A mesh with a throwaway HOME. `relocated` also sets MESH_CONF_DIR; otherwise the default config
// directory under HOME is used.
async function startMesh(relocated: boolean) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const runtime = path.join(home, 'run');
  fs.mkdirSync(runtime, {mode: 0o700});
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, MESH_RUNTIME_DIR: undefined,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    MESH_PORT: String(port)};
  for (const key of ['MESH_CONF_DIR', 'MESH_CACHE_DIR', 'MESH_HOST', 'MESH_SESSION', 'MESH_SESSION_TOKEN']) delete env[key];
  const confDir = path.join(home, '.config', 'session-mesh');
  if (relocated) env.MESH_CONF_DIR = confDir;
  for (const argv of [ptyhostArgv(), [PYTHON, 'server.py']]) {
    children.push(spawn(argv[0], argv.slice(1), {cwd: REPO, env, stdio: 'ignore'}));
  }
  const token = await until('the master token', () =>
    fs.existsSync(path.join(confDir, 'token')) ? fs.readFileSync(path.join(confDir, 'token'), 'utf8').trim() : undefined);
  await until('the server to listen', () => new Promise<true | undefined>(resolve => {
    const socket = net.connect({host: '127.0.0.1', port}, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(undefined));
  }));
  return {home, port, token, confDir};
}

async function sessionEnvironment(mesh: Awaited<ReturnType<typeof startMesh>>) {
  const out = path.join(mesh.home, 'session-env.txt');
  const response = await fetch(`http://127.0.0.1:${mesh.port}/api/new`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${mesh.token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({cwd: mesh.home, preset: 'custom', name: 'envprobe',
      command: `env > ${out}.tmp && mv ${out}.tmp ${out}`}),
  });
  assert.equal(response.status, 200, await response.text());
  const text = await until('the session to write its environment', () =>
    fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : undefined);
  return Object.fromEntries(text.split('\n').filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

describe('a session reaches the mesh that launched it', () => {
  for (const relocated of [false, true]) {
    test(`MESH_PORT and MESH_CONF_DIR, ${relocated ? 'MESH_CONF_DIR set' : 'default config directory'}`, async () => {
      const mesh = await startMesh(relocated);
      assert.notEqual(mesh.port, 7690);
      const env = await sessionEnvironment(mesh);
      assert.equal(env.MESH_PORT, String(mesh.port));
      assert.equal(env.MESH_CONF_DIR, mesh.confDir);
      assert.equal(env.MESH_SESSION, 'envprobe');
    });
  }
});
