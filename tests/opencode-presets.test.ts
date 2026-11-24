// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// OpenCode in the mesh without a model: a fake `opencode` on PATH records its argv, its environment and what is
// typed into it, and the real Mesh OpenCode plugin reports hook events to a real server and PTY host.
// Covered: launch from "+ New" with the board server and plugin injected through OPENCODE_CONFIG_CONTENT
// (no credential in it), the state and conversation the plugin reports, the wake notice typed only while
// idle, and the restore of the conversation after a PTY host restart.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {addConversation, createStore} from './helpers/opencode-store.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {approveMail} from './helpers/agent-mail-mesh.ts';

const CONVERSATION = 'ses_e1ec1ceb2ffeve47ULriArjJ5g';
const OTHER_CONVERSATION = 'ses_openedlaterconversation1';
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
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode-'));
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode-data-'));
  const bin = path.join(fakes, 'bin');
  const meshBin = path.join(fakes, 'meshbin');
  fs.mkdirSync(bin);
  fs.mkdirSync(meshBin);
  // The board bridge only has to exist and be executable: this test never talks MCP.
  fs.writeFileSync(path.join(meshBin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  // The mesh reads the version before it launches (1.x and 2.x): the probe is not a launch and is not logged.
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh
[ "$1" = "--version" ] && { echo 1.18.35; exit 0; }
printf 'argv:%s\\n' "$*" >> '${log('argv.log')}'
printf '%s\\n' "$OPENCODE_CONFIG_CONTENT" >> '${log('config.log')}'
printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('session.log')}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('input.log')}'; done
`, {mode: 0o755});
  pathEnv = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('opencode-presets-', {PATH: pathEnv, MESH_BIN_DIR: meshBin, OPENCODE_API_KEY: MARKER,
    XDG_DATA_HOME: dataHome});
  // OpenCode's own store, where Mesh reads the conversation a process was started with (--session).
  fs.mkdirSync(path.join(dataHome, 'opencode'));
  const store = createStore(path.join(dataHome, 'opencode', 'opencode.db'));
  addConversation(store, CONVERSATION, fs.realpathSync(mesh.home), {open: false, updated: Date.now() - 3_600_000});
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

type Listed = {mesh: {id: string; known_agent: string | null; agent: {type: string; status?: string; session_id?: string} | null}[]};
async function listing(): Promise<Listed> {
  return await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as Listed;
}

async function launch(name: string): Promise<void> {
  const before = lines('session.log').length;
  const response = await post('/api/new', {preset: 'opencode', cwd: mesh.home, name});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake opencode of ${name}`, () => lines('session.log').length > before);
}

/** Events through the real plugin, with the session token the fake received. */
function report(name: string, events: unknown[], extraEnv: NodeJS.ProcessEnv = {}): void {
  const index = lines('session.log').lastIndexOf(name);
  assert.ok(index >= 0, `no launch recorded for ${name}`);
  execFileSync(process.execPath, ['--experimental-strip-types', 'tests/helpers/opencode-plugin-driver.ts',
    JSON.stringify(events)], {cwd: REPO, stdio: 'pipe', env: {
    PATH: process.env.PATH, HOME: mesh.home, MESH_PORT: String(mesh.port),
    MESH_SESSION_TOKEN: lines('token.log')[index], ...extraEnv}});
}

const status = (id: string, type: string) => ({type: 'session.status', properties: {sessionID: CONVERSATION, status: {type}}});

describe('OpenCode preset', () => {
  test('launches bare, as the agent opencode, with the board server and plugin in the environment only', async () => {
    await launch('oc-main');
    assert.equal(lines('argv.log')[0], 'argv:');
    const config = JSON.parse(lines('config.log')[0]);
    assert.deepEqual(Object.keys(config).sort(), ['mcp', 'plugin']);
    assert.deepEqual(config.mcp['mesh-board'], {type: 'local', command: [path.join(fakes, 'meshbin', 'mesh-board-mcp')],
      environment: {MESH_CONF_DIR: mesh.confDir, MESH_PORT: String(mesh.port)}});
    assert.equal(config.plugin.length, 1);
    assert.match(config.plugin[0], /^file:\/\/\/.*\/opencode-mesh-plugin\.ts$/);
    const token = lines('token.log')[0];
    assert.match(token, /^ms1\./);
    assert.ok(!lines('config.log')[0].includes(token), 'the session token is not written in the configuration');
    assert.ok(!lines('config.log')[0].includes(MARKER), 'no ambient credential is copied into the configuration');
    const mine = (await listing()).mesh.find(item => item.id === 'oc-main');
    assert.equal(mine?.known_agent, 'opencode');
  });

  test('the plugin reports working, a question, and the end of a turn with the conversation', async () => {
    report('oc-main', [status('', 'busy')]);
    const working = await until('a working state', async () =>
      (await listing()).mesh.find(item => item.id === 'oc-main')?.agent?.status === 'busy');
    assert.ok(working);
    report('oc-main', [{type: 'question.asked', properties: {sessionID: CONVERSATION}}]);
    await until('a waiting state', async () => {
      const agent = (await listing()).mesh.find(item => item.id === 'oc-main')?.agent as {waiting_for?: string} | null;
      return agent?.waiting_for === 'input needed';
    });
    report('oc-main', [status('', 'idle')]);
    const idle = await until('an idle state', async () => {
      const agent = (await listing()).mesh.find(item => item.id === 'oc-main')?.agent;
      return agent?.status === 'idle' ? agent : undefined;
    });
    assert.equal(idle.session_id, CONVERSATION);
    assert.equal(idle.type, 'opencode');
  });

  test('the plugin ignores a proxy environment: the token goes to the local mesh only', async () => {
    report('oc-main', [status('', 'busy')], {HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9'});
    await until('a working state through a dead proxy', async () =>
      (await listing()).mesh.find(item => item.id === 'oc-main')?.agent?.status === 'busy');
    report('oc-main', [status('', 'idle')]);
    await until('idle again', async () => (await listing()).mesh.find(item => item.id === 'oc-main')?.agent?.status === 'idle');
  });

  test('a wake notice is typed only once OpenCode has reported the end of a turn', async () => {
    await launch('oc-peer');
    const target = (await listing()).mesh.find(item => item.id === 'oc-main');
    assert.ok(target);
    const created = ((await (await fetch(`${mesh.base}/api/agent-mail/overview`, {
      headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json()) as
      {sessions: {identity: {id: string; created: number}}[]}).sessions.find(item => item.identity.id === 'oc-main')!.identity.created;
    report('oc-main', [status('', 'busy')]);
    await until('working', async () => (await listing()).mesh.find(item => item.id === 'oc-main')?.agent?.status === 'busy');
    const peerToken = lines('token.log')[lines('session.log').lastIndexOf('oc-peer')];
    const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', body: JSON.stringify({
      target: 'oc-main', target_created: created, kind: 'message', text: 'hello'}),
    headers: {Authorization: `MeshSession ${peerToken}`, 'Content-Type': 'application/json'}});
    assert.equal(sent.status, 200, await sent.clone().text());
    await approveMail(mesh.base, `mesh_auth=${await ownerCookie()}`, sent);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(lines('input.log'), [], 'nothing is typed while a turn runs');
    report('oc-main', [status('', 'idle')]);
    const typed = await until('the notice', () => lines('input.log').find(line => line.startsWith('# Mesh: new message')));
    assert.match(typed, /mail\.inbox/);
  });

  test('after a PTY host restart the conversation is restored with --session and the board again', async () => {
    const identity = (await listing()).mesh.find(item => item.id === 'oc-main')?.agent;
    assert.equal(identity?.session_id, CONVERSATION);
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const restorable = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'oc-main');
    });
    assert.deepEqual([restorable.agent, restorable.resumable], ['opencode', true]);
    const before = lines('argv.log').length;
    const restored = await post('/api/restore', {names: ['oc-main']});
    assert.equal(restored.status, 200, await restored.clone().text());
    await until('the restored opencode', () => lines('argv.log').length > before);
    assert.equal(lines('argv.log')[before], `argv:--session ${CONVERSATION}`);
    assert.match(lines('config.log')[before], /"mesh-board"/);
  });

  test('a conversation opened after a restore replaces the one the process was started with', async () => {
    const name = lines('session.log').at(-1)!;
    const identity = await until('the restored conversation read from --session', async () => {
      const agent = (await listing()).mesh.find(item => item.id === name)?.agent;
      return agent?.session_id === CONVERSATION ? agent : undefined;
    });
    assert.equal((identity as {identity_source?: string}).identity_source, 'argv_session');
    report(name, [{type: 'session.status', properties: {sessionID: OTHER_CONVERSATION, status: {type: 'busy'}}}]);
    const moved = await until('the conversation the plugin declared', async () => {
      const agent = (await listing()).mesh.find(item => item.id === name)?.agent;
      return agent?.session_id === OTHER_CONVERSATION ? agent : undefined;
    });
    assert.equal((moved as {identity_source?: string}).identity_source, 'opencode_hook');
  });

  test('a late event numbered before the end of the turn does not leave OpenCode busy', async () => {
    const name = lines('session.log').at(-1)!;
    const token = lines('token.log')[lines('session.log').lastIndexOf(name)];
    const send = (type: string, seq: number) => fetch(`${mesh.base}/api/event`, {method: 'POST', body: JSON.stringify({
      type, at: Date.now() / 1000 - 1, detail: {source: 'opencode', hook: 'session.status', seq}}),
    headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'}});
    const base = Date.now() + 1_000_000;
    assert.deepEqual(await (await send('working', base)).json(), {ok: true, applied: true});
    assert.deepEqual(await (await send('done', base + 2)).json(), {ok: true, applied: true});
    // The working event of the turn that just ended arrives last, after its done.
    assert.deepEqual(await (await send('working', base + 1)).json(), {ok: true, applied: false, reason: 'stale'});
    const agent = (await listing()).mesh.find(item => item.id === name)?.agent;
    assert.equal(agent?.status, 'idle');
    assert.deepEqual(await (await send('working', base + 3)).json(), {ok: true, applied: true}, 'a newer one still applies');
  });

  test('no session token is written to any file of the instance after a launch and a resume', () => {
    const tokens = [...new Set(lines('token.log'))];
    assert.ok(tokens.length >= 3 && tokens.every(token => /^ms1\./.test(token)), 'the tokens of the launches and the resume');
    // The home (with the mesh configuration directory and the PTY host's runtime files) and OpenCode's data directory.
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

describe('an unsupported OpenCode major is launched bare', () => {
  test('no configuration, no session token in the agent, a notice, no state and no restorable conversation', async () => {
    const fake = path.join(fakes, 'bin', 'opencode');
    fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace('echo 1.18.35', 'echo opencode v3.0.1'), {mode: 0o755});
    const configs = lines('config.log').length, tokens = lines('token.log').length, argv = lines('argv.log').length;
    await launch('oc-v2');
    // The fake logs one line per launch, an empty one (dropped by lines) for a variable that is not set.
    assert.equal(lines('argv.log').length, argv + 1);
    assert.equal(lines('argv.log').at(-1), 'argv:');
    assert.equal(lines('config.log').length, configs, 'no OPENCODE_CONFIG_CONTENT');
    assert.equal(lines('token.log').length, tokens, 'MESH_SESSION_TOKEN is not inherited by the agent');
    const mine = (await listing()).mesh.find(item => item.id === 'oc-v2') as unknown as
      {known_agent: string | null; agent: unknown; notice: string | null};
    assert.equal(mine.known_agent, 'opencode');
    assert.equal(mine.notice, 'opencode-unsupported');
    assert.equal(mine.agent, null, 'no state and no conversation are claimed');
  });
});

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}
