// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {OWNER_CHECK} from './helpers/listener-owner.ts';
import {listenerReady, removeScratch, runServer, scratchHome, stopServer} from './mesh-server-lib.ts';

test('a replacement listener after child exit is never reported ready', async () => {
  const child = {pid: 123, exitCode: null as number | null, signalCode: null};
  const result = await listenerReady(child, 1234, () => child.exitCode === null, async () => {
    child.exitCode = 1;
    return true;
  });
  assert.equal(result, false);
});

test('a listener replaced while the child is alive is never reported ready', async () => {
  const child = {pid: 123, exitCode: null, signalCode: null};
  let owned = true;
  const result = await listenerReady(child, 1234, () => owned, async () => {
    owned = false;
    return true;
  });
  assert.equal(result, false);
});

test('the spawned server is recognized when it owns the port', {skip: !OWNER_CHECK}, async () => {
  const where = await scratchHome('port-owner-');
  try {
    const result = await runServer(where);
    try { assert.equal(result.result.listened, true, result.result.output); }
    finally { await stopServer(result.child); }
  } finally { removeScratch(where.scratch); }
});

test('an unrelated listener is not mistaken for the spawned server', {skip: !OWNER_CHECK}, async () => {
  const where = await scratchHome('port-owner-');
  const listener = net.createServer(socket => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    where.port = (listener.address() as net.AddressInfo).port;
    where.env.MESH_PORT = String(where.port);
    const result = await runServer(where);
    try {
      assert.equal(result.result.listened, false, result.result.output);
      assert.match(result.result.output, /address already in use|address.*in use/i);
    }
    finally { await stopServer(result.child); }
  } finally {
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    removeScratch(where.scratch);
  }
});
