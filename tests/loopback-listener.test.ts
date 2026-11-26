// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import net from 'node:net';
import {test} from 'node:test';
import {OWNER_CHECK, listensFrom, listensLoopbackFrom} from './helpers/listener-owner.ts';
import {listenerReady, stopServer} from './mesh-server-lib.ts';

const fixture = `const net = require('node:net');
const server = net.createServer(socket => socket.end());
server.on('error', error => { console.log('ERROR ' + error.code); process.exitCode = 1; });
server.listen(0, process.argv[1], () => console.log('READY ' + server.address().port));`;

async function candidate(address: string): Promise<{child: ChildProcess; port: number; error?: string}> {
  const child = spawn(process.execPath, ['-e', fixture, address], {stdio: ['ignore', 'pipe', 'pipe']});
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', chunk => resolve(String(chunk).trim()));
    child.once('exit', () => reject(new Error('listener exited before reporting readiness')));
  });
  const [tag, value] = line.split(' ');
  return tag === 'READY' ? {child, port: Number(value)} : {child, port: 0, error: value};
}

test('a server on another loopback address does not own the probed listener', {skip: !OWNER_CHECK}, async t => {
  const {child, port, error} = await candidate('127.0.0.2');
  if (error === 'EADDRNOTAVAIL') { t.skip('secondary IPv4 loopback is unavailable'); return; }
  assert.equal(error, undefined);
  const decoy = net.createServer(socket => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      decoy.once('error', reject);
      decoy.listen(port, '127.0.0.1', resolve);
    });
    assert.equal(await listenerReady(child, port, listensLoopbackFrom), false);
  } finally {
    if (decoy.listening) await new Promise<void>(resolve => decoy.close(() => resolve()));
    await stopServer(child);
  }
});

test('a server listening on every IPv4 address owns the probed listener', {skip: !OWNER_CHECK}, async () => {
  const {child, port, error} = await candidate('0.0.0.0');
  try {
    assert.equal(error, undefined);
    assert.equal(await listenerReady(child, port, listensLoopbackFrom), true);
  } finally { await stopServer(child); }
});

test('the existing ownership check retains IPv6 wildcard support', {skip: !OWNER_CHECK}, async t => {
  const {child, port, error} = await candidate('::');
  try {
    if (error === 'EADDRNOTAVAIL' || error === 'EAFNOSUPPORT') { t.skip('IPv6 unavailable'); return; }
    assert.equal(error, undefined);
    assert.equal(listensFrom(child.pid!, port), true);
  } finally { await stopServer(child); }
});
