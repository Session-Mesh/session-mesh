// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A panel shows local files only. A web page (http:// or https://) is never framed inside the
// mesh: the panel loads documents under the mesh's own origin, and a session token must not be
// able to put an arbitrary site, with its forms and dialogs, in the owner's panes. /api/view and
// /api/open refuse such a target with a message that says where to open it instead.
// server.py runs with a throwaway HOME and is driven over HTTP like the browser.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const REFUSAL = 'A web page does not open in a panel; open it in a browser';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'web-page-panel-'));
const home = path.join(scratch, 'home');
const confDir = path.join(home, '.config', 'session-mesh');
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

before(async () => {
  const port = await freePort();
  const runtime = path.join(home, 'run');
  fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, MESH_RUNTIME_DIR: undefined,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    MESH_CONF_DIR: confDir, MESH_CACHE_DIR: path.join(home, '.cache', 'session-mesh'), MESH_PORT: String(port)};
  delete env.MESH_HOST;
  delete env.MESH_ALLOW_NON_LOOPBACK;
  server = spawn(PYTHON, ['server.py'], {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
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

async function post(route: string, body: object): Promise<Response> {
  const token = fs.readFileSync(path.join(confDir, 'token'), 'utf8').trim();
  return fetch(`${base}${route}`, {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}});
}

describe('a web page never opens in a panel', () => {
  for (const target of ['https://example.invalid/page.html', 'http://127.0.0.1:1/x', 'HTTPS://example.invalid/']) {
    test(`/api/view refuses ${target}`, async () => {
      const response = await post('/api/view', {target});
      assert.equal(response.status, 400, output);
      assert.equal(await response.text(), REFUSAL);
    });

    test(`/api/open refuses ${target}`, async () => {
      const response = await post('/api/open', {target, reload: false, watch: false});
      assert.equal(response.status, 400, output);
      assert.equal(await response.text(), REFUSAL);
    });
  }

  test('a local file is still described', async () => {
    const page = path.join(home, 'page.html');
    fs.writeFileSync(page, '<p>local</p>');
    const response = await post('/api/view', {target: page});
    assert.equal(response.status, 200, output);
    const described = await response.json() as {kind: string; target: string};
    assert.deepEqual([described.kind, described.target], ['file', page]);
  });
});
