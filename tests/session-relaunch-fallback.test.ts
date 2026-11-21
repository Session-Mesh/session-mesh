// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What an approved restart or account switch does when the agent cannot be restarted in its own terminal
// (server.py replace_session, relaunch_in_place): a real server, a real native PTY host behind a proxy
// (ptyhost-proxy-lib) that records every operation and can play an older host or a refusing or slow one, and the
// fake `codex` of fake-codex-lib.
// - an older PTY host (no agent_relaunch_v1): the session is replaced by a new one, as before, and stop_agent_if is
//   never sent;
// - a refusal after which the host cannot stop the agent alone (process_scan_failed, no_terminal, no_shell,
//   no_job_control): the whole session is replaced, as before stop_agent_if existed; nothing was signalled first;
// - any other refusal: nothing is stopped or started, and the request says what the operator can do;
// - a stop reply later than the old 5 s client limit still restarts the agent in the same terminal; one later than the
//   server waits says the agent was stopped and that the session is still there, never that the host is down.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {installFakeCodex, launchesIn} from './fake-codex-lib.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {type Proxy, startProxy} from './ptyhost-proxy-lib.ts';
import {request as hostRequest, waitFor} from './ptyhost-wire-lib.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
const CARRY = fs.existsSync(PLATFORM) && spawnSync(PLATFORM, [], {encoding: 'utf8'}).stderr?.includes('accounts carry')
  ? false : `mesh-platform with accounts carry not found (${PLATFORM})`;

type Mode = {hideRelaunch?: boolean; refuseStop?: string; delayStopMs?: number};
type Request = {id: string; state: string; result: {id?: string; account?: string; error?: string} | null};
type Session = {name: string; token: string; sid: string};

let mesh: Mesh;
let bin: string, log: string, cookie = '';
let host: ChildProcess | undefined;
let proxy: Proxy | undefined;
const ops: string[] = [];
const mode: Mode = {};
const pending: Promise<unknown>[] = [];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const launches = () => launchesIn(log);
const resumesIn = (name: string) => launches().filter(fields => fields[2] === name && fields[3]!.startsWith('resume'));

/** What the proxy does with one request of the server (ptyhost-proxy-lib's intercept). */
function intercept(realSocket: string) {
  return (req: {op?: string}) => {
    ops.push(String(req.op));
    if (req.op === 'list' && mode.hideRelaunch) {
      const listing = hostRequest(realSocket, req) as Promise<{pty_capabilities?: string[]}[]>;
      return {replyAfter: listing.then(items => items.map(item => ({...item,
        pty_capabilities: (item.pty_capabilities ?? []).filter(capability => capability !== 'agent_relaunch_v1')})))};
    }
    if (req.op === 'stop_agent_if' && mode.refuseStop) return {reply: {ok: false, reason: mode.refuseStop}};
    if (req.op === 'stop_agent_if' && mode.delayStopMs) {
      const held = mode.delayStopMs;
      const late = (hostRequest(realSocket, req) as Promise<object>).then(async reply => { await sleep(held); return reply; });
      pending.push(late);
      return {replyAfter: late};
    }
    return undefined;
  };
}

before(async () => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-bin-'));
  const installed = installFakeCodex(bin);
  log = installed.log;
  mesh = await startMesh('relaunch-', {PATH: installed.PATH, MESH_MESH_PLATFORM_CMD: PLATFORM,
    CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined});
  const travel = path.join(mesh.home, '.agent-accounts', 'travel');
  fs.mkdirSync(travel, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), JSON.stringify({v: 1, accounts: [
    {id: 'travel', label: 'Travel', codex_home: path.join(travel, '.codex')}]}), {mode: 0o600});
  const realRun = path.join(mesh.home, 'real-run');
  fs.mkdirSync(realRun, {mode: 0o700});
  const realSocket = path.join(realRun, 'session-mesh', 'ptyhost.sock');
  const [command, ...args] = ptyhostArgv();
  host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH: installed.PATH, HOME: mesh.home, XDG_RUNTIME_DIR: realRun, LANG: 'C', SHELL: '/bin/sh'}});
  await waitFor('the PTY host answering', 10000, () => hostRequest(realSocket, {op: 'list'}).then(() => true, () => false));
  proxy = await startProxy(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), realSocket, intercept(realSocket));
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
});

after(async () => {
  await Promise.allSettled(pending);
  if (bin) spawnSync('pkill', ['-KILL', '-f', path.join(bin, 'real', 'codex')]);
  proxy?.close();
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (bin) fs.rmSync(bin, {recursive: true, force: true});
});

async function listed(name: string): Promise<{created?: number; account?: string; agent?: {session_id?: string}} | undefined> {
  const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`}}))
    .json() as {mesh: {id: string}[]};
  return data.mesh.find(item => item.id === name);
}

async function codexSession(name: string): Promise<Session> {
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', body: JSON.stringify({cwd: mesh.home,
    preset: 'codex', name}),
  headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, await response.clone().text());
  let token = '', sid = '';
  for (let attempt = 0; attempt < 150 && !(token && sid); attempt += 1) {
    token = launches().find(fields => fields[2] === name)?.[4] ?? '';
    sid = (await listed(name))?.agent?.session_id ?? '';
    if (!(token && sid)) await sleep(200);
  }
  assert.ok(token && sid, `the fake codex of ${name} is listed with its conversation`);
  return {name, token, sid};
}

/** The owner approves what ``session`` asked (body): the request once carried out. */
async function approved(session: Session, body: object): Promise<Request> {
  const made = await fetch(`${mesh.base}/api/session-actions/@self/request`, {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `MeshSession ${session.token}`, 'Content-Type': 'application/json'}});
  assert.equal(made.status, 202, await made.clone().text());
  const {request} = await made.json() as {request: Request};
  const owner = {Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'};
  const claimed = await fetch(`${mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST', headers: owner,
    body: JSON.stringify({tab_nonce: 'c'.repeat(32)})});
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
  const decided = await fetch(`${mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST', headers: owner,
    body: JSON.stringify({approve: true, claim_nonce: claimNonce})});
  assert.equal(decided.status, 200, await decided.clone().text());
  return (await decided.json() as {request: Request}).request;
}

/** The request replaced ``session`` by a new session, which resumed its conversation (the old path). */
async function replacedByNewSession(session: Session, decided: Request, since: number): Promise<void> {
  assert.equal(decided.state, 'completed', JSON.stringify(decided));
  const name = decided.result!.id!;
  assert.notEqual(name, session.name, 'a new session');
  await waitFor(`the resume in ${name}`, 10000, () => resumesIn(name).length === 1);
  const [resumed] = resumesIn(name);
  assert.match(resumed![3]!, new RegExp(`^resume ${session.sid}`));
  assert.notEqual(resumed![4], session.token, 'a new shell, with its own session token');
  assert.ok(ops.slice(since).includes('kill_if'), 'the source was stopped as a whole');
  await waitFor(`${session.name} gone`, 10000, async () => (await listed(session.name)) === undefined);
}

describe('an approved restart or switch that cannot restart the agent in its terminal', () => {
  test('an older PTY host: a restart replaces the session as before, and nothing is stopped alone', async () => {
    mode.hideRelaunch = true;
    try {
      const session = await codexSession('o-restart');
      const since = ops.length;
      await replacedByNewSession(session, await approved(session, {action: 'restart'}), since);
      assert.ok(!ops.slice(since).includes('stop_agent_if'), 'stop_agent_if never sent');
    } finally { mode.hideRelaunch = false; }
  });

  test('an older PTY host: a switch replaces the session as before, and nothing is stopped alone', {skip: CARRY}, async () => {
    mode.hideRelaunch = true;
    try {
      const session = await codexSession('o-switch');
      const since = ops.length;
      const decided = await approved(session, {action: 'switch_account', account: 'travel'});
      await replacedByNewSession(session, decided, since);
      assert.equal(decided.result?.account, 'travel');
      assert.ok(!ops.slice(since).includes('stop_agent_if'), 'stop_agent_if never sent');
    } finally { mode.hideRelaunch = false; }
  });

  for (const reason of ['process_scan_failed', 'no_terminal', 'no_shell', 'no_job_control']) {
    test(`${reason}: the host cannot stop the agent alone, so the whole session is replaced as before`, async () => {
      mode.refuseStop = reason;
      try {
        const session = await codexSession(`w-${reason.replaceAll('_', '-')}`);
        const since = ops.length;
        await replacedByNewSession(session, await approved(session, {action: 'restart'}), since);
        const sent = ops.slice(since);
        assert.ok(sent.indexOf('stop_agent_if') >= 0 && sent.indexOf('stop_agent_if') < sent.indexOf('kill_if'),
          'stop_agent_if was asked first and refused');
      } finally { mode.refuseStop = undefined; }
    });
  }

  test('any other refusal stops and starts nothing, and says what to do', async () => {
    const session = await codexSession('r-refused');
    const before = await listed('r-refused');
    const expected: [string, RegExp][] = [
      ['unsupported_foreground', /^Another program holds the terminal of session r-refused: nothing was stopped\. Quit it, or bring the agent back to the foreground, then ask again$/],
      ['agent_not_foreground', /^The agent of session r-refused does not hold its terminal \(it runs in the background, or beside another agent\): nothing was stopped\. Bring it to the foreground, then ask again$/],
      ['agent_starting', /^The agent was not stopped \(agent_starting\): nothing was started$/],
      ['agent_still_running', /^The agent was not stopped \(agent_still_running\): nothing was started$/],
      ['stale_incarnation', /^The agent was not stopped \(stale_incarnation\): nothing was started$/],
    ];
    for (const [reason, message] of expected) {
      mode.refuseStop = reason;
      try {
        const since = ops.length, started = launches().length;
        const decided = await approved(session, {action: 'restart'});
        assert.equal(decided.state, 'failed', JSON.stringify(decided));
        assert.match(decided.result!.error!, message);
        assert.ok(!ops.slice(since).includes('kill_if') && !ops.slice(since).includes('start_if'), reason);
        assert.equal(launches().length, started, `${reason}: nothing started`);
        assert.equal((await listed('r-refused'))?.created, before?.created, `${reason}: the same incarnation`);
      } finally { mode.refuseStop = undefined; }
    }
  });

  test('a stop reply later than the former 5 s client limit still restarts the agent in the same terminal', async () => {
    mode.delayStopMs = 7000;
    try {
      const session = await codexSession('l-late');
      const decided = await approved(session, {action: 'restart'});
      assert.equal(decided.state, 'completed', JSON.stringify(decided));
      assert.equal(decided.result?.id, 'l-late', 'the same session');
      await waitFor('the resume', 10000, () => resumesIn('l-late').length === 1);
      assert.equal(resumesIn('l-late')[0]![4], session.token, 'in the same shell');
    } finally { mode.delayStopMs = undefined; }
  });

  test('a stop reply later than the server waits: the agent was stopped, the session is still there', async () => {
    mode.delayStopMs = 17000;
    try {
      const session = await codexSession('l-lost');
      const before = await listed('l-lost');
      const decided = await approved(session, {action: 'restart'});
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.equal(decided.result?.error, 'Conversation stopped; its agent could not be started again in session l-lost',
        'the real state, not "ptyhost is not responding"');
      const now = await listed('l-lost');
      assert.ok(now, 'the session is still listed');
      assert.notEqual(now?.created, before?.created, 'its agent was stopped: a new incarnation');
      await sleep(1000);
      assert.equal(resumesIn('l-lost').length, 0, 'nothing was started again');
    } finally { mode.delayStopMs = undefined; }
  });
});
