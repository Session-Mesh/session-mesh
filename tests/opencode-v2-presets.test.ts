// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// OpenCode 2 in the mesh without a model: a fake `opencode` (it answers `--version` with a 2.x version and
// a private config API with no document) on PATH records its argv, its environment and what is typed
// into it, and the real Mesh OpenCode 2 plugin reports hook events to a real server and PTY host.
// Covered: launch from "+ New" with --standalone, the v2 configuration (no credential in it), the state and
// conversation the plugin reports (working, permission, question, sub-agents), the wake notice typed only while
// idle, a second terminal that shares nothing with the first, and the restore of the conversation after a PTY
// host restart (and its refusal when the conversation is not in OpenCode's store).
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {after, before, describe, test} from 'node:test';
import {addConversationV2, createStoreV2} from './helpers/opencode-store.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';

const CONVERSATION = 'ses_e1ec1ceb2ffeve47ULriArjJ5g';
const CHILD = 'ses_e1ec1ceb2ffeCHILD00000000001';
const MARKER = 'OPENCODE-TEST-CREDENTIAL';
let mesh: Mesh;
let fakes: string;
let dataHome: string;
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
    env: {PATH: pathEnv, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C'}});
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
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode2-'));
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode2-data-'));
  const bin = path.join(fakes, 'bin');
  const meshBin = path.join(fakes, 'meshbin');
  fs.mkdirSync(bin);
  fs.mkdirSync(meshBin);
  // The board bridge only has to exist and be executable: this test never talks MCP.
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  // The mesh reads the version and the configuration before it launches: those probes are not launches.
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh
[ "$1" = "--version" ] && { echo 'opencode v2.3.0'; exit 0; }
if [ "$1" = "api" ]; then
  [ "$#" = 4 ] && [ "$2" = get ] && [ "$4" = --standalone ] || exit 9
  case "$3" in '/api/config?location%5Bdirectory%5D='*) ;; *) exit 9 ;; esac
  env | grep -q '^MESH_' && exit 4
  echo '[]'; exit 0
fi
printf 'argv:%s\\n' "$*" >> '${log('argv.log')}'
printf '%s\\n' "$OPENCODE_CONFIG_CONTENT" >> '${log('config.log')}'
# In a resumed launch, make the argv-before-token ordering observable to the test.
if [ "$1" = "--standalone" ] && [ "$2" = "--session" ]; then sleep 0.2; fi
printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('session.log')}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('input.log')}'; done
`, {mode: 0o755});
  pathEnv = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('opencode-v2-presets-', {PATH: pathEnv, MESH_BIN_DIR: meshBin, OPENCODE_API_KEY: MARKER,
    XDG_DATA_HOME: dataHome});
  // OpenCode 2's own store, where Mesh checks the conversation to resume and reads the one a process was started with.
  fs.mkdirSync(path.join(dataHome, 'opencode'));
  const store = createStoreV2(path.join(dataHome, 'opencode', 'opencode.db'));
  addConversationV2(store, CONVERSATION, fs.realpathSync(mesh.home), {updated: Date.now() - 3_600_000});
  store.close();
  host = startHost();
  await until('the PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (fakes) fs.rmSync(fakes, {recursive: true, force: true});
  if (dataHome) fs.rmSync(dataHome, {recursive: true, force: true});
});

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
const post = (route: string, body: unknown) =>
  fetch(`${mesh.base}${route}`, {method: 'POST', headers: headers(), body: JSON.stringify(body)});

type Listed = {mesh: {id: string; known_agent: string | null;
  agent: {type: string; status?: string; session_id?: string; waiting_for?: string; identity_source?: string} | null}[]};
async function listing(): Promise<Listed> {
  return await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as Listed;
}
const agentOf = async (name: string) => (await listing()).mesh.find(item => item.id === name)?.agent;

async function launch(name: string): Promise<void> {
  const before = lines('session.log').length;
  const response = await post('/api/new', {preset: 'opencode', cwd: mesh.home, name});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake opencode of ${name}`, () => lines('session.log').length > before);
}

/** Events through the real v2 plugin, with the session token the fake received. Each call is one plugin
 *  process, so a sequence starts with its own `started`: the translator has no memory of an earlier call. */
function report(name: string, events: unknown[], extraEnv: NodeJS.ProcessEnv = {}): void {
  const index = lines('session.log').lastIndexOf(name);
  assert.ok(index >= 0, `no launch recorded for ${name}`);
  execFileSync(process.execPath, ['--experimental-strip-types', 'tests/helpers/opencode-plugin-v2-driver.ts',
    JSON.stringify(events)], {cwd: REPO, stdio: 'pipe', env: {
    PATH: process.env.PATH, HOME: mesh.home, MESH_PORT: String(mesh.port),
    MESH_SESSION_TOKEN: lines('token.log')[index], ...extraEnv}});
}

const started = (sessionID = CONVERSATION) => ({type: 'session.execution.started', data: {sessionID}});
const succeeded = (sessionID = CONVERSATION) => ({type: 'session.execution.succeeded', data: {sessionID}});
const asked = {type: 'permission.asked', data: {id: 'per_1', sessionID: CONVERSATION, action: 'bash', resources: ['*']}};
const replied = {type: 'permission.replied', data: {sessionID: CONVERSATION, requestID: 'per_1', reply: 'once'}};
const question = {type: 'form.created', data: {form: {id: 'frm_1', sessionID: CONVERSATION, metadata: {kind: 'question'}}}};
const cancelled = {type: 'form.cancelled', data: {id: 'frm_1', sessionID: CONVERSATION}};

describe('OpenCode 2 preset', () => {
  test('launches with --standalone, as the agent opencode, with the v2 board server and plugin in the environment only', async () => {
    await launch('oc2-main');
    assert.equal(lines('argv.log')[0], 'argv:--standalone');
    const config = JSON.parse(lines('config.log')[0]);
    assert.deepEqual(Object.keys(config).sort(), ['mcp', 'plugins']);
    assert.deepEqual(config.mcp.servers['mesh-board'], {type: 'local', command: [path.join(fakes, 'meshbin', 'mesh-board-mcp')],
      environment: {MESH_CONF_DIR: mesh.confDir, MESH_PORT: String(mesh.port)}});
    assert.deepEqual(config.plugins, [{package: path.join(REPO, 'opencode-mesh-plugin-v2')}]);
    const token = lines('token.log')[0];
    assert.match(token, /^ms1\./);
    assert.ok(!lines('config.log')[0].includes(token), 'the session token is not written in the configuration');
    assert.ok(!lines('config.log')[0].includes(MARKER), 'no ambient credential is copied into the configuration');
    const mine = (await listing()).mesh.find(item => item.id === 'oc2-main') as unknown as {known_agent: string; notice: string | null};
    assert.equal(mine.known_agent, 'opencode');
    assert.equal(mine.notice, null);
  });

  test('the plugin reports working, a permission request, a question and the end of a turn with the conversation', async () => {
    report('oc2-main', [started()]);
    await until('a working state', async () => (await agentOf('oc2-main'))?.status === 'busy');
    report('oc2-main', [started(), asked]);
    await until('a permission wait', async () => (await agentOf('oc2-main'))?.waiting_for === 'permission prompt');
    report('oc2-main', [started(), asked, replied, question]);
    await until('a question wait', async () => (await agentOf('oc2-main'))?.waiting_for === 'input needed');
    report('oc2-main', [started(), question, cancelled, succeeded()]);
    const idle = await until('an idle state', async () => {
      const agent = await agentOf('oc2-main');
      return agent?.status === 'idle' ? agent : undefined;
    });
    assert.equal(idle.session_id, CONVERSATION);
    assert.equal(idle.type, 'opencode');
  });

  test('a sub-agent session never makes the terminal idle nor names the conversation', async () => {
    report('oc2-main', [started(), started(CHILD), succeeded(CHILD)]);
    await until('working', async () => (await agentOf('oc2-main'))?.status === 'busy');
    await new Promise(resolve => setTimeout(resolve, 600));
    const agent = await agentOf('oc2-main');
    assert.equal(agent?.status, 'busy', 'the root turn is still running');
    assert.equal(agent?.session_id, CONVERSATION);
    report('oc2-main', [started(), succeeded()]);
    await until('idle', async () => (await agentOf('oc2-main'))?.status === 'idle');
  });

  test('the plugin ignores a proxy environment: the token goes to the local mesh only', async () => {
    report('oc2-main', [started()], {HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9'});
    await until('a working state through a dead proxy', async () => (await agentOf('oc2-main'))?.status === 'busy');
    report('oc2-main', [started(), succeeded()]);
    await until('idle again', async () => (await agentOf('oc2-main'))?.status === 'idle');
  });

  test('a second terminal gets its own token and configuration, and reports to its own session only', async () => {
    await launch('oc2-peer');
    const [first, second] = [lines('token.log')[0], lines('token.log')[lines('session.log').lastIndexOf('oc2-peer')]];
    assert.notEqual(first, second);
    assert.equal(lines('config.log')[0], lines('config.log')[lines('session.log').lastIndexOf('oc2-peer')],
      'the same configuration, and neither holds a token');
    report('oc2-peer', [started()]);
    await until('the peer working', async () => (await agentOf('oc2-peer'))?.status === 'busy');
    assert.equal((await agentOf('oc2-main'))?.status, 'idle', 'the first terminal did not inherit the peer state');
    report('oc2-peer', [started(), succeeded()]);
    await until('the peer idle', async () => (await agentOf('oc2-peer'))?.status === 'idle');
  });

  test('a wake notice is typed only at the idle prompt: not during a turn, a permission request or a question', async () => {
    const created = ((await (await fetch(`${mesh.base}/api/agent-mail/overview`, {
      headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json()) as
      {sessions: {identity: {id: string; created: number}}[]}).sessions.find(item => item.identity.id === 'oc2-main')!.identity.created;
    const peerToken = lines('token.log')[lines('session.log').lastIndexOf('oc2-peer')];
    const send = async (text: string) => {
      const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', body: JSON.stringify({
        target: 'oc2-main', target_created: created, kind: 'message', text}),
      headers: {Authorization: `MeshSession ${peerToken}`, 'Content-Type': 'application/json'}});
      assert.equal(sent.status, 200, await sent.clone().text());
    };
    report('oc2-main', [started()]);
    await until('working', async () => (await agentOf('oc2-main'))?.status === 'busy');
    await send('during a turn');
    report('oc2-main', [started(), asked]);
    await until('a permission wait', async () => (await agentOf('oc2-main'))?.waiting_for === 'permission prompt');
    await send('during a permission request');
    report('oc2-main', [started(), asked, replied, question]);
    await until('a question wait', async () => (await agentOf('oc2-main'))?.waiting_for === 'input needed');
    await send('during a question');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed while a turn runs or waits');
    report('oc2-main', [started(), question, cancelled, succeeded()]);
    const typed = await until('the notice', () => lines('input.log').find(line => line.startsWith('# Mesh: new message')));
    assert.match(typed, /mail\.inbox/);
  });

  test('after a PTY host restart the conversation is restored with --standalone --session and the board again', async () => {
    const identity = await agentOf('oc2-main');
    assert.equal(identity?.session_id, CONVERSATION);
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const restorable = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'oc2-main');
    });
    assert.deepEqual([restorable.agent, restorable.resumable], ['opencode', true]);
    const before = lines('argv.log').length;
    const tokensBefore = lines('token.log').length;
    // The conversation is gone from OpenCode's store: OpenCode 2 would start an empty one, so nothing is restored.
    const storeFile = path.join(dataHome, 'opencode', 'opencode.db');
    const store = new DatabaseSync(storeFile);
    store.prepare('DELETE FROM session_v2 WHERE id = ?').run(CONVERSATION);
    store.prepare('DELETE FROM session_message WHERE session_id = ?').run(CONVERSATION);
    store.close();
    const refused = await (await post('/api/restore', {names: ['oc2-main']})).json() as {results: Record<string, {ok: boolean; error?: string}>};
    assert.equal(refused.results['oc2-main'].ok, false);
    assert.match(refused.results['oc2-main'].error!, /would start an empty conversation/);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(lines('argv.log').length, before, 'nothing was launched');
    const back = createStoreV2Rows(storeFile);
    back.close();
    const restored = await post('/api/restore', {names: ['oc2-main']});
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal(((await restored.json()) as {results: Record<string, {ok: boolean}>}).results['oc2-main'].ok, true);
    await until('the restored opencode', () => lines('argv.log').length > before);
    // The fake writes argv before its token. Wait for that independent write before the next test scans it.
    await until('the restored opencode token', () => lines('token.log').length > tokensBefore);
    assert.equal(lines('argv.log')[before], `argv:--standalone --session ${CONVERSATION}`);
    assert.match(lines('config.log')[before], /"mesh-board"/);
    assert.match(lines('config.log')[before], /"plugins"/);
  });

  test('no session token is written to any file of the instance after the launches and the resume', () => {
    const tokens = [...new Set(lines('token.log'))];
    assert.ok(tokens.length >= 3 && tokens.every(token => /^ms1\./.test(token)), 'the tokens of the launches and the resume');
    const needles = tokens.flatMap(token => [Buffer.from(token), Buffer.from(token.split('.')[3])]);
    let scanned = 0;
    for (const root of [mesh.home, mesh.confDir, dataHome]) {
      for (const entry of fs.readdirSync(root, {recursive: true, withFileTypes: true})) {
        if (!entry.isFile()) continue;
        const file = path.join(entry.parentPath, entry.name);
        const content = fs.readFileSync(file);
        scanned += 1;
        for (const needle of needles) assert.ok(!content.includes(needle), `a session token is in ${file}`);
      }
    }
    assert.ok(scanned > 3, `the scan looked at ${scanned} files`);
  });
});

/** Puts the conversation back into OpenCode 2's store (the file already has its tables). */
function createStoreV2Rows(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  addConversationV2(db, CONVERSATION, fs.realpathSync(mesh.home), {updated: Date.now() - 3_600_000});
  return db;
}

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}
