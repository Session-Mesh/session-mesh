// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {scratchHome, runServer, stopServer, removeScratch} from './mesh-server-lib.ts';
import {until} from '../checks/dictation-fixture.ts';
import {createHumanInputLease, createHumanInputScope} from '../static/pane-actions.ts';

function browserHandle(created: unknown = 1, legacy = false) {
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: unknown[] = [];
    onmessage!: (event: {data: unknown}) => void;
    onopen!: () => void;
    onclose!: () => void;
    readonly url: string;
    constructor(url: string) { this.url = url; }
    send(value: unknown) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({WebSocket: Socket, Uint8Array, TextEncoder,
    t(key: string) {assert.equal(key, 'dictation.inline.invalidIncarnation'); return 'invalid terminal incarnation';},
    requireLocalMesh() {}, location: {protocol: 'https:', host: 'example.test'}, enc: new TextEncoder()});
  vm.runInContext(fs.readFileSync('static/pane-actions.js', 'utf8'), context);
  const xterm = {exports: {} as any, module: {exports: {} as any}, self: {}, process, setTimeout, clearTimeout};
  vm.runInNewContext(fs.readFileSync('static/vendor/xterm.min.js', 'utf8'), xterm);
  const modeSource = new (xterm.exports.Terminal || xterm.module.exports.Terminal)();
  const app = fs.readFileSync('static/app.js', 'utf8');
  vm.runInContext(app.slice(app.indexOf('function localTerminalSocketReady('), app.indexOf('class Pane {')), context);
  let visible = true;
  const output: number[][] = [], geometry: unknown[] = [], ptySizes: unknown[] = [];
  const handle = context.openLocalTerminal('alpha', {rows: 24, cols: 80, ...(legacy ? {} : {created})}, {
    modeSource,
    current: () => visible, opened() {}, closed() {},
    bytes: (_: unknown, bytes: Uint8Array) => output.push([...bytes]),
    replayGeometry: (_: unknown, size: unknown) => geometry.push(size),
    ptySize: (_: unknown, size: unknown) => ptySizes.push(size),
  });
  const socket = handle.socket as Socket;
  const message = (data: unknown) => socket.onmessage({data});
  return {handle, socket, output, geometry, ptySizes, hide: () => {visible = false;}, message,
    bound: (body: unknown = {t: 'bound', name: 'alpha', created: 1}) => message(JSON.stringify(body)),
    replay: () => message(new ArrayBuffer(0))};
}

test('bound authority requires one exact acknowledgement before even an empty replay', () => {
  const f = browserHandle();
  assert.equal(new URL(f.socket.url).searchParams.get('created'), '1');
  f.socket.onopen();
  assert.equal(f.handle.isOpen(), true);
  assert.equal(f.handle.isBound('alpha', 1), false, 'open socket is not identity proof');
  f.bound();
  assert.equal(f.handle.isBound('alpha', 1), true);
  assert.equal(f.handle.isBound('alpha', 9), false);
  assert.equal(f.handle.isBound('beta', 1), false);
  f.replay();
  assert.deepEqual(f.output, [[]], 'empty D still crosses the first-replay boundary');
  assert.equal(f.handle.isBound('alpha', 1), true);
  f.bound();
  assert.equal(f.handle.isBound('alpha', 1), false, 'duplicate permanently revokes authority');
  f.bound();
  assert.equal(f.handle.isBound('alpha', 1), false);
  f.handle.queueInput(Uint8Array.of(97));
  assert.equal(f.socket.sent.length, 1, 'invalid dictation authority does not disable ordinary typing');
  f.handle.dispose();
});

test('missing, late, malformed, mismatched and compatibility acknowledgements never authorize', () => {
  for (const sequence of [
    (f: ReturnType<typeof browserHandle>) => {f.replay(); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.bound({t: 'bound', name: 'alpha', created: 9}); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.bound({t: 'bound', name: 'beta', created: 1}); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.bound({t: 'bound', name: 'alpha', created: true}); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.bound({t: 'bound', name: 'alpha', created: 1, extra: 1}); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.message('{"t":"bound"'); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.bound({t: 'bound'}); f.bound();},
    (f: ReturnType<typeof browserHandle>) => {f.replay();},
  ]) {
    const f = browserHandle(); sequence(f);
    assert.equal(f.handle.isBound('alpha', 1), false);
    assert.equal(f.handle.isOpen(), true);
    f.handle.dispose();
  }
  const legacy = browserHandle(undefined, true);
  assert.equal(new URL(legacy.socket.url).searchParams.has('created'), false);
  legacy.bound(); assert.equal(legacy.handle.isBound('alpha', 1), false);
  legacy.handle.dispose();
});

test('invalid explicit expected incarnations never fall back to a name-only browser attach', () => {
  for (const created of [true, false, 0, -1, NaN, Infinity, '1'])
    assert.throws(() => browserHandle(created), /invalid terminal incarnation/);
});

test('PTY ownership updates preserve exact binding and stay fenced from a detached pane', () => {
  const f = browserHandle();
  assert.equal(new URL(f.socket.url).searchParams.get('pty_size'), '1');
  f.bound(); f.replay();
  f.message(JSON.stringify({t: 's', rows: 37, cols: 101, owner: 'other'}));
  assert.equal(f.handle.isBound('alpha', 1), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ptySizes)), [{rows: 37, cols: 101, owner: 'other'}]);
  f.handle.resize(37, 101, 'keep');
  f.handle.resize(31, 91, 'take');
  assert.deepEqual(f.socket.sent.map(value => JSON.parse(value as string)), [
    {t: 'r', rows: 37, cols: 101, size: 'keep'}, {t: 'r', rows: 31, cols: 91, size: 'take'},
  ]);
  const release = f.handle.retain();
  f.hide(); f.handle.close();
  f.message(JSON.stringify({t: 's', rows: 65535, cols: 1001, owner: 'other'}));
  assert.equal(f.handle.isBound('alpha', 1), true, 'oversized metadata does not revoke a retained binding');
  f.message(JSON.stringify({t: 's', rows: 31, cols: 91, owner: 'you'}));
  assert.equal(f.ptySizes.length, 1, 'a retained socket cannot resize a reused view');
  assert.equal(f.handle.isBound('alpha', 1), true);
  f.message(JSON.stringify({t: 's', rows: 31, cols: 91, owner: 'invalid'}));
  assert.equal(f.handle.isBound('alpha', 1), false, 'malformed controls still revoke authority');
  release();
});

for (const dimension of ['rows', 'cols'] as const) for (const value of [1001, 65535]) {
  test(`wire-valid PTY ${dimension}=${value} preserves binding without resizing the view`, () => {
    for (const owner of ['you', 'other', 'none']) {
      const f = browserHandle();
      try {
        f.bound(); f.replay();
        f.message(JSON.stringify({t: 's', rows: 37, cols: 101, [dimension]: value, owner}));
        assert.equal(f.handle.isBound('alpha', 1), true, `${owner}: renderability is not identity authority`);
        assert.deepEqual(f.ptySizes, [], 'oversized metadata never reaches the size/view callback');
        assert.deepEqual(f.geometry, [], 'ownership metadata does not change replay geometry');
        assert.deepEqual(f.output, [[]], 'the admitted empty replay is unchanged');
        for (const size of [{rows: 2, cols: 1000}, {rows: 1000, cols: 2}]) {
          f.message(JSON.stringify({t: 's', ...size, owner}));
          assert.equal(f.handle.isBound('alpha', 1), true);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(f.ptySizes)), [
          {rows: 2, cols: 1000, owner}, {rows: 1000, cols: 2, owner},
        ], 'ordinary renderable size updates resume on the same socket');
      } finally {f.handle.dispose();}
    }
  });
}

test('PTY size metadata never establishes binding or admits a late acknowledgement', () => {
  for (const missingBeforeReplay of [false, true]) {
    const f = browserHandle();
    try {
      f.message(JSON.stringify({t: 's', rows: 1001, cols: 65535, owner: 'other'}));
      assert.equal(f.handle.isBound('alpha', 1), false, 'size metadata is not an acknowledgement');
      assert.deepEqual(f.ptySizes, []);
      if (missingBeforeReplay) f.replay();
      f.bound();
      assert.equal(f.handle.isBound('alpha', 1), !missingBeforeReplay);
      f.replay();
      assert.equal(f.handle.isBound('alpha', 1), !missingBeforeReplay);
    } finally {f.handle.dispose();}
  }
});

test('malformed PTY controls still revoke binding irreversibly', () => {
  const size = {t: 's', rows: 37, cols: 101, owner: 'other'};
  const invalid = [0, 1, -1, 65536, 2.5, '37', true, null, [], {}];
  const messages = [
    ...(['rows', 'cols'] as const).flatMap(dimension => invalid.map(value => ({...size, [dimension]: value}))),
    ...['invalid', 1, null].map(owner => ({...size, owner})),
    {...size, t: 'unexpected'}, {t: 's'}, null, [], 's',
  ];
  for (const message of messages) {
    const f = browserHandle();
    try {
      f.bound(); f.replay(); f.message(JSON.stringify(message));
      assert.equal(f.handle.isBound('alpha', 1), false, JSON.stringify(message));
      assert.deepEqual(f.ptySizes, [], 'malformed metadata is not rendered');
      f.message(JSON.stringify(size)); f.bound();
      assert.equal(f.handle.isBound('alpha', 1), false, 'ordinary metadata and another acknowledgement cannot restore authority');
    } finally {f.handle.dispose();}
  }
});

test('null and omitted inventory incarnations support ordinary lease I/O without dictation authority', () => {
  const source = fs.readFileSync('static/app.js', 'utf8');
  for (const omitted of [false, true]) {
    const f = browserHandle(null, omitted);
    const session = {name: 'alpha', ...(omitted ? {} : {created: null})};
    const context = vm.createContext({requireLocalMesh() {}, find: () => session, humanInputScopes: new Map(),
      MeshPaneActions: {createHumanInputScope, createHumanInputLease}, inputLeaseTab: 'tab'});
    vm.runInContext(`class Pane {${source.slice(source.indexOf('  inputLeaseFor(name) {'), source.indexOf('  // Tell the pty this pane'))}}; globalThis.pane = new Pane();`, context);
    const pane = context.pane;
    pane.conn = {...session, terminal: f.handle}; pane.inputLeases = new Map(); pane.inputLeaseSlot = 'pane';
    const lease = pane.inputLeaseFor('alpha');
    assert.equal(new URL(f.socket.url).searchParams.has('created'), false);
    assert.equal(lease.write(Uint8Array.of(97)), true);
    assert.equal(lease.atomic(Uint8Array.of(13)), true);
    assert.deepEqual(f.socket.sent.filter(value => value instanceof Uint8Array).map(value => [...value as Uint8Array]), [[97], [13]]);
    f.bound(); assert.equal(f.handle.isBound('alpha', 1), false);
    f.handle.dispose();
  }
});

test('retained original handle observes binding and modes while its view is detached', () => {
  const f = browserHandle();
  const release = f.handle.retain();
  f.hide(); f.handle.close(); f.bound(); f.replay();
  assert.equal(f.handle.isBound('alpha', 1), true);
  f.message(new TextEncoder().encode('\x1b[?2004h').buffer);
  assert.equal(f.handle.dictationMode.value, true);
  assert.deepEqual(f.output, [], 'retained output must not write to a reused view');
  f.bound(); assert.equal(f.handle.isBound('alpha', 1), false);
  release(); assert.equal(f.handle.isOpen(), false);
});

test('geometry controls preserve binding, unexpected controls revoke it, and disposal ignores late frames', () => {
  const f = browserHandle();
  f.bound(); f.message(JSON.stringify({t: 'g', rows: 31, cols: 91}));
  assert.deepEqual(JSON.parse(JSON.stringify(f.geometry)), [{rows: 31, cols: 91}]);
  assert.equal(f.handle.isBound('alpha', 1), true);
  f.replay(); f.message(JSON.stringify({t: 'unexpected'}));
  assert.equal(f.handle.isBound('alpha', 1), false);
  f.message(new TextEncoder().encode('ordinary-output').buffer);
  assert.equal(f.output.length, 2, 'revoked bound authority does not stop ordinary output');
  const mode = f.handle.dictationMode;
  f.handle.dispose();
  assert.equal(mode.valid, false, 'the private mode parser is disposed with the socket');
  f.message(new TextEncoder().encode('late-output\x1b[?2004h').buffer);
  f.message(JSON.stringify({t: 'g', rows: 40, cols: 100}));
  f.bound();
  assert.equal(f.handle.isBound('alpha', 1), false);
  assert.equal(f.output.length, 2); assert.equal(f.geometry.length, 1);
  assert.throws(() => f.handle.queueInput(Uint8Array.of(97)), /disconnected/);
});

function frame(kind: string, body: unknown): Buffer {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const head = Buffer.alloc(5); head[0] = kind.charCodeAt(0); head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}
async function native(socketPath: string, body: unknown): Promise<any> {
  const socket = net.connect(socketPath);
  socket.setTimeout(5000, () => socket.destroy(Error('native control fixture timeout')));
  let bytes = Buffer.alloc(0);
  try {
    await once(socket, 'connect'); socket.write(frame('C', body));
    for await (const part of socket) {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt32BE(1)) {
        assert.equal(bytes[0], 67);
        return JSON.parse(bytes.subarray(5, 5 + bytes.readUInt32BE(1)).toString());
      }
    }
    throw Error('native fixture closed without a reply');
  } finally { socket.destroy(); }
}
async function nativeReplay(socketPath: string, body: unknown) {
  const socket = net.connect(socketPath);
  socket.setTimeout(5000, () => socket.destroy(Error('native replay fixture timeout')));
  let bytes = Buffer.alloc(0);
  const frames: {kind: string; data: Buffer}[] = [];
  try {
    await once(socket, 'connect'); socket.write(frame('C', body));
    for await (const part of socket) {
      bytes = Buffer.concat([bytes, part]);
      while (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt32BE(1)) {
        const size = bytes.readUInt32BE(1);
        frames.push({kind: String.fromCharCode(bytes[0]), data: bytes.subarray(5, 5 + size)});
        bytes = bytes.subarray(5 + size);
        if (frames.length === 2) {
          assert.deepEqual(frames.map(item => item.kind), ['C', 'D']);
          return {reply: JSON.parse(frames[0].data.toString()), replay: frames[1].data.toString()};
        }
      }
    }
    throw Error('native fixture closed before its C/D replay pair');
  } finally { socket.destroy(); }
}
async function relay(port: number, token: string, query: string, authenticated = true) {
  return await new Promise<{status: number; socket?: net.Socket; frames: {kind: number; data: Buffer}[]}>((resolve, reject) => {
    const frames: {kind: number; data: Buffer}[] = [];
    const req = http.request({host: '127.0.0.1', port, path: `/ws/alpha?rows=31&cols=91&replay_geometry=1${query}`,
      headers: {Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'),
        ...(authenticated ? {Authorization: `Bearer ${token}`} : {})}});
    req.on('response', response => {response.resume(); resolve({status: response.statusCode!, frames});});
    req.on('upgrade', (_response, socket, head) => {
      socket.setTimeout(5000, () => socket.destroy(Error('upgraded relay fixture timeout')));
      let bytes = Buffer.alloc(0);
      const receive = (part: Buffer) => {
        bytes = Buffer.concat([bytes, part]);
        while (bytes.length >= 2) {
          let size = bytes[1] & 127, offset = 2;
          if (size === 126) {if (bytes.length < 4) return; size = bytes.readUInt16BE(2); offset = 4;}
          if (size === 127) {if (bytes.length < 10) return; size = Number(bytes.readBigUInt64BE(2)); offset = 10;}
          if (bytes.length < offset + size) return;
          frames.push({kind: bytes[0] & 15, data: bytes.subarray(offset, offset + size)});
          bytes = bytes.subarray(offset + size);
        }
      };
      socket.on('data', receive); socket.on('error', () => {}); receive(head);
      resolve({status: 101, socket, frames});
    });
    req.setTimeout(5000, () => req.destroy(Error('relay fixture timeout')));
    req.on('error', reject); req.end();
  });
}

function sendBrowser(socket: net.Socket, kind: number, data: Buffer) {
  assert.ok(data.length < 126);
  // Test-owned client masking key; server frames are never masked.
  socket.write(Buffer.concat([Buffer.from([0x80 | kind, 0x80 | data.length]), Buffer.alloc(4), data]));
}

test('relay waits for a strict native handshake and never falls back on refusal or uncertainty', {timeout: 15000}, async () => {
  const where = await scratchHome('mesh-binding-handshake-', {MESH_WHISPER_URL: ''});
  const socketPath = path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh', 'ptyhost.sock');
  fs.mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});
  const requests: any[] = [], peers = new Set<net.Socket>();
  let respond: (peer: net.Socket) => void = () => {};
  const owner = net.createServer(peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', () => {});
    let bytes = Buffer.alloc(0);
    peer.on('data', (part: Buffer) => {
      bytes = Buffer.concat([bytes, part]);
      if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt32BE(1)) return;
      const body = JSON.parse(bytes.subarray(5, 5 + bytes.readUInt32BE(1)).toString());
      peer.removeAllListeners('data');
      if (!body.op.startsWith('attach')) {peer.end(frame('C', [])); return;}
      requests.push(body); respond(peer);
    });
  });
  await new Promise<void>(resolve => owner.listen(socketPath, resolve));
  const server = await runServer(where);
  try {
    assert.equal(server.result.listened, true, server.output());
    const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    for (const response of [frame('C', {ok: false, outcome: 'denied'}), frame('C', {ok: false, outcome: 'indeterminate'}),
      frame('C', {ok: true, outcome: 'indeterminate'}), frame('D', {ok: true}), frame('C', {ok: 1}),
      frame('C', []), frame('C', Buffer.from('{')), Buffer.alloc(0)]) {
      respond = peer => peer.end(response);
      assert.equal((await relay(where.port, token, '&created=1')).status, 404);
    }
    let release: () => void = () => {};
    respond = peer => {release = () => peer.write(Buffer.concat([frame('C', {ok: true, replay_geometry: {rows: 50, cols: 200}}), frame('D', Buffer.alloc(0))]));};
    let upgraded = false;
    const pending = relay(where.port, token, '&created=1').then(result => {upgraded = true; return result;});
    await until(() => requests.length === 9);
    await delay(20); assert.equal(upgraded, false, 'no upgrade/bound before the native response');
    release();
    const good = await pending; assert.equal(good.status, 101);
    await until(() => good.frames.length === 3);
    assert.deepEqual(good.frames.map(item => item.kind), [1, 1, 2]);
    assert.deepEqual(good.frames.slice(0, 2).map(item => JSON.parse(item.data.toString())),
      [{t: 'bound', name: 'alpha', created: 1}, {t: 'g', rows: 50, cols: 200}]);
    assert.deepEqual(requests, Array.from({length: 9}, () => ({op: 'attach_if', name: 'alpha', created: 1, rows: 31, cols: 91})));
    good.socket!.destroy();
    for (const value of ['0', '-1', 'true', 'false', 'NaN', 'Infinity', '1e999', '', '1&created=1'])
      assert.equal((await relay(where.port, token, `&created=${value}`)).status, 400, value);
    assert.equal(requests.length, 9, 'invalid incarnations never contact the host');
    respond = peer => peer.write(Buffer.concat([frame('C', {ok: true, replay_geometry: {rows: 50, cols: 200}}), frame('D', Buffer.alloc(0))]));
    const legacy = await relay(where.port, token, '');
    try {
      assert.equal(legacy.status, 101);
      await until(() => legacy.frames.length === 2);
      assert.deepEqual(legacy.frames.map(item => item.kind), [1, 2]);
      assert.deepEqual(JSON.parse(legacy.frames[0].data.toString()), {t: 'g', rows: 50, cols: 200});
      assert.deepEqual(requests[9], {op: 'attach', name: 'alpha', rows: 31, cols: 91});
    } finally { legacy.socket?.destroy(); }
  } finally {
    for (const peer of peers) peer.destroy();
    await stopServer(server.child);
    await new Promise<void>(resolve => owner.close(() => resolve()));
    removeScratch(where.scratch);
  }
});

test('AC-7: conditional incarnation binding acknowledgement', {timeout: 30000}, async () => {
  const where = await scratchHome('mesh-binding-', {SHELL: '/bin/bash', MESH_WHISPER_URL: ''});
  const command = process.env.MESH_PTYHOST_CMD;
  assert.ok(command && path.isAbsolute(command), 'MESH_PTYHOST_CMD must name the private native build');
  const host = spawn(command, [], {env: where.env, stdio: ['ignore', 'ignore', 'pipe']});
  const socketPath = path.join(where.env.XDG_RUNTIME_DIR!, 'session-mesh', 'ptyhost.sock');
  let hostErrors = ''; host.stderr.on('data', chunk => {hostErrors += chunk;});
  let server: Awaited<ReturnType<typeof runServer>> | undefined;
  const connections: net.Socket[] = [];
  try {
    await until(async () => {assert.equal(host.exitCode, null, hostErrors); try {return Array.isArray(await native(socketPath, {op: 'list'}));} catch {return false;}});
    server = await runServer(where); assert.equal(server.result.listened, true, server.output());
    const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    const oracle = path.join(where.home, 'editor.json');
    const editor = path.join(where.home, 'editor.cjs');
    fs.writeFileSync(editor, `const fs=require('node:fs');require('node:child_process').execFileSync('stty',['raw','-echo'],{stdio:'inherit'});
      let input='';const save=()=>{fs.writeFileSync(${JSON.stringify(oracle + '.tmp')},JSON.stringify({rows:process.stdout.rows,cols:process.stdout.columns,input}));fs.renameSync(${JSON.stringify(oracle + '.tmp')},${JSON.stringify(oracle)});};
      process.stdout.on('resize',()=>{save();process.stdout.write('RESIZED:'+process.stdout.rows+'x'+process.stdout.columns);});
      process.stdin.on('data',part=>{input+=part;save();});save();process.stdout.write('EDITOR_READY:'+process.stdout.rows+'x'+process.stdout.columns);`);
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    const create = async () => {
      fs.rmSync(oracle, {force: true});
      assert.deepEqual(await native(socketPath, {op: 'new', name: 'alpha', cwd: where.home,
        command: `exec ${quote(process.execPath)} ${quote(editor)}`}), {ok: true, name: 'alpha'});
      await until(() => fs.existsSync(oracle));
      const [session] = await native(socketPath, {op: 'list'}); return session.created as number;
    };
    const first = await create();
    assert.deepEqual(await native(socketPath, {op: 'kill', name: 'alpha'}), {ok: true});
    await until(async () => (await native(socketPath, {op: 'list'})).length === 0);
    const replacement = await create(); assert.notEqual(first, replacement);
    const before = fs.readFileSync(oracle, 'utf8');
    assert.equal((await relay(where.port, token, `&created=${first}&pty_size=1`)).status, 404,
      'stale incarnation must refuse before upgrading, resize or input');
    for (const value of ['0', '-1', 'true', 'false', 'NaN', 'Infinity', '1e999', '', '1&created=1']) {
      assert.equal((await relay(where.port, token, `&created=${value}`)).status, 400, value);
    }
    assert.equal((await relay(where.port, token, `&created=${replacement}`, false)).status, 401);
    await delay(80);
    assert.equal(fs.readFileSync(oracle, 'utf8'), before, 'replacement geometry and input untouched by all denied attaches');
    const oldSize = JSON.parse(before);
    const raw = await nativeReplay(socketPath, {op: 'attach_if', name: 'alpha', created: replacement, rows: 37, cols: 101});
    assert.deepEqual(raw.reply.replay_geometry, {rows: oldSize.rows, cols: oldSize.cols},
      'native C must name the replay geometry captured before conditional resize');
    assert.equal(raw.reply.ok, true);
    assert.ok(raw.replay.includes(`EDITOR_READY:${oldSize.rows}x${oldSize.cols}`), 'native D replays the original-size bytes');
    assert.equal(raw.replay.includes('RESIZED:37x101'), false, 'resize output cannot enter the captured initial replay');
    await until(() => JSON.parse(fs.readFileSync(oracle, 'utf8')).rows === 37);
    const good = await relay(where.port, token, `&created=${replacement}&pty_size=1`);
    assert.equal(good.status, 101); connections.push(good.socket!);
    await until(() => good.frames.some(item => item.kind === 2));
    const controls = good.frames.filter(item => item.kind === 1).map(item => JSON.parse(item.data.toString()));
    assert.deepEqual(controls.filter(item => item.t === 'bound'), [{t: 'bound', name: 'alpha', created: replacement}]);
    assert.deepEqual(controls.filter(item => item.t === 'g'), [{t: 'g', rows: 37, cols: 101}]);
    assert.deepEqual(good.frames.slice(0, 3).map(item => item.kind), [1, 1, 2]);
    assert.equal(good.frames[0].kind, 1);
    assert.equal(JSON.parse(good.frames[0].data.toString()).t, 'bound', 'bound precedes geometry and binary replay');
    await until(() => JSON.parse(fs.readFileSync(oracle, 'utf8')).rows === 31);
    sendBrowser(good.socket!, 1, Buffer.from(JSON.stringify({t: 'r', rows: 32, cols: 92})));
    sendBrowser(good.socket!, 2, Buffer.from('native-input'));
    await until(() => {
      const state = JSON.parse(fs.readFileSync(oracle, 'utf8'));
      return state.rows === 32 && state.cols === 92 && state.input === 'native-input';
    });
    const follower = await relay(where.port, token, `&created=${replacement}&pty_size=1`);
    assert.equal(follower.status, 101); connections.push(follower.socket!);
    await until(() => follower.frames.some(item => item.kind === 1 && JSON.parse(item.data.toString()).t === 's'));
    assert.deepEqual(follower.frames.slice(0, 4).map(item => item.kind), [1, 1, 2, 1],
      'bound and captured geometry precede replay; ownership follows replay');
    const ownership = (frames: typeof follower.frames) => frames.filter(item => item.kind === 1)
      .map(item => JSON.parse(item.data.toString())).filter(item => item.t === 's');
    assert.deepEqual(ownership(follower.frames).at(-1), {t: 's', rows: 32, cols: 92, owner: 'other'});
    assert.equal(JSON.parse(fs.readFileSync(oracle, 'utf8')).rows, 32, 'a conditional claim cannot steal the size');
    sendBrowser(follower.socket!, 1, Buffer.from(JSON.stringify({t: 'r', rows: 33, cols: 93})));
    await until(() => ownership(follower.frames).length >= 2);
    assert.deepEqual(ownership(follower.frames).at(-1), {t: 's', rows: 32, cols: 92, owner: 'other'});
    sendBrowser(follower.socket!, 1, Buffer.from(JSON.stringify({t: 'r', rows: 33, cols: 93, size: 'take'})));
    await until(() => ownership(follower.frames).at(-1)?.owner === 'you');
    await until(() => JSON.parse(fs.readFileSync(oracle, 'utf8')).rows === 33);
    assert.deepEqual(ownership(follower.frames).at(-1), {t: 's', rows: 33, cols: 93, owner: 'you'});
    const legacy = await relay(where.port, token, ''); assert.equal(legacy.status, 101); connections.push(legacy.socket!);
    await until(() => legacy.frames.some(item => item.kind === 2));
    assert.equal(legacy.frames.some(item => item.kind === 1 && JSON.parse(item.data.toString()).t === 'bound'), false);
  } finally {
    for (const socket of connections) socket.destroy();
    if (server) await stopServer(server.child);
    await native(socketPath, {op: 'kill', name: 'alpha'}).catch(() => {});
    if (host.exitCode === null && host.signalCode === null) {const closed = once(host, 'close'); host.kill('SIGTERM'); await closed;}
    removeScratch(where.scratch);
  }
});
