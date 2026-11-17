// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// ptyhost.py is only the Python client of the native host now. A PTY unit left by an earlier
// install still runs it as a script: it must fail (status 78, EX_CONFIG, so that systemd marks the
// unit failed instead of seeing a clean exit) and say how to switch to the native host.
// Importing it as a module stays silent.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';

describe('ptyhost.py run as the PTY host', () => {
  test('exits 78 and prints the commands that switch to the native host', () => {
    const result = spawnSync(PYTHON, [path.join(REPO, 'ptyhost.py')], {encoding: 'utf8', timeout: 30_000});
    assert.equal(result.status, 78, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /the Python PTY host was removed; the PTY host is now the native mesh-ptyhost/);
    for (const command of [
      'systemctl --user disable --now session-mesh-pty',
      'rm ~/.config/systemd/user/session-mesh-pty.service',
      'systemctl --user daemon-reload',
      'systemctl --user reset-failed session-mesh-pty',
      './install.sh',
    ]) {
      assert.ok(result.stderr.includes(`  ${command}\n`), `missing: ${command}`);
    }
  });

  test('importing it as the client module does not exit', () => {
    const result = spawnSync(PYTHON, ['-c', 'import ptyhost; print("imported")'], {cwd: REPO, encoding: 'utf8', timeout: 30_000});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'imported\n');
  });
});
