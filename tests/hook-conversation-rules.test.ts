// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What an agent's hooks may change in a described session. A report received before the process started is
// of an earlier process and applies to none of the five hook agents (OpenCode, Gemini, Antigravity, Vibe and
// Copilot, whose discovery all read the process start). The conversation OpenCode's plugin reports replaces the
// one discovery read; Gemini, Antigravity and Vibe only fill in a missing one (a mutation that makes every hook
// replace it must fail here).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const DISCOVERED = '99999999-8888-7777-6666-555555555555';
const REPORTED = '11111111-2222-3333-4444-555555555555';
const OPENCODE_DISCOVERED = 'ses_discoveredAAAAAAAA';
const OPENCODE_REPORTED = 'ses_reportedBBBBBBBBBB';

type Outcome = {session_id: string | null; status: string; identity_source: string | null};

function python(code: string): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import discover, server
${code}`], {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp',
    MESH_CONF_DIR: process.env.TMPDIR ?? '/tmp', TMPDIR: process.env.TMPDIR ?? '/tmp'}});
  return JSON.parse(output);
}

/** One described agent with its hook report, through the real hook application of the server. */
function applied(kind: string, opts: {started: number | null; received: number; known: string | null; reported: string}): Outcome {
  return python(`
known = ${opts.known === null ? 'None' : JSON.stringify(opts.known)}
agent = {"type": ${JSON.stringify(kind)}, "session_id": known, "status": "idle",
         "identity_source": "discovery" if known else None}
if ${opts.started === null ? 'False' : 'True'}:
    agent["started"] = ${opts.started ?? 0}
hook = {"type": "working", "received": ${opts.received}, "detail": {"source": ${JSON.stringify(kind)}, "session": ${JSON.stringify(opts.reported)}}}
mesh = [{"agent": agent, "hook": hook}]
server._apply_reported_state(mesh)
server._apply_copilot_hooks(mesh)
print(json.dumps({k: agent.get(k) for k in ("session_id", "status", "identity_source")}))`) as Outcome;
}

describe('a hook report older than the process', () => {
  for (const kind of ['gemini', 'agy', 'vibe', 'opencode', 'copilot']) {
    test(`is ignored for ${kind}: neither the state nor the conversation changes`, () => {
      const reported = kind === 'opencode' ? OPENCODE_REPORTED : REPORTED;
      const known = kind === 'opencode' ? OPENCODE_DISCOVERED : DISCOVERED;
      const got = applied(kind, {started: 1000, received: 500, known, reported});
      assert.deepEqual(got, {session_id: known, status: 'idle', identity_source: 'discovery'});
    });

    test(`applies to ${kind} once received after the start`, () => {
      const now = Date.now() / 1000;   // a recent report: agy takes a silent "working" terminal for waiting
      const got = applied(kind, {started: now - 100, received: now - 1, known: null,
        reported: kind === 'opencode' ? OPENCODE_REPORTED : REPORTED});
      assert.equal(got.status, 'busy');
    });
  }
});

describe('the conversation a hook reports', () => {
  test('OpenCode: the plugin replaces the one discovery read', () => {
    const got = applied('opencode', {started: 1000, received: 2000, known: OPENCODE_DISCOVERED, reported: OPENCODE_REPORTED});
    assert.deepEqual(got, {session_id: OPENCODE_REPORTED, status: 'busy', identity_source: 'opencode_hook'});
  });

  for (const kind of ['gemini', 'agy', 'vibe']) {
    test(`${kind}: the hooks only fill in a missing conversation, never replace the discovered one`, () => {
      const reported = kind === 'agy' ? 'conversationAAAA1' : REPORTED;
      const kept = applied(kind, {started: 1000, received: 2000, known: DISCOVERED.slice(0, 36), reported});
      assert.equal(kept.session_id, DISCOVERED, 'the discovered conversation stays');
      assert.equal(kept.identity_source, 'discovery');
      const filled = applied(kind, {started: 1000, received: 2000, known: null, reported});
      assert.deepEqual([filled.session_id, filled.identity_source], [reported, `${kind}_hook`]);
    });
  }
});

describe('discovery reports the process start', () => {
  test('copilot_info, agy_info, vibe_info and opencode_info carry a start time', () => {
    assert.deepEqual(python(`
pid = os.getpid()
infos = [discover.copilot_info(pid), discover.agy_info(pid), discover.vibe_info(pid), discover.opencode_info(pid),
         discover.gemini_info(pid)]
print(json.dumps([[i["type"], isinstance(i.get("started"), (int, float)) and i["started"] > 0] for i in infos]))`),
    [['copilot', true], ['agy', true], ['vibe', true], ['opencode', true], ['gemini', true]]);
  });
});
