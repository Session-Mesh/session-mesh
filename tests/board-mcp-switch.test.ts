// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// One convention between scripts/bootstrap.sh (where mesh-board-mcp is installed) and agentmcp.py
// (where agent sessions are told to find it): both resolve the same opam switch to the same bin,
// when no release install holds the program (tests/install-release-units.test.ts covers that).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';

function run(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {cwd: REPO, env, encoding: 'utf8'});
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// The switch the suite runs with: MESH_OPAM_SWITCH, otherwise opam's current switch; none without opam.
function selectedSwitch(): string | null {
  if (process.env.MESH_OPAM_SWITCH) return process.env.MESH_OPAM_SWITCH;
  const shown = spawnSync('opam', ['switch', 'show'], {cwd: REPO, encoding: 'utf8'});
  return shown.status === 0 ? shown.stdout.trim() : null;
}

const SWITCH = selectedSwitch();

function bootstrapBin(env: NodeJS.ProcessEnv): string {
  return run('bash', ['scripts/bootstrap.sh', '--print-bin'], env);
}

// In an empty HOME, where a release install (~/.local/share/session-mesh/current/bin) would come first;
// the opam root stays the one of the real home, as opam itself resolves it.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-board-switch-'));
after(() => fs.rmSync(EMPTY_HOME, {recursive: true, force: true}));

function sessionBoardMcp(env: NodeJS.ProcessEnv): string {
  const opamRoot = env.OPAMROOT || path.join(os.homedir(), '.opam');
  return run(PYTHON, ['-c', 'import agentmcp; print(agentmcp.BOARD_MCP)'], {...env, HOME: EMPTY_HOME, OPAMROOT: opamRoot});
}

function withoutSwitch(): NodeJS.ProcessEnv {
  const env = {...process.env};
  for (const name of ['MESH_OPAM_SWITCH', 'OPAMSWITCH', 'OPAM_SWITCH_PREFIX']) delete env[name];
  return env;
}

describe('mesh-board-mcp: bootstrap and session resolution agree', {skip: SWITCH === null && 'opam absent'}, () => {
  test('with MESH_OPAM_SWITCH, sessions point at the bootstrap install directory', () => {
    const env = {...withoutSwitch(), MESH_OPAM_SWITCH: SWITCH as string};
    assert.equal(sessionBoardMcp(env), path.join(bootstrapBin(env), 'mesh-board-mcp'));
  });

  test('unset, both follow the current opam environment', () => {
    const base = {...withoutSwitch(), OPAMSWITCH: SWITCH as string};
    const prefix = run('opam', ['var', `--switch=${SWITCH}`, 'prefix'], base);
    assert.equal(sessionBoardMcp({...base, OPAM_SWITCH_PREFIX: prefix}), path.join(bootstrapBin(base), 'mesh-board-mcp'));
  });
});
