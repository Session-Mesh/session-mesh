// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// server.py refuses, before listening and before creating anything in its config dir, a MESH_HOST outside
// loopback (the empty value included: it would listen on every interface; IPv4-mapped and scoped IPv6 forms
// too). Only MESH_ALLOW_NON_LOOPBACK=1 lets one through, with a warning.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const REFUSAL = /refusing MESH_HOST=/;
const WARNING = /WARNING: listening on .*outside loopback/;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'host-loopback-'));
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

type Outcome = {code: number | null; output: string; listened: boolean; created: string[]};

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({host, port}, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

function environment(home: string, host: string | undefined, port: number, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = path.join(home, 'run');
  fs.mkdirSync(runtime, {mode: 0o700});
  const env: NodeJS.ProcessEnv = {...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, MESH_RUNTIME_DIR: undefined,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    MESH_CONF_DIR: path.join(home, '.config', 'session-mesh'), MESH_CACHE_DIR: path.join(home, '.cache', 'session-mesh'),
    MESH_PORT: String(port)};
  delete env.MESH_ALLOW_NON_LOOPBACK;
  delete env.MESH_HOST;
  if (host !== undefined) env.MESH_HOST = host;
  return {...env, ...extra};
}

const IPV6 = await new Promise<boolean>(resolve => {
  const probe = net.createServer().on('error', () => resolve(false)).listen(0, '::1', () => probe.close(() => resolve(true)));
});
// Both loopbacks: a server bound to `::` alone (no IPv4) still answers quickly on ::1.
const PROBES = IPV6 ? ['127.0.0.1', '::1'] : ['127.0.0.1'];

async function acceptsAny(hosts: string[], port: number): Promise<boolean> {
  return (await Promise.all(hosts.map(host => accepts(host, port)))).some(Boolean);
}

// Everything under `home` except the runtime dir the test made itself.
function createdUnder(home: string): string[] {
  return (fs.readdirSync(home, {recursive: true}) as string[]).filter(entry => entry !== 'run').sort();
}

// Starts server.py, waits until it either exits or accepts a connection on a loopback, then stops it.
async function start(host: string | undefined, extra: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const child = spawn(PYTHON, ['server.py'], {cwd: REPO, env: environment(home, host, port, extra), stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  let code: number | null = null;
  let exited = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise<void>(resolve => child.on('close', status => { code = status; exited = true; resolve(); }));
  let listened = false;
  for (let attempt = 0; attempt < 200 && !exited && !listened; attempt += 1) {
    listened = await acceptsAny(PROBES, port);
    if (!listened) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!exited) child.kill('SIGTERM');
  await closed;
  return {code: listened ? null : code, output, listened, created: createdUnder(home)};
}

describe('MESH_HOST is refused outside loopback', () => {
  for (const host of ['0.0.0.0', '', '::', '192.0.2.1', 'example.invalid', '::ffff:127.0.0.1', '::1%lo']) {
    test(`MESH_HOST=${JSON.stringify(host)} stops before listening, without a trace or a config file`, async () => {
      const outcome = await start(host);
      assert.equal(outcome.listened, false, outcome.output);
      assert.notEqual(outcome.code, 0, outcome.output);
      assert.match(outcome.output, REFUSAL);
      assert.doesNotMatch(outcome.output, /Traceback/);
      assert.deepEqual(outcome.created, [], 'files created before the refusal');
    });
  }

  test('the default (unset) starts on 127.0.0.1', async () => {
    const outcome = await start(undefined);
    assert.equal(outcome.listened, true, outcome.output);
    assert.doesNotMatch(outcome.output, REFUSAL);
  });

  test('MESH_HOST=127.0.0.1 starts', async () => {
    const outcome = await start('127.0.0.1');
    assert.equal(outcome.listened, true, outcome.output);
  });

  test('MESH_HOST=localhost starts', async () => {
    const outcome = await start('localhost');
    assert.equal(outcome.listened, true, outcome.output);
  });

  test('MESH_HOST=::1 starts', {skip: !IPV6 && 'no IPv6 loopback'}, async () => {
    const outcome = await start('::1');
    assert.equal(outcome.listened, true, outcome.output);
  });

  test('MESH_ALLOW_NON_LOOPBACK=1 lets another address through, with a warning', async () => {
    // 192.0.2.1 (TEST-NET-1) is not assigned here: the bind itself fails, so nothing listens off loopback.
    const outcome = await start('192.0.2.1', {MESH_ALLOW_NON_LOOPBACK: '1'});
    assert.doesNotMatch(outcome.output, REFUSAL);
    assert.match(outcome.output, WARNING);
  });

  for (const value of ['yes', ' 1', 'true']) {
    test(`MESH_ALLOW_NON_LOOPBACK=${JSON.stringify(value)} still refuses`, async () => {
      const outcome = await start('0.0.0.0', {MESH_ALLOW_NON_LOOPBACK: value});
      assert.equal(outcome.listened, false, outcome.output);
      assert.match(outcome.output, REFUSAL);
    });
  }
});
