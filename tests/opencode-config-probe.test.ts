// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Exercise the existing Python adapter through a private, recording CLI. No installed OpenCode,
// user configuration, shared service, MCP process or provider is used.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
type Call = {argv: string[]; cwd: string; env: Record<string, string>; stdin: string};
type Reply = {stdout: string; status?: number; delay?: number};
const SOURCES = [
  {type: 'directory', path: '/fixture/config'},
  {type: 'document', info: {mcp: {servers: {'mesh-board': {disabled: true}, other: {disabled: true}}}}},
  {type: 'document', info: {mcp: {servers: {'mesh-work': {disabled: true}}}}},
  {type: 'document', info: {mcp: {servers: {'mesh-board': {disabled: false}}}}},
];

function fixture(reply: Reply = {stdout: JSON.stringify(SOURCES)}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-config-probe-'));
  const cwd = path.join(fixtureRoot, `project space # ? ' " = & café`);
  const home = path.join(fixtureRoot, 'home');
  const bin = path.join(home, '.local', 'bin');
  const record = path.join(fixtureRoot, 'calls.jsonl');
  for (const directory of [cwd, bin, 'config', 'data', 'cache', 'state', 'runtime', 'tmp'].map(
    name => path.isAbsolute(name) ? name : path.join(fixtureRoot, name))) {
    fs.mkdirSync(directory, {recursive: true});
  }
  const executable = path.join(bin, 'opencode');
  // The stand-in accepts exactly the private raw API command. Log even rejected commands so a
  // legacy/shared-service fallback cannot hide behind a successful second invocation.
  const argv = ['api', 'get', `/api/config?${new URLSearchParams({'location[directory]': cwd})}`, '--standalone'];
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({argv, cwd: process.cwd(), env: process.env,
  stdin: fs.readFileSync(0, 'utf8')}) + '\\n');
if (JSON.stringify(argv) !== ${JSON.stringify(JSON.stringify(argv))}) process.exit(64);
setTimeout(() => { process.stdout.write(${JSON.stringify(reply.stdout)}); process.exit(${reply.status ?? 0}); }, ${reply.delay ?? 0});
`, {mode: 0o755});
  for (const name of ['mesh-board-mcp', 'work-mcp']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 99\n', {mode: 0o755});
  }
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: path.join(fixtureRoot, 'tmp'),
    XDG_CONFIG_HOME: path.join(fixtureRoot, 'config'), XDG_DATA_HOME: path.join(fixtureRoot, 'data'),
    XDG_CACHE_HOME: path.join(fixtureRoot, 'cache'), XDG_STATE_HOME: path.join(fixtureRoot, 'state'),
    XDG_RUNTIME_DIR: path.join(fixtureRoot, 'runtime'),
    OPENCODE_CONFIG: path.join(fixtureRoot, 'selected.json'), OPENCODE_CONFIG_CONTENT: '{"mcp":{"servers":{}}}',
    OPENCODE_DISABLE_AUTOUPDATE: '0', MESH_BIN_DIR: bin, MESH_CONF_DIR: path.join(fixtureRoot, 'mesh'),
    MESH_SESSION_TOKEN: 'fixture-only-mesh-token', MESH_PORT: '17691', MESH_SESSION: 'fixture-session',
    OPENAI_API_KEY: 'fixture-only-provider-key', ANTHROPIC_API_KEY: 'fixture-only-provider-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-only-provider-key', GOOGLE_API_KEY: 'fixture-only-provider-key',
  };
  fs.writeFileSync(env.OPENCODE_CONFIG, '{}');
  function python(expression: string): unknown {
    return JSON.parse(execFileSync(PYTHON, ['-I', '-c',
      `import asyncio, json, os, shlex, sys; sys.path.insert(0, ${JSON.stringify(REPO)}); import agentmcp, server; print(json.dumps(${expression}, default=list))`,
      cwd, executable], {cwd: fixtureRoot, env, encoding: 'utf8', timeout: 22000}));
  }
  return {cwd, executable, env, argv,
    sources: () => python('agentmcp._opencode_config_sources(sys.argv[2], sys.argv[1], os.environ)'),
    disabled: () => python('agentmcp.opencode_user_disabled_servers(sys.argv[1])'),
    command: () => python('shlex.split(asyncio.run(server._opencode_v2_command(["opencode"], sys.argv[1])))') as string[],
    calls: () => fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call),
    close: () => fs.rmSync(fixtureRoot, {recursive: true, force: true}),
  };
}

function inline(command: string[]): {mcp?: {servers: Record<string, unknown>}; plugins?: unknown[]} {
  assert.equal(command[0], 'env');
  assert.ok(command.includes('--standalone'));
  const assignment = command.find(word => word.startsWith('OPENCODE_CONFIG_CONTENT='));
  assert.ok(assignment);
  return JSON.parse(assignment.slice('OPENCODE_CONFIG_CONTENT='.length));
}

test('config sources use only the private API with an exactly encoded location and selected context', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.sources(), SOURCES);
    const [call] = f.calls();
    assert.equal(f.calls().length, 1);
    assert.deepEqual(call.argv, f.argv);
    assert.equal(call.cwd, f.cwd);
    assert.equal(call.stdin, '');
    assert.equal(new URL(call.argv[2], 'http://fixture.invalid').searchParams.get('location[directory]'), f.cwd);
    for (const name of ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT']) {
      assert.equal(call.env[name], f.env[name], name);
    }
    assert.equal(call.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.deepEqual(Object.keys(call.env).filter(name => name.startsWith('MESH_')), []);
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_API_KEY']) {
      assert.equal(call.env[name], undefined, name);
    }
  } finally { f.close(); }
});

test('normalised disabled Mesh names win over later enabled entries and prevent MCP injection', () => {
  const f = fixture();
  try {
    assert.deepEqual((f.disabled() as string[]).sort(), ['mesh-board', 'mesh-work']);
    const config = inline(f.command());
    assert.equal(config.mcp, undefined);
    assert.equal(config.plugins?.length, 1);
    assert.equal(f.calls().length, 2);
    for (const call of f.calls()) assert.deepEqual(call.argv, f.argv);
  } finally { f.close(); }
});

test('readable empty sources still permit the installed Mesh servers', () => {
  const f = fixture({stdout: '[]'});
  try {
    assert.deepEqual(f.disabled(), []);
    assert.deepEqual(Object.keys(inline(f.command()).mcp!.servers).sort(), ['mesh-board', 'mesh-work']);
    assert.equal(f.calls().length, 2);
  } finally { f.close(); }
});

test('disabling either Mesh server leaves only the other eligible for injection', () => {
  for (const [disabled, kept] of [['mesh-board', 'mesh-work'], ['mesh-work', 'mesh-board']]) {
    const f = fixture({stdout: JSON.stringify([
      {type: 'document', info: {mcp: {servers: {[disabled]: {disabled: true}, other: {disabled: true}}}}},
    ])});
    try {
      assert.deepEqual(f.disabled(), [disabled]);
      assert.deepEqual(Object.keys(inline(f.command()).mcp!.servers), [kept]);
      assert.equal(f.calls().length, 2);
      for (const call of f.calls()) assert.deepEqual(call.argv, f.argv);
    } finally { f.close(); }
  }
});

for (const [name, reply] of Object.entries({
  'command failure': {stdout: '[]', status: 1},
  'unsupported API': {stdout: 'Unknown command: api', status: 64},
  'malformed JSON': {stdout: '[not-json'},
  'non-array response': {stdout: '{"error":"unavailable"}'},
  'null response': {stdout: 'null'},
})) {
  test(`${name}: unknown configuration, no MCP injection and no fallback`, () => {
    const f = fixture(reply);
    try {
      assert.equal(f.sources(), null);
      assert.equal(f.disabled(), null);
      const config = inline(f.command());
      assert.equal(config.mcp, undefined);
      assert.equal(config.plugins?.length, 1);
      assert.equal(f.calls().length, 3, 'one invocation per probe, never a fallback');
      for (const call of f.calls()) assert.deepEqual(call.argv, f.argv);
    } finally { f.close(); }
  });
}

test('a stalled private config probe times out and remains unknown', () => {
  const f = fixture({stdout: '[]', delay: 20000});
  try {
    const start = performance.now();
    assert.equal(f.sources(), null);
    assert.ok(performance.now() - start < 19000, 'the adapter keeps its short config timeout');
    assert.equal(f.calls().length, 1);
    assert.deepEqual(f.calls()[0].argv, f.argv);
  } finally { f.close(); }
});
