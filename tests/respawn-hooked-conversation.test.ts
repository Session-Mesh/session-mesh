// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// (Copilot, OpenCode, Gemini, Antigravity and Vibe.) A restored Copilot is launched with `--resume=<A>`, so its argv always names a conversation. After the web
// server restarts (its in-memory hook state is empty), a listing that has not heard a hook yet must not take
// the snapshot back from the conversation the hooks last reported (B, after a /new or /resume inside Copilot).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function python(code: string): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-hooked-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import respawn
home = ${JSON.stringify(home)}
respawn.FILE = pathlib.Path(home) / "respawn.json"
A = "0cb916db-26aa-40f2-86b5-1ba81b225fd2"
B = "11111111-2222-3333-4444-555555555555"

C = "ses_cccccccccccc"

def sess(kind, sid, source, argv=None, created=10.0, started=100.0):
    agent = {"type": kind, "session_id": sid, "identity_source": source,
             "argv": argv if argv is not None else [kind, f"--resume={A}"]}
    if started is not None:
        agent["started"] = started      # when the agent process started (discovery reports it)
    return {"name": "w", "cwd": home, "created": created, "cmd": None, "agent": agent}

def snapshot_id():
    return respawn._load()["live"][0]["agent"]["session_id"]
${code}`],
    {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, MESH_CONF_DIR: home, TMPDIR: home}});
    return JSON.parse(output);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
}

describe('the snapshot keeps the conversation the hooks reported', () => {
  test('a listing that names the launch conversation (argv) does not take it back, and a restore resumes B', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", B, "copilot_hooks")], True, host="1:1")
hooked = snapshot_id()
respawn.update([sess("copilot", A, "argv_session")], True, host="1:1")
after_argv = snapshot_id()
respawn.update([], True, host="2:2")
print(json.dumps([hooked, after_argv, respawn.lost_entry("w")["agent"]["session_id"]]))
`), ['11111111-2222-3333-4444-555555555555', '11111111-2222-3333-4444-555555555555',
      '11111111-2222-3333-4444-555555555555']);
  });

  test('a listing without any conversation keeps it as well', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", B, "copilot_hooks")], True, host="1:1")
respawn.update([sess("copilot", None, None)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), '11111111-2222-3333-4444-555555555555');
  });

  test('a snapshot stored before start times existed keeps the hooked conversation once, then stores the start time', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", B, "copilot_hooks", started=None)], True, host="1:1")
legacy = respawn._load()["live"][0]["agent"].get("started")
respawn.update([sess("copilot", A, "argv_session", started=100.0)], True, host="1:1")
kept = snapshot_id()
stored = respawn._load()["live"][0]["agent"]["started"]
respawn.update([sess("copilot", C, "argv_session", ["copilot", f"--resume={C}"], started=900.0)], True, host="1:1")
print(json.dumps([legacy, kept, stored, snapshot_id()]))
`), [null, '11111111-2222-3333-4444-555555555555', 100.0, 'ses_cccccccccccc']);
  });

  test('Copilot: a new process started with --resume=C names its own conversation, not the old report', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", B, "copilot_hooks")], True, host="1:1")
respawn.update([sess("copilot", C, "argv_session", ["copilot", f"--resume={C}"], started=900.0)], True, host="1:1")
print(json.dumps([snapshot_id(), respawn._load()["live"][0]["agent"].get("identity_source")]))
`), ['ses_cccccccccccc', 'argv']);
  });

  test('a conversation that came from argv in the previous listing is replaced by a new argv one', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", A, "argv_session")], True, host="1:1")
respawn.update([sess("copilot", B, "argv_session", ["copilot", f"--resume={B}"])], True, host="1:1")
print(json.dumps(snapshot_id()))
`), '11111111-2222-3333-4444-555555555555');
  });

  test('another incarnation of the same name (a new created) starts from its own listing', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", B, "copilot_hooks")], True, host="1:1")
respawn.update([sess("copilot", A, "argv_session", created=11.0)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), '0cb916db-26aa-40f2-86b5-1ba81b225fd2');
  });

  test('a fresh hook report replaces an earlier hooked one', () => {
    assert.deepEqual(python(`
respawn.update([sess("copilot", B, "copilot_hooks")], True, host="1:1")
respawn.update([sess("copilot", A, "copilot_hooks")], True, host="1:1")
print(json.dumps(snapshot_id()))
`), '0cb916db-26aa-40f2-86b5-1ba81b225fd2');
  });

  test('OpenCode: the conversation its plugin reported survives a listing that has not heard a hook yet', () => {
    assert.deepEqual(python(`
respawn.update([sess("opencode", "ses_aaaaaaaaaaaa", "opencode_hook", ["opencode"])], True, host="1:1")
respawn.update([sess("opencode", "ses_bbbbbbbbbbbb", "argv_session", ["opencode"])], True, host="1:1")
after_argv = snapshot_id()
respawn.update([sess("opencode", "ses_cccccccccccc", "unique_opencode_session", ["opencode"])], True, host="1:1")
after_discovery = snapshot_id()
respawn.update([], True, host="2:2")
print(json.dumps([after_argv, after_discovery, respawn.lost_entry("w")["agent"]["session_id"]]))
`), ['ses_aaaaaaaaaaaa', 'ses_aaaaaaaaaaaa', 'ses_aaaaaaaaaaaa']);
  });

  test('OpenCode: a fresh plugin report replaces an earlier one, and discovery alone is replaced by a newer discovery', () => {
    assert.deepEqual(python(`
respawn.update([sess("opencode", "ses_aaaaaaaaaaaa", "opencode_hook", ["opencode"])], True, host="1:1")
respawn.update([sess("opencode", "ses_bbbbbbbbbbbb", "opencode_hook", ["opencode"])], True, host="1:1")
hooked = snapshot_id()
respawn.update([sess("opencode", "ses_cccccccccccc", "argv_session", ["opencode"], created=11.0)], True, host="1:1")
print(json.dumps([hooked, snapshot_id()]))
`), ['ses_bbbbbbbbbbbb', 'ses_cccccccccccc']);
  });

  test('Gemini, Antigravity and Vibe: a conversation their hooks filled in is kept when a listing names none', () => {
    assert.deepEqual(python(`
out = []
for kind, sid in (("gemini", B), ("agy", "conversation0001"), ("vibe", B)):
    respawn.FILE = pathlib.Path(home) / f"{kind}.json"
    respawn.update([sess(kind, sid, f"{kind}_hook", [kind])], True, host="1:1")
    respawn.update([sess(kind, None, None, [kind])], True, host="1:1")
    out.append(snapshot_id())
print(json.dumps(out))
`), ['11111111-2222-3333-4444-555555555555', 'conversation0001', '11111111-2222-3333-4444-555555555555']);
  });

  test('other agents are untouched: the newest listing wins', () => {
    assert.deepEqual(python(`
respawn.update([sess("claude", A, "hooks", ["claude"])], True, host="1:1")
respawn.update([sess("claude", B, "argv_session", ["claude"])], True, host="1:1")
print(json.dumps(snapshot_id()))
`), '11111111-2222-3333-4444-555555555555');
  });
});

// The incarnation of a snapshot entry is the terminal, not the agent process: quit the agent and start it again in the
// same terminal and the conversation the hooks reported belongs to the first process.
describe('the kept conversation belongs to the same agent process', () => {
  for (const [kind, hook] of [['opencode', 'opencode_hook'], ['vibe', 'vibe_hook'], ['agy', 'agy_hook'], ['gemini', 'gemini_hook']]) {
    test(`${kind}: the same process keeps the reported conversation over a listing that names another`, () => {
      assert.deepEqual(python(`
respawn.update([sess("${kind}", "ses_aaaaaaaaaaaa", "${hook}", ["${kind}"])], True, host="1:1")
respawn.update([sess("${kind}", C, "argv_session", ["${kind}"], started=100.5)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), 'ses_aaaaaaaaaaaa');
    });

    test(`${kind}: a new process started with --session names its own conversation, not the old report`, () => {
      assert.deepEqual(python(`
respawn.update([sess("${kind}", "ses_aaaaaaaaaaaa", "${hook}", ["${kind}"])], True, host="1:1")
respawn.update([sess("${kind}", C, "argv_session", ["${kind}", "--session", C], started=900.0)], True, host="1:1")
print(json.dumps([snapshot_id(), respawn._load()["live"][0]["agent"].get("identity_source")]))
`), ['ses_cccccccccccc', 'argv']);
    });

    test(`${kind}: a new process whose only conversation is the lone one written since its start gets that one`, () => {
      assert.deepEqual(python(`
respawn.update([sess("${kind}", "ses_aaaaaaaaaaaa", "${hook}", ["${kind}"])], True, host="1:1")
respawn.update([sess("${kind}", "ses_bbbbbbbbbbbb", "unique_${kind}_session", ["${kind}"], started=900.0)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), 'ses_bbbbbbbbbbbb');
    });
  }

  test('a new process that read no conversation does not inherit the old one', () => {
    assert.deepEqual(python(`
respawn.update([sess("opencode", "ses_aaaaaaaaaaaa", "opencode_hook", ["opencode"])], True, host="1:1")
respawn.update([sess("opencode", None, None, ["opencode"], started=900.0)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), null);
  });

  test('the start time is stored, and a web server restart (no hook heard yet) keeps the same process\'s conversation', () => {
    assert.deepEqual(python(`
respawn.update([sess("opencode", "ses_aaaaaaaaaaaa", "opencode_hook", ["opencode"])], True, host="1:1")
respawn.update([sess("opencode", None, None, ["opencode"])], True, host="1:1")
print(json.dumps([snapshot_id(), respawn._load()["live"][0]["agent"]["started"]]))
`), ['ses_aaaaaaaaaaaa', 100.0]);
  });

  test('without a known start time the old conversation is kept only where the listing read none', () => {
    assert.deepEqual(python(`
respawn.update([sess("opencode", "ses_aaaaaaaaaaaa", "opencode_hook", ["opencode"], started=None)], True, host="1:1")
respawn.update([sess("opencode", C, "argv_session", ["opencode", "--session", C], started=None)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), 'ses_cccccccccccc');
    assert.deepEqual(python(`
respawn.update([sess("opencode", "ses_aaaaaaaaaaaa", "opencode_hook", ["opencode"], started=None)], True, host="1:1")
respawn.update([sess("opencode", None, None, ["opencode"], started=None)], True, host="1:1")
print(json.dumps(snapshot_id()))
`), 'ses_aaaaaaaaaaaa');
  });
});
