// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {isBindCollision, retryBindCollision} from './helpers/bind-retry.ts';
import {runServer, scratchHome, startMesh, type Scratch} from './mesh-server-lib.ts';

const collision = (errno: number) =>
  `OSError: [Errno ${errno}] error while attempting to bind on address: address already in use`;

/** Model a child that has already exited: no server or socket is started by these tests. */
function fixture(outcomes: Array<string | null>) {
  const scratches: string[] = [];
  const ports: number[] = [];
  const create: typeof scratchHome = async (_prefix, env = {}) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-bind-retry-'));
    scratches.push(scratch);
    const port = 41000 + scratches.length;
    ports.push(port);
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home);
    return {scratch, home, confDir: path.join(home, 'config'), port,
      env: {MESH_PORT: String(port), ...env}};
  };
  const run: typeof runServer = async (_where: Scratch) => {
    const result = outcomes.shift();
    assert.notEqual(result, undefined, 'unexpected extra attempt');
    const output = result ?? '';
    const child = {exitCode: 0, signalCode: null} as unknown as ChildProcess;
    return {child, result: {code: result === null ? null : 1, output, listened: result === null}, output: () => output};
  };
  return {scratches, ports, dependencies: {scratchHome: create, runServer: run}};
}

test('only Linux and macOS server bind collisions match', () => {
  assert.equal(isBindCollision(collision(98)), true);
  assert.equal(isBindCollision(collision(48)), true);
  assert.equal(isBindCollision(collision(13)), false);
  assert.equal(isBindCollision('address already in use'), false);
});

test('a collision retries with a fresh scratch and cleans both attempts', async () => {
  const f = fixture([collision(98), null]);
  const mesh = await retryBindCollision(() => startMesh('work-doc-route-', {}, undefined, f.dependencies));
  try {
    assert.equal(f.scratches.length, 2);
    assert.notEqual(f.ports[0], f.ports[1]);
    assert.equal(fs.existsSync(f.scratches[0]!), false);
    assert.equal(fs.existsSync(f.scratches[1]!), true);
  } finally { await mesh.stop(); }
  assert.equal(fs.existsSync(f.scratches[1]!), false);
});

test('a different failure is propagated without retry and its scratch is removed', async () => {
  const f = fixture(['invalid configuration']);
  await assert.rejects(retryBindCollision(() => startMesh('work-doc-route-', {}, undefined, f.dependencies)),
    /invalid configuration/);
  assert.equal(f.scratches.length, 1);
  assert.equal(fs.existsSync(f.scratches[0]!), false);
});

test('a fifth collision is propagated and every failed scratch is removed', async () => {
  const f = fixture(Array.from({length: 5}, () => collision(48)));
  await assert.rejects(retryBindCollision(() => startMesh('work-doc-route-', {}, undefined, f.dependencies)),
    /address already in use/);
  assert.equal(f.scratches.length, 5);
  for (const scratch of f.scratches) assert.equal(fs.existsSync(scratch), false);
});

test('the final bind error is not replaced with a generic failure', async () => {
  let attempts = 0;
  const last = new Error(`server.py did not listen:\n${collision(98)}`);
  await assert.rejects(retryBindCollision(async () => {
    attempts++;
    if (attempts === 5) throw last;
    throw new Error(`server.py did not listen:\n${collision(98)}`);
  }), error => error === last);
  assert.equal(attempts, 5);
});

test('normal startMesh still calls prepare once and never retries an explicit port', async () => {
  const f = fixture([collision(98)]);
  let prepares = 0;
  await assert.rejects(startMesh('explicit-', {MESH_PORT: '4567'}, where => {
    prepares++;
    assert.equal(where.env.MESH_PORT, '4567');
  }, f.dependencies), /address already in use/);
  assert.equal(prepares, 1);
  assert.equal(f.scratches.length, 1);
  assert.equal(fs.existsSync(f.scratches[0]!), false);
});
