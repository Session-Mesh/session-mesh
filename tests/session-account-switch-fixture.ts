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
import {installFakeCodex, launchesIn, rolloutIn} from './fake-codex-lib.ts';
import {appendFixturePath} from './fixture-login-path.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {createSessionRequestGate, setTranslator} from '../static/pane-actions.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
const PROFILE = process.env.MESH_PROFILE_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_profile_main.exe');
const SKIP = fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`;
const PROFILE_SKIP = fs.existsSync(PROFILE) || process.env.MESH_REQUIRE_MESH_PROFILE ? false
  : `mesh-profile not built: dune build ./bin/mesh_profile_main.exe, or set MESH_PROFILE_CMD (${PROFILE})`;
// `accounts carry` is in the usage text of a mesh-platform that has it.
const CARRY = SKIP ? SKIP : spawnSync(PLATFORM, [], {encoding: 'utf8'}).stderr?.includes('accounts carry') ? false
  : `this mesh-platform has no accounts carry command (${PLATFORM})`;

let mesh: Mesh;
let bin: string;
let log: string;
let cookie = '';
let host: ChildProcess | undefined;
let travelHome: string, workHome: string, clientClaude: string;

before(async () => {
  if (SKIP) return;
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-bin-'));
  const installed = installFakeCodex(bin);
  log = installed.log;
  fs.copyFileSync(path.join(bin, 'real', 'codex'), path.join(bin, 'real', 'claude'));
  const claude = [
    "#!/bin/sh",
    "umask 077",
    "while [ \"$#\" -gt 1 ]; do",
    "  case \"$1\" in --session-id|--resume|-r) id=$2; break;; esac",
    "  shift",
    "done",
    "test -n \"$id\" || exit 1",
    "root=\"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"",
    "folder=\"$root/projects/test-workspace\"",
    "mkdir -p \"$folder\"",
    "transcript=\"$folder/$id.jsonl\"",
    "mkdir -p \"$HOME/.claude/sessions\"",
    "printf '{\"sessionId\":\"%s\"}\\n' \"$id\" > \"$HOME/.claude/sessions/$$.json\"",
    "test -f \"$transcript\" || printf '{\"type\":\"user\",\"sessionId\":\"%s\",\"message\":{\"role\":\"user\",\"content\":\"test account transfer\"}}\\n' \"$id\" > \"$transcript\"",
    "printf 'claude|%s|%s|%s|%s|%s\\n' \"$root\" \"$MESH_SESSION\" \"$id\" \"$MESH_SESSION_TOKEN\" \"$$\" >> \"@LOG@\"",
    "exec 3<\"$transcript\"; exec \"@BIN@/real/claude\" 300",
    "",
  ].join('\n').replace('@LOG@', log).replace('@BIN@', bin);
  fs.writeFileSync(path.join(bin, 'claude'), claude, {mode: 0o755});
  const PATH = installed.PATH;
  mesh = await startMesh('switch-', {PATH, MESH_MESH_PLATFORM_CMD: PLATFORM, MESH_MESH_PROFILE_CMD: PROFILE,
    CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined});
  appendFixturePath(mesh.home, PATH);
  const accounts = path.join(mesh.home, '.agent-accounts');
  fs.mkdirSync(accounts, {mode: 0o700});
  travelHome = path.join(accounts, 'travel', '.codex');   // missing: created when a request names it
  workHome = path.join(accounts, 'work', '.codex');
  clientClaude = path.join(accounts, 'client', '.claude');
  for (const folder of ['travel', 'work', 'client', 'twin', 'spare', 'mirror']) fs.mkdirSync(path.join(accounts, folder), {mode: 0o700});
  fs.mkdirSync(workHome, {mode: 0o700});
  fs.mkdirSync(clientClaude, {mode: 0o700});
  fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), JSON.stringify({v: 1, accounts: [
    {id: 'travel', label: 'Travel', codex_home: travelHome},
    {id: 'work', label: 'Work', codex_home: workHome},
    {id: 'client', label: 'Client', claude_config_dir: clientClaude},
    // labels are unique among the aliases, but one can equal the default account's
    {id: 'twin', label: 'Default Account', codex_home: path.join(accounts, 'twin', '.codex')},
    // one account's label is another's id: that name designates neither (Mesh_account_resolver)
    {id: 'spare', label: 'Reserve', codex_home: path.join(accounts, 'spare', '.codex')},
    {id: 'mirror', label: 'spare', codex_home: path.join(accounts, 'mirror', '.codex')},
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
  if (bin) for (const agent of ['codex', 'claude']) spawnSync('pkill', ['-KILL', '-f', path.join(bin, 'real', agent)]);
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (bin) fs.rmSync(bin, {recursive: true, force: true});
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const launches = () => launchesIn(log);
const owner = () => ({Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'});

type Session = {name: string; token: string; sid: string};

/** A Codex session started under ``account`` (absent: the default one), once the listing knows its conversation. */
async function fixtureSession(agent: 'codex' | 'claude', name: string, account?: string, cwd?: string): Promise<Session> {
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', body: JSON.stringify({cwd: cwd ?? mesh.home,
    preset: agent, name, ...account ? {account} : {}}),
  headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, await response.clone().text());
  let token = '', sid = '';
  for (let attempt = 0; attempt < 150 && !(token && sid); attempt += 1) {
    token = launches().find(fields => fields[2] === name)?.[4] ?? '';
    sid = ((await listed(name))?.agent as {session_id?: string} | null)?.session_id ?? '';
    if (!(token && sid)) await sleep(200);
  }
  assert.ok(token && sid, `the fake ${agent} of ${name} is listed with its conversation`);
  return {name, token, sid};
}

const codexSession = (name: string, account?: string, cwd?: string) => fixtureSession('codex', name, account, cwd);

async function listed(name: string): Promise<Record<string, unknown> | undefined> {
  const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`}}))
    .json() as {mesh: Record<string, unknown>[]};
  return data.mesh.find(item => item.id === name);
}

/** Rename session ``name`` LABEL as the list does, and file it in a folder (which ranks it). */
async function arrange(name: string): Promise<void> {
  const headers = {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'};
  for (const op of [{op: 'folder-add', name: 'Moved'}, {op: 'move', id: name, folder: 'Moved'}, {op: 'rename', id: name, label: LABEL}]) {
    const done = await fetch(`${mesh.base}/api/organize`, {method: 'POST', headers, body: JSON.stringify(op)});
    assert.equal(done.status, 200, await done.text());
  }
}

/** The label and folder of session ``name``, read twice: the second listing would prune those of an ended incarnation. */
async function arrangement(name: string): Promise<unknown[]> {
  await listed(name);
  const item = await listed(name);
  return [item?.label, item?.folder];
}

const LABEL = 'Renamed before the switch';

function installNativeProfiles(): string {
  const registry = path.join(mesh.confDir, 'backend-profiles.json');
  fs.chmodSync(path.dirname(mesh.confDir), 0o700);
  fs.chmodSync(mesh.confDir, 0o700);
  const profiles = [
    {backend: 'codex', id: 'work', label: 'Work', enabled: true,
      roots: {config: workHome, state: path.join(mesh.home, '.agent-accounts/work/state')}},
    {backend: 'codex', id: 'travel', label: 'Travel', enabled: true,
      roots: {config: travelHome, state: path.join(mesh.home, '.agent-accounts/travel/state')}},
  ];
  for (const profile of profiles) {
    fs.mkdirSync(profile.roots.config, {recursive: true, mode: 0o700});
    fs.mkdirSync(profile.roots.state, {recursive: true, mode: 0o700});
  }
  fs.writeFileSync(registry, JSON.stringify({version: 1, profiles}), {mode: 0o600});
  return registry;
}

async function nativeProfiles() {
  const response = await fetch(`${mesh.base}/api/accounts/profiles`, {headers: owner()});
  assert.equal(response.status, 200, await response.clone().text());
  const {data} = await response.json() as {data: {profiles: {id: string; switch_qualified: boolean}[]}};
  assert.deepEqual(data.profiles.map(profile => profile.id), ['work', 'travel']);
  assert.ok(data.profiles.every(profile => typeof profile.switch_qualified === 'boolean'));
}

async function consentPolicy() {
  const response = await fetch(`${mesh.base}/api/accounts/consent`, {headers: owner()});
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as {data: unknown}).data;
}

async function unchangedSource(session: Session, before: Record<string, unknown>, launchLog: string): Promise<void> {
  assert.equal(fs.readFileSync(log, 'utf8'), launchLog, `${session.name}: no replacement agent was launched`);
  const still = await listed(session.name);
  assert.equal(still?.created, before.created, `${session.name}: the same source incarnation is still running`);
  const pid = (before.agent as {pid?: number} | undefined)?.pid;
  assert.equal(typeof pid, 'number', `${session.name}: the source agent was live`);
  assert.equal((still?.agent as {pid?: number} | undefined)?.pid, pid, `${session.name}: source agent was not stopped`);
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


export {SKIP, PROFILE_SKIP, CARRY, mesh, log, travelHome, workHome, sleep, launches, owner,
  clientClaude, fixtureSession, codexSession, listed, arrange, arrangement, LABEL, installNativeProfiles, nativeProfiles,
  consentPolicy, unchangedSource, ask, requested, refused, decide, launchOf};
export type {Session, Request};
