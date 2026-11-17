// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// bin/mesh-attach names the command that starts the PTY host the installer set up on this
// platform when nothing answers on the socket: systemd on Linux, launchd on macOS (simulated here
// by setting sys.platform before the script runs).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const RUN = 'import runpy, sys; sys.platform = sys.argv[1]; sys.argv = [sys.argv[2], "-l"]; runpy.run_path(sys.argv[0], run_name="__main__")';

function attach(platform: string) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-'));
  try {
    return spawnSync(PYTHON, ['-c', RUN, platform, path.join(ROOT, 'bin', 'mesh-attach')],
      {env: {...process.env, MESH_RUNTIME_DIR: runtime}, encoding: 'utf8', timeout: 30000});
  } finally {
    fs.rmSync(runtime, {recursive: true, force: true});
  }
}

test('without a PTY host, mesh-attach suggests systemctl on Linux and launchctl on macOS', () => {
  const linux = attach('linux');
  assert.equal(linux.status, 1, linux.stderr);
  assert.match(linux.stderr, /ptyhost is not responding \(systemctl --user start session-mesh-pty\)/);
  const mac = attach('darwin');
  assert.equal(mac.status, 1, mac.stderr);
  const uid = process.getuid!();
  assert.match(mac.stderr, new RegExp(`launchctl kickstart gui/${uid}/io\\.session-mesh\\.pty, or, installed without`));
  assert.match(mac.stderr, new RegExp(`launchctl bootstrap user/${uid} \\S+io\\.session-mesh\\.pty\\.plist .* launchctl kickstart user/${uid}/io\\.session-mesh\\.pty`));
  assert.match(mac.stderr, /sudo launchctl kickstart system\/io\.session-mesh\.pty/);
  assert.doesNotMatch(mac.stderr, /systemctl/);
});
