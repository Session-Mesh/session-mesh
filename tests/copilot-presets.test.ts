// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Copilot CLI in the mesh without a model: a fake `copilot` on PATH records its argv, its environment and what is
// typed into it. The hooks are the real ones: the commands of copilot-mesh-plugin/hooks/hooks.json are run with the
// payloads Copilot sends (captured from copilot 1.0.86) and the environment the fake received.
// Covered: launch from "+ New" with the board server and the plugin as options (no credential in them), the state
// and conversation the hooks report, the wake notice typed only while idle, and the restore of the conversation
// after a PTY host restart with the options the user chose.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {fakeAgentPrologue, fakeAgentShell} from './helpers/fake-agent.ts';

const CONVERSATION = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';
const OTHER = '11111111-2222-4333-8444-555555555555';
const MARKER = 'COPILOT-TEST-CREDENTIAL';
let mesh: Mesh;
let fakes: string;
let host: ChildProcess | undefined;
let pathEnv: string;
const log = (file: string) => path.join(fakes, file);
const lines = (file: string): string[] =>
  fs.existsSync(log(file)) ? fs.readFileSync(log(file), 'utf8').split('\n').filter(Boolean) : [];

// The native host named by MESH_PTYHOST_CMD (nativePtyhost fails with a clear message when it is not set).

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

before(async () => {
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-copilot-'));
  fakeAgentShell(fakes);
  const bin = path.join(fakes, 'bin');
  const meshBin = path.join(fakes, 'meshbin');
  fs.mkdirSync(bin);
  fs.mkdirSync(meshBin);
  // The board bridge only has to exist and be executable: this test never talks MCP. The event helper is the real one.
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.symlinkSync(path.join(REPO, 'bin', 'mesh-event'), path.join(meshBin, 'mesh-event'));
  fs.writeFileSync(path.join(bin, 'copilot'), `${fakeAgentPrologue('copilot')}for a in "$@"; do printf '%s\\n' "$a"; done | { printf 'argv-start\\n'; cat; printf 'argv-end\\n'; } >> '${log('argv.log')}'
printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('session.log')}'
printf '%s\\n' "$MESH_EVENT_BIN" >> '${log('event-bin.log')}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('input.log')}'; done
`, {mode: 0o755});
  pathEnv = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('copilot-presets-', {PATH: pathEnv, MESH_BIN_DIR: meshBin, COPILOT_GITHUB_TOKEN: MARKER});
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

type Listed = {mesh: {id: string; known_agent: string | null; agent: {type: string; status?: string; session_id?: string; waiting_for?: string} | null}[]};
async function listing(): Promise<Listed> {
  return await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as Listed;
}
const agentOf = async (name: string) => (await listing()).mesh.find(item => item.id === name)?.agent;

/** The argv a launch recorded, one list of words per launch. */
function launches(): string[][] {
  const all = lines('argv.log');
  const result: string[][] = [];
  let current: string[] | null = null;
  for (const line of all) {
    if (line === 'argv-start') current = [];
    else if (line === 'argv-end' && current) { result.push(current); current = null; }
    else current?.push(line);
  }
  return result;
}

async function launch(name: string, command?: string): Promise<void> {
  const before = lines('session.log').length;
  const response = await post('/api/new', command ? {preset: 'custom', cwd: mesh.home, name, command} : {preset: 'copilot', cwd: mesh.home, name});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake copilot of ${name}`, () => lines('session.log').length > before);
}

const HOOKS = JSON.parse(fs.readFileSync(path.join(REPO, 'copilot-mesh-plugin', 'hooks', 'hooks.json'), 'utf8')) as
  {hooks: Record<string, {bash: string}[]>};

/** One hook of the plugin, run like Copilot runs it: bash -c, the payload on stdin, the session's environment. */
function hook(name: string, event: string, payload: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}): void {
  const index = lines('session.log').lastIndexOf(name);
  assert.ok(index >= 0, `no launch recorded for ${name}`);
  const entry = HOOKS.hooks[event]?.[0];
  assert.ok(entry, `the plugin registers ${event}`);
  execFileSync('bash', ['-c', entry.bash], {cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify({
    sessionId: CONVERSATION, timestamp: Date.now(), cwd: mesh.home, ...payload}), env: {
    PATH: process.env.PATH, HOME: mesh.home, MESH_PORT: String(mesh.port), MESH_SESSION_TOKEN: lines('token.log')[index],
    MESH_EVENT_BIN: lines('event-bin.log')[index], ...extraEnv}});
}

describe('Copilot CLI preset', () => {
  test('launches as the agent copilot with the board server and the plugin as options, and no credential in them', async () => {
    await launch('cp-main');
    const [argv] = launches();
    assert.deepEqual(argv.filter(word => word.startsWith('--')), ['--additional-mcp-config', '--plugin-dir']);
    const config = JSON.parse(argv[argv.indexOf('--additional-mcp-config') + 1]);
    assert.deepEqual(config, {mcpServers: {'mesh-board': {type: 'local', command: path.join(fakes, 'meshbin', 'mesh-board-mcp'),
      args: [], env: {MESH_CONF_DIR: mesh.confDir, MESH_PORT: String(mesh.port)}}}});
    assert.equal(argv[argv.indexOf('--plugin-dir') + 1], path.join(REPO, 'copilot-mesh-plugin'));
    const token = lines('token.log')[0];
    assert.match(token, /^ms1\./);
    const everything = lines('argv.log').join('\n');
    assert.ok(!everything.includes(token), 'the session token is not in the command line');
    assert.ok(!everything.includes(MARKER), 'no ambient credential is copied into the command line');
    assert.equal(lines('event-bin.log')[0], path.join(fakes, 'meshbin', 'mesh-event'));
    assert.equal((await listing()).mesh.find(item => item.id === 'cp-main')?.known_agent, 'copilot');
  });

  test('the hooks report working, a permission prompt, a question and the end of a turn with the conversation', async () => {
    hook('cp-main', 'userPromptSubmitted', {prompt: 'hello'});
    await until('a working state', async () => (await agentOf('cp-main'))?.status === 'busy');
    hook('cp-main', 'notification', {notification_type: 'permission_prompt', title: 'Permission needed', message: 'Run command: touch x'});
    await until('a permission wait', async () => (await agentOf('cp-main'))?.waiting_for === 'permission prompt');
    hook('cp-main', 'postToolUse', {toolName: 'bash', toolArgs: {}});
    await until('working again', async () => (await agentOf('cp-main'))?.status === 'busy');
    hook('cp-main', 'notification', {notification_type: 'elicitation_dialog', title: 'Information requested', message: 'Pick one?'});
    await until('a question wait', async () => (await agentOf('cp-main'))?.waiting_for === 'input needed');
    hook('cp-main', 'agentStop', {stopReason: 'end_turn', stop_hook_active: false});
    const idle = await until('an idle state', async () => {
      const agent = await agentOf('cp-main');
      return agent?.status === 'idle' ? agent : undefined;
    });
    assert.equal(idle.session_id, CONVERSATION);
    assert.equal(idle.type, 'copilot');
  });

  test("hooks that say nothing about the user's terminal change nothing", async () => {
    hook('cp-main', 'notification', {notification_type: 'idle_prompt', message: 'x'});
    hook('cp-main', 'userPromptSubmitted', {prompt: 'sub-agent', agentId: 'sub-1', agentType: 'explore'});
    hook('cp-main', 'errorOccurred', {error: {message: 'rate limited', name: 'E'}, errorContext: 'model_call', recoverable: true});
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await agentOf('cp-main'))?.status, 'idle');
  });

  test('a missing event helper never fails the hook (it must not block a tool)', () => {
    const entry = HOOKS.hooks.postToolUse[0];
    // The event comes from a file, not a pipe: the hook exits without reading it, and a write to a
    // pipe that bash already closed fails with EPIPE in the test, not in the hook.
    const event = path.join(mesh.home, 'hook-event.json');
    fs.writeFileSync(event, '{}');
    const input = fs.openSync(event, 'r');
    try {
      execFileSync('bash', ['-c', entry.bash], {stdio: [input, 'pipe', 'pipe'], env: {PATH: process.env.PATH, MESH_EVENT_BIN: '/nonexistent'}});
    } finally {
      fs.closeSync(input);
    }
  });

  test('no wake notice is ever typed into Copilot, not even after the end of a turn', async () => {
    await launch('cp-peer');
    const created = ((await (await fetch(`${mesh.base}/api/agent-mail/overview`, {
      headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json()) as
      {sessions: {identity: {id: string; created: number}}[]}).sessions.find(item => item.identity.id === 'cp-main')!.identity.created;
    hook('cp-main', 'userPromptSubmitted', {prompt: 'work'});
    await until('working', async () => (await agentOf('cp-main'))?.status === 'busy');
    const peerToken = lines('token.log')[lines('session.log').lastIndexOf('cp-peer')];
    const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', body: JSON.stringify({
      target: 'cp-main', target_created: created, kind: 'message', text: 'hello'}),
    headers: {Authorization: `MeshSession ${peerToken}`, 'Content-Type': 'application/json'}});
    assert.equal(sent.status, 200, await sent.clone().text());
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed while a turn runs');
    hook('cp-main', 'notification', {notification_type: 'permission_prompt', message: 'Run command: x'});
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed over a permission prompt');
    hook('cp-main', 'agentStop', {stopReason: 'end_turn', stop_hook_active: false});
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed after the end of a turn either: the message waits in the inbox');
  });

  test('after a PTY host restart the conversation is restored with --resume, the user options and the board again', async () => {
    // A custom command is not a Mesh preset: it gets neither the board nor the plugin at first. The conversation it
    // names in its arguments is the one restored, and the options the user chose are kept.
    await launch('cp-strict', `copilot --resume=${OTHER} --deny-tool 'shell(rm)' --model gpt-x`);
    assert.deepEqual(launches().at(-1), [`--resume=${OTHER}`, '--deny-tool', 'shell(rm)', '--model', 'gpt-x']);
    const identity = await agentOf('cp-main');
    assert.equal(identity?.session_id, CONVERSATION);
    assert.equal((await agentOf('cp-strict'))?.session_id, OTHER);
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const restorable = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'cp-main');
    });
    assert.deepEqual([restorable.agent, restorable.resumable], ['copilot', true]);
    const before = launches().length;
    // On Linux the fake's argv is `sh <script> ...`, a launcher Mesh cannot read (below). On macOS the fakes run
    // with argv[0] set to the agent's name (helpers/fake-agent.ts), so Mesh reads them as it reads the real
    // binary: that refusal can only be shown on Linux, and only cp-main is restored elsewhere.
    const unreadableLauncher = process.platform === 'linux';
    const restored = await post('/api/restore', {names: unreadableLauncher ? ['cp-main', 'cp-strict'] : ['cp-main']});
    const answer = await restored.json() as {results: Record<string, {ok: boolean; error?: string}>};
    assert.equal(restored.status, 200);
    await until('the restored copilot', () => launches().length > before);
    const main = launches()[before];
    assert.equal(main[0], `--resume=${CONVERSATION}`);
    assert.equal(main.filter(word => word === '--additional-mcp-config').length, 1, 'the board option is not duplicated');
    assert.equal(main.filter(word => word === '--plugin-dir').length, 1);
    assert.match(main[main.indexOf('--additional-mcp-config') + 1], /"mesh-board"/);
    // The fake is a shell script: its argv is `sh <script> ...`, a launcher Mesh cannot read. The saved command names
    // --deny-tool, so the restore is refused rather than restarted without it (the real binary is read: see
    // copilot-resume.test.ts and the real-binary test).
    if (unreadableLauncher) {
      assert.equal(answer.results['cp-strict'].ok, false);
      assert.match(answer.results['cp-strict'].error ?? '', /--deny-tool/);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(launches().length, before + 1, 'nothing was started for the refused one');
  });
});

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}
