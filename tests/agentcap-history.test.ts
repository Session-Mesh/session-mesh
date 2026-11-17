// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The capability matrix (agentcap.py) must agree with the agents whose conversations the History index
// reads (server.HISTORY_AGENTS, history.py): an agent is "history: supported" exactly when it is indexed.
// Read from the Python modules the server uses; no agent binary is involved.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

/** Every location a client or Mesh reads is under one throwaway home: no real conversation is opened. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const at = (...parts: string[]): string => path.join(home, ...parts);
  return {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: at('conf'), MESH_CACHE_DIR: at('cache'),
    XDG_DATA_HOME: at('data'), XDG_CONFIG_HOME: at('xdg-config'), XDG_CACHE_HOME: at('xdg-cache'), XDG_STATE_HOME: at('xdg-state'),
    PI_CODING_AGENT_DIR: at('pi'), COPILOT_HOME: at('.copilot'), VIBE_HOME: at('.vibe'), GEMINI_CLI_HOME: home,
    OPENCODE_DB: at('data', 'opencode', 'opencode.db'), MESH_HISTORY_DB_DISABLE: '1'};
}

function python(code: string): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcap-history-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
      {cwd: REPO, env: isolatedEnv(home), encoding: 'utf8'});
    return JSON.parse(output);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
}

test('history is supported for exactly the agents the History index reads', () => {
  const result = python(`
import json, agentcap, server
supported = sorted(a for a in agentcap.MATRIX if agentcap.status(a, agentcap.Feature.HISTORY) is agentcap.Status.SUPPORTED)
print(json.dumps({"supported": supported, "indexed": sorted(server.HISTORY_AGENTS)}))
`) as {supported: string[]; indexed: string[]};
  assert.deepEqual(result.supported, result.indexed);
  assert.ok(result.indexed.includes('pi'), 'Pi conversations are indexed');
});
