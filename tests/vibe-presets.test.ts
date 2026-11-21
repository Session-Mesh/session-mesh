// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Mistral Vibe in the mesh without a model: a fake `vibe` on PATH records its argv, its environment and what is typed
// into it, and the hooks Mesh hands to Vibe (run the way Vibe runs them: the command of each hook, the payload on its
// standard input) report to a real server and PTY host.
// Covered: launch from "+ New" with the board server in VIBE_MCP_SERVERS and the hooks directory in --add-dir (the
// session token only in the environment, a stricter user choice kept), the state and conversation the hooks report,
// the wake notice typed only while idle, and the restore of the conversation after a PTY host restart.
// MESH_VIBE_FAKE_TUI=1 makes the fake `vibe` exec a fake `vibe-rs`, as the real launcher does: the process is then
// named vibe-rs, which both PTY hosts must recognise as the agent vibe (run with MESH_PTYHOST_CMD for the native one).
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import {fakeAgentShell} from './helpers/fake-agent.ts';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, removeScratch, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';

const CONVERSATION = 'e98ebb44-7316-c2a7-62cf-582ea59f42f6';
const MARKER = 'VIBE-TEST-CREDENTIAL';
const THROUGH_TUI = process.env.MESH_VIBE_FAKE_TUI === '1';
let mesh: Mesh;
let fakes: string;
let userHome: string;
let host: ChildProcess | undefined;
let pathEnv: string;
const log = (file: string) => path.join(fakes, file);
const lines = (file: string): string[] =>
  fs.existsSync(log(file)) ? fs.readFileSync(log(file), 'utf8').split('\n').filter(Boolean) : [];


function startHost(): ChildProcess {
  const argv = nativePtyhost();
  return spawn(argv[0], argv.slice(1), {
    cwd: REPO, stdio: 'ignore',
    env: {PATH: pathEnv, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: path.join(fakes, 'plain-bash')}});
}

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const recorder = (dir: string) => `
printf 'argv:%s\\n' "$*" >> '${log('argv.log')}'
printf '%s\\n' "$VIBE_MCP_SERVERS" >> '${log('mcp.log')}'
printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('session.log')}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('input.log')}'; done
`;

before(async () => {
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-vibe-'));
  fakeAgentShell(fakes);
  const bin = path.join(fakes, 'bin');
  const meshBin = path.join(fakes, 'meshbin');
  userHome = path.join(fakes, 'vibe-home');
  fs.mkdirSync(bin);
  fs.mkdirSync(meshBin);
  fs.mkdirSync(userHome);
  // The board bridge only has to exist and be executable: this test never talks MCP.
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.symlinkSync(path.join(REPO, 'bin', 'mesh-event'), path.join(meshBin, 'mesh-event'));
  // A stricter choice of the user on the board: the injected entry replaces theirs by name and must repeat it.
  fs.writeFileSync(path.join(userHome, 'config.toml'),
    '[[mcp_servers]]\nname = "mesh-board"\ntransport = "stdio"\ncommand = "/bin/false"\ndisabled_tools = ["agent_message_send"]\n');
  if (THROUGH_TUI) {
    fs.writeFileSync(path.join(bin, 'vibe'), `#!/bin/sh\nexec '${path.join(bin, 'vibe-rs')}' "$@"\n`, {mode: 0o755});
    fs.writeFileSync(path.join(bin, 'vibe-rs'), `#!/bin/sh${recorder(bin)}`, {mode: 0o755});
  } else {
    fs.writeFileSync(path.join(bin, 'vibe'), `#!/bin/sh${recorder(bin)}`, {mode: 0o755});
  }
  pathEnv = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('vibe-presets-', {PATH: pathEnv, MESH_BIN_DIR: meshBin, VIBE_HOME: userHome,
    MISTRAL_API_KEY: MARKER});
  host = startHost();
  await until('the PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (fakes) removeScratch(fakes);
});

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
const post = (route: string, body: unknown) =>
  fetch(`${mesh.base}${route}`, {method: 'POST', headers: headers(), body: JSON.stringify(body)});

type Listed = {mesh: {id: string; known_agent: string | null; agent: {type: string; status?: string; session_id?: string} | null}[]};
async function listing(): Promise<Listed> {
  return await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as Listed;
}
const agentOf = async (name: string) => (await listing()).mesh.find(item => item.id === name)?.agent;

async function launch(name: string): Promise<void> {
  const before = lines('session.log').length;
  const response = await post('/api/new', {preset: 'vibe', cwd: mesh.home, name});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake vibe of ${name}`, () => lines('session.log').length > before);
}

/** The directory a launch passed with --add-dir: private to that launch, mesh-vibe-hooks/vibe-<nonce>. */
const hooksDirOf = (index: number) => {
  const found = /^argv:--add-dir (\S+)/.exec(lines('argv.log')[index] ?? '');
  assert.ok(found, `no --add-dir in launch ${index}`);
  return found[1];
};
const isHooksDir = (directory: string) => new RegExp(`^${mesh.confDir}/mesh-vibe-hooks/vibe-[0-9a-f]{24}$`).test(directory);
const hooksFile = (index: number) => fs.readFileSync(path.join(hooksDirOf(index), '.vibe', 'hooks.toml'), 'utf8');

/** One hook run the way Vibe runs it: the hook's command through a shell, the payload on standard input. */
async function runHook(session: string, name: string, type: string, payload: object): Promise<void> {
  const index = lines('session.log').lastIndexOf(session);
  assert.ok(index >= 0, `no launch recorded for ${session}`);
  const found = new RegExp(`name = "session-mesh-${name}"\\ntype = "${type}"\\ncommand = (".*")`).exec(hooksFile(index));
  assert.ok(found, `no ${type} hook named ${name}`);
  const child = spawn('sh', ['-c', JSON.parse(found[1]) as string], {stdio: ['pipe', 'ignore', 'ignore'], env: {
    PATH: process.env.PATH, HOME: mesh.home, MESH_PORT: String(mesh.port), MESH_SESSION_TOKEN: lines('token.log')[index]}});
  const exit = new Promise<number | null>(resolve => child.on('close', resolve));
  child.stdin.end(JSON.stringify({session_id: CONVERSATION, transcript_path: '/x', cwd: mesh.home, parent_session_id: null,
    agent_name: 'accept-edits', hook_event_name: type, ...payload}));
  assert.equal(await exit, 0);
}
const notify = (session: string, kind: string) =>
  runHook(session, 'notify', 'notification', {notification_type: kind, message: 'm'});

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}

async function createdOf(session: string): Promise<number> {
  const overview = await (await fetch(`${mesh.base}/api/agent-mail/overview`, {
    headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json() as
    {sessions: {identity: {id: string; created: number}}[]};
  return overview.sessions.find(item => item.identity.id === session)!.identity.created;
}

/** A message from `from` to `to`, through the agent mailbox with the sender's own session token. */
async function send(from: string, to: string, text: string): Promise<void> {
  const token = lines('token.log')[lines('session.log').lastIndexOf(from)];
  const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', body: JSON.stringify({
    target: to, target_created: await createdOf(to), kind: 'message', text}),
  headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'}});
  assert.equal(sent.status, 200, await sent.clone().text());
}

const waitingFor = async (name: string) => ((await agentOf(name)) as {waiting_for?: string} | null | undefined)?.waiting_for;

describe('Vibe preset', () => {
  test('launches as the agent vibe with the hooks directory in argv and the board server in the environment only', async () => {
    await launch('vb-main');
    const hooksDir = hooksDirOf(0);
    assert.ok(isHooksDir(hooksDir), hooksDir);
    assert.equal(lines('argv.log')[0], `argv:--add-dir ${hooksDir}`);
    assert.deepEqual(fs.readdirSync(hooksDir), ['.vibe'], 'nothing but the hooks file: the agent\'s workspace root');
    assert.equal(fs.statSync(hooksDir).mode & 0o777, 0o500);
    const servers = JSON.parse(lines('mcp.log')[0]);
    const token = lines('token.log')[0];
    assert.match(token, /^ms1\./);
    assert.deepEqual(servers, [{name: 'mesh-board', transport: 'stdio', command: path.join(fakes, 'meshbin', 'mesh-board-mcp'),
      args: [], env: {MESH_CONF_DIR: mesh.confDir, MESH_PORT: String(mesh.port), MESH_SESSION_TOKEN: token},
      disabled_tools: ['agent_message_send']}]);
    assert.ok(!lines('argv.log')[0].includes(token), 'the session token is not in the arguments');
    assert.ok(!lines('mcp.log')[0].includes(MARKER), 'no ambient credential is copied into the configuration');
    const mine = (await listing()).mesh.find(item => item.id === 'vb-main');
    assert.equal(mine?.known_agent, 'vibe');
  });

  test('the session token is in no command line and in no file of the mesh home', () => {
    const token = lines('token.log')[0];
    const holders: string[] = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (fs.readFileSync(`/proc/${entry}/cmdline`, 'latin1').includes(token)) holders.push(`pid ${entry}`);
      } catch { /* gone, or not ours */ }
    }
    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file);
        else if (item.isFile() && fs.readFileSync(file, 'latin1').includes(token)) holders.push(file);
      }
    };
    walk(mesh.home);
    assert.deepEqual(holders, []);
  });

  test('the hooks report working, a permission, a question and the end of a turn, with the conversation', async () => {
    await runHook('vb-main', 'prompt', 'pre_agent', {turn_id: 't1', prompt: 'private'});
    await until('a working state', async () => (await agentOf('vb-main'))?.status === 'busy');
    await notify('vb-main', 'approval_requested');
    await until('a permission wait', async () => (await waitingFor('vb-main')) === 'permission prompt');
    await runHook('vb-main', 'tool-done', 'post_tool', {tool_name: 'bash'});
    await until('work again after the answer', async () => (await agentOf('vb-main'))?.status === 'busy');
    await notify('vb-main', 'question_asked');
    await until('a question wait', async () => (await waitingFor('vb-main')) === 'input needed');
    await notify('vb-main', 'turn_completed');
    const idle = await until('an idle state', async () => {
      const agent = await agentOf('vb-main');
      return agent?.status === 'idle' ? agent : undefined;
    });
    assert.equal(idle.session_id, CONVERSATION);
    assert.equal(idle.type, 'vibe');
  });

  test('a wake notice is typed only once Vibe has reported the end of a turn', async () => {
    await launch('vb-peer');
    await runHook('vb-main', 'prompt', 'pre_agent', {turn_id: 't2'});
    await until('working', async () => (await agentOf('vb-main'))?.status === 'busy');
    await send('vb-peer', 'vb-main', 'hello');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed while a turn runs');
    await notify('vb-main', 'turn_completed');
    const typed = await until('the notice', () => lines('input.log').find(line => line.startsWith('# Mesh: new message')));
    assert.match(typed, /agent_inbox/);
    assert.ok(!typed.includes('hello'), 'the message text never reaches the terminal');
  });

  test('nothing is typed while a permission is open', async () => {
    const typedBefore = lines('input.log').length;
    await notify('vb-main', 'approval_requested');
    await until('a permission wait', async () => (await waitingFor('vb-main')) === 'permission prompt');
    await send('vb-peer', 'vb-main', 'again');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(lines('input.log').length, typedBefore, 'an Enter on an approval prompt would answer it');
    await notify('vb-main', 'turn_completed');
  });

  test('after a PTY host restart the conversation is restored with --resume and the board again', async () => {
    const identity = await agentOf('vb-main');
    assert.equal(identity?.session_id, CONVERSATION);
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const restorable = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'vb-main');
    });
    assert.deepEqual([restorable.agent, restorable.resumable], ['vibe', true]);
    const countBefore = lines('argv.log').length;
    const restored = await post('/api/restore', {names: ['vb-main']});
    assert.equal(restored.status, 200, await restored.clone().text());
    await until('the restored vibe', () => lines('argv.log').length > countBefore);
    const hooksDir = hooksDirOf(countBefore);
    assert.ok(isHooksDir(hooksDir), hooksDir);
    assert.notEqual(hooksDir, hooksDirOf(0), 'a restored session has its own hooks directory');
    assert.equal(lines('argv.log')[countBefore], `argv:--add-dir ${hooksDir} --resume ${CONVERSATION}`);
    assert.match(lines('mcp.log')[countBefore], /"mesh-board"/);
  });
});
