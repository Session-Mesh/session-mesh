// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A Claude session that Mesh launched is woken on its messaging socket, not by typing:
// - a real server and a real PTY host (the native host named by MESH_PTYHOST_CMD);
// - a fake Claude (a script named `claude`, running Node) that answers --version and listens on the
//   --messaging-socket-path it was given, logging every line it receives;
// - delivery: one fixed line, nothing typed;
// - confirmation: the agent's look at its inbox (the route of the mail.inbox tool) ends the wake;
// - unconfirmed: without that look, after the confirmation window (shortened to 2 s by
//   MESH_CLAUDE_WAKE_CONFIRM_SECONDS), the owner sees the wake as unconfirmed and NOTHING is typed:
//   a typed Enter could answer a dialog Claude opened to hold the line;
// - a session without a socket (a user's `refuse`) keeps the typed notice from the start.
// Nothing in this file writes outside its own scratch directories.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {hostArgv, installFakeClaude, fakeAgentShell, MANAGED, NOTICE} from './claude-wake-lib.ts';
import {approveWakeMail} from './codex-queue-wake-lib.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

const hosts: ChildProcess[] = [];
const scratches: string[] = [];
let mesh: Mesh | undefined;

after(async () => {
  for (const host of hosts) host.kill('SIGKILL');
  await mesh?.stop();
  for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true});
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('server: a Claude with a messaging socket', {skip: MANAGED.length > 0 && `managed Claude settings at ${MANAGED[0]}`}, () => {
  type Agent = {name: string; dir: string; token: string; created: number};
  const agents: Record<string, Agent> = {};
  let socketPath = '';

  const ownerHeaders = () => ({Authorization: `Bearer ${mesh!.token()}`, Origin: mesh!.base, 'Content-Type': 'application/json'});
  const agentHeaders = (agent: Agent) => ({Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'});
  const read = (agent: Agent, file: string) => {
    const log = path.join(agent.dir, file);
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  };
  const lines = (agent: Agent) => read(agent, 'socket.log');
  const notices = (agent: Agent) => read(agent, 'input.log').filter(line => line.includes(NOTICE)).length;

  async function launch(name: string): Promise<Agent> {
    const dir = path.join(mesh!.home, name);
    fs.mkdirSync(dir);
    const response = await fetch(`${mesh!.base}/api/new`, {method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({preset: 'claude', cwd: dir, name})});
    assert.equal(response.status, 200, await response.clone().text());
    await waitFor(`fake claude ${name}`, 20000, () => fs.existsSync(path.join(dir, 'token')));
    const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    return {name, dir, token, created: 0};
  }

  // The peers a session lists are the others: that is where one learns another's incarnation.
  async function learnCreated(viewer: Agent, other: Agent): Promise<void> {
    const peers = await (await fetch(`${mesh!.base}/api/agent-mail/@self/peers`, {headers: agentHeaders(viewer)}))
      .json() as {peers: {id: string; created: number; agent: string}[]};
    const found = peers.peers.find(item => item.id === other.name);
    assert.equal(found?.agent, 'claude');
    other.created = found!.created;
  }

  const launched = (agent: Agent) => JSON.parse(fs.readFileSync(path.join(agent.dir, 'argv.json'), 'utf8')) as string[];

  // The hook names its agent (`detail.source`): the server ignores an event that does not speak for the
  // session's own agent (`foreign_source`), so a bare event would never open the typed-notice gate.
  async function event(agent: Agent, type: string): Promise<void> {
    const response = await fetch(`${mesh!.base}/api/event`, {method: 'POST', headers: agentHeaders(agent),
      body: JSON.stringify({type, detail: {source: 'claude'}})});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(((await response.json()) as {applied: boolean}).applied, true, 'the server applied the event');
  }

  async function deposit(from: Agent, to: Agent, text: string): Promise<Response> {
    const response = await fetch(`${mesh!.base}/api/agent-mail/@self/send`, {method: 'POST', headers: agentHeaders(from),
      body: JSON.stringify({target: to.name, target_created: to.created, kind: 'message', text})});
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }

  async function sendApproved(from: Agent, to: Agent, text: string): Promise<void> {
    await approveWakeMail(mesh!.base, mesh!.token(), await deposit(from, to, text));
  }

  async function lookAtInbox(agent: Agent): Promise<number> {
    const response = await fetch(`${mesh!.base}/api/agent-mail/@self/inbox`, {headers: agentHeaders(agent)});
    assert.equal(response.status, 200);
    return ((await response.json()) as {messages: unknown[]}).messages.length;
  }

  test('setup: a real server, a real PTY host, a Claude that listens', async () => {
    const {bin, PATH, MESH_BIN_DIR} = installFakeClaude();
    scratches.push(bin);
    mesh = await startMesh('skw-', {PATH, MESH_BIN_DIR, MESH_CLAUDE_WAKE_CONFIRM_SECONDS: '2'});
    const hostSocket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
    hosts.push(spawn(hostArgv()[0], hostArgv().slice(1), {cwd: REPO, stdio: 'ignore',
      env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: fakeAgentShell(bin)}}));
    await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));

    agents.sender = await launch('sender');
    agents.target = await launch('target');
    const words = launched(agents.target);
    assert.equal(words.filter(word => word === '--messaging-socket-path').length, 1);
    assert.equal(words.join(' ').includes('crossSessionInbound'), false, 'the mesh never writes that setting');
    socketPath = words[words.indexOf('--messaging-socket-path') + 1];
    await waitFor('the fake Claude listening', 10000, () => fs.existsSync(socketPath));
    assert.equal(fs.statSync(socketPath).isSocket(), true);
    await learnCreated(agents.sender, agents.target);
  });

  test('delivery: no wake before approval, then one fixed line on the socket and nothing typed', async () => {
    const {sender, target} = agents;
    await event(target, 'done');
    const sent = await deposit(sender, target, 'SECRET first message');
    await pause(1500);
    assert.equal(lines(target).length, 0, 'no socket line without approval');
    assert.equal(notices(target), 0, 'no typed notice without approval');
    await approveWakeMail(mesh!.base, mesh!.token(), sent);
    await waitFor('the line on the socket', 10000, () => lines(target).length === 1);
    const line = JSON.parse(lines(target)[0]) as {type: string; message: {role: string; content: string}};
    assert.equal(line.type, 'user');
    assert.equal(line.message.content, 'Mesh: 1 new message(s) in your inbox; the user approved reading mail. '
      + 'Please check mail.inbox and read authorized entries without asking again.');
    assert.doesNotMatch(lines(target)[0], /SECRET/);
    await pause(700);
    assert.equal(notices(target), 0, 'nothing is typed in the terminal');
  });

  test('confirmation: the look at the inbox ends the wake, no typed notice follows', async () => {
    const {target} = agents;
    assert.equal(await lookAtInbox(target), 1);
    await pause(3500);                       // well past the 2 s window and several dispatch rounds
    assert.equal(notices(target), 0);
    assert.equal(lines(target).length, 1, 'one line per batch');
  });

  const flagged = async (agent: Agent) => {
    const response = await fetch(`${mesh!.base}/api/sessions`, {headers: ownerHeaders()});
    const data = await response.json() as {mesh: {name: string; wake_unconfirmed?: boolean}[]};
    return data.mesh.find(item => item.name === agent.name)?.wake_unconfirmed === true;
  };

  test('a line nobody follows becomes unconfirmed and visible; nothing is ever typed; no second line', async () => {
    const {sender, target} = agents;
    await sendApproved(sender, target, 'second message');
    await waitFor('the second line', 10000, () => lines(target).length === 2);
    assert.equal(await flagged(target), false, 'not flagged while the line may still be followed');
    await waitFor('the unconfirmed state in the page listing', 15000, () => flagged(target));
    await pause(4500);                       // two more windows and many dispatch rounds
    assert.equal(notices(target), 0, 'no keystroke after a line: it could answer Claude\'s dialog');
    assert.equal(lines(target).length, 2, 'no third line');
    assert.equal(await flagged(target), true, 'it stays visible until the inbox is read');
    assert.equal(await lookAtInbox(target), 2, 'both messages are still there: nothing was acknowledged');
    assert.equal(await flagged(target), false, 'the look clears it');
    assert.equal(notices(target), 0);
  });

  test('a session whose user refuses cross-session messages keeps the typed notice from the start', async () => {
    const settings = path.join(mesh!.home, '.claude');
    fs.mkdirSync(settings, {recursive: true});
    fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({crossSessionInbound: 'refuse'}));
    const strict = await launch('strict');
    await learnCreated(agents.sender, strict);
    fs.rmSync(path.join(settings, 'settings.json'));
    assert.equal(launched(strict).includes('--messaging-socket-path'), false);
    await event(strict, 'done');
    await sendApproved(agents.sender, strict, 'for the strict one');
    await waitFor('the typed notice', 15000, () => notices(strict) === 1);
    assert.equal(lines(strict).length, 0);
  });

  test('no file is left in the repository', () => {
    assert.equal(fs.existsSync(path.join(REPO, 'token')), false);
  });
});
