// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A lost or damaged `wake-lines.json` is never read as "no line was written". After a line was written and
// the server restarted with that file lost, corrupt or holding one invalid entry, and with the session's
// socket gone, the wake stays unconfirmed: nothing is typed (a typed Enter could answer the dialog that
// holds the line) and no second line is written. A real server, a real PTY host and a fake Claude.
// Nothing in this file writes outside its own scratch directories.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {hostArgv, installFakeClaude, fakeAgentShell, MANAGED, NOTICE} from './claude-wake-lib.ts';
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

type Agent = {name: string; dir: string; token: string; created: number};

const read = (agent: Agent, file: string) => {
  const log = path.join(agent.dir, file);
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
};
const lines = (agent: Agent) => read(agent, 'socket.log');
const notices = (agent: Agent) => read(agent, 'input.log').filter(line => line.includes(NOTICE)).length;
const socketOf = (agent: Agent) => {
  const words = JSON.parse(fs.readFileSync(path.join(agent.dir, 'argv.json'), 'utf8')) as string[];
  return words[words.indexOf('--messaging-socket-path') + 1];
};

/** What happens to the remembered lines, and to the socket, while the server is down. */
const damages: [string, (state: string) => void, boolean][] = [
  ['the file is lost', state => fs.rmSync(state), true],
  ['the file is corrupt', state => fs.writeFileSync(state, '{not json'), true],
  ['one entry is invalid beside the valid one', state => {
    const data = JSON.parse(fs.readFileSync(state, 'utf8')) as {lines: object[]};
    data.lines.push({name: 'x', created: 2, id: 'y', at: 1, state: ['bad']});
    fs.writeFileSync(state, JSON.stringify(data));
  }, true],
  ['the file is intact', () => {}, true],
  ['the file is lost and the socket is still there', state => fs.rmSync(state), false],
];

describe('a lost or damaged state of the wake lines', {skip: MANAGED.length > 0 && `managed Claude settings at ${MANAGED[0]}`}, () => {
  for (const [label, damage, socketGone] of damages) {
    test(`${label}${socketGone ? ' and the socket gone' : ''}: nothing typed, no second line, still unconfirmed`, async () => {
      const {bin, PATH, MESH_BIN_DIR} = installFakeClaude();
      scratches.push(bin);
      const where = await scratchHome('skw-state-', {PATH, MESH_BIN_DIR, MESH_CLAUDE_WAKE_CONFIRM_SECONDS: '2'});
      scratches.push(where.scratch);
      const base = `http://127.0.0.1:${where.port}`;
      const token = () => fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
      const owner = () => ({Authorization: `Bearer ${token()}`,
        Origin: base, 'Content-Type': 'application/json'});
      const session = (agent: Agent) => ({Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'});
      let run = await runServer(where);
      assert.equal(run.result.listened, true, run.result.output);
      servers.push(run.child);
      const hostSocket = path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock');
      hosts.push(spawn(hostArgv()[0], hostArgv().slice(1), {cwd: REPO, stdio: 'ignore',
        env: {PATH, HOME: where.home, XDG_RUNTIME_DIR: path.join(where.home, 'run'), LANG: 'C', SHELL: fakeAgentShell(bin)}}));
      await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));

      const launch = async (name: string): Promise<Agent> => {
        const dir = path.join(where.home, name);
        fs.mkdirSync(dir);
        const response = await fetch(`${base}/api/new`, {method: 'POST', headers: owner(),
          body: JSON.stringify({preset: 'claude', cwd: dir, name})});
        assert.equal(response.status, 200, await response.clone().text());
        await waitFor(`fake claude ${name}`, 20000, () => fs.existsSync(path.join(dir, 'token')));
        return {name, dir, token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(), created: 0};
      };
      const post = async (agent: Agent, route: string, body: object) => {
        const response = await fetch(`${base}/api/${route}`, {method: 'POST', headers: session(agent), body: JSON.stringify(body)});
        assert.equal(response.status, 200, await response.clone().text());
        return response;
      };
      const flagged = async (agent: Agent) => {
        const data = await (await fetch(`${base}/api/sessions`, {headers: owner()})).json() as
          {mesh: {name: string; wake_unconfirmed?: boolean}[]};
        return data.mesh.find(item => item.name === agent.name)?.wake_unconfirmed === true;
      };

      const sender = await launch('sender');
      const target = await launch('target');
      const peers = await (await fetch(`${base}/api/agent-mail/@self/peers`, {headers: session(sender)})).json() as
        {peers: {id: string; created: number}[]};
      target.created = peers.peers.find(item => item.id === target.name)!.created;
      await post(target, 'event', {type: 'done'});
      const sent = await post(sender, 'agent-mail/@self/send',
        {target: target.name, target_created: target.created, kind: 'message', text: 'first'});
      await approveWakeMail(base, token(), sent);
      await waitFor('the line', 10000, () => lines(target).length === 1);

      await stopServer(servers.pop()!);
      const directory = path.dirname(socketOf(target));
      damage(path.join(directory, 'wake-lines.json'));
      if (socketGone) fs.rmSync(socketOf(target), {force: true});
      run = await runServer(where);
      assert.equal(run.result.listened, true, run.result.output);
      servers.push(run.child);

      await waitFor('the wake judged unconfirmed', 20000, () => flagged(target));
      await new Promise(resolve => setTimeout(resolve, 3000));
      assert.equal(lines(target).length, 1, 'no second line');
      assert.equal(notices(target), 0, 'nothing typed');
    });
  }
});
