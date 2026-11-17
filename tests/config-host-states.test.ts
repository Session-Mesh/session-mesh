// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// GET /api/config must describe the terminal host, never fail because of it: no host at all, and
// a host that accepts the connection but answers with bytes that are not JSON. Throwaway server;
// the "bad host" is a small Unix-socket server of the test's own, at the socket path Mesh expects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {type Mesh, startMesh} from './mesh-server-lib.ts';
import {encode} from './ptyhost-wire-lib.ts';

const meshes: Mesh[] = [];
const listeners: net.Server[] = [];
after(async () => {
  for (const listener of listeners) listener.close();
  for (const mesh of meshes) await mesh.stop();
});

async function signIn(mesh: Mesh): Promise<string> {
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  return cookie;
}

async function report(mesh: Mesh): Promise<{status: number; body: Record<string, any>}> {
  const response = await fetch(`${mesh.base}/api/config`, {headers: {Cookie: await signIn(mesh)}});
  return {status: response.status, body: await response.json() as Record<string, any>};
}

describe('GET /api/config with an unusual terminal host', () => {
  test('no host: 200, not running, no capabilities', async () => {
    const mesh = await startMesh('cfgh-none-');
    meshes.push(mesh);
    const {status, body} = await report(mesh);
    assert.equal(status, 200);
    assert.equal(body.host.running, false);
    assert.deepEqual(body.host.capabilities, []);
    assert.equal(body.host.kind, null);
    assert.equal(body.paths.host_socket_present, false);
  });

  test('a host that answers with non-JSON bytes: 200 and "reply_valid" false, never 500', async () => {
    const mesh = await startMesh('cfgh-bad-');
    meshes.push(mesh);
    const socketPath = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
    fs.mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});
    const listener = net.createServer(socket => {
      socket.on('error', () => undefined);
      socket.on('data', () => socket.write(encode('C', Buffer.from('this is not json \xff\xfe'))));
    }).listen(socketPath);
    listeners.push(listener);
    await new Promise(resolve => listener.once('listening', resolve));
    const {status, body} = await report(mesh);
    assert.equal(status, 200);
    assert.equal(body.host.running, true, 'a process accepts connections on the socket');
    assert.equal(body.host.reply_valid, false);
    assert.deepEqual(body.host.capabilities, []);
  });
});
