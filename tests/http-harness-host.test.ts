// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The harness needs a PTY host the way CONTRIBUTING.md says: MESH_PTYHOST_CMD is one path (spaces allowed),
// else mesh-ptyhost on PATH, and a missing host fails the run instead of skipping the session-token tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {sessionSkipReason} from './http-harness.ts';
import {ptyhostArgv} from './ptyhost-command.ts';

const saved = {cmd: process.env.MESH_PTYHOST_CMD, path: process.env.PATH};
afterEach(() => {
  for (const [key, value] of [['MESH_PTYHOST_CMD', saved.cmd], ['PATH', saved.path]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('with no host configured and none on PATH, the session checks fail, they are not skipped', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-no-host-'));
  try {
    delete process.env.MESH_PTYHOST_CMD;
    process.env.PATH = empty;
    assert.throws(() => sessionSkipReason(), /no native PTY host to test/);
  } finally { fs.rmSync(empty, {recursive: true, force: true}); }
});

test('a host path containing spaces is kept as one argument', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh host '));
  try {
    const host = path.join(dir, 'mesh-ptyhost');
    fs.writeFileSync(host, '#!/bin/sh\n', {mode: 0o755});
    process.env.MESH_PTYHOST_CMD = host;
    assert.deepEqual(ptyhostArgv(), [host]);
    assert.doesNotThrow(() => sessionSkipReason());
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
