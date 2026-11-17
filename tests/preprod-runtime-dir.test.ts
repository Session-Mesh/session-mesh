// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/preprod.sh and MESH_RUNTIME_DIR. The hosts take MESH_RUNTIME_DIR before
// XDG_RUNTIME_DIR, so a shell that carries it names the live socket through it: the safety
// check refuses that directory as the live one, and the launcher sets MESH_RUNTIME_DIR to its own
// runtime directory, so an inherited value never reaches the pre-production processes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';

const LAUNCHER = path.resolve(import.meta.dirname, '..', 'scripts', 'preprod.sh');
const scratches: string[] = [];
after(() => { for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true}); });

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rt-')));
  scratches.push(root);
  const dirs = {home: path.join(root, 'home'), xdg: path.join(root, 'xdg'), mesh: path.join(root, 'mesh'),
    pre: path.join(root, 'pre'), preRuntime: path.join(root, 'prert')};
  for (const dir of [dirs.home, dirs.xdg, dirs.mesh]) fs.mkdirSync(dir, {mode: 0o700});
  return {root, ...dirs};
}

function check(where: ReturnType<typeof world>, runtime: string, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: where.home, LANG: 'C',
    XDG_RUNTIME_DIR: where.xdg, MESH_PREPROD_PORT: '17691', MESH_PREPROD_DIR: where.pre,
    MESH_PREPROD_RUNTIME: runtime, ...extra};
  return spawnSync('/bin/bash', [LAUNCHER, 'check'], {env, encoding: 'utf8', timeout: 20000});
}

describe('preprod.sh: MESH_RUNTIME_DIR', () => {
  test('an inherited MESH_RUNTIME_DIR is refused as the live runtime directory', () => {
    const where = world();
    const result = check(where, where.mesh, {MESH_RUNTIME_DIR: where.mesh});
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /refusing: runtime dir .* is the live mesh's/);
  });

  test('a separate runtime directory passes while MESH_RUNTIME_DIR names the live one', () => {
    const where = world();
    const result = check(where, where.preRuntime, {MESH_RUNTIME_DIR: where.mesh});
    assert.equal(result.status, 0, result.stderr);
  });

  test('the launcher gives its processes its own MESH_RUNTIME_DIR', () => {
    const text = fs.readFileSync(LAUNCHER, 'utf8');
    const runMesh = text.slice(text.indexOf('run_mesh() {'), text.indexOf('\n}', text.indexOf('run_mesh() {')));
    assert.match(runMesh, /MESH_RUNTIME_DIR="\$RUNTIME"/);
    assert.match(runMesh, /XDG_RUNTIME_DIR="\$RUNTIME"/);
  });
});
