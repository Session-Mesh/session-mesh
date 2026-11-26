// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A Claude restarted in its own terminal gets a working wake socket (server.py _start_in_place,
// claudewake.clear_socket). The socket path follows from the session's nonce, which a restart in the same terminal
// keeps: the stopped Claude's socket file is still there when the next one starts, whether it ended on SIGHUP or was
// killed. A real server, a real native PTY host (SIGKILL 0.5 s after SIGHUP here), and a fake Claude (Node run under
// the name claude) that names its conversation as Claude does, listens on --messaging-socket-path, logs whether it
// could, and never removes its socket file. What else lies at that path (a regular file, a directory, a symbolic link
// to a live socket) stays, and so does a stale socket in a wake directory others can read: only a socket of this user
// in the private directory is removed. (A socket of another user cannot be made without privileges: not tested.)
// Nothing in this file writes outside its own scratch directories.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {after, before, describe, test} from 'node:test';
import {hostArgv, MANAGED, fakeAgentShell} from './claude-wake-lib.ts';
import {approveMail} from './helpers/agent-mail-mesh.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

// `--version` answers; otherwise: the conversation id in ~/.claude/sessions/<pid>.json (a resume keeps it), a
// transcript line, the socket (`bound <pid>` or `bind-failed <code>` in ./events.log), the token in ./token. A file
// ./stubborn makes it ignore SIGHUP. It ends on SIGHUP or SIGKILL without closing the socket: its file stays.
const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const FAKE = [
  "const fs = require('node:fs'), net = require('node:net'), path = require('node:path');",
  "const readline = require('node:readline'), crypto = require('node:crypto');",
  'const args = process.argv.slice(2);',
  "if (args[0] === '--version') { process.stdout.write('2.1.325 (Claude Code)\\n'); process.exit(0); }",
  "const resumed = args.indexOf('--resume'), sid = resumed >= 0 ? args[resumed + 1] : crypto.randomUUID();",
  "const claude = path.join(process.env.HOME, '.claude');",
  "fs.mkdirSync(path.join(claude, 'sessions'), {recursive: true}); fs.mkdirSync(path.join(claude, 'projects', 'p'), {recursive: true});",
  "fs.appendFileSync(path.join(claude, 'projects', 'p', sid + '.jsonl'), JSON.stringify({type: 'user', sessionId: sid}) + '\\n');",
  "fs.writeFileSync(path.join(claude, 'sessions', process.pid + '.json'), JSON.stringify({sessionId: sid, status: 'idle'}));",
  "if (fs.existsSync('./stubborn')) process.on('SIGHUP', () => {});",
  "const log = line => fs.appendFileSync('./events.log', line + '\\n');",
  "fs.writeFileSync('./launch.json', JSON.stringify(args));",
  "const at = args.indexOf('--messaging-socket-path');",
  'if (at >= 0) {',
  "  const server = net.createServer(c => readline.createInterface({input: c}).on('line', l => fs.appendFileSync('./socket.log', l + '\\n')));",
  "  server.on('error', error => log('bind-failed ' + error.code));",
  "  server.listen(args[at + 1], () => log('bound ' + process.pid + ' ' + args[at + 1]));",
  "} else log('no-socket ' + process.pid);",
  "fs.writeFileSync('./token.tmp', process.env.MESH_SESSION_TOKEN ?? ''); fs.renameSync('./token.tmp', './token');",
  'setInterval(() => {}, 1 << 30);',
  '',
].join('\n');

type Agent = {name: string; dir: string; token: string};

let mesh: Mesh | undefined;
let host: ChildProcess | undefined;
let bin = '', cookie = '';

const events = (agent: Agent) => {
  const file = path.join(agent.dir, 'events.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};
const owner = () => ({Cookie: cookie, Origin: mesh!.base, 'Content-Type': 'application/json'});
const as = (agent: Agent) => ({Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'});

before(async () => {
  if (MANAGED.length > 0) return;
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'crw-bin-'));
  fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), FAKE);
  fs.writeFileSync(path.join(bin, 'claude'),
    `#!/bin/bash\nexec -a claude '${process.execPath}' '${path.join(bin, 'fake-claude.js')}' "$@"\n`, {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('crw-', {PATH, MESH_BIN_DIR: bin, MESH_CLAUDE_WAKE_CONFIRM_SECONDS: '2', MESH_MESH_PLATFORM_CMD: PLATFORM});
  const hostSocket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
  host = spawn(hostArgv()[0]!, hostArgv().slice(1), {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, SHELL: fakeAgentShell(bin), XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C',
      MESH_PTYHOST_AGENT_STOP_GRACE: '0.5'}});
  await waitFor('ptyhost answering', 10000, () => request(hostSocket, {op: 'list'}).then(() => true, () => false));
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
});

after(async () => {
  // a fake that ignores SIGHUP would outlive its terminal
  if (bin) spawnSync('pkill', ['-KILL', '-f', path.join(bin, 'fake-claude.js')]);
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (bin) fs.rmSync(bin, {recursive: true, force: true});
});

async function launch(name: string, stubborn = false): Promise<Agent> {
  const dir = path.join(mesh!.home, name);
  fs.mkdirSync(dir);
  if (stubborn) fs.writeFileSync(path.join(dir, 'stubborn'), '');
  const response = await fetch(`${mesh!.base}/api/new`, {method: 'POST', body: JSON.stringify({preset: 'claude', cwd: dir, name}),
    headers: {Authorization: `Bearer ${mesh!.token()}`, Origin: mesh!.base, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, await response.clone().text());
  await waitFor(`the socket of ${name}`, 20000, () => events({name, dir, token: ''}).some(line => line.startsWith('bound ')));
  return {name, dir, token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()};
}

async function sessionId(agent: Agent): Promise<string> {
  let sid = '';
  await waitFor(`the conversation of ${agent.name}`, 10000, async () => {
    const data = await (await fetch(`${mesh!.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh!.token()}`}}))
      .json() as {mesh: {id: string; agent?: {session_id?: string} | null}[]};
    sid = data.mesh.find(item => item.id === agent.name)?.agent?.session_id ?? '';
    return sid !== '';
  });
  return sid;
}

async function restarted(agent: Agent, body: Record<string, unknown> = {action: 'restart'}): Promise<{state: string; result: {id?: string; error?: string} | null}> {
  const made = await fetch(`${mesh!.base}/api/session-actions/@self/request`, {method: 'POST', headers: as(agent),
    body: JSON.stringify(body)});
  assert.equal(made.status, 202, await made.clone().text());
  const {request: item} = await made.json() as {request: {id: string}};
  const claimed = await fetch(`${mesh!.base}/api/session-actions/${item.id}/claim`, {method: 'POST', headers: owner(),
    body: JSON.stringify({tab_nonce: 'd'.repeat(32)})});
  const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
  const decided = await fetch(`${mesh!.base}/api/session-actions/${item.id}/decision`, {method: 'POST', headers: owner(),
    body: JSON.stringify({approve: true, claim_nonce: claimNonce})});
  return (await decided.json() as {request: {state: string; result: {id?: string; error?: string} | null}}).request;
}

/** Restart ``agent`` in its terminal once ``plant(socket path)`` put something at its socket path: what
 * ``survives(socket path)`` checks is still there afterwards (the server removes only a stale socket of this user in
 * its private directory). */
async function restartKeeps(agent: Agent, plant: (socket: string) => void, survives: (socket: string) => void): Promise<void> {
  const socket = events(agent)[0]!.split(' ')[2]!;
  plant(socket);
  const decided = await restarted(agent);
  assert.equal(decided.state, 'completed', JSON.stringify(decided));
  await waitFor(`the second Claude of ${agent.name}`, 20000, () => events(agent).length >= 2);
  survives(socket);
}

/** Restart ``agent`` in its terminal: the next Claude must listen on the same path as the stopped one. */
async function restartBinds(agent: Agent): Promise<void> {
  const sid = await sessionId(agent);
  const [first] = events(agent);
  const socket = first!.split(' ')[2]!;
  const decided = await restarted(agent);
  assert.equal(decided.state, 'completed', JSON.stringify(decided));
  assert.equal(decided.result?.id, agent.name, 'restarted in the same session');
  await waitFor(`the second Claude of ${agent.name}`, 20000, () => events(agent).length >= 2);
  const second = events(agent)[1]!;
  assert.match(second, /^bound \d+ /, `the restarted Claude listens on its socket: ${second}`);
  assert.equal(second.split(' ')[2], socket, 'at the same path: the nonce is kept');
  assert.equal(fs.readFileSync(path.join(agent.dir, 'token'), 'utf8').trim(), agent.token, 'the same shell');
  assert.equal(await sessionId(agent), sid, 'the same conversation');
}

describe('a Claude restarted in its terminal listens on its wake socket again',
  {skip: MANAGED.length > 0 && `managed Claude settings at ${MANAGED[0]}`}, () => {
    let sender: Agent;
    let target: Agent;

    test('one that ended on SIGHUP: its socket file stayed, the next one listens there', async () => {
      sender = await launch('w-sender');
      target = await launch('w-hup');
      await restartBinds(target);
    });

    test('approved settings resume Claude with the requested options in the same terminal',
      {skip: !fs.existsSync(PLATFORM) && !process.env.MESH_REQUIRE_MESH_PLATFORM}, async () => {
        const agent = await launch('w-settings');
        const sid = await sessionId(agent);
        const decided = await restarted(agent, {action: 'settings', model: 'sonnet', effort: 'medium'});
        assert.equal(decided.state, 'completed', JSON.stringify(decided));
        assert.equal(decided.result?.id, agent.name);
        await waitFor('Claude relaunched with its settings', 20000, () => events(agent).length === 2);
        const args = JSON.parse(fs.readFileSync(path.join(agent.dir, 'launch.json'), 'utf8')) as string[];
        assert.equal(args[args.indexOf('--resume') + 1], sid);
        assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
        assert.equal(args[args.indexOf('--effort') + 1], 'medium');
        assert.equal(fs.readFileSync(path.join(agent.dir, 'token'), 'utf8').trim(), agent.token);
        const {control} = await (await fetch(`${mesh!.base}/api/session-actions/@self/request?view=control`,
          {headers: as(agent)})).json() as {control: Record<string, unknown>};
        assert.deepEqual([control.launch_model, control.launch_effort], ['sonnet', 'medium']);
        assert.deepEqual([control.observed_model, control.observed_effort], [null, null]);
      });

    test('the wake line reaches the restarted Claude on its socket', async () => {
      const peers = await (await fetch(`${mesh!.base}/api/agent-mail/@self/peers`, {headers: as(sender)}))
        .json() as {peers: {id: string; created: number}[]};
      const created = peers.peers.find(item => item.id === target.name)!.created;
      const done = await fetch(`${mesh!.base}/api/event`, {method: 'POST', headers: as(target),
        body: JSON.stringify({type: 'done', detail: {source: 'claude'}})});
      assert.equal(done.status, 200, await done.clone().text());
      const sent = await fetch(`${mesh!.base}/api/agent-mail/@self/send`, {method: 'POST', headers: as(sender),
        body: JSON.stringify({target: target.name, target_created: created, kind: 'message', text: 'after the restart'})});
      assert.equal(sent.status, 200, await sent.clone().text());
      await approveMail(mesh!.base, cookie, sent);
      const lines = () => {
        const file = path.join(target.dir, 'socket.log');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      };
      await waitFor('the line on the restarted Claude\'s socket', 15000, () => lines().length === 1);
      assert.match(lines()[0]!, /Mesh: 1 new message\(s\) in your inbox/);
    });

    test('one that ignored SIGHUP and was killed: the next one listens there too', async () => {
      await restartBinds(await launch('w-kill', true));
    });
  });

describe('a restart in place removes nothing but a stale socket at the wake path',
  {skip: MANAGED.length > 0 && `managed Claude settings at ${MANAGED[0]}`}, () => {
    test('a regular file at that path stays', async () => {
      await restartKeeps(await launch('k-file'), socket => {
        fs.rmSync(socket);
        fs.writeFileSync(socket, 'not a socket');
      }, socket => assert.equal(fs.readFileSync(socket, 'utf8'), 'not a socket'));
    });

    test('a directory at that path stays, with what it holds', async () => {
      await restartKeeps(await launch('k-dir'), socket => {
        fs.rmSync(socket);
        fs.mkdirSync(socket);
        fs.writeFileSync(path.join(socket, 'kept'), 'kept');
      }, socket => assert.equal(fs.readFileSync(path.join(socket, 'kept'), 'utf8'), 'kept'));
    });

    test('a symbolic link to a live socket stays, and so does that socket', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'crw-live-'));
      const live = path.join(elsewhere, 'live.sock');
      const server = net.createServer(connection => connection.end('alive\n'));
      await new Promise<void>(resolve => server.listen(live, resolve));
      try {
        await restartKeeps(await launch('k-link'), socket => {
          fs.rmSync(socket);
          fs.symlinkSync(live, socket);
        }, socket => {
          assert.equal(fs.readlinkSync(socket), live, 'the link stays');
          assert.ok(fs.lstatSync(live).isSocket(), 'its target stays');
        });
        const answer = await new Promise<string>((resolve, reject) => {
          const connection = net.connect(live, () => connection.once('data', data => resolve(String(data))));
          connection.on('error', reject);
        });
        assert.equal(answer, 'alive\n', 'the linked socket still answers');
      } finally {
        server.close();
        fs.rmSync(elsewhere, {recursive: true, force: true});
      }
    });

    test('in a wake directory others can read (0755), even the stale socket stays', async () => {
      const agent = await launch('k-shared-dir');
      let before = 0;
      const directory = path.dirname(events(agent)[0]!.split(' ')[2]!);
      try {
        await restartKeeps(agent, socket => {
          before = fs.lstatSync(socket).ino;
          fs.chmodSync(directory, 0o755);
        }, socket => assert.equal(fs.lstatSync(socket).ino, before, 'the same socket file'));
      } finally { fs.chmodSync(directory, 0o700); }
    });
  });
