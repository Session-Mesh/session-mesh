// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Account aliases (accounts.json on the runner, docs/operations.md "Account aliases"): a session started with
// an alias runs Claude with CLAUDE_CONFIG_DIR and Codex with CODEX_HOME set to that alias's folder; with no
// alias nothing changes. The page names an alias id only, never a folder; an alias without a folder for the
// agent is refused, never replaced by the default account. Fake `claude` and `codex` on PATH record their
// account variables. `mesh-platform` (which validates the file) comes from MESH_MESH_PLATFORM_CMD or the dune
// build.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
// Without mesh-platform (a job that only fetches the PTY host) the suite is skipped, with the reason;
// ocaml/accounts/test covers the validation itself.
const SKIP = fs.existsSync(PLATFORM) ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`;

let mesh: Mesh;
let bin: string;
let log: string;
let cookie = '';
let host: ChildProcess | undefined;
let workClaude: string, workCodex: string, codexOnly: string;

const fake = (agent: string, variable: string) => [
  '#!/bin/sh',
  'case "$*" in *--version*) echo "2.1.0 (Claude Code)"; exit 0;; esac',
  `printf '%s|%s|%s\\n' "${agent}" "\${${variable}-unset}" "$MESH_SESSION" >> '${'LOG'}'`,
  'exec sleep 30', ''].join('\n');

before(async () => {
  if (SKIP) return;
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-bin-'));
  log = path.join(bin, 'launches.log');
  for (const [agent, variable] of [['claude', 'CLAUDE_CONFIG_DIR'], ['codex', 'CODEX_HOME']]) {
    fs.writeFileSync(path.join(bin, agent!), fake(agent!, variable!).replace("'LOG'", `'${log}'`), {mode: 0o755});
  }
  const PATH = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('accounts-', {PATH, MESH_MESH_PLATFORM_CMD: PLATFORM, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined});
  const accounts = path.join(mesh.home, '.agent-accounts');
  fs.mkdirSync(path.join(accounts, 'work'), {recursive: true, mode: 0o700});
  fs.mkdirSync(path.join(accounts, 'perso'), {recursive: true, mode: 0o700});
  workClaude = path.join(accounts, 'work', '.claude');
  workCodex = path.join(accounts, 'work', '.codex');     // missing: created at the first launch
  codexOnly = path.join(accounts, 'perso', '.codex');
  fs.mkdirSync(workClaude, {mode: 0o700});
  fs.mkdirSync(codexOnly, {mode: 0o700});
  const [command, ...args] = ptyhostArgv();
  host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: '/bin/sh'}});
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (bin) fs.rmSync(bin, {recursive: true, force: true});
});

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});

function declare(accounts: unknown[]): void {
  fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), JSON.stringify({v: 1, accounts}));
}

async function create(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${mesh.base}/api/new`, {method: 'POST', headers: headers(), body: JSON.stringify({cwd: mesh.home, ...body})});
}

/** Start a session and return what the fake agent recorded: [agent, variable value]. */
async function launched(body: Record<string, unknown>): Promise<string[]> {
  const response = await create(body);
  assert.equal(response.status, 200, await response.clone().text());
  const {id} = await response.json() as {id: string};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const line = lines.map(item => item.split('|')).find(fields => fields[2] === id);
    if (line) return line.slice(0, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no agent started for ${JSON.stringify(body)}`);
}

async function listed(name: string): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as {mesh: Record<string, unknown>[]};
    const row = data.mesh.find(item => item.id === name);
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return undefined;
}

async function configAccounts(): Promise<{text: string; accounts: unknown}> {
  const text = await (await fetch(`${mesh.base}/api/config`, {headers: {Cookie: cookie}})).text();
  return {text, accounts: (JSON.parse(text) as {accounts: unknown}).accounts};
}

describe('account aliases', {skip: SKIP}, () => {
  test('without accounts.json nothing changes: the default account, no alias offered', async () => {
    assert.deepEqual(await launched({preset: 'claude', name: 'plain'}), ['claude', 'unset']);
    assert.deepEqual((await configAccounts()).accounts, []);
    assert.equal((await listed('plain'))?.account, undefined);
  });

  test('a declared alias runs Claude and Codex with its own folders, and the page only learns id and label', async () => {
    declare([{id: 'work', label: 'Atacama', claude_config_dir: workClaude, codex_home: workCodex},
      {id: 'perso', label: 'Perso', codex_home: codexOnly}]);
    const {text, accounts} = await configAccounts();
    assert.deepEqual(accounts, [{id: 'work', label: 'Atacama', claude: true, codex: true},
      {id: 'perso', label: 'Perso', claude: false, codex: true}]);
    assert.ok(!text.includes('.agent-accounts'), 'no folder reaches the page');
    assert.deepEqual(await launched({preset: 'claude', name: 'c-work', account: 'work'}), ['claude', workClaude]);
    assert.deepEqual(await launched({preset: 'codex', name: 'x-work', account: 'work'}), ['codex', workCodex]);
    assert.equal(fs.statSync(workCodex).mode & 0o777, 0o700, 'a missing folder is created private');
    assert.deepEqual(await launched({preset: 'codex-yolo', name: 'x-perso', account: 'perso'}), ['codex', codexOnly]);
    const row = await listed('c-work');
    assert.equal(row?.account, 'work');
    assert.equal(row?.account_label, 'Atacama');
    assert.deepEqual(await launched({preset: 'codex', name: 'x-default'}), ['codex', 'unset']);
  });

  test('an alias without a folder for the agent, an unknown alias or a shell is refused, never the default account', async () => {
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    for (const [body, message] of [
      [{preset: 'claude', name: 'r1', account: 'perso'}, /^The account alias Perso has no Claude folder$/],
      [{preset: 'claude', name: 'r2', account: 'nobody'}, /^Unknown account alias/],
      [{preset: 'shell', name: 'r3', account: 'work'}, /^An account alias applies to Claude and Codex sessions only$/],
      [{preset: 'custom', command: 'claude', name: 'r4', account: 'work'}, /^An account alias applies/],
    ] as const) {
      const response = await create(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(await response.text(), message);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', before, 'no agent was started');
  });

  test('the page cannot name a folder or inject a command: only an alias id is taken', async () => {
    for (const account of [workClaude, '../work', 'work; touch /tmp/x', 'WORK', 'default', 42, ['work'], {id: 'work'}]) {
      const response = await create({preset: 'claude', name: 'inj', account});
      assert.equal(response.status, 400, JSON.stringify(account));
    }
    // folders or variables in the body are ignored: the default account
    assert.deepEqual(await launched({preset: 'claude', name: 'extra', claude_config_dir: workClaude,
      env: {CLAUDE_CONFIG_DIR: workClaude}}), ['claude', 'unset']);
  });

  test('an invalid accounts.json (a folder through a link) offers no alias and leaves the default account', async () => {
    const link = path.join(mesh.home, 'linked');
    fs.symlinkSync(path.join(mesh.home, '.agent-accounts'), link);
    declare([{id: 'work', label: 'Atacama', claude_config_dir: path.join(link, 'work', '.claude')}]);
    assert.deepEqual((await configAccounts()).accounts, []);
    const response = await create({preset: 'claude', name: 'linked', account: 'work'});
    assert.equal(response.status, 400);
    assert.deepEqual(await launched({preset: 'claude', name: 'after-invalid'}), ['claude', 'unset']);
  });
});
