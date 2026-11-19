// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The diff viewer through the real routes of a running server.py (throwaway HOME, no PTY host:
// /view needs none): a `.diff` or `.patch` file opened with /api/view is rendered by the diff
// page; ?raw=1, a subresource load, a file past the 4 MiB limit or holding a NUL byte get the
// plain text; ?source=1 gets the code viewer; /viewlib/ serves the built bundle.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const LIMIT = 4 * 1024 * 1024;
const DIFF = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-view-route-'));
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

const token = (): string => fs.readFileSync(path.join(confDir, 'token'), 'utf8').trim();

// The signed URL of a file written under the throwaway HOME, as the panel gets it.
async function signed(name: string, content: string | Buffer): Promise<{url: string; keepsScroll: boolean}> {
  const file = path.join(home, name);
  fs.writeFileSync(file, content);
  const response = await fetch(`${base}/api/view`, {
    method: 'POST',
    headers: {'Authorization': `Bearer ${token()}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({target: file}),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const described = await response.json() as {url: string; keeps_scroll: boolean};
  return {url: `${base}${described.url}`, keepsScroll: described.keeps_scroll};
}

// What a frame (or another destination) loading `url` gets: the type and the body.
async function load(url: string, dest = 'iframe'): Promise<{type: string; body: string; csp: string}> {
  const response = await fetch(url, {headers: {'Sec-Fetch-Dest': dest}});
  assert.equal(response.status, 200);
  return {type: (response.headers.get('content-type') ?? '').split(';')[0] ?? '', body: await response.text(),
    csp: response.headers.get('content-security-policy') ?? ''};
}

describe('the diff viewer through the server routes', () => {
  before(async () => {
    const port = await freePort();
    const runtime = path.join(scratch, 'run');
    fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
    fs.mkdirSync(home, {recursive: true});
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      MESH_CONF_DIR: confDir, MESH_CACHE_DIR: path.join(home, '.cache', 'session-mesh'), MESH_PORT: String(port),
      LANG: 'C.UTF-8'};
    server = spawn(PYTHON, ['server.py'], {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
    server.stdout?.on('data', chunk => { output += chunk; });
    server.stderr?.on('data', chunk => { output += chunk; });
    for (let attempt = 0; attempt < 200 && !(await accepts(port)); attempt += 1) {
      if (server.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!(await accepts(port))) throw new Error(`server.py did not start:\n${output}`);
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const closed = new Promise(resolve => server?.on('close', resolve));
      server.kill('SIGTERM');
      await closed;
    }
    fs.rmSync(scratch, {recursive: true, force: true});
  });

  test('.diff and .patch files open in the diff page, under the rendered-Markdown policy', async () => {
    for (const name of ['change.diff', 'change.PATCH']) {
      const {url, keepsScroll} = await signed(name, DIFF);
      assert.equal(keepsScroll, true);
      const page = await load(url);
      assert.equal(page.type, 'text/html', name);
      assert.ok(page.body.includes('MeshDiffView.mount'), name);
      assert.match(page.csp, /^sandbox allow-scripts allow-downloads; /);
      assert.match(page.csp, /script-src 'nonce-[^']+'/);
    }
  });

  test('?raw=1 and a subresource load get the bytes as they are', async () => {
    const {url} = await signed('raw.diff', DIFF);
    assert.deepEqual([(await load(`${url}?raw=1`)).type, (await load(`${url}?raw=1`)).body], ['text/plain', DIFF]);
    assert.notEqual((await load(url, 'script')).type, 'text/html');
  });

  test('?source=1 gets the code viewer, which line targets use', async () => {
    const {url} = await signed('source.diff', DIFF);
    const page = await load(`${url}?source=1`);
    assert.equal(page.type, 'text/html');
    assert.ok(!page.body.includes('MeshDiffView'));
  });

  test('a diff past 4 MiB, or holding a NUL byte, is served whole as plain text', async () => {
    const large = DIFF + '+x\n'.repeat(Math.ceil(LIMIT / 3));
    const big = await load((await signed('big.diff', large)).url);
    assert.deepEqual([big.type, big.body.length], ['text/plain', large.length]);
    const exact = DIFF + 'x'.repeat(LIMIT - DIFF.length);
    assert.equal((await load((await signed('exact.diff', exact)).url)).type, 'text/html');
    const binary = Buffer.from(`${DIFF}\0tail`);
    const nul = await load((await signed('nul.patch', binary)).url);
    assert.deepEqual([nul.type, nul.body.length], ['text/plain', binary.length]);
  });

  test('/viewlib/ serves the built bundle, and nothing else of static/', async () => {
    const bundle = await fetch(`${base}/viewlib/diff-view.js`);
    assert.equal(bundle.status, 200);
    assert.equal(await bundle.text(), fs.readFileSync(path.join(REPO, 'static', 'diff-view.js'), 'utf8'));
    assert.equal((await fetch(`${base}/viewlib/app.js`)).status, 404);
    assert.equal((await fetch(`${base}/viewlib/diff-view.ts`)).status, 404);
  });
});
