// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Legacy native merge tests, not qualification of Mesh's current private config API probe.
// These execute the real `opencode debug config` (1.x, historically observed on 1.18.35) and
// `opencode debug config --standalone` (2.x, historically reported on 2.3.0). Private HOME/XDG alone
// does not establish isolation: the old 2.x command is not qualified to honour --standalone, and
// system/ancestor configuration is not excluded here. Do not run this file against an installed
// OpenCode 2 binary as a safe private probe. The executable test bodies below remain legacy coverage.
// The current command is `opencode api get <target> --standalone`, with a URL-encoded
// location[directory] query parameter on /api/config. Its historical native proof used
// 2.0.28-native1m.1; OpenCode 2.3.0 is not verified for that command. The old merge test is not proof.
// Use opencode-config-probe.test.ts for the fake-CLI adapter contract (no native qualification).
// MESH_OPENCODE_BIN selects a native executable here, otherwise PATH; absent/wrong majors skip.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';

function findOpencode(): string | null {
  const configured = process.env.MESH_OPENCODE_BIN;
  if (configured) return fs.existsSync(configured) ? configured : null;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'opencode');
    if (directory && fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const binary = findOpencode();

/** The major version, read with an isolated HOME (`--version` of 2.x also needs none of the shared service). */
function majorOf(executable: string | null): number | null {
  if (!executable) return null;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-version-'));
  try {
    const text = execFileSync(executable, ['--version'], {cwd: home, encoding: 'utf8', timeout: 60000, env: {
      PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
      XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), TMPDIR: home,
      OPENCODE_DISABLE_AUTOUPDATE: '1'}});
    const match = /(\d+)\.\d+\.\d+/.exec(text);
    return match ? Number(match[1]) : null;
  } catch { return null; } finally { fs.rmSync(home, {recursive: true, force: true}); }
}
const major = majorOf(binary);
let scratch: string;
let meshBin: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-merge-'));
  meshBin = path.join(scratch, 'meshbin');
  fs.mkdirSync(meshBin);
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\n', {mode: 0o755});
});
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

type Resolved = {mcp: Record<string, {command: string[]; enabled?: boolean; environment?: Record<string, string>}>;
  permission?: Record<string, string>; plugin: string[]};

/** The configuration OpenCode resolves for a user configuration plus the mesh's inline one. */
function resolve(user: object): Resolved {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const config = path.join(home, 'config');
  fs.mkdirSync(path.join(config, 'opencode'), {recursive: true});
  fs.writeFileSync(path.join(config, 'opencode', 'opencode.json'), JSON.stringify(user));
  const inline = execFileSync(PYTHON, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)}); import agentmcp; print(agentmcp.opencode_config(reach={"MESH_PORT": "17691"}), end="")`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, MESH_BIN_DIR: meshBin}});
  const output = execFileSync(binary!, ['debug', 'config'], {cwd: home, encoding: 'utf8', timeout: 60000, env: {
    PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), TMPDIR: home,
    OPENCODE_CONFIG_CONTENT: inline}});
  return JSON.parse(output) as Resolved;
}

describe('the mesh configuration merged with the user\'s OpenCode 1.x configuration', {skip: major === 1 ? false : `needs OpenCode 1.x (found ${major ?? 'none'})`}, () => {
  test('without a user configuration: the board server and the plugin', () => {
    const resolved = resolve({});
    assert.deepEqual(resolved.mcp['mesh-board'].command, [path.join(meshBin, 'mesh-board-mcp')]);
    assert.equal(resolved.plugin.length, 1);
    assert.match(resolved.plugin[0], /opencode-mesh-plugin\.ts$/);
  });

  test('a stricter choice of the user survives: enabled false and permission rules stay in force', () => {
    const resolved = resolve({
      mcp: {'mesh-board': {type: 'local', command: ['/usr/bin/other'], enabled: false}},
      permission: {'mesh-board_*': 'ask', bash: 'deny'}});
    assert.equal(resolved.mcp['mesh-board'].enabled, false, 'a board disabled by the user stays disabled');
    assert.deepEqual(resolved.permission, {'mesh-board_*': 'ask', bash: 'deny'});
  });

  test('a user or project configuration cannot point the bridge at another port', () => {
    const resolved = resolve({mcp: {'mesh-board': {type: 'local', command: ['/usr/bin/other'],
      environment: {MESH_PORT: '6666', KEPT: '1'}}}});
    assert.equal(resolved.mcp['mesh-board'].environment?.MESH_PORT, '17691');
    assert.equal(resolved.mcp['mesh-board'].environment?.KEPT, '1', 'the user\'s other variables are not touched');
  });

  test('the command is the mesh\'s, the user\'s other servers and plugins are kept', () => {
    const resolved = resolve({
      mcp: {'mesh-board': {type: 'local', command: ['/usr/bin/other']}, mine: {type: 'local', command: ['/usr/bin/mine']}},
      plugin: ['file:///user/plugin.ts']});
    assert.deepEqual(resolved.mcp['mesh-board'].command, [path.join(meshBin, 'mesh-board-mcp')],
      'the board server cannot be replaced by a lookalike through the user configuration');
    assert.deepEqual(resolved.mcp.mine.command, ['/usr/bin/mine']);
    assert.equal(resolved.plugin[0], 'file:///user/plugin.ts');
    assert.match(resolved.plugin[1], /opencode-mesh-plugin\.ts$/);
  });
});

/** The sources OpenCode 2 lists for a user configuration plus the mesh's inline one (always with --standalone). */
type Source = {type: string; path?: string; info?: {mcp?: {servers?: Record<string, {command?: string[]; disabled?: boolean;
  environment?: Record<string, string>}>}; plugins?: {package: string}[]}};

function oc2Home(user: object): {home: string; environ: NodeJS.ProcessEnv} {
  const home = fs.mkdtempSync(path.join(scratch, 'home2-'));
  const config = path.join(home, 'config');
  fs.mkdirSync(path.join(config, 'opencode'), {recursive: true});
  fs.writeFileSync(path.join(config, 'opencode', 'opencode.json'), JSON.stringify(user));
  return {home, environ: {PATH: `${path.dirname(binary!)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
    TMPDIR: home, OPENCODE_DISABLE_AUTOUPDATE: '1'}};
}

function sources2(user: object, board = true): Source[] {
  const {home, environ} = oc2Home(user);
  const inline = execFileSync(PYTHON, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)}); import agentmcp; print(agentmcp.opencode_config_v2(reach={"MESH_PORT": "17691"}, disabled=${board ? '()' : 'agentmcp.MESH_SERVER_NAMES'}))`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, MESH_BIN_DIR: meshBin}}).trim();
  const output = execFileSync(binary!, ['debug', 'config', '--standalone'], {cwd: home, encoding: 'utf8', timeout: 60000,
    env: {...environ, OPENCODE_CONFIG_CONTENT: inline}});
  return JSON.parse(output) as Source[];
}

function disablesBoard(user: object): unknown {
  const {home, environ} = oc2Home(user);
  const output = execFileSync(PYTHON, ['-I', '-c', `import json, sys; sys.path.insert(0, ${JSON.stringify(REPO)}); import agentmcp
off = agentmcp.opencode_user_disabled_servers(${JSON.stringify(home)}, ${JSON.stringify(environ)})
print(json.dumps(None if off is None else "mesh-board" in off))`],
  {cwd: REPO, encoding: 'utf8', timeout: 90000, env: {PATH: process.env.PATH, HOME: home}});
  return JSON.parse(output);
}

describe('the mesh configuration next to the user\'s OpenCode 2.x configuration', {skip: major === 2 ? false : `needs OpenCode 2.x (found ${major ?? 'none'})`}, () => {
  test('without a user configuration: the board server and the plugin, in the v2 shape', () => {
    const list = sources2({});
    const inline = list.at(-1)!.info!;
    assert.deepEqual(inline.mcp!.servers!['mesh-board'].command, [path.join(meshBin, 'mesh-board-mcp')]);
    assert.equal(inline.mcp!.servers!['mesh-board'].environment?.MESH_PORT, '17691');
    assert.equal(inline.plugins?.length, 1);
    assert.match(inline.plugins![0].package, /opencode-mesh-plugin-v2$/);
  });

  test('the sources are listed one by one: the user\'s own stays a source of its own, the mesh\'s comes last', () => {
    const list = sources2({mcp: {servers: {mine: {type: 'local', command: ['/usr/bin/mine']}}}});
    const user = list.find(source => source.type === 'document' && source.path?.endsWith('opencode.json'));
    assert.deepEqual(user?.info?.mcp?.servers?.mine?.command, ['/usr/bin/mine']);
    assert.equal(list.at(-1)!.path, undefined, 'the inline document has no path and is the last source');
    assert.ok(list.indexOf(user!) < list.length - 1);
  });

  test('a board the user disabled is seen as such, so the mesh injects no server (a whole-object replacement would lose it)', () => {
    const disabled = {mcp: {servers: {'mesh-board': {type: 'local', command: ['/usr/bin/other'], disabled: true}}}};
    assert.equal(sources2(disabled).find(source => source.path?.endsWith('opencode.json'))!.info!.mcp!.servers!['mesh-board'].disabled, true);
    assert.equal(disablesBoard(disabled), true);
    assert.equal(disablesBoard({mcp: {servers: {mine: {type: 'local', command: ['/usr/bin/mine']}}}}), false);
    const list = sources2(disabled, false);
    assert.equal(list.at(-1)!.info!.mcp, undefined, 'only the plugin is injected');
    assert.equal(list.at(-1)!.info!.plugins?.length, 1);
  });

  test('no OpenCode service is left listening on its default port', async () => {
    const listening = await new Promise<boolean>(resolve => {
      const socket = net.connect(49374, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    assert.equal(listening, false);
  });
});
