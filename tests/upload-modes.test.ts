// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// An uploaded file is private to the owner whatever the umask: server.py stores it under
// <cache>/uploads/<day>/ with both directories 0700 and the file 0600. The server runs with a
// throwaway HOME and umask 000, the most permissive one, and is driven over HTTP like the browser.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-modes-'));
const home = path.join(scratch, 'home');
const confDir = path.join(home, '.config', 'session-mesh');
const cacheDir = path.join(home, '.cache', 'session-mesh');
let server: ChildProcess | undefined;
let output = '';
let base = '';

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port}, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

const mode = (file: string): string => (fs.statSync(file).mode & 0o7777).toString(8);

before(async () => {
  const port = await freePort();
  const runtime = path.join(home, 'run');
  fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, MESH_RUNTIME_DIR: undefined,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    MESH_CONF_DIR: confDir, MESH_CACHE_DIR: cacheDir, MESH_PORT: String(port)};
  delete env.MESH_HOST;
  delete env.MESH_ALLOW_NON_LOOPBACK;
  server = spawn('/bin/sh', ['-c', 'umask 000; exec "$@"', 'sh', PYTHON, 'server.py'],
    {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
  server.stdout?.on('data', chunk => { output += chunk; });
  server.stderr?.on('data', chunk => { output += chunk; });
  let exited = false;
  server.on('exit', () => { exited = true; });
  for (let attempt = 0; attempt < 200 && !exited; attempt += 1) {
    if (await accepts(port)) { base = `http://127.0.0.1:${port}`; return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`server.py did not listen:\n${output}`);
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = new Promise(resolve => server!.on('close', resolve));
    server.kill('SIGTERM');
    await closed;
  }
  fs.rmSync(scratch, {recursive: true, force: true});
});

describe('uploads are owner-only whatever the umask', () => {
  test('the uploads and day directories are 0700, the file 0600', async () => {
    const token = fs.readFileSync(path.join(confDir, 'token'), 'utf8').trim();
    const response = await fetch(`${base}/api/upload?name=note.txt`, {method: 'POST', body: 'payload',
      headers: {Authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200, output);
    const stored = (await response.json() as {path: string}).path;
    const day = path.dirname(stored);
    assert.equal(path.dirname(day), path.join(cacheDir, 'uploads'));
    assert.equal(fs.readFileSync(stored, 'utf8'), 'payload');
    assert.deepEqual([mode(path.dirname(day)), mode(day), mode(stored)], ['700', '700', '600']);
  });

  test('an existing uploads directory left open is narrowed to 0700 on the next upload', async () => {
    const uploads = path.join(cacheDir, 'uploads');
    fs.chmodSync(uploads, 0o755);
    const token = fs.readFileSync(path.join(confDir, 'token'), 'utf8').trim();
    const response = await fetch(`${base}/api/upload?name=second.txt`, {method: 'POST', body: 'again',
      headers: {Authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200, output);
    assert.equal(mode(uploads), '700');
  });
});
