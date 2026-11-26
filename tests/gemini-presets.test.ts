// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Gemini CLI in the mesh without a model: a fake `gemini` on PATH records its argv and environment, and the real
// bin/mesh-event hook helper reports Gemini hook payloads (the shapes of Gemini's hooks reference) to a real
// server and PTY host. Covered: the private GEMINI_CLI_HOME overlay (the user's ~/.gemini is not modified, its
// restrictions are kept, the token is a reference), state and conversation reported by the hooks, the wake notice
// typed only while idle, and the restore with `--resume <id>` after a PTY host restart.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {approveMail} from './helpers/agent-mail-mesh.ts';

const CONVERSATION = '3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b';
const USER_SETTINGS = JSON.stringify({
  mcp: {excluded: ['dangerous']}, hooksConfig: {notifications: false}, tools: {exclude: ['run_shell_command']},
  mcpServers: {mine: {command: '/opt/mine'}},
  hooks: {AfterAgent: [{hooks: [{type: 'command', command: '/opt/user-hook'}]}]}}, null, 2);
let mesh: Mesh;
let fakes: string;
let host: ChildProcess | undefined;
let pathEnv: string;
const log = (file: string) => path.join(fakes, file);
const lines = (file: string): string[] =>
  fs.existsSync(log(file)) ? fs.readFileSync(log(file), 'utf8').split('\n').filter(Boolean) : [];
const userDir = () => path.join(mesh.home, '.gemini');
// Never the home directory itself: Gemini would take the real ~/.gemini for a project folder.
const workDir = () => path.join(mesh.home, 'work');
/** Remove whatever sits at ``entry`` (a file, a link, even a dangling one, a FIFO): rmSync with force leaves a
 * dangling link behind, and the next case would then find it in its way. */
function removeEntry(entry: string): void {
  if (fs.lstatSync(entry, {throwIfNoEntry: false})) fs.unlinkSync(entry);
}
const snapshot = (): string => fs.readdirSync(userDir()).sort().map(name => {
  const stat = fs.lstatSync(path.join(userDir(), name));
  return `${name}:${stat.size}:${stat.mtimeMs}`;
}).join('|');

function startHost(): ChildProcess {
  const argv = nativePtyhost();
  return spawn(argv[0], argv.slice(1), {cwd: REPO, stdio: 'ignore',
    env: {PATH: pathEnv, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C',
      SHELL: path.join(fakes, 'plain-bash')}});
}

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gemini-'));
  // Keep fake commands on PATH; this suite does not test machine login profiles.
  fs.writeFileSync(path.join(fakes, 'plain-bash'), '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', {mode: 0o755});
  const bin = path.join(fakes, 'bin');
  const meshBin = path.join(fakes, 'meshbin');
  fs.mkdirSync(bin);
  fs.mkdirSync(meshBin);
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.copyFileSync(path.join(REPO, 'bin', 'mesh-event'), path.join(meshBin, 'mesh-event'));
  fs.chmodSync(path.join(meshBin, 'mesh-event'), 0o755);
  // Like the real one, a node script run through its `#!/usr/bin/env node` line: the process is `node <path>/gemini`,
  // which the PTY host's foreground check (discover._is_gemini_script, Mesh_ptyhost.runs_gemini_script) must
  // recognise for the wake notice to be typed at all.
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/usr/bin/env node
const fs = require('fs');
const record = (file, text) => fs.appendFileSync(${JSON.stringify(fakes)} + '/' + file, text + '\\n');
record('argv.log', 'argv:' + process.argv.slice(2).join(' '));
record('home.log', process.env.GEMINI_CLI_HOME || '');
record('trust.log', process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || '');
record('token.log', process.env.MESH_SESSION_TOKEN || '');
record('session.log', process.env.MESH_SESSION || '');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.search(/[\\r\\n]/)) >= 0) { record('input.log', buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
});
setInterval(() => {}, 1000);
`, {mode: 0o755});
  pathEnv = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('gemini-presets-', {PATH: pathEnv, MESH_BIN_DIR: meshBin});
  fs.mkdirSync(workDir());
  fs.mkdirSync(userDir());
  fs.writeFileSync(path.join(userDir(), 'settings.json'), USER_SETTINGS);
  fs.writeFileSync(path.join(userDir(), 'oauth_creds.json'), '{"credential":"never-copied"}', {mode: 0o600});
  fs.writeFileSync(path.join(userDir(), 'GEMINI.md'), 'owner memory');
  fs.mkdirSync(path.join(userDir(), 'tmp'));
  fs.writeFileSync(path.join(userDir(), 'projects.json'), '{}');
  host = startHost();
  await until('the PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (fakes) fs.rmSync(fakes, {recursive: true, force: true});
});

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
const post = (route: string, body: unknown) =>
  fetch(`${mesh.base}${route}`, {method: 'POST', headers: headers(), body: JSON.stringify(body)});
type Listed = {mesh: {id: string; known_agent: string | null; agent: {type: string; status?: string; waiting_for?: string; session_id?: string} | null}[]};
const listing = async (): Promise<Listed> => await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as Listed;
const agentOf = async (name: string) => (await listing()).mesh.find(item => item.id === name)?.agent;

async function launch(name: string): Promise<void> {
  const count = lines('session.log').length;
  const response = await post('/api/new', {preset: 'gemini', cwd: workDir(), name});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake gemini of ${name}`, () => lines('session.log').length > count);
}

/** One Gemini hook payload through the real helper, with the session's token. */
function hook(name: string, payload: object): void {
  const index = lines('session.log').lastIndexOf(name);
  execFileSync(path.join(fakes, 'meshbin', 'mesh-event'), ['gemini'], {
    input: JSON.stringify({session_id: CONVERSATION, cwd: mesh.home, ...payload}), stdio: ['pipe', 'pipe', 'pipe'],
    env: {PATH: process.env.PATH, MESH_PORT: String(mesh.port), MESH_SESSION_TOKEN: lines('token.log')[index]}});
}

describe('Gemini preset', () => {
  test('launches bare with a private GEMINI_CLI_HOME; the user\'s ~/.gemini is untouched, its restrictions kept', async () => {
    const before = snapshot();
    await launch('gm-main');
    assert.equal(lines('argv.log')[0], 'argv:');
    assert.equal(snapshot(), before, 'nothing in ~/.gemini was written, created or removed');
    const home = lines('home.log')[0];
    assert.ok(home.startsWith(mesh.confDir), 'the overlay lives under the mesh configuration directory');
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.mcp, {excluded: ['dangerous']});
    assert.equal(settings.hooksConfig.notifications, false);
    assert.deepEqual(settings.mcpServers.mine, {command: '/opt/mine'});
    assert.equal(settings.mcpServers['mesh-board'].command, path.join(fakes, 'meshbin', 'mesh-board-mcp'));
    assert.deepEqual(settings.mcpServers['mesh-board'].env.MESH_SESSION_TOKEN, '$MESH_SESSION_TOKEN');
    assert.ok(!JSON.stringify(settings).includes(lines('token.log')[0]), 'the token is a reference, never a value');
    assert.deepEqual(settings.hooks.AfterAgent[0].hooks[0].command, '/opt/user-hook');
    assert.match(settings.hooks.AfterAgent[1].hooks[0].command, /mesh-event gemini >\/dev\/null 2>&1 \|\| true$/);
    assert.deepEqual(settings.tools, {exclude: ['run_shell_command']});
    assert.equal(lines('trust.log')[0], path.join(userDir(), 'trustedFolders.json'), 'the trust decisions are the user\'s own file');
    assert.ok(!fs.existsSync(path.join(home, '.gemini', 'trustedFolders.json')), 'and not a copy or a link in the overlay');
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['AfterAgent', 'AfterTool', 'BeforeAgent', 'BeforeTool', 'Notification']);
    assert.equal(fs.readlinkSync(path.join(home, '.gemini', 'oauth_creds.json')), path.join(userDir(), 'oauth_creds.json'));
    assert.equal(fs.readlinkSync(path.join(home, '.gemini', 'GEMINI.md')), path.join(userDir(), 'GEMINI.md'));
    for (const privateName of ['tmp', 'projects.json']) {
      assert.ok(!fs.lstatSync(path.join(home, '.gemini', privateName), {throwIfNoEntry: false})?.isSymbolicLink(),
        `${privateName} is not shared with the user's directory`);
    }
    assert.equal((await listing()).mesh.find(item => item.id === 'gm-main')?.known_agent, 'gemini');
  });

  test('a settings file that cannot be read faithfully refuses the launch instead of launching without it', async () => {
    const settingsPath = path.join(userDir(), 'settings.json');
    const good = fs.readFileSync(settingsPath, 'utf8');
    const refused = async (label: string, prepare: () => void) => {
      removeEntry(settingsPath);
      prepare();
      const response = await post('/api/new', {preset: 'gemini', cwd: workDir(), name: 'gm-bad'});
      assert.equal(response.status, 503, label);
      assert.match(await response.text(), /Gemini settings: .*settings\.json/, label);
    };
    try {
      await refused('not JSON', () => fs.writeFileSync(settingsPath, '{not json'));
      await refused('NaN', () => fs.writeFileSync(settingsPath, '{"n": NaN}'));
      await refused('not an object', () => fs.writeFileSync(settingsPath, '[]'));
      await refused('too large', () => fs.writeFileSync(settingsPath, `{"pad": "${'a'.repeat(1024 * 1024)}"}`));
      await refused('dangling link', () => fs.symlinkSync(path.join(mesh.home, 'nowhere.json'), settingsPath));
      await refused('FIFO', () => execFileSync('mkfifo', [settingsPath]));
    } finally {
      removeEntry(settingsPath);
      fs.writeFileSync(settingsPath, good);
    }
  });

  test('a settings file reached through a link is read', async () => {
    const settingsPath = path.join(userDir(), 'settings.json');
    const good = fs.readFileSync(settingsPath, 'utf8');
    const real = path.join(mesh.home, 'real-settings.json');
    fs.writeFileSync(real, good);
    fs.rmSync(settingsPath);
    fs.symlinkSync(real, settingsPath);
    try {
      await launch('gm-link');
    } finally {
      fs.rmSync(settingsPath);
      fs.writeFileSync(settingsPath, good);
    }
  });

  test('Gemini is not started in the home directory, where it would take ~/.gemini for a project', async () => {
    const response = await post('/api/new', {preset: 'gemini', cwd: mesh.home, name: 'gm-home'});
    assert.equal(response.status, 400);
    assert.match(await response.text(), /home directory/);
  });

  test('the hook command exits 0 and prints nothing whatever happens to mesh-event', () => {
    const home = lines('home.log')[0];
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    const command: string = settings.hooks.BeforeAgent.at(-1).hooks[0].command;
    const helper = path.join(fakes, 'meshbin', 'mesh-event');
    assert.ok(command.includes(helper));
    const failing = path.join(fakes, 'failing-event');
    fs.writeFileSync(failing, '#!/bin/sh\necho "boom" >&2\necho "denied"\nexit 3\n', {mode: 0o755});
    for (const [label, replaced] of [['absent', path.join(fakes, 'absent-event')], ['failing', failing]]) {
      const result = spawnSync('bash', ['-c', command.replace(helper, replaced)], {input: '{}', encoding: 'utf8'});
      assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], label);
    }
    const noPython = spawnSync('/bin/bash', ['-c', command], {input: '{}', encoding: 'utf8', env: {PATH: '/nonexistent'}});
    assert.deepEqual([noPython.status, noPython.stdout, noPython.stderr], [0, '', ''], 'no interpreter on the PATH');
  });

  test('trust follows the user\'s file: a copy left in the overlay is removed at the next launch', async () => {
    const home = lines('home.log')[0];
    const stale = path.join(home, '.gemini', 'trustedFolders.json');
    fs.writeFileSync(stale, '{"/work/evil":"TRUST_FOLDER"}');
    await launch('gm-trust');
    assert.ok(!fs.existsSync(stale));
    assert.equal(lines('trust.log').at(-1), path.join(userDir(), 'trustedFolders.json'));
  });

  test('two launches at once both succeed', async () => {
    const count = lines('session.log').length;
    const responses = await Promise.all(['gm-a', 'gm-b', 'gm-c'].map(name => post('/api/new', {preset: 'gemini', cwd: workDir(), name})));
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
    await until('the three fakes', () => lines('session.log').length >= count + 3);
    const leftovers = fs.readdirSync(path.join(lines('home.log')[0], '.gemini')).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('the hooks report the working, permission and finished states and the conversation', async () => {
    hook('gm-main', {hook_event_name: 'BeforeAgent', prompt: 'x'});
    await until('busy', async () => (await agentOf('gm-main'))?.status === 'busy');
    hook('gm-main', {hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'm', details: {}});
    await until('waiting', async () => (await agentOf('gm-main'))?.waiting_for === 'permission prompt');
    hook('gm-main', {hook_event_name: 'AfterTool', tool_name: 'run_shell_command'});
    hook('gm-main', {hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'y'});
    const idle = await until('idle', async () => {
      const agent = await agentOf('gm-main');
      return agent?.status === 'idle' ? agent : undefined;
    });
    assert.equal(idle.session_id, CONVERSATION);
    assert.equal(idle.type, 'gemini');
  });

  test('a wake notice is typed only once a turn has finished', async () => {
    await launch('gm-peer');
    const cookie = (await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'}))
      .headers.getSetCookie().find(item => item.startsWith('mesh_auth='))!.split(';')[0];
    const overview = await (await fetch(`${mesh.base}/api/agent-mail/overview`, {headers: {Origin: mesh.base, Cookie: cookie}})).json() as
      {sessions: {identity: {id: string; created: number}}[]};
    const created = overview.sessions.find(item => item.identity.id === 'gm-main')!.identity.created;
    hook('gm-main', {hook_event_name: 'BeforeAgent', prompt: 'x'});
    await until('busy', async () => (await agentOf('gm-main'))?.status === 'busy');
    hook('gm-main', {hook_event_name: 'BeforeTool', tool_name: 'run_shell_command'});   // a tool running is not a finished turn
    const peerToken = lines('token.log')[lines('session.log').lastIndexOf('gm-peer')];
    const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', headers: {
      Authorization: `MeshSession ${peerToken}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({target: 'gm-main', target_created: created, kind: 'message', text: 'hello'})});
    assert.equal(sent.status, 200, await sent.clone().text());
    await approveMail(mesh.base, cookie, sent);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed while a turn runs');
    assert.equal((await agentOf('gm-main'))?.status, 'busy');
    hook('gm-main', {hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'y'});
    const typed = await until('the notice', () => lines('input.log').find(line => line.startsWith('# Mesh: new message')));
    assert.match(typed, /mail\.inbox/);
  });

  test('after a PTY host restart the conversation is restored with --resume and the overlay again', async () => {
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const offered = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'gm-main');
    });
    assert.deepEqual([offered.agent, offered.resumable], ['gemini', true]);
    const count = lines('argv.log').length;
    const restored = await post('/api/restore', {names: ['gm-main']});
    assert.equal(restored.status, 200, await restored.clone().text());
    await until('the restored gemini', () => lines('argv.log').length > count);
    assert.equal(lines('argv.log')[count], `argv:--resume ${CONVERSATION}`);
    assert.ok(lines('home.log')[count].startsWith(mesh.confDir));
  });

  test('a Gemini whose settings cannot be read fails alone in a restore batch', async () => {
    const other = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    await launch('gm-lost');
    hook('gm-lost', {hook_event_name: 'BeforeAgent', prompt: 'x', session_id: other});
    await until('the conversation of gm-lost', async () => (await agentOf('gm-lost'))?.session_id === other);
    assert.equal((await post('/api/new', {preset: 'custom', command: 'sleep 3000', cwd: workDir(), name: 'sh-lost'})).status, 200);
    await until('the sleep in the snapshot', async () => (await listing()).mesh.some(item => item.id === 'sh-lost'));
    await new Promise(resolve => setTimeout(resolve, 1000));
    await listing();
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    await until('both lost sessions offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string}[]};
      return ['gm-lost', 'sh-lost'].every(name => data.restorable.some(item => item.name === name));
    });
    const settingsPath = path.join(userDir(), 'settings.json');
    const good = fs.readFileSync(settingsPath, 'utf8');
    try {
      fs.writeFileSync(settingsPath, '{not json');
      const restored = await post('/api/restore', {names: ['gm-lost', 'sh-lost']});
      assert.equal(restored.status, 200, await restored.clone().text());
      const {results} = await restored.json() as {results: Record<string, {ok: boolean; error?: string}>};
      assert.equal(results['gm-lost'].ok, false);
      assert.match(results['gm-lost'].error ?? '', /Gemini settings: .*settings\.json/);
      assert.equal(results['sh-lost'].ok, true, 'the other entry of the batch is still restored');
      assert.ok(results['gm-lost'].error !== results['sh-lost'].error);
    } finally {
      fs.writeFileSync(settingsPath, good);
    }
  });
});
