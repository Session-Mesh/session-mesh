// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The native PTY host and its clients pick the socket directory in one order:
// MESH_RUNTIME_DIR, else XDG_RUNTIME_DIR, else /run/user/<uid> (on macOS
// ~/Library/Application Support/session-mesh/run, the home of the user database); an empty
// variable counts as unset.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';

function sock(extra: NodeJS.ProcessEnv): string {
  const env: NodeJS.ProcessEnv = {PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', ...extra};
  const result = spawnSync(PYTHON, ['-c', 'import ptyhost; print(ptyhost.SOCK)'],
    {cwd: REPO, env, encoding: 'utf8', timeout: 20000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe('ptyhost.SOCK follows the runtime directory rule', () => {
  test('MESH_RUNTIME_DIR wins over XDG_RUNTIME_DIR', () => {
    assert.equal(sock({MESH_RUNTIME_DIR: '/m/run', XDG_RUNTIME_DIR: '/x/run'}),
      '/m/run/session-mesh/ptyhost.sock');
  });

  test('an empty MESH_RUNTIME_DIR falls back to XDG_RUNTIME_DIR', () => {
    assert.equal(sock({MESH_RUNTIME_DIR: '', XDG_RUNTIME_DIR: '/x/run'}),
      '/x/run/session-mesh/ptyhost.sock');
  });

  test('both empty gives the platform default', () => {
    const runtime = process.platform === 'darwin'
      ? path.join(os.userInfo().homedir, 'Library/Application Support/session-mesh/run')
      : `/run/user/${process.getuid?.()}`;
    assert.equal(sock({MESH_RUNTIME_DIR: '', XDG_RUNTIME_DIR: '', HOME: '/elsewhere'}),
      `${runtime}/session-mesh/ptyhost.sock`);
  });
});
