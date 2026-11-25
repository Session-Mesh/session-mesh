// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {nativeMeshCommand} from './helpers/native-cli.ts';
import {sessionSkipReason, startMesh, type Mesh} from './http-harness.ts';

const command = nativeMeshCommand('mesh-open');
const skip = sessionSkipReason();
let mesh: Mesh;
let emptyHome: string;
let doc: string;
let fileNumber = 0;

function document(): string {
  const file = path.join(mesh.home, `cli-${++fileNumber}.md`);
  fs.writeFileSync(file, '# CLI\n');
  return fs.realpathSync(file);
}

before(async () => {
  mesh = await startMesh({session: !skip});
  emptyHome = fs.mkdtempSync(path.join(mesh.home, 'empty-'));
  doc = document();
});

after(async () => { if (mesh) await mesh.stop(); });

function run(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = mesh.home) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith('MESH_')) delete env[key];
  Object.assign(env, {HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'),
    MESH_PORT: new URL(mesh.base).port}, extra);
  return new Promise<{code: number; stdout: string; stderr: string}>((resolve, reject) => {
    execFile(command[0]!, [...command.slice(1), ...args], {env, cwd, timeout: 7500}, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({code: error ? Number(error.code) : 0, stdout, stderr});
    });
  });
}

type Opened = {target: string; session: string | null; reload: boolean; watch: boolean; mtime?: string};

async function listing(): Promise<Opened[]> {
  const response = await fetch(`${mesh.base}/api/sessions`, {headers: {Cookie: mesh.cookie}});
  assert.equal(response.status, 200);
  return (await response.json() as {opens?: Opened[]}).opens ?? [];
}

async function accepted(file: string, flags: Pick<Opened, 'session' | 'reload' | 'watch'>) {
  const deadline = performance.now() + 5000;
  do {
    const opened = (await listing()).findLast(entry => entry.target === file);
    if (opened) {
      assert.deepEqual({session: opened.session, reload: opened.reload, watch: opened.watch}, flags);
      if (flags.watch) assert.equal(opened.mtime, String(fs.statSync(file, {bigint: true}).mtimeNs));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  assert.fail(`no open request for ${file}`);
}

async function succeeds(args: string[], file: string, extra: NodeJS.ProcessEnv = {}, cwd?: string) {
  const result = await run(args, extra, cwd);
  assert.deepEqual(result, {code: 0, stdout: `opened in session-mesh: ${file}\n`, stderr: ''});
}

describe('native mesh-open against the web server', () => {
  test('master credential opens for the owner with flags false by default', async () => {
    await succeeds([doc], doc);
    await accepted(doc, {session: null, reload: false, watch: false});
  });

  test('reload and watch reach the server with the current modification time', async () => {
    let file = document();
    await succeeds(['--reload', file], file);
    await accepted(file, {session: null, reload: true, watch: false});
    file = document();
    await succeeds([file, '--watch'], file);
    await accepted(file, {session: null, reload: true, watch: true});
  });

  test('resolves a relative link and a home-relative path', async () => {
    const relative = document();
    fs.symlinkSync(path.basename(relative), path.join(mesh.home, 'cli link.md'));
    await succeeds(['./cli link.md'], relative);
    const homeRelative = document();
    fs.symlinkSync(path.basename(homeRelative), path.join(mesh.home, 'home link.md'));
    await succeeds(['~/home link.md', '--reload', '--watch'], homeRelative);
    await accepted(homeRelative, {session: null, reload: true, watch: true});
  });

  test('resolves a long chain of links before passing the filename to the mesh', async () => {
    const file = document();
    let target = path.basename(file);
    for (let i = 0; i < 45; i += 1) {
      const alias = `chain-${i}.md`;
      fs.symlinkSync(target, path.join(mesh.home, alias));
      target = alias;
    }
    await succeeds([target], file);
  });

  test('URL and syntax errors leave the server queue untouched', async () => {
    const before = await listing();
    for (const args of [[], ['--bogus', 'x'], ['a', 'b'], ['--watch', 'HTTPS://example.invalid/x']]) {
      const result = await run(args);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /^usage: mesh-open/m);
      if (args[0] === '--watch') assert.match(result.stderr, /a web page does not open in a panel/);
    }
    assert.deepEqual(await listing(), before);
  });

  test('help describes both flags without a token', async () => {
    const result = await run(['--help'], {HOME: emptyHome});
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^usage: mesh-open.*--reload.*--watch/m);
    assert.equal(result.stderr, '');
  });

  test('session scope comes from the token, even with a different name and no master file', {skip}, async () => {
    const file = document();
    assert.equal(mesh.plainSessionToken?.startsWith('ms1.plain.'), true);
    const token = mesh.sessionToken!;
    await succeeds([file], file, {HOME: emptyHome, MESH_SESSION: 'plain', MESH_SESSION_TOKEN: ` ${token}\n`});
    assert.equal(fs.existsSync(path.join(emptyHome, '.config')), false);
    await accepted(file, {session: 'alpha', reload: false, watch: false});
  });

  test('a refused session token cannot fall back to the master token', async () => {
    const file = document();
    const token = 'refused-session-token';
    const result = await run([file], {MESH_SESSION: 'gone', MESH_SESSION_TOKEN: token});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^mesh-open: session token refused \(the session is closed or MESH_SESSION_TOKEN is out of date\)\n$/);
    assert.ok(!(result.stdout + result.stderr).includes(token));
    assert.equal((await listing()).some(entry => entry.target === file), false);
  });

  test('missing master file gives a clean error and MESH_CONF_DIR overrides it', async () => {
    const result = await run([doc], {HOME: emptyHome});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^mesh-open: session-mesh token not found/);
    const conf = path.join(emptyHome, 'other-conf');
    fs.mkdirSync(conf);
    fs.writeFileSync(path.join(conf, 'token'), ` ${mesh.token}\n`);
    await succeeds([doc], doc, {HOME: emptyHome, MESH_CONF_DIR: conf});
    assert.equal(fs.existsSync(path.join(emptyHome, '.config')), false);
  });

  test('a dead listener gives a clean error', async () => {
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const result = await run([doc], {MESH_PORT: String(port)});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^mesh-open: session-mesh is not responding/);
  });

  test('a silent HTTP peer is bounded by the five-second request deadline', async t => {
    const sockets = new Set<net.Socket>();
    const listener = net.createServer(socket => {
      sockets.add(socket);
      socket.resume();
      socket.once('close', () => sockets.delete(socket));
    });
    t.after(() => { for (const socket of sockets) socket.destroy(); listener.close(); });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const start = performance.now();
    const result = await run([doc], {MESH_PORT: String((listener.address() as net.AddressInfo).port)});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^mesh-open: session-mesh is not responding \(no answer within 5 s/);
    assert.ok(performance.now() - start >= 4500);
  });
});
