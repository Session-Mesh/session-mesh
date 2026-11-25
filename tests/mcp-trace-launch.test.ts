// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tracing path belongs to the owner configuration and must reach the
// injected MCP server even when the agent client filters its environment.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';

for (const absolute of [true, false]) test(`Codex forwards only an absolute plugin path (absolute=${absolute})`, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-trace-launch-'));
  const bin = path.join(scratch, 'bin');
  const argsFile = path.join(scratch, 'args');
  const envFile = path.join(scratch, 'env');
  const journal = path.join(scratch, 'events.jsonl');
  const plugin = absolute ? path.join(scratch, 'plugin"\\trace.cmxs') : 'relative-plugin.cmxs';
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'work-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'codex'),
    `#!/bin/sh\ncase "$*" in *--version*) echo "codex-cli 1.0"; exit 0;; esac\nprintf "%s\\n" "$@" > '${argsFile}'\nprintf "%s\\n%s" "$MESH_MCP_TRACE_JOURNAL" "$MESH_MCP_TRACE_PLUGIN" > '${envFile}'\nexec sleep 30\n`,
    {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  const mesh = await startMesh('trace-launch-', {PATH, MESH_BIN_DIR: bin,
    MESH_MCP_TRACE_JOURNAL: journal, MESH_MCP_TRACE_PLUGIN: plugin});
  const [command, ...args] = ptyhostArgv();
  const host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: '/bin/sh'}});
  try {
    const socket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
    for (let n = 0; n < 100 && !fs.existsSync(socket); n++) await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(`${mesh.base}/api/new`, {method: 'POST',
      headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'},
      body: JSON.stringify({cwd: mesh.home, preset: 'codex', name: 'traced'})});
    assert.equal(response.status, 200, await response.text());
    for (let n = 0; n < 100 && (!fs.existsSync(argsFile) || !fs.existsSync(envFile)
      || fs.statSync(envFile).size === 0); n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const launched = fs.readFileSync(argsFile, 'utf8');
    assert.match(launched, /mcp_servers\.mesh-board\.env_vars=.*MESH_MCP_TRACE_JOURNAL/);
    assert.match(launched, /mcp_servers\.mesh-work\.env_vars=.*MESH_MCP_TRACE_JOURNAL/);
    assert.doesNotMatch(launched, /mcp_servers\.mesh-work\.env_vars=.*MESH_SESSION_TOKEN/);
    assert.doesNotMatch(launched, /mcp_servers\.mesh-work\.env_vars=.*MESH_MCP_TRACE_PLUGIN/);
    if (absolute) assert.match(launched, /mcp_servers\.mesh-board\.env_vars=.*MESH_MCP_TRACE_PLUGIN/);
    else assert.doesNotMatch(launched, /mcp_servers\.mesh-board\.env_vars=.*MESH_MCP_TRACE_PLUGIN/);
    assert.equal(fs.readFileSync(envFile, 'utf8'), `${journal}\n${absolute ? plugin : ''}`);
  } finally {
    host.kill('SIGKILL');
    await mesh.stop();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

test('Vibe keeps quotes and backslashes in the trace path as JSON data', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-vibe-trace-'));
  const bin = path.join(scratch, 'bin');
  const output = path.join(scratch, 'vibe-env.json');
  const journal = path.join(scratch, 'journal"\\trace.jsonl');
  const plugin = path.join(scratch, 'plugin"\\trace.cmxs');
  fs.mkdirSync(bin);
  for (const name of ['mesh-board-mcp', 'work-mcp']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  }
  fs.writeFileSync(path.join(bin, 'vibe'),
    `#!/bin/sh\ncase "$*" in *--version*) echo "vibe 2.0"; exit 0;; esac\nprintf "%s" "$VIBE_MCP_SERVERS" > '${output}'\nexec sleep 30\n`,
    {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  const mesh = await startMesh('vibe-trace-', {PATH, MESH_BIN_DIR: bin,
    MESH_MCP_TRACE_JOURNAL: journal, MESH_MCP_TRACE_PLUGIN: plugin});
  const [command, ...args] = ptyhostArgv();
  const host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: '/bin/sh'}});
  try {
    const socket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
    for (let n = 0; n < 100 && !fs.existsSync(socket); n++) await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(`${mesh.base}/api/new`, {method: 'POST',
      headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'},
      body: JSON.stringify({cwd: mesh.home, preset: 'vibe', name: 'traced-vibe'})});
    assert.equal(response.status, 200, await response.text());
    for (let n = 0; n < 100 && (!fs.existsSync(output) || fs.statSync(output).size === 0); n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const servers = JSON.parse(fs.readFileSync(output, 'utf8')) as Array<{name: string; env: Record<string, string>}>;
    const board = servers.find(server => server.name === 'mesh-board');
    const work = servers.find(server => server.name === 'mesh-work');
    assert.equal(board?.env.MESH_MCP_TRACE_JOURNAL, journal);
    assert.equal(board?.env.MESH_MCP_TRACE_PLUGIN, plugin);
    assert.equal(work?.env.MESH_MCP_TRACE_JOURNAL, journal);
    assert.equal(Object.hasOwn(work?.env ?? {}, 'MESH_SESSION_TOKEN'), false);
    assert.equal(Object.hasOwn(work?.env ?? {}, 'MESH_MCP_TRACE_PLUGIN'), false);
  } finally {
    host.kill('SIGKILL');
    await mesh.stop();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});
