// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The mailbox of an OpenCode 2 session, through the REAL board bridge (MESH_BOARD_MCP_BIN: the built mesh-board-mcp)
// and the REAL OpenCode 2 binary (MESH_OPENCODE_V2_BIN) with a scripted provider. Two sessions are started in a real
// mesh (a fake opencode answering like 2.x stands in for the process in the terminal, which gives each its token and
// the configuration the mesh injected); the real OpenCode then runs as each of them, with that token and that
// configuration. Covered, as the protocol asks: a message sent from one agent, listed by `agent_inbox`, read only
// after the user's consent, answered; all through OpenCode 2's single `execute` tool. Skipped without both binaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REAL_BINARY, RealOpencode, skipReal} from './helpers/opencode-v2-real.ts';
import {type Mesh, REPO, startMesh} from './mesh-server-lib.ts';
import {type ChildProcess, spawn} from 'node:child_process';
import {nativePtyhost} from './helpers/native-ptyhost.ts';

const BRIDGE = process.env.MESH_BOARD_MCP_BIN ?? '';
const skip = skipReal || (BRIDGE && fs.existsSync(BRIDGE) ? false : 'MESH_BOARD_MCP_BIN not set');
const SECRET = 'mailbox-secret-text-7f3a';
const oc = new RealOpencode();
let mesh: Mesh;
let fakes: string;
let host: ChildProcess | undefined;
const log = (file: string) => path.join(fakes, file);
const lines = (file: string): string[] =>
  fs.existsSync(log(file)) ? fs.readFileSync(log(file), 'utf8').split('\n').filter(Boolean) : [];

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  if (skip) return;
  await oc.start();
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'oc2-mailbox-'));
  const bin = path.join(fakes, 'bin');
  const meshBin = path.join(fakes, 'meshbin');
  fs.mkdirSync(bin);
  fs.mkdirSync(meshBin);
  fs.symlinkSync(BRIDGE, path.join(meshBin, 'mesh-board-mcp'));
  // Version and configuration probes go to the real binary; a launch is recorded and idles.
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh
case "$1" in --version|debug) exec '${REAL_BINARY}' "$@";; esac
printf '%s\\n' "$OPENCODE_CONFIG_CONTENT" >> '${log('config.log')}'
printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('session.log')}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('input.log')}'; done
`, {mode: 0o755});
  const pathEnv = `${bin}:${oc.env().PATH}`;
  mesh = await startMesh('opencode-v2-mailbox-', {PATH: pathEnv, MESH_BIN_DIR: meshBin, ...{
    XDG_CONFIG_HOME: undefined}});
  const argv = nativePtyhost();
  host = spawn(argv[0], argv.slice(1), {cwd: REPO, stdio: 'ignore',
    env: {PATH: pathEnv, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C'}});
  await until('the PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  await oc.stop();
  if (fakes) fs.rmSync(fakes, {recursive: true, force: true});
});

const ownerHeaders = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}
const ownerGet = async (route: string) => (await fetch(`${mesh.base}${route}`, {
  headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json() as Promise<any>;

async function launch(name: string): Promise<void> {
  const before = lines('session.log').length;
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', headers: ownerHeaders(),
    body: JSON.stringify({preset: 'opencode', cwd: mesh.home, name})});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake opencode of ${name}`, () => lines('session.log').length > before);
}

/** The real OpenCode 2 running as the session `name`: its token, the configuration the mesh injected for it. */
function runAs(name: string, prompt: string) {
  const index = lines('session.log').lastIndexOf(name);
  const config = JSON.parse(lines('config.log')[index]);
  return oc.run(prompt, config, {MESH_SESSION: name, MESH_SESSION_TOKEN: lines('token.log')[index], MESH_PORT: String(mesh.port)});
}
const tool = (name: string, args: object) => `await tools["mesh-board"]["${name}"](${JSON.stringify(args)})`;
const execute = (code: string) => `go [[execute: ${code}]]`;

describe('the mailbox of OpenCode 2 through the real bridge', {skip}, () => {
  let created: number;
  let messageId: string;

  test('the peers are listed through `execute`', async () => {
    await launch('mail-a');
    await launch('mail-b');
    const result = await runAs('mail-b', execute('const r = await tools["mesh-board"]["agent_peers"](); console.log(JSON.stringify(r));'));
    assert.equal(result.code, 0, result.stderr);
    const seen = result.texts.join('\n');
    assert.match(seen, /mail-a/, `the model saw the peer list: ${seen.slice(0, 400)}`);
    created = ((await ownerGet('/api/agent-mail/overview')) as {sessions: {identity: {id: string; created: number}}[]})
      .sessions.find(item => item.identity.id === 'mail-a')!.identity.created;
  });

  test('a message sent from the other agent is listed by agent_inbox, and its text is not in the listing', async () => {
    const sent = await runAs('mail-b', execute(`const r = ${tool('agent_message_send', {target: 'mail-a', target_created: created, kind: 'message', text: SECRET})}; console.log(JSON.stringify(r));`));
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.texts.join('\n'), /deposited|receipt|message_id|id/i, sent.texts.join('\n').slice(0, 300));
    const listing = await runAs('mail-a', execute('const r = await tools["mesh-board"]["agent_inbox"](); console.log(JSON.stringify(r));'));
    assert.equal(listing.code, 0, listing.stderr);
    const seen = listing.texts.join('\n');
    assert.match(seen, /mail-b/, `the model saw the inbox: ${seen.slice(0, 500)}`);
    assert.ok(!seen.includes(SECRET), 'the inbox listing never carries the message text');
    messageId = /"message_id":\s*"([^"]+)"|"id":\s*"([^"]+)"/.exec(seen)?.slice(1).find(Boolean) as string;
    assert.ok(messageId, `a message id in ${seen.slice(0, 500)}`);
  });

  test('reading raises the user\'s approval request; after "yes" the text is returned, and a reply works', async () => {
    const pending = await runAs('mail-a', execute(`const r = ${tool('agent_message_read', {message_id: messageId})}; console.log(JSON.stringify(r));`));
    assert.equal(pending.code, 0, pending.stderr);
    assert.ok(!pending.texts.join('\n').includes(SECRET), 'no text while approval is pending');
    const consent = await until('the user\'s approval request', async () => {
      const projection = await ownerGet('/api/agent-mail/consent');
      return (projection.pending ?? projection.requests ?? [])[0] as {id?: string; request_id?: string} | undefined;
    });
    const requestId = (consent.id ?? consent.request_id)!;
    const decided = await fetch(`${mesh.base}/api/agent-mail/consent/${requestId}/decision`, {method: 'POST',
      headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({decision: 'yes'})});
    assert.equal(decided.status, 200, await decided.clone().text());
    const opened = await runAs('mail-a', execute(`const r = ${tool('agent_message_read', {message_id: messageId})}; console.log(JSON.stringify(r));`));
    assert.ok(opened.texts.join('\n').includes(SECRET), `the text after approval: ${opened.texts.join('\n').slice(0, 400)}`);
    const reply = await runAs('mail-a', execute(`const r = ${tool('agent_message_reply', {message_id: messageId, kind: 'message', text: 'reply-from-a'})}; console.log(JSON.stringify(r));`));
    assert.equal(reply.code, 0, reply.stderr);
    const back = await runAs('mail-b', execute('const r = await tools["mesh-board"]["agent_inbox"](); console.log(JSON.stringify(r));'));
    assert.match(back.texts.join('\n'), /mail-a/, 'the reply reached the sender\'s inbox');
  });

  test('the message text never reached a terminal', () => {
    assert.ok(!lines('input.log').some(line => line.includes(SECRET)), 'nothing typed into either terminal carries the text');
  });
});
