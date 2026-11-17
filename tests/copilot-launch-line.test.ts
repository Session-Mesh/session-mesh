// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The launch line is typed into the user's interactive shell: `VAR=value command` is not valid in csh and tcsh, so
// the assignment travels through `env` (OpenCode, Gemini, Copilot and Vibe all do).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

test('the Copilot line starts with env, names the event helper, and keeps the options of the run after it', () => {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, shlex, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
words = shlex.split(server._copilot_command("copilot --resume=0cb916db-26aa-40f2-86b5-1ba81b225fd2"))
print(json.dumps([words[0], words[1].split("=", 1)[0], words[2], words[3]]))`],
  {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp', MESH_CONF_DIR: process.env.TMPDIR ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp'}});
  assert.deepEqual(JSON.parse(output), ['env', 'MESH_EVENT_BIN', 'copilot', '--resume=0cb916db-26aa-40f2-86b5-1ba81b225fd2']);
});
