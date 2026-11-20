// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Account switch requests (docs/agent-guide.md "Ask for sessions"): a Claude or Codex session asks, with its
// session token, to continue its conversation under another account alias. The server resolves the name for the
// session's own agent kind (never one the body names), refuses with a code and a message what cannot be carried
// out, and does nothing until the owner approves. Once approved: the exact source stops, `mesh-platform accounts
// carry` copies the conversation, and the agent resumes under the target; when the carry fails the conversation
// resumes under its own account (rolled_back). A fake `codex` on PATH records its Codex home and arguments, and
// writes and holds open a rollout as the real one does, so the listing knows its conversation.
// `mesh-platform` comes from MESH_MESH_PLATFORM_CMD or the dune build (MESH_REQUIRE_MESH_PLATFORM=1: required); the
// cases that carry a conversation need its `accounts carry` command and are skipped, with the reason, without it.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {createSessionRequestGate, setTranslator} from '../static/pane-actions.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
const SKIP = fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`;
// `accounts carry` is in the usage text of a mesh-platform that has it.
const CARRY = SKIP ? SKIP : spawnSync(PLATFORM, [], {encoding: 'utf8'}).stderr?.includes('accounts carry') ? false
  : `this mesh-platform has no accounts carry command (${PLATFORM})`;

let mesh: Mesh;
let bin: string;
let log: string;
let cookie = '';
let host: ChildProcess | undefined;
let travelHome: string, workHome: string, clientClaude: string;

// codex|CODEX_HOME|session|arguments|session token. The rollout is held open (fd 3) by a process named codex.
const fakeCodex = (logFile: string, real: string) => [
  '#!/bin/sh',
  `printf '%s|%s|%s|%s|%s\\n' codex "\${CODEX_HOME-unset}" "$MESH_SESSION" "$*" "$MESH_SESSION_TOKEN" >> '${logFile}'`,
  'if [ "$1" = resume ]; then id=$2; else id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr A-F a-f); fi',
  'folder="${CODEX_HOME:-$HOME/.codex}/sessions/2026/11/20"; mkdir -p "$folder"',
  'rollout="$folder/rollout-2026-11-20T10-00-00-$id.jsonl"',
  `printf '{"type":"session_meta","payload":{"id":"%s","home":"%s"}}\\n' "$id" "\${CODEX_HOME-default}" >> "$rollout"`,
  `exec 3<"$rollout"; exec '${real}/codex' 300`, ''].join('\n');

before(async () => {
  if (SKIP) return;
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-bin-'));
  log = path.join(bin, 'launches.log');
  const real = path.join(bin, 'real');   // a `sleep` named codex: the process the listing recognises
  fs.mkdirSync(real);
  fs.copyFileSync(fs.realpathSync('/bin/sleep'), path.join(real, 'codex'));
  fs.chmodSync(path.join(real, 'codex'), 0o755);
  fs.writeFileSync(path.join(bin, 'codex'), fakeCodex(log, real), {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('switch-', {PATH, MESH_MESH_PLATFORM_CMD: PLATFORM, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined});
  const accounts = path.join(mesh.home, '.agent-accounts');
  fs.mkdirSync(accounts, {mode: 0o700});
  travelHome = path.join(accounts, 'travel', '.codex');   // missing: created when a request names it
  workHome = path.join(accounts, 'work', '.codex');
  clientClaude = path.join(accounts, 'client', '.claude');
  for (const folder of ['travel', 'work', 'client', 'twin']) fs.mkdirSync(path.join(accounts, folder), {mode: 0o700});
  fs.mkdirSync(workHome, {mode: 0o700});
  fs.mkdirSync(clientClaude, {mode: 0o700});
  fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), JSON.stringify({v: 1, accounts: [
    {id: 'travel', label: 'Travel', codex_home: travelHome},
    {id: 'work', label: 'Work', codex_home: workHome},
    {id: 'client', label: 'Client', claude_config_dir: clientClaude},
    // labels are unique among the aliases, but one can equal the default account's
    {id: 'twin', label: 'Default Account', codex_home: path.join(accounts, 'twin', '.codex')},
  ]}), {mode: 0o600});
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
  // The fake agents outlive the PTY host; a process named codex left running would be seen by the next suites'
  // listings (they would read its rollout and write a cache).
  if (bin) spawnSync('pkill', ['-KILL', '-f', path.join(bin, 'real', 'codex')]);
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (bin) fs.rmSync(bin, {recursive: true, force: true});
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const launches = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)
  .map(line => line.split('|'));
const owner = () => ({Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'});

type Session = {name: string; token: string; sid: string};

/** A Codex session started under ``account`` (absent: the default one), once the listing knows its conversation. */
async function codexSession(name: string, account?: string): Promise<Session> {
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', body: JSON.stringify({cwd: mesh.home,
    preset: 'codex', name, ...account ? {account} : {}}),
  headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, await response.clone().text());
  let token = '', sid = '';
  for (let attempt = 0; attempt < 150 && !(token && sid); attempt += 1) {
    token = launches().find(fields => fields[2] === name)?.[4] ?? '';
    sid = ((await listed(name))?.agent as {session_id?: string} | null)?.session_id ?? '';
    if (!(token && sid)) await sleep(200);
  }
  assert.ok(token && sid, `the fake codex of ${name} is listed with its conversation`);
  return {name, token, sid};
}

async function listed(name: string): Promise<Record<string, unknown> | undefined> {
  const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`}}))
    .json() as {mesh: Record<string, unknown>[]};
  return data.mesh.find(item => item.id === name);
}

const ask = (session: Session, body: Record<string, unknown>) => fetch(`${mesh.base}/api/session-actions/@self/request`,
  {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `MeshSession ${session.token}`, 'Content-Type': 'application/json'}});

type Request = {id: string; state: string; account: string | null; from_account: string | null;
  result: {id?: string; account?: string; error?: string; rolled_back?: boolean; code?: string;
    retryable?: boolean; operator_action?: boolean} | null};

async function requested(session: Session, account: unknown): Promise<Request> {
  const response = await ask(session, {action: 'switch_account', account});
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json() as {request: Request}).request;
}

/** The coded refusal of a switch request: [code, message]. */
async function refused(session: Session, account: unknown): Promise<[string, string]> {
  const response = await ask(session, {action: 'switch_account', account});
  const text = await response.text();
  assert.equal(response.status, 400, text);
  const {error} = JSON.parse(text) as {error: {code: string; message: string}};
  return [error.code, error.message];
}

async function decide(request: Request, approve: boolean): Promise<Request> {
  const claimed = await fetch(`${mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST', headers: owner(),
    body: JSON.stringify({tab_nonce: 'b'.repeat(32)})});
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
  const decided = await fetch(`${mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST', headers: owner(),
    body: JSON.stringify({approve, claim_nonce: claimNonce})});
  assert.equal(decided.status, 200, await decided.clone().text());
  return (await decided.json() as {request: Request}).request;
}

/** The last resume the fake codex recorded in session ``name`` (a name freed by the stop can be reused): [CODEX_HOME, arguments]. */
async function launchOf(name: string): Promise<[string, string]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = launches().findLast(fields => fields[2] === name && fields[3]!.startsWith('resume'));
    if (found) return [found[1]!, found[3]!];
    await sleep(100);
  }
  throw new Error(`no codex launched in ${name}`);
}

const rolloutIn = (home: string, sid: string) => path.join(home, 'sessions', '2026', '11', '20', `rollout-2026-11-20T10-00-00-${sid}.jsonl`);

describe('account switch requests', {skip: SKIP}, () => {
  let source: Session;

  test('a name is an exact id or one label ignoring case, for the agent of the session; anything else is refused with the list', async () => {
    source = await codexSession('x-ask');
    const [unknown, listing] = await refused(source, 'trav');
    assert.equal(unknown, 'account_unknown', 'no prefix match');
    assert.match(listing, /Available: default \(Default account\), travel \(Travel\), work \(Work\)/);
    assert.ok(!listing.includes('.agent-accounts') && !listing.includes(mesh.home), 'no folder in a refusal');
    const [ambiguous, candidates] = await refused(source, 'default ACCOUNT');
    assert.equal(ambiguous, 'account_ambiguous', 'two labels equal without case: none is chosen');
    assert.match(candidates, /\(default, twin\); give the id\.$/);
    const [noAgent, noAgentText] = await refused(source, 'Client');
    assert.equal(noAgent, 'account_no_agent');
    assert.match(noAgentText, /^Account Client has no Codex folder; it serves: Claude\.$/);
    assert.equal((await refused(source, 'default'))[0], 'account_same');
    assert.equal((await refused(source, 'work '))[0], 'account_unknown', 'no trimming');
    for (const bad of ['', 'x'.repeat(65), 42, null, ['travel'], {id: 'travel'}]) {
      assert.equal((await refused(source, bad))[0], 'account_unknown', JSON.stringify(bad));
    }
    const byLabel = await requested(source, 'TRAVEL');
    assert.deepEqual([byLabel.account, byLabel.from_account, byLabel.state], ['travel', 'default', 'pending']);
    assert.equal(fs.statSync(travelHome).mode & 0o777, 0o700, "the target's folder is prepared, private");
  });

  test('the agent kind is the session\'s: a body naming another agent or session is refused, and no other action names an account', async () => {
    const before = launches().length;
    // refused for their shape, before any account is looked at (Client serves Claude only: never this Codex session)
    for (const body of [{action: 'switch_account', account: 'client', agent: 'claude'},
      {action: 'switch_account', account: 'client', preset: 'claude'},
      {action: 'switch_account', account: 'travel', session: 'other'},
      {action: 'switch_account', account: 'travel', model: 'gpt-5'}]) {
      const response = await ask(source, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await response.text(), 'Invalid request fields', JSON.stringify(body));
    }
    for (const body of [{action: 'restart', account: 'travel'}, {action: 'create', preset: 'codex', account: 'travel'}]) {
      const response = await ask(source, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await response.text(), 'Only an account switch names an account', JSON.stringify(body));
    }
    await sleep(300);
    assert.equal(launches().length, before, 'nothing started');
  });

  test('nothing is stopped or launched without the owner: a pending request waits, a declined one ends', async () => {
    const before = launches().length;
    const request = await requested(source, 'work');
    await sleep(1500);
    assert.equal(launches().length, before, 'no agent started while the request waits');
    assert.ok(await listed('x-ask'), 'the source still runs');
    const status = await fetch(`${mesh.base}/api/session-actions/@self/request?id=${request.id}`,
      {headers: {Authorization: `MeshSession ${source.token}`}});
    assert.equal((await status.json() as {request: Request}).request.state, 'pending');
    const declined = await decide(request, false);
    assert.equal(declined.state, 'rejected');
    await sleep(500);
    assert.equal(launches().length, before, 'a declined request starts nothing');
    assert.ok(await listed('x-ask'), 'and stops nothing');
  });

  test('a target refused once approved stops nothing and never falls back to the default account', async () => {
    const session = await codexSession('x-refused', 'work');
    const request = await requested(session, 'travel');
    const before = launches().length;
    const file = path.join(mesh.confDir, 'accounts.json');
    const declared = fs.readFileSync(file, 'utf8');
    const {accounts} = JSON.parse(declared) as {accounts: {id: string}[]};
    // the operator removes the target alias after the request: it is unknown at execution
    fs.writeFileSync(file, JSON.stringify({v: 1, accounts: accounts.filter(account => account.id !== 'travel')}), {mode: 0o600});
    try {
      const decided = await decide(request, true);
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.match(decided.result!.error!, /^Unknown account alias/);
      assert.ok(!decided.result?.rolled_back, 'nothing was stopped');
    } finally {
      fs.writeFileSync(file, declared, {mode: 0o600});
    }
    await sleep(500);
    assert.equal(launches().length, before, 'no agent started, under no account');
    assert.ok(await listed('x-refused'), 'the source still runs');
  });

  test('approved: the source stops, its conversation is carried, and it resumes under the target', {skip: CARRY}, async () => {
    const session = await codexSession('x-move');
    const carried = rolloutIn(travelHome, session.sid);
    const original = fs.readFileSync(rolloutIn(path.join(mesh.home, '.codex'), session.sid), 'utf8');
    const decided = await decide(await requested(session, 'Travel'), true);
    assert.equal(decided.state, 'completed', JSON.stringify(decided));
    assert.equal(decided.result?.account, 'travel');
    const name = decided.result!.id!;
    const [home, argv] = await launchOf(name);
    assert.equal(home, travelHome, "the replacement runs with the target's Codex home");
    assert.match(argv, new RegExp(`^resume ${session.sid}`));
    // the carried copy first, then what the resumed agent wrote: the conversation was there before it started
    assert.ok(fs.readFileSync(carried, 'utf8').startsWith(original), 'the conversation was carried before the resume');
    assert.equal((await listed(name))?.account, 'travel');
    assert.equal(await listed('x-move'), undefined, 'the source is gone');
  });

  test('a carry that fails resumes the conversation under its own account and says it was undone', {skip: CARRY}, async () => {
    const session = await codexSession('x-undone');
    const target = rolloutIn(workHome, session.sid);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    fs.writeFileSync(target, '{"type":"session_meta","payload":{"other":"copy"}}\n', {mode: 0o600});   // a divergent copy
    const decided = await decide(await requested(session, 'work'), true);
    assert.equal(decided.state, 'failed', JSON.stringify(decided));
    assert.equal(decided.result?.rolled_back, true);
    assert.equal(decided.result?.code, 'conversation_diverged');
    assert.match(decided.result!.error!, /^Switch undone: the conversation resumed under account default\. Cause: conversation_diverged/);
    assert.match(decided.result!.error!, /Asking again does not change this\.$/, 'a refusal, not a retryable failure');
    assert.deepEqual([decided.result?.retryable, decided.result?.operator_action], [false, false]);
    const name = decided.result!.id!;
    const [home, argv] = await launchOf(name);
    assert.equal(home, 'unset', "resumed under its own (default) account, never the target's");
    assert.match(argv, new RegExp(`^resume ${session.sid}`));
    assert.equal(fs.readFileSync(target, 'utf8'), '{"type":"session_meta","payload":{"other":"copy"}}\n', 'the target copy is untouched');
    assert.equal((await listed(name))?.account, undefined, 'the resumed session runs under the default account');
  });
});

describe("the owner's switch dialog", () => {
  const dialog = async (language: string, request: Record<string, unknown>): Promise<string[]> => {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'i18n', `${language}.json`), 'utf8')) as Record<string, string>;
    setTranslator((key, params = {}) => (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name])));
    const shown: string[] = [];
    const gate = createSessionRequestGate({
      claim: async () => ({kind: 'claimed', claimNonce: 'n'.repeat(32)}),
      confirm: message => { shown.push(message); return false; },
      decide: async () => 'settled',
      notify: () => {},
    });
    await gate.consider([{id: 'r', action: 'switch_account', state: 'pending', preset: 'codex', model: null,
      source: {id: 'x-agent'}, ...request}]);
    return shown;
  };
  const request = {account: 'travel', account_label: 'Travel', from_account: 'default', from_label: 'Default account'};

  test('says which accounts, and that the whole conversation goes to the other account', async () => {
    const [english] = await dialog('en', request);
    assert.match(english!, /^Agent “x-agent” asks to move from account Default account \(default\) to account Travel \(travel\)\./);
    assert.match(english!, /whole conversation will be copied .* and sent to that account’s provider/);
    const [french] = await dialog('fr', request);
    assert.match(french!, /^L’agent « x-agent » demande à passer du compte Default account \(default\) au compte Travel \(travel\)\./);
    assert.match(french!, /Toute sa conversation sera copiée .* et envoyée au fournisseur de ce compte/);
    assert.doesNotMatch(french!, /propriétaire/);
  });

  test('a switch request without both accounts is never shown', async () => {
    assert.deepEqual(await dialog('en', {account: 'travel'}), []);
    assert.deepEqual(await dialog('en', {from_account: 'default'}), []);
  });
});
