// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The state and conversation an agent's hooks reported outlive its process. A report received before the process
// started (an earlier Gemini in the same terminal, then another one typed by hand) says nothing about it and must
// not replace what discovery read.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const OLD = '11111111-2222-3333-4444-555555555555';
const OWN = '99999999-8888-7777-6666-555555555555';

function applied(kind: string, started: number | null, received: number, session: string): {session_id: string | null; status: string} {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
agent = {"type": ${JSON.stringify(kind)}, "session_id": ${JSON.stringify(OWN)}, "status": "idle"}
if ${started === null ? 'False' : 'True'}:
    agent["started"] = ${started ?? 0}
hook = {"type": "working", "received": ${received}, "detail": {"source": ${JSON.stringify(kind)}, "session": ${JSON.stringify(session)}}}
entry = {"agent": agent, "hook": hook}
server._apply_reported_state([entry])
print(json.dumps({"session_id": agent["session_id"], "status": agent["status"]}))`],
  {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp', MESH_CONF_DIR: process.env.TMPDIR ?? '/tmp', TMPDIR: process.env.TMPDIR ?? '/tmp'}});
  return JSON.parse(output) as {session_id: string | null; status: string};
}

describe('a hook report of an earlier Gemini process', () => {
  test('does not change the state of a Gemini started afterwards in the same terminal', () => {
    assert.deepEqual(applied('gemini', 1000, 500, OLD), {session_id: OWN, status: 'idle'});
  });

  test('a report received after the start (with the one second error of the start time) still applies', () => {
    assert.equal(applied('gemini', 1000, 1000, OLD).status, 'busy');
    assert.equal(applied('gemini', 1000, 998.5, OLD).status, 'busy');
  });

  test('without a start time (an agent whose discovery reads none) the report applies as before', () => {
    assert.equal(applied('vibe', null, 500, OLD).status, 'busy');
  });

  test('the same rule holds for OpenCode', () => {
    assert.equal(applied('opencode', 1000, 500, 'ses_abcdefghijkl').status, 'idle');
  });
});

describe('Gemini discovery reports the process start', () => {
  test('gemini_info carries a start time', () => {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import discover
info = discover.gemini_info(os.getpid())
print(json.dumps([info["type"], isinstance(info["started"], (int, float)) and info["started"] > 0]))`],
    {encoding: 'utf8', env: {PATH: process.env.PATH}});
    assert.deepEqual(JSON.parse(output), ['gemini', true]);
  });
});
