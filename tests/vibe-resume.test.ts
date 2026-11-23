// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Mistral Vibe's resume command, capability row, launch vector and injected configuration, read from the
// Python modules the server uses. The option list is `vibe --help` of 3.1.2. No Vibe binary and no model is involved.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = 'e98ebb44-7316-c2a7-62cf-582ea59f42f6';

function python(code: string, env: NodeJS.ProcessEnv = {}): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}, encoding: 'utf8'});
  return JSON.parse(output);
}

const resume = (argv: string[]): unknown => python(`
import json, resumeargs
try:
    print(json.dumps(resumeargs.resume_argv("vibe", ${JSON.stringify(argv)}, ${JSON.stringify(SID)})))
except resumeargs.WeakerResume as exc:
    print(json.dumps({"refused": str(exc)}))
`);

const TUI = '/opt/vibe/lib/python3.14/site-packages/vibe/_bin/vibe-rs';

describe('Vibe resume', () => {
  test('keeps the session options, drops the pickers, the headless options and the prompt', () => {
    assert.deepEqual(resume(['vibe']), ['vibe', '--resume', SID]);
    assert.deepEqual(resume(['vibe', '--resume', 'old-id', '--continue', '--workdir', '/x', '--model', 'm', '--trust',
      '--worktree', 'topic', '--yolo', 'do the thing']),
    ['vibe', '--resume', SID, '--yolo']);
    assert.deepEqual(resume(['vibe', '--smart-approve', '--add-dir', '/data', '--enabled-tools', 'bash']),
      ['vibe', '--resume', SID, '--smart-approve', '--add-dir', '/data', '--enabled-tools', 'bash']);
  });

  test('the process of a running Vibe is its bundled interface, vibe-rs, and is read the same way', () => {
    assert.deepEqual(resume([TUI, '--yolo']), ['vibe', '--resume', SID, '--yolo']);
  });

  test('the Mesh hooks directory is dropped (a launch adds the current one), another --add-dir stays', () => {
    assert.deepEqual(resume([TUI, '--add-dir', '/home/u/.config/session-mesh/mesh-vibe-hooks', '--add-dir', '/data']),
      ['vibe', '--resume', SID, '--add-dir', '/data']);
    assert.deepEqual(resume([TUI, '--add-dir=/c/mesh-vibe-hooks/']), ['vibe', '--resume', SID]);
  });

  test('the per-launch hooks directory (mesh-vibe-hooks/vibe-<nonce>) is dropped too', () => {
    const launch = '/home/u/.config/session-mesh/mesh-vibe-hooks/vibe-0123456789abcdef01234567';
    assert.deepEqual(resume([TUI, '--add-dir', launch, '--add-dir', '/data']), ['vibe', '--resume', SID, '--add-dir', '/data']);
    assert.deepEqual(resume([TUI, `--add-dir=${launch}/`, '--yolo']), ['vibe', '--resume', SID, '--yolo']);
    assert.deepEqual(resume([TUI, '--add-dir', '/data/vibe-0123456789abcdef01234567']),
      ['vibe', '--resume', SID, '--add-dir', '/data/vibe-0123456789abcdef01234567'], 'only the mesh\'s directory');
  });

  test('-p stuck to its value or to flags is a one-shot run too, -c alone and --add-dir are not', () => {
    for (const argv of [['vibe', '-phello'], ['vibe', '-p=hello'], ['vibe', '-cp', 'hello'], ['vibe', '-cphello'], ['vibe', '--yolo', '-pgo']]) {
      assert.match((resume(argv) as {refused: string}).refused, /^the session was started with vibe --prompt, which is not interactive/, argv.join(' '));
    }
    assert.deepEqual(resume(['vibe', '-c', '--yolo']), ['vibe', '--resume', SID, '--yolo']);
    assert.deepEqual(resume(['vibe', '--add-dir', '/p']), ['vibe', '--resume', SID, '--add-dir', '/p']);
  });

  test('a restriction hidden behind a vibe subcommand is refused with a message about vibe, not codex', () => {
    const refused = (resume(['vibe', 'mcp', '--agent', 'ask']) as {refused: string}).refused;
    assert.match(refused, /^the saved command has a vibe subcommand and names --agent: resume refused rather than restarted without --agent$/);
  });

  test('keeps the restrictive options and refuses rather than drop one it cannot read', () => {
    assert.deepEqual(resume(['vibe', '--agent', 'ask', '--disabled-tools', 'bash']),
      ['vibe', '--resume', SID, '--agent', 'ask', '--disabled-tools', 'bash']);
    assert.match((resume(['vibe', '--unknown-flag', '--agent', 'ask']) as {refused: string}).refused, /--agent/);
    assert.match((resume(['sh', '-c', 'vibe --disabled-tools bash']) as {refused: string}).refused, /--disabled-tools/);
  });

  test('a one-shot run is never resumed, another subcommand is not an interactive conversation', () => {
    assert.match((resume(['vibe', '-p', 'hello']) as {refused: string}).refused, /not interactive/);
    assert.match((resume(['vibe', '--prompt=hello']) as {refused: string}).refused, /not interactive/);
    assert.match((resume(['vibe', '--prompt-file', 'p.txt']) as {refused: string}).refused, /not interactive/);
    assert.deepEqual(resume(['vibe', 'mcp']), ['vibe', '--resume', SID]);
  });

  test('a node or npx launcher is not a Vibe entry point: the bare resume, refused when it hides a restriction', () => {
    assert.deepEqual(resume(['node', '/x/cli.js', '--yolo']), ['vibe', '--resume', SID]);
    assert.match((resume(['node', '/x/cli.js', '--agent', 'ask']) as {refused: string}).refused, /--agent/);
  });
});

describe('Vibe integration data', () => {
  test('the capability row: board, history and resume supported, bare launch vector', () => {
    assert.deepEqual(python(`
import json, agentcap, launchplan
print(json.dumps({"row": {f.value: s.value for f, s in agentcap.MATRIX["vibe"].items()},
                  "argv": launchplan.build("vibe").command(), "type": launchplan.agent_type("vibe")}))`),
    {row: {board_mcp: 'supported', history: 'supported', resume: 'supported', structured_output: 'unknown'},
      argv: ['vibe'], type: 'vibe'});
  });

  test('the MCP value holds the board with the token between two texts, and nothing without the bridge', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-bin-'));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-empty-'));
    try {
      fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\n', {mode: 0o755});
      const code = 'import json, agentmcp; v = agentmcp.vibe_mcp_value({"MESH_PORT": "7777"}, LIMITS); print(json.dumps(v))';
      const [before, after] = python(code.replace('LIMITS', 'None'), {MESH_BIN_DIR: bin}) as [string, string];
      const entry = JSON.parse(`${before}TOKEN${after}`)[0];
      assert.deepEqual(entry, {name: 'mesh-board', transport: 'stdio', command: path.join(bin, 'mesh-board-mcp'), args: [],
        env: {MESH_PORT: '7777', MESH_SESSION_TOKEN: 'TOKEN'}});
      assert.equal(python(code.replace('LIMITS', 'None'), {MESH_BIN_DIR: empty}), null,
        'an entry for a missing bridge would only fail at every launch');
    } finally {
      fs.rmSync(bin, {recursive: true, force: true});
      fs.rmSync(empty, {recursive: true, force: true});
    }
  });

  test('user and project denials of retired Deck tools restrict their groups', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-limits-'));
    try {
      const home = path.join(scratch, 'vibe-home');
      const project = path.join(scratch, 'project');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(project, '.vibe'), {recursive: true});
      fs.writeFileSync(path.join(home, 'config.toml'), `
[[mcp_servers]]
name = "mesh-board"
transport = "stdio"
command = "/bin/true"
disabled_tools = ["agent_message_send", "demo", "agent_guide_read", "agent_future"]

[[mcp_servers]]
name = "mesh-work"
transport = "stdio"
command = "/bin/true"
disabled = true
disabled_tools = ["agent_message_send"]
`);
      fs.writeFileSync(path.join(project, '.vibe', 'config.toml'), `
[[mcp_servers]]
name = "mesh-board"
transport = "stdio"
command = "/bin/true"
disabled_tools = ["agent_peers", "whiteboard_replace", "session_restart_request", 7]
`);
      const limits = (cwd: string, extra: NodeJS.ProcessEnv, name = 'mesh-board') => python(
        `import json, agentmcp; print(json.dumps(agentmcp.vibe_user_limits(${JSON.stringify(cwd)}, name=${JSON.stringify(name)})))`, extra);
      assert.deepEqual(limits(project, {VIBE_HOME: home}), {disabled: false,
        disabled_tools: ['agent_future', 'agent_guide_read', 'demo', 'mail', 'session', 'whiteboard']});
      assert.deepEqual(limits(project, {VIBE_HOME: home}, 'mesh-work'),
        {disabled: true, disabled_tools: ['agent_message_send']});
      fs.appendFileSync(path.join(home, 'config.toml'), '\n[[mcp_servers]]\nname = "mesh-board"\ndisabled = true\n');
      // `disabled` set by any entry of that name counts; the project here has no configuration of its own.
      assert.deepEqual(limits(scratch, {VIBE_HOME: home}), {disabled: true,
        disabled_tools: ['agent_future', 'agent_guide_read', 'demo', 'mail']});
      assert.deepEqual(limits(scratch, {VIBE_HOME: path.join(scratch, 'absent')}), {disabled: false, disabled_tools: []});
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  });
});
