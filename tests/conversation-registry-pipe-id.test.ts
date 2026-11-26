// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';

const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');

test('pipe identifiers wider than an OCaml integer retain their identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-registry-wide-'));
  try {
    // Simulate an unsigned 64-bit inode with the same low 63 bits as the
    // actual pipe. Darwin can return such values for anonymous pipes.
    const code = [
      'import fsutil, os, types',
      'original = os.fstat',
      'def wide(fd):',
      '    s = original(fd)',
      '    return types.SimpleNamespace(st_dev=s.st_dev + (1 << 63), st_ino=s.st_ino + (1 << 63))',
      'os.fstat = wide',
      'assert fsutil.conversation_request("snapshot") == []',
    ].join('\n');
    const result = spawnSync(process.env.MESH_PYTHON || 'python3', ['-c', code], {
      cwd: REPO,
      env: {...process.env, MESH_CONF_DIR: dir, MESH_MESH_HISTORY_CMD: helper},
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('pipe identifier conversion matches OCaml signed integer boundaries', () => {
  const code = [
    'import fsutil',
    'for n in ((1 << 62) - 1, 1 << 62, (1 << 63) - 1, 1 << 63):',
    '    print(fsutil._ocaml_int(n))',
  ].join('\n');
  const result = spawnSync(process.env.MESH_PYTHON || 'python3', ['-c', code], {
    cwd: REPO, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    '4611686018427387903', '-4611686018427387904', '-1', '0',
  ]);
});
