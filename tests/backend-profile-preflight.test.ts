// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Context plumbing only: recording CLIs and private stores, never installed agents or providers.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createStoreV2, addConversationV2} from './helpers/opencode-store.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const SID = 'ses_selected0123456789';
type Call = {name: string; argv: string[]; env: Record<string, string>};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-preflight-'));
  const home = path.join(root, 'home'), bin = path.join(home, '.local/bin');
  const cwd = path.join(root, 'project'), record = path.join(root, 'calls.jsonl');
  const mesh = path.join(root, 'mesh');
  const directories = (name: string) => Object.fromEntries(['config', 'data', 'state', 'cache'].map(role =>
    [`XDG_${role.toUpperCase()}_HOME`, path.join(root, name, role)])) as Record<string, string>;
  const ambient = directories('ambient'), selected = directories('selected');
  const piAmbient = path.join(root, 'pi-ambient'), piSelected = path.join(root, 'pi-selected');
  for (const directory of [bin, cwd, mesh, piAmbient, piSelected, ...Object.values(ambient), ...Object.values(selected)]) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  }
  const env = {PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: root, MESH_CONF_DIR: mesh,
    MESH_BIN_DIR: bin, MESH_SESSION_TOKEN: 'fixture-token-never-probed',
    OPENAI_API_KEY: 'fixture-provider-key-never-probed', ...ambient, PI_CODING_AGENT_DIR: piAmbient};
  const context = {...env, ...selected, PI_CODING_AGENT_DIR: piSelected};
  fs.writeFileSync(record, '');
  for (const name of ['opencode', 'pi']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs = require('node:fs'), argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({name: ${JSON.stringify(name)}, argv, env: process.env}) + '\\n');
if (argv.length === 1 && argv[0] === '--version') {
  console.log(${JSON.stringify(name === 'pi' ? '1.3.0' : '2.0.28-native1m.1')}); process.exit(0);
}
if (${JSON.stringify(name)} === 'opencode' && argv[0] === 'api' && argv[1] === 'get' &&
    argv[2].startsWith('/api/config?') && argv[3] === '--standalone' && argv.length === 4) {
  const disabled = process.env.XDG_CONFIG_HOME === ${JSON.stringify(selected.XDG_CONFIG_HOME)} ? 'mesh-board' : 'mesh-work';
  console.log(JSON.stringify([{info: {mcp: {servers: {[disabled]: {disabled: true}}}}}])); process.exit(0);
}
process.exit(99);
`, {mode: 0o700});
  }
  for (const name of ['mesh-board-mcp', 'work-mcp']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 99\n', {mode: 0o700});
  }
  for (const [directory, name] of [[piAmbient, 'ambient'], [piSelected, 'selected']]) {
    fs.writeFileSync(path.join(directory!, 'mcp.json'), JSON.stringify({mcpServers: {
      other: {command: `${name}-only`}, 'mesh-board': {enabled: false},
    }}), {mode: 0o600});
    fs.writeFileSync(path.join(directory!, 'auth.json'), 'fixture credentials; never read', {mode: 0o600});
  }
  function run(expression: string, setup = '') {
    return JSON.parse(execFileSync(PYTHON, ['-I', '-c',
      `import asyncio,json,os,shlex,sys; sys.path.insert(0, ${JSON.stringify(REPO)}); import server,pimcp,discover; context=json.loads(sys.argv[1])\n${setup}\nprint(json.dumps(${expression}))`,
      JSON.stringify(context)], {cwd, env, encoding: 'utf8', timeout: 20000}));
  }
  return {root, home, cwd, mesh, ambient, selected, piAmbient, piSelected, context, run,
    calls: () => fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call),
    close: () => fs.rmSync(root, {recursive: true, force: true})};
}

test('OpenCode preflight reads disabled servers from the selected context without mutating the ambient environment', () => {
  const f = fixture();
  try {
    const result = f.run(`{"command": shlex.split(asyncio.run(server._opencode_command("opencode", ${JSON.stringify(f.cwd)}, context))[0]),
      "ambient": os.environ["XDG_CONFIG_HOME"]}`);
    assert.equal(result.ambient, f.ambient.XDG_CONFIG_HOME);
    assert(result.command.includes('--standalone'));
    const assignment = result.command.find((word: string) => word.startsWith('OPENCODE_CONFIG_CONTENT='));
    assert(assignment);
    const config = JSON.parse(assignment.slice('OPENCODE_CONFIG_CONTENT='.length));
    assert.deepEqual(Object.keys(config.mcp.servers), ['mesh-work'], 'selected profile disables mesh-board, not mesh-work');
    const [probe] = f.calls().filter(call => call.argv[0] === 'api');
    assert(probe); assert.equal(probe.env.XDG_CONFIG_HOME, f.selected.XDG_CONFIG_HOME);
    for (const name of Object.keys(f.selected)) assert.equal(probe.env[name], f.selected[name]);
    assert.equal(probe.env.MESH_SESSION_TOKEN, undefined);
    assert.equal(probe.env.OPENAI_API_KEY, undefined);
  } finally { f.close(); }
});

test('OpenCode resume admission checks the selected store, never an ambient conversation with the same id', () => {
  const f = fixture();
  try {
    for (const [base, id] of [[f.ambient.XDG_DATA_HOME, SID], [f.selected.XDG_DATA_HOME, 'ses_other0123456789']]) {
      const directory = path.join(base!, 'opencode'); fs.mkdirSync(directory);
      const db = createStoreV2(path.join(directory, 'opencode.db'));
      try { addConversationV2(db, id!, f.cwd, {updated: 10000}); } finally { db.close(); }
    }
    assert.deepEqual(f.run(`[discover.opencode_session_exists(${JSON.stringify(SID)}),
      discover.opencode_session_exists(${JSON.stringify(SID)}, context)]`), [true, false]);
    assert.throws(() => f.run(`asyncio.run(server._opencode_command(
      "opencode --session ${SID}", ${JSON.stringify(f.cwd)}, context))`), /HTTPConflict/);
    const file = path.join(f.selected.XDG_DATA_HOME!, 'opencode/opencode.db');
    // A fresh valid context has its own resumable transcript; the ambient copy is irrelevant.
    const db = new DatabaseSync(file);
    try { addConversationV2(db, SID, f.cwd, {updated: 10000}); } finally { db.close(); }
    const command = f.run(`shlex.split(asyncio.run(server._opencode_command(
      "opencode --session ${SID}", ${JSON.stringify(f.cwd)}, context))[0])`) as string[];
    assert(command.includes(SID)); assert(command.includes('--standalone'));
  } finally { f.close(); }
});

test('an asynchronous OpenCode preflight keeps one context snapshot even if its caller changes the mapping', () => {
  const f = fixture();
  try {
    const command = f.run(`shlex.split(asyncio.run(server._opencode_command("opencode", ${JSON.stringify(f.cwd)}, context))[0])`,
      `original = server.agentmcp.opencode_resolved
def changed(environ):
    context["XDG_CONFIG_HOME"] = ${JSON.stringify(f.ambient.XDG_CONFIG_HOME)}
    return original(environ)
server.agentmcp.opencode_resolved = changed`) as string[];
    const assignment = command.find(word => word.startsWith('OPENCODE_CONFIG_CONTENT='));
    assert(assignment);
    assert.deepEqual(Object.keys(JSON.parse(assignment.slice('OPENCODE_CONFIG_CONTENT='.length)).mcp.servers), ['mesh-work']);
    assert.equal(f.calls().find(call => call.argv[0] === 'api')!.env.XDG_CONFIG_HOME, f.selected.XDG_CONFIG_HOME);
  } finally { f.close(); }
});

test('Pi prepares its overlay from the selected agent directory and does not probe with Mesh/provider credentials', () => {
  const f = fixture();
  try {
    const result = f.run(`{"runtime": list(map(str, pimcp.prepare(${JSON.stringify(f.mesh)}, context))),
      "ambient": os.environ["PI_CODING_AGENT_DIR"]}`);
    assert.equal(result.ambient, f.piAmbient);
    const [, overlay] = result.runtime;
    assert.equal(fs.readlinkSync(path.join(overlay, 'auth.json')), path.join(f.piSelected, 'auth.json'));
    const config = JSON.parse(fs.readFileSync(path.join(overlay, 'mcp.json'), 'utf8'));
    assert.equal(config.mcpServers.other.command, 'selected-only');
    assert.equal(config.mcpServers['mesh-board'].enabled, false);
    const [call] = f.calls(); assert.equal(f.calls().length, 1);
    assert.equal(call!.name, 'pi'); assert.deepEqual(call!.argv, ['--version']);
    assert.equal(call!.env.PI_CODING_AGENT_DIR, f.piSelected);
    assert.equal(call!.env.MESH_SESSION_TOKEN, undefined); assert.equal(call!.env.OPENAI_API_KEY, undefined);
  } finally { f.close(); }
});

test('a refused selected Pi configuration does not fall back to a valid ambient configuration', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.piSelected, 'mcp.json'), '{invalid');
    assert.throws(() => f.run(`list(map(str, pimcp.prepare(${JSON.stringify(f.mesh)}, context)))`),
      /Invalid Pi MCP configuration/);
    assert.equal(fs.existsSync(path.join(f.mesh, 'pi-agent-overlays')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.piAmbient, 'mcp.json'), 'utf8')).mcpServers.other,
      {command: 'ambient-only'});
  } finally { f.close(); }
});
