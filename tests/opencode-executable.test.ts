// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The OpenCode binary Mesh probes is the one the session's shell will launch: ~/.local/bin (the PTY host puts it
// first), ~/.opencode/bin (where OpenCode's own installer puts it), then the PATH of the web server.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function resolve(layout: string[], pathVariable: string): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-exe-'));
  try {
    for (const relative of layout) {
      fs.mkdirSync(path.dirname(path.join(home, relative)), {recursive: true});
      fs.writeFileSync(path.join(home, relative), '#!/bin/sh\n', {mode: 0o755});
    }
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import json, sys\nsys.path.insert(0, ${JSON.stringify(REPO)})\nimport agentmcp\nprint(json.dumps(agentmcp._opencode_executable({"PATH": ${JSON.stringify(pathVariable.replaceAll('$HOME', home))}})))`],
    {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home}});
    const found = JSON.parse(output) as string | null;
    return found === null ? null : path.relative(home, found);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
}

describe('OpenCode executable resolution', () => {
  test('the installer directory is searched when the server PATH omits it', () => {
    assert.equal(resolve(['.opencode/bin/opencode'], '/usr/bin:/bin'), path.join('.opencode', 'bin', 'opencode'));
  });

  test('~/.local/bin comes before ~/.opencode/bin, which comes before the server PATH', () => {
    assert.equal(resolve(['.local/bin/opencode', '.opencode/bin/opencode', 'other/opencode'], '$HOME/other:/usr/bin'),
      path.join('.local', 'bin', 'opencode'));
    assert.equal(resolve(['.opencode/bin/opencode', 'other/opencode'], '$HOME/other:/usr/bin'),
      path.join('.opencode', 'bin', 'opencode'));
    assert.equal(resolve(['other/opencode'], '$HOME/other:/usr/bin'), path.join('other', 'opencode'));
  });

  test('nothing found is None', () => {
    assert.equal(resolve([], '/usr/bin:/bin'), null);
  });
});
