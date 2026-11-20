// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Account aliases (accounts.json on the runner, docs/operations.md "Account aliases"): a session started with
// an alias runs Claude with CLAUDE_CONFIG_DIR and Codex with CODEX_HOME set to that alias's folder; with no
// alias nothing changes. The page names an alias id only, never a folder; an alias without a folder for the
// agent is refused, never replaced by the default account. Fake `claude` and `codex` on PATH record their
// account variables and which credential variables reached them. `mesh-platform` (which validates the file)
// comes from MESH_MESH_PLATFORM_CMD or the dune build; MESH_REQUIRE_MESH_PLATFORM=1 (CI) makes its absence a
// failure instead of a skip.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, runServer, scratchHome, startMesh, stopServer} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
// Without mesh-platform (a job that only fetches the PTY host) the suite is skipped, with the reason, unless
// MESH_REQUIRE_MESH_PLATFORM is set; ocaml/accounts/test covers the validation itself.
const SKIP = fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`;

// The credentials a login shell profile may export for the default account (server.ACCOUNT_OVERRIDES).
const PROFILE_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const REFUSED = 'Account alias refused: check accounts.json and its folders on the runner (details in the server log)';

let mesh: Mesh;
let bin: string;
let log: string;
let cookie = '';
let host: ChildProcess | undefined;
let workClaude: string, workCodex: string, codexOnly: string, claudeOnly: string;

// agent|account variable|session|credential variables present (comma-separated names, sorted)|arguments|session token.
// The fake codex also writes a rollout under its Codex home and keeps it open (then runs as a process named
// codex), as the real one does: the listing then knows its conversation, which a restart request resumes.
const fake = (agent: string, variable: string) => [
  '#!/bin/sh',
  'case "$*" in *--version*) echo "2.1.0 (Claude Code)"; exit 0;; esac',
  `found=$(env | cut -d= -f1 | grep -E '^(${PROFILE_CREDENTIALS.join('|')})$' | sort | tr '\\n' ,)`,
  `printf '%s|%s|%s|%s|%s|%s\\n' "${agent}" "\${${variable}-unset}" "$MESH_SESSION" "$found" "$*" "$MESH_SESSION_TOKEN" >> '${'LOG'}'`,
  ...agent === 'codex' ? [
    'if [ "$1" = resume ]; then id=$2; else id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr A-F a-f); fi',
    'folder="${CODEX_HOME:-$HOME/.codex}/sessions/2026/11/20"; mkdir -p "$folder"',
    'rollout="$folder/rollout-2026-11-20T10-00-00-$id.jsonl"',
    `printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\\n' "$id" "$PWD" >> "$rollout"`,
    `exec 3<"$rollout"; exec 'REALDIR/codex' 300`,
  ] : ['exec sleep 30'], ''].join('\n');

before(async () => {
  if (SKIP) return;
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-bin-'));
  log = path.join(bin, 'launches.log');
  const real = path.join(bin, 'real');   // a `sleep` named codex: the process the listing recognises
  fs.mkdirSync(real);
  fs.copyFileSync(fs.realpathSync('/bin/sleep'), path.join(real, 'codex'));
  fs.chmodSync(path.join(real, 'codex'), 0o755);
  for (const [agent, variable] of [['claude', 'CLAUDE_CONFIG_DIR'], ['codex', 'CODEX_HOME']]) {
    fs.writeFileSync(path.join(bin, agent!), fake(agent!, variable!).replace("'LOG'", `'${log}'`).replace('REALDIR', real),
      {mode: 0o755});
  }
  const PATH = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('accounts-', {PATH, MESH_MESH_PLATFORM_CMD: PLATFORM, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined});
  // The default account's credentials, exported by the login shell every session starts (`$SHELL -l`).
  fs.writeFileSync(path.join(mesh.home, '.profile'),
    PROFILE_CREDENTIALS.map(name => `export ${name}=profile-default-${name.toLowerCase()}\n`).join(''));
  const accounts = path.join(mesh.home, '.agent-accounts');
  fs.mkdirSync(path.join(accounts, 'work'), {recursive: true, mode: 0o700});
  fs.mkdirSync(path.join(accounts, 'perso'), {recursive: true, mode: 0o700});
  fs.chmodSync(accounts, 0o700);
  workClaude = path.join(accounts, 'work', '.claude');
  workCodex = path.join(accounts, 'work', '.codex');     // missing: created at the first launch
  codexOnly = path.join(accounts, 'perso', '.codex');
  claudeOnly = path.join(accounts, 'client', '.claude');   // missing: created at the first launch
  fs.mkdirSync(path.dirname(claudeOnly), {mode: 0o700});
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
  fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), JSON.stringify({v: 1, accounts}), {mode: 0o600});
}

async function create(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${mesh.base}/api/new`, {method: 'POST', headers: headers(), body: JSON.stringify({cwd: mesh.home, ...body})});
}

/** Start a session and return what the fake agent recorded: [agent, variable value, credentials present]. */
async function launchedWith(body: Record<string, unknown>): Promise<string[]> {
  const response = await create(body);
  assert.equal(response.status, 200, await response.clone().text());
  const {id} = await response.json() as {id: string};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const line = lines.map(item => item.split('|')).find(fields => fields[2] === id);
    if (line) return [line[0]!, line[1]!, line[3]!];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no agent started for ${JSON.stringify(body)}`);
}

/** [agent, variable value] the fake agent recorded. */
async function launched(body: Record<string, unknown>): Promise<string[]> {
  return (await launchedWith(body)).slice(0, 2);
}

const logText = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';

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

const viewStatus = async (target: string) => (await fetch(`${mesh.base}/api/view`, {method: 'POST', headers: headers(),
  body: JSON.stringify({target})})).status;

describe('account aliases', {skip: SKIP}, () => {
  test('without accounts.json nothing changes: the default account, no alias offered', async () => {
    assert.deepEqual(await launchedWith({preset: 'claude', name: 'plain'}),
      ['claude', 'unset', `${['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'].join(',')},`],
      "the default account keeps the profile's credentials");
    assert.deepEqual((await configAccounts()).accounts, []);
    assert.equal((await listed('plain'))?.account, undefined);
  });

  test('a declared alias runs Claude and Codex with its own folders, and the page only learns id and label', async () => {
    // three aliases: Claude and Codex, Codex only, Claude only
    declare([{id: 'work', label: 'Atacama', claude_config_dir: workClaude, codex_home: workCodex},
      {id: 'perso', label: 'Perso', codex_home: codexOnly}, {id: 'client', label: 'Client', claude_config_dir: claudeOnly}]);
    const {text, accounts} = await configAccounts();
    assert.deepEqual(accounts, [{id: 'work', label: 'Atacama', claude: true, codex: true},
      {id: 'perso', label: 'Perso', claude: false, codex: true}, {id: 'client', label: 'Client', claude: true, codex: false}]);
    assert.ok(!text.includes('.agent-accounts'), 'no folder reaches the page');
    assert.deepEqual(await launched({preset: 'claude', name: 'c-work', account: 'work'}), ['claude', workClaude]);
    assert.deepEqual(await launched({preset: 'codex', name: 'x-work', account: 'work'}), ['codex', workCodex]);
    assert.equal(fs.statSync(workCodex).mode & 0o777, 0o700, 'a missing folder is created private');
    assert.deepEqual(await launched({preset: 'codex-yolo', name: 'x-perso', account: 'perso'}), ['codex', codexOnly]);
    assert.deepEqual(await launched({preset: 'claude', name: 'c-client', account: 'client'}), ['claude', claudeOnly]);
    const refused = await create({preset: 'codex', name: 'x-client', account: 'client'});
    assert.equal(refused.status, 400);
    assert.equal(await refused.text(), 'The account alias Client has no Codex folder');
    const row = await listed('c-work');
    assert.equal(row?.account, 'work');
    assert.equal(row?.account_label, 'Atacama');
    assert.deepEqual(await launched({preset: 'codex', name: 'x-default'}), ['codex', 'unset']);
    assert.deepEqual(await launched({preset: 'codex', name: 'x-null', account: null}), ['codex', 'unset']);
  });

  test("a credential the login shell exports for the default account never reaches an alias's agent", async () => {
    // each agent loses its own credentials only: the other agent's are not an account choice for it
    assert.deepEqual(await launchedWith({preset: 'claude', name: 'c-profile', account: 'work'}),
      ['claude', workClaude, 'CODEX_API_KEY,OPENAI_API_KEY,']);
    assert.deepEqual(await launchedWith({preset: 'codex', name: 'x-profile', account: 'work'}),
      ['codex', workCodex, 'ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN,']);
  });

  test('an approved restart request of an alias session resumes it under the same alias', async () => {
    const response = await create({preset: 'codex', name: 'x-restart', account: 'work'});
    assert.equal(response.status, 200, await response.clone().text());
    let token = '';
    for (let attempt = 0; attempt < 100 && !token; attempt += 1) {
      token = logText().split('\n').map(line => line.split('|')).find(fields => fields[2] === 'x-restart')?.[5] ?? '';
      if (!token) await new Promise(resolve => setTimeout(resolve, 100));
    }
    let sid = '';
    for (let attempt = 0; attempt < 100 && !sid; attempt += 1) {   // the listing reads the rollout it holds
      sid = ((await listed('x-restart'))?.agent as {session_id?: string} | null)?.session_id ?? '';
      if (!sid) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(sid, 'the fake codex is listed with its conversation');
    const owner = {Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'};
    const made = await fetch(`${mesh.base}/api/session-actions/@self/request`, {method: 'POST',
      headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({action: 'restart'})});
    assert.equal(made.status, 202, await made.clone().text());
    const {request} = await made.json() as {request: {id: string}};
    const claimed = await fetch(`${mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST', headers: owner,
      body: JSON.stringify({tab_nonce: 'a'.repeat(32)})});
    const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
    const decided = await fetch(`${mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST', headers: owner,
      body: JSON.stringify({approve: true, claim_nonce: claimNonce})});
    const result = (await decided.json() as {request: {result: {id?: string; error?: string}}}).request.result;
    assert.ok(result.id, JSON.stringify(result));
    let resumed: string[] | undefined;
    for (let attempt = 0; attempt < 100 && !resumed; attempt += 1) {
      resumed = logText().split('\n').map(line => line.split('|')).find(fields => fields[2] === result.id && fields[4]!.startsWith('resume'));
      if (!resumed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(resumed, 'the replacement resumed the conversation');
    assert.deepEqual([resumed[1], resumed[3]], [workCodex, 'ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN,'],
      "the alias's Codex home, without the profile's Codex credentials");
    assert.match(resumed[4]!, new RegExp(`^resume ${sid}`));
    assert.equal((await listed(result.id))?.account, 'work');
  });

  test('an alias without a folder for the agent, an unknown alias or a shell is refused, never the default account', async () => {
    const before = logText();
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
    assert.equal(logText(), before, 'no agent was started');
  });

  test('a folder refused at launch (the list still cached) refuses the session, without naming a folder', async () => {
    const before = logText();
    fs.chmodSync(workClaude, 0o770);   // accounts.json unchanged: only `prepare` sees it
    try {
      const response = await create({preset: 'claude', name: 'r-prepare', account: 'work'});
      const text = await response.text();
      assert.equal(response.status, 400, text);
      assert.equal(text, REFUSED);
      assert.match(mesh.output(), /account alias work refused: .*can be written by other users/, 'the reason is logged');
    } finally {
      fs.chmodSync(workClaude, 0o700);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(logText(), before, 'no agent was started, under no account');
  });

  test('the page cannot name a folder or inject a command: only an alias id is taken', async () => {
    for (const account of [workClaude, '../work', 'work; touch /tmp/x', 'WORK', 'default', 42, ['work'], {id: 'work'},
      0, false, '', []]) {
      const response = await create({preset: 'claude', name: 'inj', account});
      assert.equal(response.status, 400, JSON.stringify(account));
    }
    // folders or variables in the body are ignored: the default account
    assert.deepEqual(await launched({preset: 'claude', name: 'extra', claude_config_dir: workClaude,
      env: {CLAUDE_CONFIG_DIR: workClaude}}), ['claude', 'unset']);
  });

  test('any number of aliases up to 64: all offered, each usable, each login file refused by /view', async () => {
    const root = path.join(mesh.home, '.agent-accounts', 'many');
    fs.mkdirSync(root, {mode: 0o700});
    const extra = Array.from({length: 61}, (_, index) => {
      const folder = path.join(root, `a${index}`);
      fs.mkdirSync(folder, {mode: 0o700});
      const members = [{claude_config_dir: path.join(folder, '.claude')}, {codex_home: path.join(folder, '.codex')},
        {claude_config_dir: path.join(folder, '.claude'), codex_home: path.join(folder, '.codex')}][index % 3]!;
      return {id: `a${index}`, label: `Account ${index}`, ...members} as
        {id: string; label: string; claude_config_dir?: string; codex_home?: string};
    });
    const all = [{id: 'work', label: 'Atacama', claude_config_dir: workClaude, codex_home: workCodex},
      {id: 'perso', label: 'Perso', codex_home: codexOnly}, {id: 'client', label: 'Client', claude_config_dir: claudeOnly}, ...extra];
    assert.equal(all.length, 64);
    declare([...all, {id: 'one-more', label: 'One more', codex_home: path.join(root, 'one-more')}]);
    assert.deepEqual((await configAccounts()).accounts, [], '65 aliases: the whole file is refused');
    declare(all);
    const offered = (await configAccounts()).accounts as {id: string}[];
    assert.deepEqual(offered.map(item => item.id), all.map(item => item.id));
    const last = extra[59]!;   // index 59: Claude and Codex
    assert.deepEqual(await launched({preset: 'claude', name: 'c-last', account: last.id}), ['claude', last.claude_config_dir]);
    assert.deepEqual(await launched({preset: 'codex', name: 'x-last', account: last.id}), ['codex', last.codex_home]);
    const credentials = path.join(last.claude_config_dir!, '.credentials.json');
    fs.writeFileSync(credentials, '{"secret": 1}\n', {mode: 0o600});
    assert.equal(await viewStatus(credentials), 403);
  });

  test("an alias's login files stay refused by /view after the alias is removed or accounts.json refused", async () => {
    const credentials = path.join(workClaude, '.credentials.json');
    const auth = path.join(codexOnly, 'auth.json');
    fs.writeFileSync(credentials, '{"secret": 1}\n', {mode: 0o600});
    fs.writeFileSync(auth, '{"secret": 1}\n', {mode: 0o600});
    const notes = path.join(workClaude, 'notes.md');
    fs.writeFileSync(notes, '# notes\n');
    assert.equal(await viewStatus(credentials), 403);
    assert.equal(await viewStatus(auth), 403);
    assert.equal(await viewStatus(notes), 200, 'another file of the folder is a document');
    declare([{id: 'perso', label: 'Perso', codex_home: codexOnly}]);   // work removed
    assert.equal((await configAccounts()).accounts instanceof Array, true);
    assert.equal(await viewStatus(credentials), 403, 'removed alias');
    fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), '{"v": 1, "accounts": [', {mode: 0o600});
    assert.deepEqual((await configAccounts()).accounts, []);
    assert.equal(await viewStatus(credentials), 403, 'refused file');
    assert.equal(await viewStatus(auth), 403, 'refused file');
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

/** The session token the fake agent of session ``name`` was started with. */
async function tokenOf(name: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const token = logText().split('\n').map(line => line.split('|')).find(fields => fields[2] === name)?.[5];
    if (token) return token;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no token recorded for ${name}`);
}

const selfAccounts = (token: string, query = '') => fetch(`${mesh.base}/api/session-actions/@self/accounts${query}`,
  {headers: {Authorization: `MeshSession ${token}`}});

// The mesh-board `session_accounts` tool reads this route: what an agent may learn of the accounts.
describe("a session's own accounts, read with its session token", {skip: SKIP}, () => {
  const DEFAULT = {id: 'default', label: 'Default account', claude: true, codex: true};

  test('the alias of the calling session, its agent kind as launched, and ids and labels only', async () => {
    declare([{id: 'work', label: 'Atacama', claude_config_dir: workClaude, codex_home: workCodex},
      {id: 'perso', label: 'Perso', codex_home: codexOnly}]);
    assert.equal((await create({preset: 'claude', name: 'a-work', account: 'work'})).status, 200);
    assert.equal((await create({preset: 'codex', name: 'a-default'})).status, 200);
    const response = await selfAccounts(await tokenOf('a-work'));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(JSON.parse(text), {agent: 'claude', switch_supported: true, accounts_file: 'ok',
      current: {id: 'work', label: 'Atacama', declared: true},
      accounts: [DEFAULT, {id: 'work', label: 'Atacama', claude: true, codex: true},
        {id: 'perso', label: 'Perso', claude: false, codex: true}]});
    assert.ok(!text.includes('.agent-accounts') && !text.includes(mesh.home), 'no folder reaches the agent');
    const plain = await (await selfAccounts(await tokenOf('a-default'))).json() as Record<string, unknown>;
    assert.equal(plain.agent, 'codex');
    assert.deepEqual(plain.current, {id: 'default', label: 'Default account', declared: true});
  });

  test('nothing the caller sends chooses the session or the agent kind', async () => {
    const token = await tokenOf('a-work');
    for (const query of ['?agent=codex', '?session=a-default', '?account=perso']) {
      const response = await selfAccounts(token, query);
      assert.equal(response.status, 400, query);
    }
    const bearer = await fetch(`${mesh.base}/api/session-actions/@self/accounts`, {headers: headers()});
    assert.equal(bearer.status, 401, 'the master token names no session');
    const forged = await selfAccounts(`${token.slice(0, -2)}xx`);
    assert.equal(forged.status, 401);
  });

  test('a refused accounts.json is said, offers the default account only, and keeps naming the current alias', async () => {
    fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), '{"v": 1, "accounts": [', {mode: 0o600});
    const refused = await (await selfAccounts(await tokenOf('a-work'))).json() as Record<string, unknown>;
    assert.equal(refused.accounts_file, 'refused');
    assert.deepEqual(refused.accounts, [DEFAULT]);
    assert.deepEqual(refused.current, {id: 'work', label: 'work', declared: false});
    fs.rmSync(path.join(mesh.confDir, 'accounts.json'));
    const absent = await (await selfAccounts(await tokenOf('a-work'))).json() as Record<string, unknown>;
    assert.equal(absent.accounts_file, 'absent');
  });
});

describe('alias login files across a restart', {skip: SKIP}, () => {
  test('a server restarted with a refused accounts.json still refuses the login files of the folders declared before', async () => {
    const where = await scratchHome('accounts-restart-', {MESH_MESH_PLATFORM_CMD: PLATFORM});
    try {
      const folder = path.join(where.home, '.agent-accounts', 'work', '.claude');
      fs.mkdirSync(folder, {recursive: true, mode: 0o700});
      fs.chmodSync(path.join(where.home, '.agent-accounts'), 0o700);
      fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
      const accounts = path.join(where.confDir, 'accounts.json');
      fs.writeFileSync(accounts, JSON.stringify({v: 1, accounts: [{id: 'work', label: 'Work', claude_config_dir: folder}]}),
        {mode: 0o600});
      const credentials = path.join(folder, '.credentials.json');
      fs.writeFileSync(credentials, '{"secret": 1}\n', {mode: 0o600});
      const status = async () => {
        const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
        return (await fetch(`http://127.0.0.1:${where.port}/api/view`, {method: 'POST', body: JSON.stringify({target: credentials}),
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}})).status;
      };
      const first = await runServer(where);
      assert.equal(first.result.listened, true, first.result.output);
      try {
        assert.equal(await status(), 403);
      } finally {
        await stopServer(first.child);
      }
      fs.writeFileSync(accounts, '{"v": 1, "accounts": [', {mode: 0o600});   // a typo
      const second = await runServer(where);
      assert.equal(second.result.listened, true, second.result.output);
      try {
        assert.equal(await status(), 403, second.output());
      } finally {
        await stopServer(second.child);
      }
    } finally {
      fs.rmSync(where.scratch, {recursive: true, force: true});
    }
  });
});
