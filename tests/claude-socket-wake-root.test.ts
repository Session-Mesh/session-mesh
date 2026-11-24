// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Two properties of the Claude socket wake that need a real server, a real PTY host and a fake Claude:
// - the repository root: Claude reads `settings.local.json` from the canonical root of the git
//   repository (the main checkout, for a linked worktree), not only from the session's folder, so a
//   `hold`, a `refuse` or a bypass default written there keeps the session off the socket;
// - a restart of the server after a line was written types nothing, writes no second line and still
//   shows the wake as unconfirmed.
// Nothing in this file writes outside its own scratch directories.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {hostArgv, installFakeClaude, MANAGED, NOTICE} from './claude-wake-lib.ts';
import {approveWakeMail} from './codex-queue-wake-lib.ts';
import {REPO, runServer, scratchHome, stopServer} from './mesh-server-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

const hosts: ChildProcess[] = [];
const servers: ChildProcess[] = [];
const scratches: string[] = [];

after(async () => {
  for (const host of hosts) host.kill('SIGKILL');
  for (const server of servers) await stopServer(server);
  for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true});
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Where = Awaited<ReturnType<typeof scratchHome>>;
type Agent = {name: string; dir: string; token: string; created: number};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'init.defaultBranch=main', ...args],
    {cwd, stdio: 'pipe'});

class Session {
  readonly where: Where;
  constructor(where: Where) { this.where = where; }

  get base() { return `http://127.0.0.1:${this.where.port}`; }
  token() { return fs.readFileSync(path.join(this.where.confDir, 'token'), 'utf8').trim(); }
  owner() {
    return {Authorization: `Bearer ${this.token()}`, Origin: this.base, 'Content-Type': 'application/json'};
  }
  headers(agent: Agent) { return {Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'}; }

  async launch(name: string, cwd: string): Promise<Agent> {
    fs.mkdirSync(cwd, {recursive: true});
    for (const stale of ['token', 'argv.json']) fs.rmSync(path.join(cwd, stale), {force: true});
    const response = await fetch(`${this.base}/api/new`, {method: 'POST', headers: this.owner(),
      body: JSON.stringify({preset: 'claude', cwd, name})});
    assert.equal(response.status, 200, await response.clone().text());
    await waitFor(`fake claude ${name}`, 20000, () => fs.existsSync(path.join(cwd, 'token')));
    return {name, dir: cwd, token: fs.readFileSync(path.join(cwd, 'token'), 'utf8').trim(), created: 0};
  }

  async learnCreated(viewer: Agent, other: Agent): Promise<void> {
    const peers = await (await fetch(`${this.base}/api/agent-mail/@self/peers`, {headers: this.headers(viewer)}))
      .json() as {peers: {id: string; created: number}[]};
    other.created = peers.peers.find(item => item.id === other.name)!.created;
  }

  async post(agent: Agent, route: string, body: object): Promise<Response> {
    const response = await fetch(`${this.base}/api/${route}`, {method: 'POST', headers: this.headers(agent), body: JSON.stringify(body)});
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }

  async flagged(agent: Agent): Promise<boolean> {
    const response = await fetch(`${this.base}/api/sessions`, {headers: this.owner()});
    const data = await response.json() as {mesh: {name: string; wake_unconfirmed?: boolean}[]};
    return data.mesh.find(item => item.name === agent.name)?.wake_unconfirmed === true;
  }
}

const read = (agent: Agent, file: string) => {
  const log = path.join(agent.dir, file);
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};
const lines = (agent: Agent) => read(agent, 'socket.log');
const notices = (agent: Agent) => read(agent, 'input.log').filter(line => line.includes(NOTICE)).length;
const hasSocket = (agent: Agent) => (JSON.parse(fs.readFileSync(path.join(agent.dir, 'argv.json'), 'utf8')) as string[])
  .includes('--messaging-socket-path');

async function startWorld(prefix: string, window: string): Promise<Session> {
  const {bin, PATH, MESH_BIN_DIR} = installFakeClaude();
  scratches.push(bin);
  const where = await scratchHome(prefix, {PATH, MESH_BIN_DIR, MESH_CLAUDE_WAKE_CONFIRM_SECONDS: window});
  scratches.push(where.scratch);
  const run = await runServer(where);
  assert.equal(run.result.listened, true, run.result.output);
  servers.push(run.child);
  const hostSocket = path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock');
  hosts.push(spawn(hostArgv()[0], hostArgv().slice(1), {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: where.home, XDG_RUNTIME_DIR: path.join(where.home, 'run'), LANG: 'C'}}));
  await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));
  return new Session(where);
}

const options = {skip: MANAGED.length > 0 && `managed Claude settings at ${MANAGED[0]}`};

describe('the repository root decides, as Claude reads it', options, () => {
  let world: Session;
  let main = '';
  let linked = '';
  let count = 0;
  const restrict = (settings: object) => {
    fs.mkdirSync(path.join(main, '.claude'), {recursive: true});
    fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), JSON.stringify(settings));
  };
  const socketFor = async (cwd: string) => hasSocket(await world.launch(`agent${count++}`, cwd));

  test('setup: a repository with a sub-folder and a linked worktree', async () => {
    world = await startWorld('skr-root-', '2');
    main = path.join(world.where.home, 'main');
    linked = path.join(world.where.home, 'linked');
    fs.mkdirSync(path.join(main, 'sub', 'deeper'), {recursive: true});
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'first');
    git(main, 'worktree', 'add', '-q', linked, '-b', 'linked');
    fs.mkdirSync(path.join(linked, 'sub'));
  });

  test('control: with no restriction anywhere every folder of the repository gets a socket', async () => {
    for (const cwd of [main, path.join(main, 'sub'), path.join(main, 'sub', 'deeper'), linked, path.join(linked, 'sub')]) {
      assert.equal(await socketFor(cwd), true, cwd);
    }
  });

  for (const [label, settings] of [
    ['hold', {crossSessionInbound: 'hold'}],
    ['refuse', {crossSessionInbound: 'refuse'}],
    ['a bypass default', {permissions: {defaultMode: 'bypassPermissions'}}],
  ] as const) {
    test(`${label} in the root's settings.local.json keeps every folder of the repository off the socket`, async () => {
      restrict(settings);
      for (const cwd of [path.join(main, 'sub'), path.join(main, 'sub', 'deeper'), linked, path.join(linked, 'sub')]) {
        assert.equal(await socketFor(cwd), false, `${cwd} must not get a socket`);
      }
    });
  }
});

describe('a restart of the server after a line was written', options, () => {
  test('types nothing, writes no second line and keeps the wake unconfirmed', async () => {
    const world = await startWorld('skr-restart-', '3');
    const sender = await world.launch('sender', path.join(world.where.home, 'sender'));
    const target = await world.launch('target', path.join(world.where.home, 'target'));
    assert.equal(hasSocket(target), true);
    await world.learnCreated(sender, target);
    await world.post(target, 'event', {type: 'done'});
    const sent = await world.post(sender, 'agent-mail/@self/send',
      {target: target.name, target_created: target.created, kind: 'message', text: 'first'});
    await approveWakeMail(world.base, world.token(), sent);
    await waitFor('the line', 10000, () => lines(target).length === 1);

    // Restart 1: the server dies while the line waits for its confirmation.
    const before = servers.pop()!;
    await stopServer(before);
    const second = await runServer(world.where);
    assert.equal(second.result.listened, true, second.result.output);
    servers.push(second.child);
    await waitFor('the wake judged unconfirmed', 20000, () => world.flagged(target));
    assert.equal(lines(target).length, 1, 'no second line after the restart');
    assert.equal(notices(target), 0, 'nothing typed');

    // Restart 2: after the judgement, the state is still there and still nothing is typed.
    await stopServer(servers.pop()!);
    const third = await runServer(world.where);
    assert.equal(third.result.listened, true, third.result.output);
    servers.push(third.child);
    await waitFor('the unconfirmed state kept', 10000, () => world.flagged(target));
    await pause(4500);
    assert.equal(lines(target).length, 1);
    assert.equal(notices(target), 0);
  });
});
