// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { startMesh } from './mesh-server-lib.ts';
import { encode } from './ptyhost-wire-lib.ts';

// This exercises the real authenticated HTTP forwarder with an opaque socket
// fixture. Native operation semantics are qualified separately by host tests.
test('bridge forwards the four observation operations and refuses everything else', { timeout: 15000 }, async () => {
  const mesh = await startMesh('mi1-bridge-', { MESH_AUTH_MODE: 'legacy' });
  const received: unknown[] = [];
  const sockets = new Set<net.Socket>();
  const socketPath = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const fixture = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt32BE(1)) return;
      const request = JSON.parse(bytes.subarray(5, 5 + bytes.readUInt32BE(1)).toString('utf8'));
      received.push(request);
      socket.end(encode('C', Buffer.from(JSON.stringify({ witness: request, opaque: ['é', 0.125] }))));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(socketPath, resolve);
    });
    const owner = { Authorization: `Bearer ${mesh.token()}` };
    const send = (body: unknown, headers: Record<string, string> = owner) => fetch(mesh.base + '/api/projects/v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
      body: JSON.stringify(body),
    });
    // The server also asks the host for its session list now and then (snapshot and push loops, every 5 to
    // 10 s), so on a slow run extra `list` requests reach the fixture. Only the project operations are counted.
    const projectRequests = () => received.filter((request: any) => String(request?.op).startsWith('project_'));
    for (const op of ['project_observation_start', 'project_observation_status',
      'project_observation_page', 'project_observation_cancel']) {
      const body = { op, version: 1, marker: ['unchanged', 0.125] };
      const response = await send(body);
      assert.equal(response.status, 200, `${op} reaches the socket fixture`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { witness: body, opaque: ['é', 0.125] });
      assert.deepEqual(projectRequests().at(-1), body, 'the web layer forwards the logical DTO without project interpretation');
    }
    assert.equal(projectRequests().length, 4, 'all four admitted operations reached the fixture');
    const validName = { op: 'project_observation_start', version: 1 };
    assert.equal((await send(validName, {})).status, 401);
    assert.equal((await send(validName, { Authorization: 'MeshSession ms1.invalid' })).status, 401);
    assert.equal((await send(validName, { ...owner, Origin: 'https://other.invalid' })).status, 403);
    const unknown = await send({ op: 'project_observation_exec' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.headers.get('content-type') ?? '', /^text\/plain\b/);
    assert.equal(await unknown.text(), 'Unsupported project operation');
    assert.equal((await fetch(mesh.base + '/api/projects/v1', { headers: owner })).status, 405);
    assert.equal((await send({ ...validName, padding: 'x'.repeat(131072) })).status, 413);
    assert.equal(projectRequests().length, 4, 'denied and oversized requests never reach the socket');
    assert.ok(!received.some((request: any) => 'padding' in request || request?.op === 'project_observation_exec'),
      'no denied body reached the socket');
    assert.ok(received.every((request: any) => request?.op === 'list' || String(request?.op).startsWith('project_')),
      'every request that reached the socket is a host list or a project operation');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await mesh.stop();
  }
});
