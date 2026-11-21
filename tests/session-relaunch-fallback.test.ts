// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What an approved restart or account switch does when the agent cannot be restarted in its own terminal
// (server.py replace_session, relaunch_in_place): a real server, a real native PTY host behind a proxy
// (ptyhost-proxy-lib) that records every operation and can play an older host or a refusing or slow one, and the
// fake `codex` of fake-codex-lib.
// - an older PTY host (no agent_relaunch_v1): the session is replaced by a new one, as before, and stop_agent_if is
//   never sent;
// - no_shell (the agent is the session's own program): the whole session is replaced, as before stop_agent_if
//   existed; nothing was signalled first, and the replacement starts no agent while the old one runs;
// - any other refusal, process_scan_failed, no_terminal and no_job_control included: nothing is stopped or started,
//   and the request says what the operator can do. After those three a stop of the whole session could leave an
//   agent that ignores SIGHUP running beside the new one (kill_if signals the shell's group, and SIGKILL follows only
//   while the shell lives: shown with no_job_control before the server refused it); the tests run such an agent
//   (a folder with .stubborn) in a shell with job control, in one without (.no-job-control), and as the session's own
//   program (.agent-leader);
// - a stop reply later than the old 5 s client limit still restarts the agent in the same terminal; one later than the
//   server waits says the agent was stopped and that the session is still there, never that the host is down; and
//   says the host is not responding when the listing shows the same incarnation, or the name held by another shell.
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

// holdStopMs: stop_agent_if never reaches the host, and its refusal comes after that delay. forge: once a stop_agent_if
// was held, the listing shows session forge.name with these fields instead (another incarnation, another shell).
type Mode = {hideRelaunch?: boolean; refuseStop?: string; delayStopMs?: number; holdStopMs?: number;
  forge?: {name: string; pid: number; created: number; armed?: boolean}};
type Request = {id: string; state: string; result: {id?: string; account?: string; error?: string} | null};
type Session = {name: string; token: string; sid: string};
type Layout = {stubborn?: boolean; noJobControl?: boolean; agentLeader?: boolean};

// The session's shell (SHELL, run as `$SHELL -l` in the session's folder): an interactive bash without job control in
// a folder holding .no-job-control (its rc file turns job control off at each prompt), the fake codex itself in one holding .agent-leader, else /bin/sh.
const SHELL_WRAPPER = ['#!/bin/sh',
  'if [ -e ./.no-job-control ]; then exec /bin/bash --noprofile --rcfile ./.no-job-control -i; fi',
  'if [ -e ./.agent-leader ]; then exec codex; fi',
  'exec /bin/sh "$@"', ''].join('\n');

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
    if (req.op === 'list' && mode.forge?.armed) {
      const forge = mode.forge;
      const listing = hostRequest(realSocket, req) as Promise<{name?: string}[]>;
      return {replyAfter: listing.then(items => items.map(item => (item.name === forge.name
        ? {...item, pid: forge.pid, created: forge.created} : item)))};
    }
    if (req.op === 'stop_agent_if' && mode.holdStopMs) {
      if (mode.forge) mode.forge.armed = true;
      const late = sleep(mode.holdStopMs).then(() => ({ok: false, reason: 'stale_incarnation'}));
      pending.push(late);
      return {replyAfter: late};
    }
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
  fs.writeFileSync(path.join(bin, 'shell'), SHELL_WRAPPER, {mode: 0o755});
  const realRun = path.join(mesh.home, 'real-run');
  fs.mkdirSync(realRun, {mode: 0o700});
  const realSocket = path.join(realRun, 'session-mesh', 'ptyhost.sock');
  const [command, ...args] = ptyhostArgv();
  host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH: installed.PATH, HOME: mesh.home, XDG_RUNTIME_DIR: realRun, LANG: 'C', SHELL: path.join(bin, 'shell')}});
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

async function codexSession(name: string, layout: Layout = {}): Promise<Session> {
  let cwd = mesh.home;
  if (layout.stubborn || layout.noJobControl || layout.agentLeader) {
    cwd = path.join(mesh.home, name);
    fs.mkdirSync(cwd);
    if (layout.stubborn) fs.writeFileSync(path.join(cwd, '.stubborn'), '');
    if (layout.noJobControl) fs.writeFileSync(path.join(cwd, '.no-job-control'), 'PROMPT_COMMAND="set +m"\n');
    if (layout.agentLeader) fs.writeFileSync(path.join(cwd, '.agent-leader'), '');
  }
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', body: JSON.stringify({cwd,
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

/** The live fake codex processes that hold the rollout of conversation ``sid`` open (Linux: /proc). */
function agentsOf(sid: string): number[] {
  const found: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      if (status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3) === 'Z') continue;
      if (fs.readlinkSync(`/proc/${entry}/fd/3`).includes(sid)) found.push(Number(entry));
    } catch { /* gone meanwhile, or not ours */ }
  }
  return found;
}

/** The most agents seen at once on conversation ``sid`` while ``work`` runs and for ``afterMs`` once it settled. */
async function mostAgents<T>(sid: string, work: Promise<T>, afterMs: number): Promise<{most: number; result: T}> {
  let most = 0, settled = false;
  const sample = () => { most = Math.max(most, agentsOf(sid).length); };
  const watching = (async () => { while (!settled) { sample(); await sleep(50); } })();
  const result = await work.finally(() => { settled = true; });
  await watching;
  for (const end = Date.now() + afterMs; Date.now() < end; await sleep(100)) sample();
  return {most, result};
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

  test('no_shell: the agent is the session\'s program, so the whole session is replaced as before', async () => {
    mode.refuseStop = 'no_shell';
    try {
      const session = await codexSession('w-no-shell');
      const since = ops.length;
      await replacedByNewSession(session, await approved(session, {action: 'restart'}), since);
      const sent = ops.slice(since);
      assert.ok(sent.indexOf('stop_agent_if') >= 0 && sent.indexOf('stop_agent_if') < sent.indexOf('kill_if'),
        'stop_agent_if was asked first and refused');
    } finally { mode.refuseStop = undefined; }
  });

  const linux = process.platform === 'linux' ? false : 'reads /proc';
  const refusals: [string, RegExp][] = [
    ['process_scan_failed', /^ptyhost cannot tell what holds the terminal of session s-process-scan-failed: nothing was stopped\. Quit the agent there, or close the session, then resume the conversation$/],
    ['no_terminal', /^ptyhost cannot tell what holds the terminal of session s-no-terminal: nothing was stopped\. Quit the agent there, or close the session, then resume the conversation$/],
  ];
  for (const [reason, message] of refusals) {
    test(`${reason}: nothing is stopped, so an agent that ignores SIGHUP never runs beside a second one`, {skip: linux}, async () => {
      mode.refuseStop = reason;
      try {
        const name = `s-${reason.replaceAll('_', '-')}`;
        const session = await codexSession(name, {stubborn: true});
        const before = await listed(name);
        const since = ops.length, started = launches().length;
        const {most, result: decided} = await mostAgents(session.sid, approved(session, {action: 'restart'}), 6000);
        assert.equal(decided.state, 'failed', JSON.stringify(decided));
        assert.match(decided.result!.error!, message);
        assert.equal(most, 1, 'one agent on the conversation at any time');
        assert.ok(!ops.slice(since).includes('kill_if') && !ops.slice(since).includes('start_if'), reason);
        assert.equal(launches().length, started, 'nothing started');
        assert.equal((await listed(name))?.created, before?.created, 'the same incarnation');
      } finally { mode.refuseStop = undefined; }
    });
  }

  test('a shell without job control (no_job_control, from the real host): nothing is stopped, one agent only', {skip: linux}, async () => {
    const session = await codexSession('j-no-job-control', {stubborn: true, noJobControl: true});
    const before = await listed('j-no-job-control');
    const since = ops.length, started = launches().length;
    const {most, result: decided} = await mostAgents(session.sid, approved(session, {action: 'restart'}), 8000);
    assert.equal(decided.state, 'failed', JSON.stringify(decided));
    assert.equal(decided.result?.error, 'The shell of session j-no-job-control runs the agent without job control: it '
      + 'cannot be stopped alone, and nothing was stopped. Quit the agent there, or close the session, then resume the '
      + 'conversation');
    assert.equal(most, 1, 'one agent on the conversation at any time');
    assert.ok(!ops.slice(since).includes('kill_if') && !ops.slice(since).includes('start_if'), 'nothing signalled');
    assert.equal(launches().length, started, 'nothing started');
    assert.equal((await listed('j-no-job-control'))?.created, before?.created, 'the same incarnation');
  });

  test('the agent as the session\'s program (no_shell, from the real host): never two agents, the old one is killed', {skip: linux}, async () => {
    const session = await codexSession('l-agent-leader', {stubborn: true, agentLeader: true});
    const [old] = agentsOf(session.sid);
    assert.ok(old, 'the agent runs');
    const since = ops.length;
    const {most} = await mostAgents(session.sid, approved(session, {action: 'restart'}), 2000);
    assert.equal(most, 1, 'one agent on the conversation at any time');
    assert.ok(ops.slice(since).includes('kill_if'), 'the whole session was stopped');
    await waitFor('the stubborn agent killed', 20000, () => !agentsOf(session.sid).includes(old!));
    assert.ok(agentsOf(session.sid).length <= 1, 'still one agent at most');
  });

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

  test('no stop reply in time and the same incarnation listed: the host is reported as not responding', async () => {
    mode.holdStopMs = 17000;
    try {
      const session = await codexSession('h-same');
      const decided = await approved(session, {action: 'restart'});
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.equal(decided.result?.error, 'ptyhost is not responding (systemctl --user start session-mesh-pty)',
        'nothing says the agent was stopped: it was not');
      assert.equal(launches().filter(fields => fields[2] === 'h-same').length, 1, 'nothing started');
    } finally { mode.holdStopMs = undefined; }
  });

  test('no stop reply in time and the session now another shell\'s: the host is reported as not responding', async () => {
    const session = await codexSession('h-other');
    const before = (await hostRequest(path.join(mesh.home, 'real-run', 'session-mesh', 'ptyhost.sock'), {op: 'list'}) as
      {name: string; pid: number; created: number}[]).find(item => item.name === 'h-other')!;
    mode.holdStopMs = 17000;
    mode.forge = {name: 'h-other', pid: before.pid + 100000, created: before.created + 1};
    try {
      const decided = await approved(session, {action: 'restart'});
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.equal(decided.result?.error, 'ptyhost is not responding (systemctl --user start session-mesh-pty)',
        'a session of the same name in another shell is not this one stopped');
    } finally { mode.holdStopMs = undefined; mode.forge = undefined; }
  });
});
