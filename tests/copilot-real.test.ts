// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The real `copilot` binary in the mesh, without a GitHub account or a network: the model is a local fake
// OpenAI-compatible server (BYOK, COPILOT_OFFLINE), COPILOT_HOME is a temporary directory, and the board bridge is the
// real mesh-board-mcp when MESH_BOARD_BRIDGE names it. Nothing of the caller's Copilot configuration is read or copied.
// Skipped when there is no `copilot` on PATH or no bridge. A real PTY host (MESH_PTYHOST_CMD for the native one),
// server.py and the real Mesh plugin hooks.
// Covered: the board tools the model is offered, mail.peers / mail.inbox / owner-approved read through the real
// bridge, the state the hooks report from the real TUI (working, permission prompt, idle), the wake notice typed into
// the real prompt, the restore after a PTY host restart (the earlier conversation is back), and a stricter user
// setting (disabledMcpServers) that keeps the board out.
import assert from 'node:assert/strict';
import {approveMail} from './helpers/agent-mail-mesh.ts';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {FakeProvider, type ChatRequest, type StaticReply} from './helpers/fake-copilot-provider.ts';
import {type Attachment, attach} from './ptyhost-wire-lib.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';

const BRIDGE = process.env.MESH_BOARD_BRIDGE ?? '';
const REAL = (() => {
  try { return execFileSync('which', ['copilot'], {encoding: 'utf8'}).trim(); } catch { return ''; }
})();
const skip = !REAL ? 'no copilot on PATH' : !BRIDGE || !fs.existsSync(BRIDGE) ? 'MESH_BOARD_BRIDGE not set' : false;

let mesh: Mesh;
let scratch: string;
let copilotHome: string;
let host: ChildProcess | undefined;
let pathEnv: string;
const provider = new FakeProvider();
const attached = new Map<string, Attachment>();
const log = (file: string) => path.join(scratch, file);
const lines = (file: string): string[] =>
  fs.existsSync(log(file)) ? fs.readFileSync(log(file), 'utf8').split('\n').filter(Boolean) : [];
const socketPath = () => path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');

function startHost(): ChildProcess {
  const argv = nativePtyhost();
  return spawn(argv[0], argv.slice(1), {cwd: REPO, stdio: 'ignore',
    env: {PATH: pathEnv, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C.UTF-8'}});
}

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, seconds = 40): Promise<T> {
  for (let attempt = 0; attempt < seconds * 10; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  if (skip) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-real-'));
  copilotHome = path.join(scratch, 'copilot-home');
  fs.mkdirSync(copilotHome);
  await provider.start();
  const meshBin = path.join(scratch, 'meshbin');
  const shim = path.join(scratch, 'shim');
  fs.mkdirSync(meshBin);
  fs.mkdirSync(shim);
  fs.symlinkSync(BRIDGE, path.join(meshBin, 'mesh-board-mcp'));
  fs.symlinkSync(path.join(REPO, 'bin', 'mesh-event'), path.join(meshBin, 'mesh-event'));
  // ptyhost forwards only a few variable names to a session: the shim sets the isolated Copilot environment and runs the
  // real binary in place (exec), so the process the mesh sees is the real one. It records the session's identity.
  fs.writeFileSync(path.join(shim, 'copilot'), `#!/bin/sh
printf '%s %s\\n' "$MESH_SESSION" "$MESH_SESSION_TOKEN" >> '${log('tokens.log')}'
export COPILOT_HOME='${copilotHome}' COPILOT_OFFLINE=true COPILOT_MODEL=fake COPILOT_TELEMETRY_DISABLED=true
export COPILOT_PROVIDER_BASE_URL='${provider.baseUrl}' COPILOT_PROVIDER_TYPE=openai COPILOT_PROVIDER_API_KEY=unused
exec '${REAL}' --no-auto-update "$@"
`, {mode: 0o755});
  pathEnv = `${shim}:${process.env.PATH}`;
  mesh = await startMesh('copilot-real-', {PATH: pathEnv, MESH_BIN_DIR: meshBin});
  // The folder the sessions start in is trusted, as an owner would answer the first-launch question.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({trustedFolders: [mesh.home]}));
  host = startHost();
  await until('the PTY host', () => fs.existsSync(socketPath()));
});

after(async () => {
  for (const attachment of attached.values()) attachment.close();
  host?.kill('SIGKILL');
  await mesh?.stop();
  await provider.stop();
  // No process of the run may survive.
  if (scratch) {
    killLeftovers();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

/** Kill what the run started and left (they all carry the run's directory in their command line); returns how many. */
function killLeftovers(): number {
  let pids: number[] = [];
  try {
    pids = execFileSync('pgrep', ['-f', scratch], {encoding: 'utf8'}).split('\n').filter(Boolean).map(Number)
      .filter(pid => pid !== process.pid && pid !== process.ppid);
  } catch { /* pgrep exits 1 when nothing matches */ }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  return pids.length;
}

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
const post = (route: string, body: unknown) =>
  fetch(`${mesh.base}${route}`, {method: 'POST', headers: headers(), body: JSON.stringify(body)});
type Agent = {type: string; status?: string; session_id?: string; waiting_for?: string};
async function agentOf(name: string): Promise<Agent | null | undefined> {
  const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as {mesh: {id: string; agent: Agent | null}[]};
  return data.mesh.find(item => item.id === name)?.agent;
}
const plain = (raw: string) => raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function open(name: string): Promise<Attachment> {
  const found = attached.get(name) ?? await attach(socketPath(), name);
  attached.set(name, found);
  return found;
}

/** Type a prompt the way the page does: the text, then Enter. */
async function type(name: string, text: string): Promise<void> {
  const terminal = await open(name);
  terminal.send('D', Buffer.from(text));
  await new Promise(resolve => setTimeout(resolve, 400));
  terminal.send('D', Buffer.from('\r'));
}

/** Wait for a permission prompt of the real TUI, answer "Yes" (the first choice), and say that it was there. */
async function approve(name: string): Promise<void> {
  const terminal = await open(name);
  await until(`a permission prompt in ${name}`, () => /Do you want|Allow this|permission/i.test(plain(terminal.output()).slice(-3000)));
  terminal.frames.length = 0;
  terminal.send('D', Buffer.from('\r'));
}

async function launch(name: string): Promise<void> {
  const response = await post('/api/new', {preset: 'copilot', cwd: mesh.home, name});
  assert.equal(response.status, 200, await response.clone().text());
  const terminal = await open(name);
  await until(`the Copilot TUI of ${name}`, () => /\/ commands|Copilot v/.test(plain(terminal.output())), 60)
    .catch(error => { throw new Error(`${error.message}; the terminal shows: ${plain(terminal.output()).slice(-1500)}`); });
  await new Promise(resolve => setTimeout(resolve, 1500));   // the first keystrokes of a starting TUI are lost
}

const toolMessage = (request: ChatRequest): string => {
  const last = [...request.messages].reverse().find(message => message.role === 'tool');
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
};
const tool = (name: string, args: unknown): StaticReply => ({tool: name, args});
const mail = (action: string, args?: object): StaticReply =>
  tool('mesh-board-mail', args ? {action, arguments: args} : {action});

describe('the real Copilot CLI in the mesh', {skip}, () => {
  test('the model is offered the board tools; mail.peers and mail.inbox answer through the real bridge', async () => {
    await launch('rc-main');
    provider.reset();
    provider.enqueue(mail('peers'), {text: 'peers-done'});
    await type('rc-main', 'list my peers');
    // MCP tools may ask for the user's permission first.
    const result = await until('the peers result sent back to the model', async () => {
      const prompt = plain((await open('rc-main')).output()).slice(-3000);
      if (/Do you want/.test(prompt)) { await approve('rc-main'); }
      return provider.requests.length >= 2 ? provider.requests.at(-1) : undefined;
    }, 60);
    const names = provider.toolNames();
    for (const wanted of ['mesh-board-whiteboard', 'mesh-board-demo', 'mesh-board-mail', 'mesh-board-session', 'mesh-board-control', 'mesh-board-agent_guide_read']) {
      assert.ok(names.includes(wanted), `${wanted} is offered (${names.filter(n => n.startsWith('mesh')).join(',')})`);
    }
    // The bridge appends the JSON to the text block: the model sees the peers list, not only the summary.
    assert.match(toolMessage(result), /\{"/, 'the structured result reached the model');
    assert.ok(!/ms1\./.test(JSON.stringify(provider.requests)), 'the session token never reaches the model');
  });

  test('the hooks of the real TUI report working, a permission prompt and the end of a turn with the conversation', async () => {
    provider.enqueue(tool('bash', {command: 'touch made-by-copilot.txt', description: 'make a file', mode: 'sync'}), {text: 'file-done'});
    await type('rc-main', 'make a file');
    await until('a permission wait reported', async () => (await agentOf('rc-main'))?.waiting_for === 'permission prompt');
    assert.equal((await agentOf('rc-main'))?.status, 'waiting');
    await approve('rc-main');
    const idle = await until('idle again with the conversation', async () => {
      const agent = await agentOf('rc-main');
      return agent?.status === 'idle' && agent.session_id ? agent : undefined;
    });
    assert.match(idle.session_id!, /^[0-9a-f-]{36}$/);
    assert.equal(idle.type, 'copilot');
    assert.ok(fs.existsSync(path.join(mesh.home, 'made-by-copilot.txt')), 'the approved tool ran');
  });

  test('a message from a peer waits in the inbox (no wake notice), and is read after the user agrees', async () => {
    await launch('rc-peer');
    const peerToken = lines('tokens.log').find(line => line.startsWith('rc-peer '))!.split(' ')[1];
    const overview = await (await fetch(`${mesh.base}/api/agent-mail/overview`, {
      headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json() as {sessions: {identity: {id: string; created: number}}[]};
    const created = overview.sessions.find(item => item.identity.id === 'rc-main')!.identity.created;
    provider.reset();
    provider.enqueue(
      mail('inbox'),
      request => mail('read', {message_id: (/"id":"([^"]+)"/.exec(toolMessage(request)) ?? [])[1] ?? 'none'}),
      {text: 'read-it'});
    const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', body: JSON.stringify({
      target: 'rc-main', target_created: created, kind: 'message', text: 'hello-from-peer'}),
    headers: {Authorization: `MeshSession ${peerToken}`, 'Content-Type': 'application/json'}});
    assert.equal(sent.status, 200, await sent.clone().text());
    await approveMail(mesh.base, `mesh_auth=${await ownerCookie()}`, sent);
    // No notice is ever typed into Copilot (it can enter autopilot without any change to its arguments, and what its
    // end-of-turn hook means there is unobserved): the message waits in the inbox until the user tells Copilot to look.
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.ok(!provider.requests.some(request => JSON.stringify(request.messages).includes('# Mesh: new message')),
      'no wake notice reached the model');
    await type('rc-main', 'check your inbox');
    await until('the message text reaching the model', async () => {
      const prompt = plain((await open('rc-main')).output()).slice(-3000);
      if (/Do you want/.test(prompt)) { await approve('rc-main'); }
      return provider.requests.some(request => toolMessage(request).includes('hello-from-peer'));
    }, 60);
  });

  test('after a PTY host restart the conversation is restored with --resume and the model sees the earlier turns', async () => {
    const before = await agentOf('rc-main');
    assert.ok(before?.session_id);
    for (const terminal of attached.values()) terminal.close();
    attached.clear();
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    killLeftovers();
    fs.rmSync(socketPath(), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(socketPath()));
    await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as {restorable: {name: string; resumable: boolean}[]};
      return data.restorable.find(item => item.name === 'rc-main' && item.resumable);
    });
    const restored = await post('/api/restore', {names: ['rc-main']});
    assert.equal(restored.status, 200, await restored.clone().text());
    await until('the restored TUI', async () => /\/ commands|Copilot v/.test(plain((await open('rc-main')).output())), 60);
    await new Promise(resolve => setTimeout(resolve, 1500));
    provider.reset();
    provider.enqueue({text: 'resumed-ok'});
    await type('rc-main', 'what did I ask first?');
    await until('a request after the restore', () => provider.requests.length > 0, 30).catch(async error => {
      throw new Error(`${error.message}; the terminal shows: ${plain((await open('rc-main')).output()).slice(-1500)}`);
    });
    assert.ok(JSON.stringify(provider.requests[0].messages).includes('list my peers'), 'the first prompt of the conversation is in the context');
    const after = await until('the conversation named again', async () => (await agentOf('rc-main'))?.session_id === before.session_id && true);
    assert.ok(after);
  });

  test("a user's disabledMcpServers keeps the board out of a Mesh launch", async () => {
    fs.writeFileSync(path.join(copilotHome, 'settings.json'), JSON.stringify({disabledMcpServers: ['mesh-board']}));
    await launch('rc-strict');
    provider.reset();
    provider.enqueue({text: 'plain-answer'});
    await type('rc-strict', 'hello');
    await until('a request', () => provider.requests.length > 0, 60);
    assert.deepEqual(provider.toolNames().filter(name => name.startsWith('mesh-board')), []);
    fs.rmSync(path.join(copilotHome, 'settings.json'));
  });
});

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}
