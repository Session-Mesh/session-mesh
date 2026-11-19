// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A stand-in PTY host for server tests: it speaks the host's control protocol (one frame per request: a kind
// byte, a 32-bit big-endian length, a JSON payload) on a Unix socket and answers `list` with the sessions
// a control file names, `update_notice` with the notice it names, and anything else with the error an
// older host gives. It runs as a process of its own, so that restarting it changes the host identity the
// web server reads from the socket's peer credentials.
//
// The control file is read at every request, so a test changes the host's behaviour by rewriting it:
//   sessions    the `list` reply (FakeSession[])
//   firstList   names: the first `list` this process answers holds only these sessions
//   silent      accept requests and never answer
//   slowFrom    the `list` requests from this number on (1 is the first) wait `delayMs` before the reply
//   update      the update notice (null: none)
// Every request's `op` is appended to `<control>.log`, one per line, so that a test can count them.
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type FakeSession = {name: string; pid: number; cwd: string; created: number; activity: number;
  attached: number; meta: Record<string, unknown>};
export type FakeControl = {sessions: FakeSession[]; firstList?: string[]; silent?: boolean; slowFrom?: number;
  delayMs?: number; update?: Record<string, unknown> | null};

function frame(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body));
  const head = Buffer.alloc(5);
  head.write('C', 'latin1');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function serve(socketPath: string, controlPath: string): void {
  let lists = 0;
  fs.rmSync(socketPath, {force: true});
  net.createServer(connection => {
    let received = Buffer.alloc(0);
    connection.on('error', () => undefined);
    connection.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 5 || received.length < 5 + received.readUInt32BE(1)) return;
      const request = JSON.parse(received.subarray(5, 5 + received.readUInt32BE(1)).toString('utf8')) as {op?: string};
      received = Buffer.alloc(0);
      const control = JSON.parse(fs.readFileSync(controlPath, 'utf8')) as FakeControl;
      fs.appendFileSync(`${controlPath}.log`, `${request.op}\n`);
      if (control.silent) return;
      let reply: unknown = {error: 'invalid request'};
      let delay = 0;
      if (request.op === 'list') {
        lists += 1;
        const first = lists === 1 && control.firstList ? new Set(control.firstList) : null;
        reply = first ? control.sessions.filter(session => first.has(session.name)) : control.sessions;
        if (control.slowFrom !== undefined && lists >= control.slowFrom) delay = control.delayMs ?? 1000;
      } else if (request.op === 'update_notice') {
        reply = {ok: true, update: control.update ?? null};
      }
      setTimeout(() => connection.end(frame(reply)), delay);
    });
  }).listen(socketPath);
}

export type FakeHost = {control: (next: FakeControl) => void; ops: () => string[]; restart: (next: FakeControl) => Promise<void>;
  stop: () => Promise<void>};

/** Start the fake host on `socketPath`; its control file and log live next to it. */
export async function startFakeHost(socketPath: string, initial: FakeControl): Promise<FakeHost> {
  fs.mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});
  const controlPath = `${socketPath}.control.json`;
  const control = (next: FakeControl) => fs.writeFileSync(controlPath, JSON.stringify(next));
  let child: ChildProcess;
  const start = async () => {
    fs.rmSync(socketPath, {force: true});
    child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', import.meta.filename, socketPath, controlPath],
      {stdio: 'ignore'});
    for (let attempt = 0; !fs.existsSync(socketPath); attempt += 1) {
      if (attempt > 400) throw new Error('the fake PTY host did not listen');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  };
  control(initial);
  await start();
  return {
    control,
    ops: () => (fs.existsSync(`${controlPath}.log`) ? fs.readFileSync(`${controlPath}.log`, 'utf8') : '').split('\n').filter(Boolean),
    restart: async next => { await stop(); control(next); await start(); },
    stop,
  };
}

/** `count` idle processes, each the leader of its own session, as the PTY host's shells are. */
export function sleepers(count: number): {pids: number[]; kill: () => void} {
  const children = Array.from({length: count}, () => spawn('sleep', ['600'], {detached: true, stdio: 'ignore'}));
  return {pids: children.map(child => child.pid!), kill: () => { for (const child of children) child.kill('SIGKILL'); }};
}

if (process.argv[1] === import.meta.filename) serve(process.argv[2]!, process.argv[3]!);
