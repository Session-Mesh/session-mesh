// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Session lifecycle defects of the PTY host, each reproduced against a real host process:
// - a second host deleted the socket of a running one, whose sessions became unreachable;
// - after `sleep 300 & exit` the background job held the terminal open: no EOF, so the shell
//   stayed a zombie, the session stayed listed and `kill` answered ok without effect;
// - a program that ignores SIGHUP survived `kill` for good;
// - a dirty human-input lease whose page never came back deferred agent wakes forever.
// Host under test: see ptyhost-command.ts.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {ptyhostArgv} from './ptyhost-command.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const HOST_ARGV = ptyhostArgv();

type SessionInfo = {name: string; pid: number; created: number};
type Frame = {kind: string; payload: Buffer};

const scratches: string[] = [];
const hosts: ChildProcess[] = [];
const strays: number[] = [];

after(() => {
  for (const host of hosts) host.kill('SIGKILL');
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true});
});

class Host {
  readonly home: string;
  readonly socketPath: string;
  readonly runtime: string;
  readonly env: NodeJS.ProcessEnv;
  process: ChildProcess;

  constructor(shellScript: string, extraEnv: Record<string, string> = {}) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-life-'));
    scratches.push(scratch);
    this.home = path.join(scratch, 'home');
    this.runtime = path.join(scratch, 'run');
    this.socketPath = path.join(this.runtime, 'session-mesh', 'ptyhost.sock');
    fs.mkdirSync(this.home);
    fs.mkdirSync(this.runtime, {mode: 0o700});
    const shell = path.join(scratch, 'shell.sh');
    fs.writeFileSync(shell, shellScript, {mode: 0o700});
    this.env = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.home, XDG_RUNTIME_DIR: this.runtime, SHELL: shell, LANG: 'C', ...extraEnv};
    this.process = this.start();
  }

  start(): ChildProcess {
    const child = spawn(HOST_ARGV[0], HOST_ARGV.slice(1), {cwd: REPO, env: this.env, stdio: ['ignore', 'ignore', 'pipe']});
    child.stderr?.setEncoding('utf8');
    let stderr = '';
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    Object.defineProperty(child, 'stderrText', {get: () => stderr});
    hosts.push(child);
    return child;
  }

  async ready(): Promise<void> {
    // The socket file exists before the host listens on it: wait for an answer, not for the file.
    await waitFor('ptyhost answering', 10000, async () => {
      assert.equal(this.process.exitCode, null, 'ptyhost exited early');
      return await this.request({op: 'list'}).then(() => true, () => false);
    });
  }

  request(payload: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let received = Buffer.alloc(0);
      socket.setTimeout(5000, () => socket.destroy(new Error('ptyhost did not answer')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(encode('C', Buffer.from(JSON.stringify(payload)))));
      socket.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.length < 5 || received.length < 5 + received.readUInt32BE(1)) return;
        socket.destroy();
        resolve(JSON.parse(received.subarray(5, 5 + received.readUInt32BE(1)).toString('utf8')));
      });
    });
  }

  async sessions(): Promise<SessionInfo[]> {
    return await this.request({op: 'list'}) as SessionInfo[];
  }

  async attach(name: string): Promise<Attachment> {
    const attachment = new Attachment(net.createConnection(this.socketPath));
    attachment.socket.write(encode('C', Buffer.from(JSON.stringify({op: 'attach', name, rows: 24, cols: 80}))));
    const reply = await attachment.next('C');
    assert.equal(JSON.parse(reply.payload.toString('utf8')).ok, true);
    return attachment;
  }
}

class Attachment {
  readonly frames: Frame[] = [];
  closed = false;
  private buffer = Buffer.alloc(0);
  readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 5 && this.buffer.length >= 5 + this.buffer.readUInt32BE(1)) {
        const length = this.buffer.readUInt32BE(1);
        this.frames.push({kind: this.buffer.subarray(0, 1).toString('latin1'), payload: this.buffer.subarray(5, 5 + length)});
        this.buffer = this.buffer.subarray(5 + length);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  async next(kind: string): Promise<Frame> {
    await waitFor(`a ${kind} frame`, 10000, () => this.frames.some(frame => frame.kind === kind));
    const index = this.frames.findIndex(frame => frame.kind === kind);
    return this.frames.splice(index, 1)[0];
  }

  output(): string {
    return Buffer.concat(this.frames.filter(frame => frame.kind === 'D').map(frame => frame.payload)).toString('latin1');
  }

  send(kind: string, payload: Buffer | object): void {
    this.socket.write(encode(kind, Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))));
  }

  async close(): Promise<void> {
    this.socket.end();
    this.socket.destroy();
    await waitFor('attachment closed', 5000, () => this.closed);
  }
}

function encode(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(kind, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

async function waitFor(what: string, timeoutMs: number, done: () => boolean | Promise<boolean>): Promise<number> {
  const start = performance.now();
  while (!(await done())) {
    if (performance.now() - start > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return performance.now() - start;
}

function exists(pid: number): boolean {
  return fs.existsSync(`/proc/${pid}`);
}

const BASH = '#!/bin/sh\nexec bash --noprofile --norc -i\n';

for (const observed of [false, true]) test(`quiet legacy attach needs only its replay before input (observer ${observed})`, async t => {
  const host = new Host('#!/bin/sh\nstty -echo\n: > "$HOME/ready"\nwhile IFS= read -r line; do\n'
    + 'case "$line" in size) stty size;; esac\ndone\n', observed ? {MESH_PTY_OBSERVE_BASENAME: 'trace.ndjson'} : {});
  await host.ready();
  assert.deepEqual(await host.request({op: 'new', name: 'quiet', cwd: host.home, command: null}), {ok: true, name: 'quiet'});
  await waitFor('the silent program to disable input echo', 5000, () => fs.existsSync(path.join(host.home, 'ready')));
  const attachment = new Attachment(net.createConnection(host.socketPath));
  attachment.send('C', {op: 'attach', name: 'quiet', rows: 31, cols: 71});
  await waitFor('C then D replay frames', 10000, () => attachment.frames.length >= 2);
  const acknowledgement = attachment.frames.shift()!;
  assert.equal(acknowledgement.kind, 'C', 'acknowledgement precedes replay');
  const control = JSON.parse(acknowledgement.payload.toString());
  assert.equal(control.ok, true);
  assert.ok(control.replay_geometry, 'legacy replay geometry is metadata in the C acknowledgement');
  const replay = attachment.frames.shift()!;
  assert.equal(replay.kind, 'D', 'the second frame is the replay');
  assert.equal(replay.payload.length, 0, 'even a quiet legacy attach emits one empty D replay');
  assert.deepEqual(attachment.frames, [], 'no separate geometry or unsolicited output frame is needed');
  t.diagnostic(`legacy attach: C(ok, replay_geometry), D(${replay.payload.length} bytes); next output follows input`);
  attachment.send('D', Buffer.from('size\n'));
  await waitFor('initial requested PTY size', 5000, () => attachment.output().includes('31 71'));
  attachment.frames.length = 0;
  attachment.send('R', {rows: 33, cols: 73});
  attachment.send('D', Buffer.from('size\n'));
  await waitFor('resized PTY size', 5000, () => attachment.output().includes('33 73'));
  assert.equal((await host.sessions()).length, 1);
  await attachment.close();
});

test('retained output never advertises a later silent resize as its geometry', async t => {
  const host = new Host('#!/bin/sh\nstty -echo\n: > "$HOME/ready"\nwhile IFS= read -r line; do stty size; done\n');
  await host.ready();
  const name = 'geometry';
  assert.deepEqual(await host.request({op: 'new', name, cwd: host.home, command: null}), {ok: true, name});
  await waitFor('silent shell ready', 5000, () => fs.existsSync(path.join(host.home, 'ready')));
  const [{created, pid}] = await host.sessions();
  strays.push(pid);
  const open = async (fields: object) => {
    const attachment = new Attachment(net.createConnection(host.socketPath));
    t.after(() => attachment.close());
    attachment.send('C', fields);
    await waitFor('attach reply and replay', 5000, () => attachment.frames.length >= 2);
    assert.equal(attachment.frames[0].kind, 'C');
    assert.equal(attachment.frames[1].kind, 'D');
    const reply = JSON.parse(attachment.frames[0].payload.toString());
    assert.equal(reply.ok, true);
    return {attachment, reply, bytes: attachment.frames[1].payload};
  };
  const initial = await open({op: 'attach', name, rows: 31, cols: 80});
  initial.attachment.send('D', Buffer.from('size\n'));
  await waitFor('output drawn at the initial width', 5000, () => initial.attachment.output().includes('31 80'));
  const resize = await open({op: 'attach', name, rows: 37, cols: 120});
  assert.match(resize.bytes.toString(), /31 80/);

  for (const fields of [{op: 'attach', name}, {op: 'attach_if', name, created}]) {
    const replay = await open(fields);
    assert.deepEqual(replay.bytes, resize.bytes, 'the resize emitted no replacement output');
    assert.equal(replay.reply.replay_geometry, undefined, 'uncertain geometry is omitted');
  }
});

test('a second host refuses to start and leaves the running one reachable', async () => {
  const host = new Host(BASH);
  await host.ready();
  assert.deepEqual(await host.request({op: 'new', name: 'kept', cwd: host.home, command: null}), {ok: true, name: 'kept'});
  const [{pid}] = await host.sessions();
  strays.push(pid);

  const second = host.start();
  await waitFor('the second host exits', 5000, () => second.exitCode !== null || second.signalCode !== null);
  assert.notEqual(second.exitCode, 0, 'the second host must not run');
  assert.match((second as unknown as {stderrText: string}).stderrText, /not starting/);

  assert.deepEqual((await host.sessions()).map(session => session.name), ['kept']);
  assert.equal(fs.existsSync(host.socketPath), true);
});

test('a host started after one stopped replaces its stale socket', async () => {
  const host = new Host(BASH);
  await host.ready();
  host.process.kill('SIGKILL');
  await new Promise(resolve => host.process.on('exit', resolve));
  assert.equal(fs.existsSync(host.socketPath), true, 'a killed host leaves its socket behind');
  host.process = host.start();
  await host.ready();
  assert.deepEqual(await host.sessions(), []);
});

test('a session ends when its program exits while a background job holds the terminal', async t => {
  const host = new Host(BASH);
  await host.ready();
  assert.deepEqual(await host.request({op: 'new', name: 'bg', cwd: host.home, command: null}), {ok: true, name: 'bg'});
  const [{pid}] = await host.sessions();
  strays.push(pid);
  const attachment = await host.attach('bg');
  attachment.send('D', Buffer.from("sleep 300 & echo BG=$!; exit\r"));
  await waitFor('background job started', 10000, () => /BG=\d+/.test(attachment.output()));
  const background = Number(/BG=(\d+)/.exec(attachment.output())?.[1]);
  strays.push(background);

  const elapsed = await waitFor('session gone from the listing', 5000, async () => (await host.sessions()).length === 0);
  t.diagnostic(`session gone ${elapsed.toFixed(0)} ms after the background job started`);
  const exit = await attachment.next('X');
  assert.deepEqual(JSON.parse(exit.payload.toString('utf8')), {code: 0});
  assert.equal(exists(pid), false, 'the shell was reaped, not left a zombie');
  assert.deepEqual(await host.request({op: 'kill', name: 'bg'}), {ok: false});
});

test('kill ends a program that ignores SIGHUP', async t => {
  const ignoring = '#!/bin/sh\ntrap "" HUP\n: > "$HOME/ready"\nwhile :; do sleep 0.05; done\n';
  const host = new Host(ignoring);
  await host.ready();
  assert.deepEqual(await host.request({op: 'new', name: 'deaf', cwd: host.home, command: null}), {ok: true, name: 'deaf'});
  const [{pid}] = await host.sessions();
  strays.push(pid);
  await waitFor('session program started', 10000, () => fs.existsSync(path.join(host.home, 'ready')));
  assert.deepEqual(await host.request({op: 'kill', name: 'deaf'}), {ok: true});
  // SIGHUP series: 7.75 s; SIGKILL 4 s after its last signal.
  const elapsed = await waitFor('session gone from the listing', 20000, async () => (await host.sessions()).length === 0);
  t.diagnostic(`session gone ${elapsed.toFixed(0)} ms after kill`);
  assert.equal(exists(pid), false);
});

test('a dirty input lease defers wakes only for a bounded time once its client is gone', async () => {
  const host = new Host(BASH, {MESH_PTYHOST_HUMAN_LEASE_GRACE: '1'});
  await host.ready();
  assert.deepEqual(await host.request({op: 'new', name: 'leased', cwd: host.home, command: null}), {ok: true, name: 'leased'});
  const [session] = await host.sessions();
  strays.push(session.pid);
  const wake = {op: 'notify_if', name: 'leased', created: session.created, notification_id: 'wake_notification_0001',
    count: 1, through_seq: 1, agent: 'codex', idle_since: Date.now() / 1000 + 3600};
  const clientId = 'browser_client_00000001';

  const first = await host.attach('leased');
  first.send('H', {client_id: clientId, dirty: true});
  await waitFor('lease recorded', 5000, async () => (await host.request(wake) as {reason?: string}).reason === 'human_dirty');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(await host.request(wake), {ok: false, reason: 'human_dirty'}, 'held while its client is attached');

  await first.close();
  assert.deepEqual(await host.request(wake), {ok: false, reason: 'human_dirty'}, 'survives a disconnect');
  const second = await host.attach('leased');
  second.send('H', {client_id: clientId, dirty: true});
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(await host.request(wake), {ok: false, reason: 'human_dirty'}, 'asserted again on reconnection');

  await second.close();
  await new Promise(resolve => setTimeout(resolve, 1500));
  // The lease is gone: the wake is now refused only because no agent is in the foreground.
  assert.deepEqual(await host.request(wake), {ok: false, reason: 'unsupported_foreground'});
});
