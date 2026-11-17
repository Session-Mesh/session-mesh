// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What the real Vibe (MESH_VIBE_BIN, 3.1.2) makes of the injected VIBE_MCP_SERVERS: the effective configuration it exports
// (`vibe -p … --output-dir`) holds the mesh-board entry the mesh built, the user's other servers untouched, and what the
// user restricted on mesh-board still restricted. A scripted model answers the one headless turn. Own HOME and VIBE_HOME.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const VIBE = process.env.MESH_VIBE_BIN ?? '';
let scratch: string;
let model: ChildProcess;
let port: number;

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port: free} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(free));
    });
  });
}

before(async () => {
  if (!VIBE) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-'));
  port = await freePort();
  model = spawn(process.execPath, ['--experimental-strip-types', path.join(REPO, 'tests', 'fixtures', 'fake-openai-model.ts'),
    String(port), path.join(scratch, 'requests.log')], {stdio: 'ignore'});
  fs.mkdirSync(path.join(scratch, 'bin'));
  fs.writeFileSync(path.join(scratch, 'bin', 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
});
after(() => {
  model?.kill('SIGKILL');
  if (scratch) {
    execFileSync('chmod', ['-R', 'u+rwX', scratch]);
    fs.rmSync(scratch, {recursive: true});
  }
});

/** The user's configuration, the mesh's value built from it, and the configuration Vibe reports as effective. */
function effective(name: string, userServers: string): {name: string; disabled: boolean; disabled_tools: string[]; command: unknown; env: Record<string, string>}[] {
  const vibeHome = path.join(scratch, name, 'vibe-home');
  const project = path.join(scratch, name, 'project');
  fs.mkdirSync(vibeHome, {recursive: true});
  fs.mkdirSync(project, {recursive: true});
  fs.writeFileSync(path.join(vibeHome, 'config.toml'), `active_model = "fake"
enable_telemetry = false
enable_update_checks = false
enable_auto_update = false

[[providers]]
name = "fakeprov"
api_base = "http://127.0.0.1:${port}/v1"
api_style = "openai"
backend = "generic"

[[models]]
name = "fake-model"
provider = "fakeprov"
alias = "fake"
${userServers}`);
  const code = `import json, agentmcp
limits = agentmcp.vibe_board_limits(${JSON.stringify(project)})
before, after = agentmcp.vibe_mcp_value({"MESH_PORT": "7777", "MESH_CONF_DIR": "/c"}, limits)
print(before + "tok" + after)`;
  const value = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`], {
    cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: scratch, VIBE_HOME: vibeHome, MESH_BIN_DIR: path.join(scratch, 'bin')}}).trim();
  const out = path.join(scratch, name, 'out');
  execFileSync(VIBE, ['-p', 'hi', '--output', 'text', '--output-dir', out], {cwd: project, stdio: 'pipe', timeout: 60_000, env: {
    PATH: `${path.dirname(VIBE)}:/usr/bin:/bin`, HOME: path.join(scratch, name), VIBE_HOME: vibeHome, VIBE_MCP_SERVERS: value}});
  return JSON.parse(fs.readFileSync(path.join(out, 'export.json'), 'utf8')).config.mcp_servers;
}

describe('the real Vibe reads the injected board entry', {skip: VIBE ? false : 'MESH_VIBE_BIN not set'}, () => {
  test('without a user entry: the mesh\'s entry, nothing restricted', () => {
    const servers = effective('plain', '');
    assert.deepEqual(servers.map(server => server.name), ['mesh-board']);
    assert.equal(servers[0].disabled, false);
    assert.deepEqual(servers[0].disabled_tools, []);
    assert.equal(servers[0].command, path.join(scratch, 'bin', 'mesh-board-mcp'));
  });

  test('a user entry of that name is replaced as a whole by Vibe: what it restricts is repeated, the other servers stay', () => {
    const servers = effective('strict', `
[[mcp_servers]]
name = "mesh-board"
transport = "stdio"
command = "/bin/false"
disabled_tools = ["agent_message_send", "agent_message_reply"]

[[mcp_servers]]
name = "mine"
transport = "stdio"
command = "/bin/true"
`);
    assert.deepEqual(servers.map(server => server.name).sort(), ['mesh-board', 'mine']);
    const board = servers.find(server => server.name === 'mesh-board')!;
    assert.deepEqual(board.disabled_tools, ['agent_message_reply', 'agent_message_send']);
    assert.equal(board.command, path.join(scratch, 'bin', 'mesh-board-mcp'), 'the user\'s command cannot replace the bridge');
    assert.equal(servers.find(server => server.name === 'mine')!.command, '/bin/true');
  });

  test('a board the user disabled stays disabled', () => {
    const servers = effective('off', `
[[mcp_servers]]
name = "mesh-board"
transport = "stdio"
command = "/bin/false"
disabled = true
`);
    assert.equal(servers.find(server => server.name === 'mesh-board')!.disabled, true);
  });
});
