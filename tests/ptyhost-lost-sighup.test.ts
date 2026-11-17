// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// `kill` ends a session with SIGHUP, and a shell can lose one signal: bash that receives it while
// starting records it, then waits for input without acting on it, so the session stayed listed
// for good (on Ubuntu 24.04, 26 of 300 kills sent 1 ms after `new`). The host therefore repeats
// the signal while the session's program has not exited. The session's program here loses the
// first SIGHUP every time, which makes the case deterministic: it only ends on a second one.
// Host under test: see ptyhost-command.ts.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {ptyhostArgv} from './ptyhost-command.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const HOST_ARGV = ptyhostArgv();
// The host repeats the signal 250 ms after the first one: measured 257 to 312 ms from the kill
// request to the empty listing on an idle machine. Without the repeat the session never ends, so
// the margin does not hide the defect.
const GONE_TIMEOUT_MS = 5000;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-lost-hup-'));
const home = path.join(scratch, 'home');
const runtime = path.join(scratch, 'run');
const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
const ready = path.join(home, 'ready');
const firstLost = path.join(home, 'first-lost');
const shell = path.join(scratch, 'loses-first-sighup.sh');
const SHELL_SCRIPT = `#!/bin/sh
trap 'if [ -e "$HOME/first-lost" ]; then exit 0; fi; : > "$HOME/first-lost"' HUP
: > "$HOME/ready"
while :; do sleep 0.05; done
`;
let host: ChildProcess;
let sessionPid = 0;

type SessionInfo = {name: string; pid: number};

function request(payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error('ptyhost did not answer')));
    socket.on('error', reject);
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify(payload));
      const head = Buffer.alloc(5);
      head.write('C');
      head.writeUInt32BE(body.length, 1);
      socket.write(Buffer.concat([head, body]));
    });
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 5 || received.length < 5 + received.readUInt32BE(1)) return;
      socket.destroy();
      resolve(JSON.parse(received.subarray(5, 5 + received.readUInt32BE(1)).toString('utf8')));
    });
  });
}

async function waitFor(what: string, timeoutMs: number, done: () => boolean | Promise<boolean>): Promise<number> {
  const start = performance.now();
  while (!(await done())) {
    if (performance.now() - start > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return performance.now() - start;
}

async function sessions(): Promise<SessionInfo[]> {
  return await request({op: 'list'}) as SessionInfo[];
}

before(async () => {
  fs.mkdirSync(home);
  fs.mkdirSync(runtime, {mode: 0o700});
  fs.writeFileSync(shell, SHELL_SCRIPT, {mode: 0o700});
  const env = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime, SHELL: shell, LANG: 'C'};
  host = spawn(HOST_ARGV[0], HOST_ARGV.slice(1), {cwd: REPO, env, stdio: 'ignore'});
  // The socket file exists before the host listens on it: wait for an answer, not for the file.
  await waitFor('ptyhost answering', 10000, async () => {
    assert.equal(host.exitCode, null, 'ptyhost exited early');
    return await sessions().then(() => true, () => false);
  });
});

after(() => {
  host.kill('SIGTERM');
  if (sessionPid) {
    try {
      process.kill(-sessionPid, 'SIGKILL');
    } catch {
      // The session ended, as the test expects.
    }
  }
  fs.rmSync(scratch, {recursive: true, force: true});
});

test('kill ends a session whose program lost the first SIGHUP', async t => {
  assert.deepEqual(await request({op: 'new', name: 'lost', cwd: home, command: null}), {ok: true, name: 'lost'});
  [{pid: sessionPid}] = await sessions();
  await waitFor('session program started', 10000, () => fs.existsSync(ready));
  assert.deepEqual(await request({op: 'kill', name: 'lost'}), {ok: true});
  const elapsed = await waitFor('session gone from the listing', GONE_TIMEOUT_MS, async () => (await sessions()).length === 0);
  t.diagnostic(`session gone ${elapsed.toFixed(0)} ms after kill`);
  assert.equal(fs.existsSync(firstLost), true, 'the program lost a first SIGHUP');
  assert.equal(fs.existsSync(`/proc/${sessionPid}`), false, 'the session program was reaped');
});
