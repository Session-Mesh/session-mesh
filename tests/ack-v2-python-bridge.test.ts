// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {test} from 'node:test';
import {encode, waitFor} from './ptyhost-wire-lib.ts';
import {scratchHome, runServer, stopServer, removeScratch} from './mesh-server-lib.ts';

const CREATED = 1730000000.25;
const NONCE = 'a'.repeat(32);
const RECEIPT_BINDING = {created: CREATED, slot: 0, generation: 1};
const BINDING = {...RECEIPT_BINDING, actor_nonce: NONCE};
const LISTED = {name: 'x', pid: 12345, cwd: '/tmp', created: CREATED, activity: CREATED,
  attached: 0, meta: {}, pty_capabilities: ['acknowledged_input_v2', 'acknowledged_input_v1']};
type Host = {requests: Record<string, unknown>[]; frames: {kind: string; body: Buffer}[];
  reply?: unknown; receipt?: Record<string, unknown>; listing?: Record<string, unknown>};

async function fixture(run: (base: string, token: string, host: Host) => Promise<void>): Promise<void> {
  const where = await scratchHome('ack-v2-bridge-');
  const sock = path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh', 'ptyhost.sock');
  const host: Host = {requests: [], frames: []};
  const native = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    let attached = false;
    socket.on('error', () => undefined);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const kind = pending.subarray(0, 1).toString();
        const body = pending.subarray(5, 5 + pending.readUInt32BE(1));
        pending = pending.subarray(5 + body.length);
        if (!attached) {
          const request = JSON.parse(body.toString()) as Record<string, unknown>;
          host.requests.push(request);
          if (request.op === 'attach') {
            attached = true;
            socket.write(encode('C', Buffer.from(JSON.stringify(host.reply ?? {
              ok: true, pty_capabilities: ['acknowledged_input_v2', 'human_input_lease_v1'],
              input_ack_v2: BINDING,
            }))));
          } else {
            socket.end(encode('C', Buffer.from(JSON.stringify(
              request.op === 'list' ? [host.listing ?? LISTED] : {error: 'unsupported'}))));
          }
        } else {
          host.frames.push({kind, body});
          if (kind === 'I') socket.write(encode('C', Buffer.from(JSON.stringify(host.receipt ?? {
            input_ack: true, seq: body.readUInt32BE(0), ...RECEIPT_BINDING,
          }))));
        }
      }
    });
  });
  const fs = await import('node:fs');
  fs.mkdirSync(path.dirname(sock), {recursive: true, mode: 0o700});
  await new Promise<void>(resolve => native.listen(sock, resolve));
  let child: Awaited<ReturnType<typeof runServer>>['child'] | undefined;
  try {
    const started = await runServer(where);
    child = started.child;
    assert.equal(started.result.listened, true, started.result.output);
    const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    await run(`http://127.0.0.1:${where.port}`, token, host);
  } finally {
    if (child) await stopServer(child);
    await new Promise<void>(resolve => native.close(() => resolve()));
    removeScratch(where.scratch);
  }
}

function connect(base: string, token: string, query: string): Promise<{socket: WebSocket; messages: unknown[]}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/x?${query}`, {
      headers: {Authorization: `Bearer ${token}`, Origin: base},
    });
    const messages: unknown[] = [];
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') messages.push(JSON.parse(event.data));
    });
    socket.addEventListener('open', () => resolve({socket, messages}), {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
}
const newQuery = `input_ack=2&input_ack_mode=new&input_ack_created=${CREATED}`;
const resumeQuery = `${newQuery.replace('new', 'resume')}&input_ack_slot=0&input_ack_generation=1&input_ack_nonce=${NONCE}`;

function handshakeStatus(base: string, token: string, query: string): Promise<number> {
  const {hostname, port} = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('WebSocket handshake timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write([
      `GET /ws/x?${query} HTTP/1.1`,
      `Host: ${hostname}:${port}`, `Origin: ${base}`, `Authorization: Bearer ${token}`,
      'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.alloc(16).toString('base64')}`, '', '',
    ].join('\r\n')));
    socket.on('data', chunk => {
      response += chunk.toString();
      if (!response.includes('\r\n\r\n')) return;
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(response);
      socket.destroy();
      if (status) resolve(Number(status[1]));
      else reject(new Error('Malformed handshake response'));
    });
  });
}

test('new and resume use the native v2 request and project validated receipts and H', async () => fixture(async (base, token, host) => {
  for (const [query, mode] of [[newQuery, 'new'], [resumeQuery, 'resume']]) {
    const {socket, messages} = await connect(base, token, query!);
    await waitFor('capability', 3000, () => messages.length > 0);
    assert.deepEqual(messages[0], {t: 'input_capability', supported: true, version: 2, ...BINDING});
    const requested = host.requests.filter(item => item.op === 'attach').at(-1)!;
    assert.deepEqual(requested.input_ack_v2, mode === 'new'
      ? {mode, created: CREATED} : {mode, created: CREATED, slot: 0, generation: 1, actor_nonce: NONCE});
    const input = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('benign-private-input')]);
    socket.send(input);
    await waitFor('I and ACK', 3000, () => host.frames.some(f => f.kind === 'I') && messages.length > 1);
    assert.deepEqual(messages.at(-1), {t: 'input_ack', version: 2, input_ack: true, seq: 1, ...RECEIPT_BINDING});
    socket.send(JSON.stringify({t: 'h', slot: 0, generation: 1, dirty: true}));
    await waitFor('H', 3000, () => host.frames.some(f => f.kind === 'H'));
    assert.deepEqual(JSON.parse(host.frames.find(f => f.kind === 'H')!.body.toString()),
      {slot: 0, generation: 1, dirty: true});
    socket.send(JSON.stringify({t: 'h', slot: 0, generation: 1, dirty: false}));
    await waitFor('clean H', 3000, () => host.frames.filter(f => f.kind === 'H').length === 2);
    assert.deepEqual(JSON.parse(host.frames.filter(f => f.kind === 'H')[1]!.body.toString()),
      {slot: 0, generation: 1, dirty: false});
    socket.close();
    await new Promise(resolve => socket.addEventListener('close', resolve, {once: true}));
    host.frames.length = 0;
  }
}));

test('v2 never downgrades on a malformed native binding or receipt', async () => fixture(async (base, token, host) => {
  host.reply = {ok: true, pty_capabilities: ['acknowledged_input_v2', 'human_input_lease_v1'],
    input_ack_v2: {...BINDING, created: CREATED + 1}};
  await assert.rejects(connect(base, token, newQuery));
  assert.equal(host.requests.filter(item => item.op === 'attach').length, 1);
  assert.deepEqual(host.frames, []);
}));

test('a resumed actor must match exactly; malformed receipts and H cannot cross bindings', async () => fixture(async (base, token, host) => {
  host.reply = {ok: true, pty_capabilities: ['acknowledged_input_v2', 'human_input_lease_v1'],
    input_ack_v2: {...BINDING, generation: 2}};
  await assert.rejects(connect(base, token, resumeQuery));
  host.reply = {ok: true, pty_capabilities: ['acknowledged_input_v2', 'human_input_lease_v1'],
    input_ack_v2: BINDING};
  host.receipt = {input_ack: true, seq: 1, ...RECEIPT_BINDING, generation: 2};
  const {socket, messages} = await connect(base, token, resumeQuery);
  await waitFor('binding', 3000, () => messages.length > 0);
  socket.send(Buffer.from([0, 0, 0, 1, 65]));
  socket.send(JSON.stringify({t: 'h', slot: 0, generation: 2, dirty: true}));
  socket.send(JSON.stringify({t: 'h', client_id: 'legacyclient_123456789', dirty: true}));
  await waitFor('I', 3000, () => host.frames.some(f => f.kind === 'I'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(host.frames.map(f => f.kind), ['I']);
  assert.deepEqual(messages, [{t: 'input_capability', supported: true, version: 2, ...BINDING}]);
  socket.close();
}));

test('v2 rejects malformed I without D downgrade and relays a bound refusal reason', async () => fixture(async (base, token, host) => {
  host.receipt = {input_ack: false, seq: 1, ...RECEIPT_BINDING, reason: 'input_pending'};
  const {socket, messages} = await connect(base, token, newQuery);
  await waitFor('v2 capability', 3000, () => messages.length > 0);
  socket.send(Buffer.from('raw'));
  socket.send(Buffer.from([0, 0, 0, 0, 65]));
  socket.send(Buffer.from([0, 0, 0, 1, 65]));
  await waitFor('bounded refusal', 3000, () => messages.some(item => (item as {t?: string}).t === 'input_ack'));
  assert.deepEqual(host.frames.map(f => f.kind), ['I']);
  assert.deepEqual(messages.at(-1),
    {t: 'input_ack', version: 2, input_ack: false, seq: 1, ...RECEIPT_BINDING, reason: 'input_pending'});
  socket.close();
}));

test('v2 rejects a missing or malformed native actor nonce rather than downgrade', async () => fixture(async (base, token, host) => {
  for (const actor_nonce of [undefined, 'A'.repeat(32), 'b'.repeat(31), true]) {
    host.reply = {ok: true, pty_capabilities: ['acknowledged_input_v2'],
      input_ack_v2: {...RECEIPT_BINDING, ...(actor_nonce === undefined ? {} : {actor_nonce})}};
    await assert.rejects(connect(base, token, newQuery));
  }
  assert.deepEqual(host.frames, []);
}));

test('non-object native attach response cannot grant v2 input', async () => fixture(async (base, token, host) => {
  host.reply = [];
  await assert.rejects(connect(base, token, newQuery));
  assert.deepEqual(host.frames, []);
}));

test('oversized ASCII decimal actor fields receive 400 before native attach', async () => fixture(async (base, token, host) => {
  const oversized = '9'.repeat(5000);
  for (const field of ['input_ack_slot', 'input_ack_generation']) {
    const query = resumeQuery.replace(`${field}=${field === 'input_ack_slot' ? '0' : '1'}`,
      `${field}=${oversized}`);
    assert.equal(await handshakeStatus(base, token, query), 400, field);
  }
  assert.equal(host.requests.filter(item => item.op === 'attach').length, 0, 'no v2 or raw attach');
  assert.deepEqual(host.frames, [], 'no raw D or control frame');
}));

test('resume still admits slot 63 and the maximum JS-safe generation', async () => fixture(async (base, token, host) => {
  const boundary = {...BINDING, slot: 63, generation: Number.MAX_SAFE_INTEGER};
  host.reply = {ok: true, pty_capabilities: ['acknowledged_input_v2'], input_ack_v2: boundary};
  const query = resumeQuery.replace('input_ack_slot=0', 'input_ack_slot=63')
    .replace('input_ack_generation=1', `input_ack_generation=${Number.MAX_SAFE_INTEGER}`);
  const {socket, messages} = await connect(base, token, query);
  await waitFor('boundary capability', 3000, () => messages.length > 0);
  assert.deepEqual(messages[0], {t: 'input_capability', supported: true, version: 2, ...boundary});
  assert.deepEqual(host.requests.filter(item => item.op === 'attach')[0]?.input_ack_v2,
    {mode: 'resume', ...boundary});
  socket.close();
}));

test('legacy attachment still relays D without a v2 request', async () => fixture(async (base, token, host) => {
  const {socket, messages} = await connect(base, token, 'pty_size=1');
  socket.send(Buffer.from('benign-private-input'));
  await waitFor('legacy D', 3000, () => host.frames.length > 0);
  assert.equal(host.frames[0]?.kind, 'D');
  assert.equal(host.frames[0]?.body.toString(), 'benign-private-input');
  assert.deepEqual(messages, []);
  socket.close();
}));

test('v1 remains a distinct observed-only wire contract', async () => fixture(async (base, token, host) => {
  const id = 'browser_legacy_123456789';
  host.reply = {ok: true, pty_capabilities: ['acknowledged_input_v1'],
    input_ack: {id, created: CREATED}};
  host.receipt = {input_ack: true, seq: 1, id, created: CREATED};
  const {socket, messages} = await connect(base, token,
    `input_ack=1&input_ack_id=${id}&input_ack_created=${CREATED}`);
  await waitFor('v1 capability', 3000, () => messages.length > 0);
  assert.deepEqual(messages[0], {t: 'input_capability', supported: true, id, created: CREATED});
  socket.send(Buffer.from([0, 0, 0, 1, 65]));
  await waitFor('v1 receipt', 3000, () => messages.length > 1);
  assert.deepEqual(messages[1], {t: 'input_ack', input_ack: true, seq: 1, id, created: CREATED});
  assert.deepEqual(host.requests.filter(item => item.op === 'attach')[0]?.input_ack_v2, undefined);
  socket.close();
}));

test('explicit malformed and ambiguous v2 requests are rejected rather than raw', async () => fixture(async (base, token, host) => {
  for (const query of [
    'input_ack=2&input_ack_mode=new&input_ack_created=NaN',
    `${newQuery}&input_ack_created=${CREATED}`,
    `${newQuery}&input_ack_id=legacyclient_123456789`,
    `${newQuery}&input_ack_surprise=1`,
    `${newQuery}&input_ack_nonce=${NONCE}`,
    `${newQuery}&input_ack_slot=0`,
    resumeQuery.replace(`&input_ack_nonce=${NONCE}`, ''),
    resumeQuery.replace(NONCE, 'A'.repeat(32)),
    resumeQuery.replace(NONCE, 'b'.repeat(31)),
    resumeQuery.replace('input_ack_slot=0', 'input_ack_slot=64'),
    resumeQuery.replace('input_ack_generation=1', 'input_ack_generation=0'),
    resumeQuery.replace('input_ack_generation=1', 'input_ack_generation=9007199254740992'),
    `${resumeQuery}&input_ack_generation=2`,
    'input_ack=3',
  ]) {
    try {
      const {socket, messages} = await connect(base, token, query);
      await waitFor('refusal', 3000, () => messages.length > 0 || socket.readyState === WebSocket.CLOSED);
      if (socket.readyState === WebSocket.OPEN) socket.close();
    } catch { /* handshake refusal is also correct */ }
  }
  assert.equal(host.requests.filter(item => item.op === 'attach').length, 0);
}));

test('only validated v2 upstream listing is projected, without losing v1', async () => fixture(async (base, token, host) => {
  const read = async () => (await (await fetch(`${base}/api/sessions`, {headers: {
    Authorization: `Bearer ${token}`, Origin: base,
  }})).json() as {mesh: {pty_capabilities: string[]}[]}).mesh[0]?.pty_capabilities;
  assert.deepEqual(await read(), ['acknowledged_input_v2', 'acknowledged_input_v1']);
  host.listing = {...LISTED, pty_capabilities: ['acknowledged_input_v2', 'acknowledged_input_v2']};
  assert.ok(!(await read())?.includes('acknowledged_input_v2'));
}));
