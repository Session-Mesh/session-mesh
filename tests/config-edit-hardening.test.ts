// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Review fixes for the editable launch settings: body reading, odd folder names, the failure counter,
// the elevation re-check, protected folders, a disabled agent's pending request, and the elevation's
// binding to the owner cookie. Throwaway server and PTY host; the real mesh is never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

let mesh: ConfigMesh;
const spare: ConfigMesh[] = [];
const initial = (where: string) => ({v: 1 as const, workspace_roots: [path.join(where, 'work')], enabled_agents: ['claude', 'codex']});

before(async () => {
  mesh = await ConfigMesh.start('cfh-', initial);
  assert.equal((await mesh.elevate()).status, 200);
});
after(async () => {
  await mesh?.stop();
  for (const other of spare) await other.stop();
});

async function fresh(prefix: string): Promise<ConfigMesh> {
  const other = await ConfigMesh.start(prefix, initial);
  spare.push(other);
  return other;
}

type Raw = {status: number; text: string};

/** One HTTP request over a raw socket, the body sent in the given pieces with a pause between them. */
async function rawPost(target: ConfigMesh, route: string, headers: Record<string, string>, pieces: string[],
  options: {chunked?: boolean; gapMs?: number; between?: () => Promise<void>} = {}): Promise<Raw> {
  const body = pieces.join('');
  const lines = [`POST ${route} HTTP/1.1`, `Host: 127.0.0.1:${target.port}`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    options.chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close'];
  const socket = net.connect(target.port, '127.0.0.1');
  let data = '';
  socket.on('data', chunk => { data += chunk; });
  socket.on('error', () => undefined);           // the server may answer 413 and close while we still write
  const closed = new Promise(resolve => socket.on('close', resolve));
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  for (const [index, piece] of pieces.entries()) {
    if (index > 0) {
      await new Promise(resolve => setTimeout(resolve, options.gapMs ?? 150));
      if (index === 1 && options.between) await options.between();
    }
    if (socket.destroyed) break;
    socket.write(options.chunked ? `${Buffer.byteLength(piece).toString(16)}\r\n${piece}\r\n` : piece);
  }
  if (options.chunked && !socket.destroyed) socket.write('0\r\n\r\n');
  await closed;
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
  return {status, text: data.slice(data.indexOf('\r\n\r\n') + 4)};
}

const headersOf = (target: ConfigMesh, elevated = true) => target.owner(elevated);
const saveBody = async (target: ConfigMesh, work: string, agents = ['claude']) =>
  JSON.stringify({revision: await target.revision(), enabled_agents: agents, workspace_roots: [work]});

describe('reading the body', () => {
  test('a valid body sent in several writes is accepted', async () => {
    const body = await saveBody(mesh, path.join(mesh.home, 'work2'));
    const cut = [body.slice(0, 15), body.slice(15, 60), body.slice(60)];
    const reply = await rawPost(mesh, '/api/config/launch', headersOf(mesh), cut);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(mesh.file().workspace_roots, [path.join(mesh.home, 'work2')]);
  });

  test('a declared length over the limit is 413 whatever is sent, and nothing is written', async () => {
    const before = fs.readFileSync(mesh.settingsPath, 'utf8');
    const big = JSON.stringify({revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: ['/' + 'a'.repeat(40000)]});
    assert.equal((await rawPost(mesh, '/api/config/launch', headersOf(mesh), [big])).status, 413, 'one write');
    const pieces = [big.slice(0, 10000), big.slice(10000, 25000), big.slice(25000)];
    assert.equal((await rawPost(mesh, '/api/config/launch', headersOf(mesh), pieces)).status, 413, 'several writes');
    assert.equal((await mesh.post('/api/config/launch', big)).status, 413, 'fetch');
    assert.equal(fs.readFileSync(mesh.settingsPath, 'utf8'), before);
  });

  test('a body with no declared length (chunked) over the limit is 413 too, and under it is accepted', async () => {
    const big = JSON.stringify({revision: await mesh.revision(), enabled_agents: ['claude'], workspace_roots: ['/' + 'a'.repeat(40000)]});
    const pieces = [big.slice(0, 20000), big.slice(20000)];
    assert.equal((await rawPost(mesh, '/api/config/launch', headersOf(mesh), pieces, {chunked: true})).status, 413);
    const small = await saveBody(mesh, path.join(mesh.home, 'work'));
    const accepted = await rawPost(mesh, '/api/config/launch', headersOf(mesh), [small.slice(0, 30), small.slice(30)], {chunked: true});
    assert.equal(accepted.status, 200, accepted.text);
  });

  test('/elevate keeps its 4 KiB limit, split or not', async () => {
    const big = JSON.stringify({token: 'x'.repeat(5000)});
    const owner = headersOf(mesh, false);
    assert.equal((await rawPost(mesh, '/api/config/elevate', owner, [big])).status, 413);
    assert.equal((await rawPost(mesh, '/api/config/elevate', owner, [big.slice(0, 100), big.slice(100)])).status, 413);
    const ok = JSON.stringify({token: mesh.token()});
    assert.equal((await rawPost(mesh, '/api/config/elevate', owner, [ok.slice(0, 7), ok.slice(7)])).status, 200);
  });

  test('/revoke is JSON only, like the other two, and takes an empty object', async () => {
    const owner = headersOf(mesh, false);
    assert.equal((await mesh.post('/api/config/elevate/revoke', 'x', {...owner, 'Content-Type': 'text/plain'})).status, 415);
    assert.equal((await mesh.post('/api/config/elevate/revoke', '{"a":1}', owner)).status, 400);
    assert.equal((await mesh.post('/api/config/elevate/revoke', {}, owner)).status, 200);
    assert.equal((await mesh.elevate()).status, 200);
  });
});

describe('folders that cannot be named', () => {
  test('a NUL byte or a lone surrogate is a 400 "invalid", never a 500', async () => {
    const work = path.join(mesh.home, 'work');
    for (const [name, root] of [['NUL', `${work}\u0000x`], ['lone surrogate', path.join(mesh.home, '\ud800')]] as const) {
      const response = await mesh.save(['claude'], [root]);
      assert.equal(response.status, 400, name);
      assert.equal(((await response.json()) as {error: string}).error, 'invalid', name);
    }
  });

  test('the credential stores and the configuration folder are refused, with a clear message', async () => {
    const ssh = path.join(mesh.home, '.ssh');
    fs.mkdirSync(path.join(mesh.confDir, 'sub'), {recursive: true});
    fs.mkdirSync(path.join(ssh, 'sub'), {recursive: true, mode: 0o700});
    fs.symlinkSync(ssh, path.join(mesh.home, 'ssh-link'));
    const cases: [string, string][] = [['.ssh', ssh], ['inside .ssh', path.join(ssh, 'sub')],
      ['link to .ssh', path.join(mesh.home, 'ssh-link')], ['configuration folder', mesh.confDir],
      ['inside the configuration folder', path.join(mesh.confDir, 'sub')]];
    const before = fs.readFileSync(mesh.settingsPath, 'utf8');
    for (const [name, root] of cases) {
      const response = await mesh.save(['claude'], [path.join(mesh.home, 'work'), root]);
      const body = await response.json() as {error: string; message: string};
      assert.equal(response.status, 400, name);
      assert.equal(body.error, 'invalid', name);
      assert.match(body.message, /holds credentials or Mesh's own configuration and cannot be a work folder/, name);
    }
    assert.equal(fs.readFileSync(mesh.settingsPath, 'utf8'), before, 'nothing was written');
  });

  test('the home folder itself, the default, stays allowed', async () => {
    assert.equal((await mesh.save(['claude'], [mesh.home])).status, 200);
    assert.equal((await mesh.save(['claude', 'codex'], [path.join(mesh.home, 'work')])).status, 200);
  });
});

describe('the failure counter and the elevation re-check', () => {
  test('"log out everywhere" resets the failed-attempt counter', async () => {
    const other = await fresh('cfh-count-');
    for (let i = 0; i < 5; i += 1) assert.equal((await other.post('/api/config/elevate', {token: 'nope'}, other.owner(false))).status, 403);
    assert.equal((await other.elevate()).status, 429, 'locked out');
    assert.equal((await other.post('/api/logout-all', {}, other.owner(false))).status, 200);
    await other.signIn();
    assert.equal((await other.elevate()).status, 200, 'the count started again');
  });

  test('an elevation that ends while the body is still arriving is not honoured', async () => {
    const other = await fresh('cfh-race-');
    assert.equal((await other.elevate()).status, 200);
    const before = fs.readFileSync(other.settingsPath, 'utf8');
    const body = await saveBody(other, path.join(other.home, 'work2'));
    const reply = await rawPost(other, '/api/config/launch', headersOf(other), [body.slice(0, 20), body.slice(20)], {
      gapMs: 300, between: async () => { assert.equal((await other.post('/api/config/elevate/revoke', {}, headersOf(other))).status, 200); }});
    assert.equal(reply.status, 403, reply.text);
    assert.match(reply.text, /elevation-required/);
    assert.equal(fs.readFileSync(other.settingsPath, 'utf8'), before);
  });

  test('log out everywhere during a pending write refuses it', async () => {
    const other = await fresh('cfh-logout-');
    assert.equal((await other.elevate()).status, 200);
    const before = fs.readFileSync(other.settingsPath, 'utf8');
    const body = await saveBody(other, path.join(other.home, 'work2'));
    const reply = await rawPost(other, '/api/config/launch', headersOf(other), [body.slice(0, 20), body.slice(20)], {
      gapMs: 300, between: async () => { assert.equal((await other.post('/api/logout-all', {}, other.owner(false))).status, 200); }});
    assert.ok([401, 403].includes(reply.status), `${reply.status} ${reply.text}`);
    assert.equal(fs.readFileSync(other.settingsPath, 'utf8'), before);
  });
});

describe('the elevation is bound to the owner cookie, on its own', () => {
  test('a new generation on disk, with no clear(), ends it for a fresh login', async () => {
    const other = await fresh('cfh-bind-');
    assert.equal((await other.elevate()).status, 200);
    const elevation = other.elevation;
    assert.equal((await other.config()).elevation.active, true);
    const file = path.join(other.confDir, 'cookie-generation');
    fs.writeFileSync(file, `${Number(fs.readFileSync(file, 'utf8')) + 1}\n`, {mode: 0o600});
    assert.equal((await fetch(`${other.base}/api/config`, {headers: other.owner()})).status, 401, 'the old login is refused');
    await other.signIn();
    other.elevation = elevation;                 // the old elevation cookie with the new login
    assert.equal((await other.config()).elevation.active, false);
    const response = await other.save(['claude'], [path.join(other.home, 'work2')]);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as {error: string}).error, 'elevation-required');
  });
});

describe('a request with no Origin header (pinned behaviour)', () => {
  test('is accepted when the owner cookie, the JSON type and the elevation are all there', async () => {
    const other = await fresh('cfh-origin-');
    assert.equal((await other.elevate()).status, 200);
    const {Origin: _origin, ...noOrigin} = other.owner();
    const body = await saveBody(other, path.join(other.home, 'work2'));
    const response = await fetch(`${other.base}/api/config/launch`, {method: 'POST', headers: noOrigin, body});
    assert.equal(response.status, 200, await response.text());
    const refused = await fetch(`${other.base}/api/config/launch`, {method: 'POST', headers: {...noOrigin, Cookie: other.cookie},
      body: await saveBody(other, path.join(other.home, 'work'))});
    assert.equal(refused.status, 403, 'still needs the elevation');
    const foreign = await fetch(`${other.base}/api/config/launch`, {method: 'POST', headers: {...noOrigin, Origin: 'https://evil.example'},
      body: await saveBody(other, path.join(other.home, 'work'))});
    assert.equal(foreign.status, 403, 'a foreign Origin is still refused');
  });
});

describe('a pending agent request for an agent disabled since', () => {
  test('is refused with a message that names the agent, not "Action failed"', async () => {
    const other = await fresh('cfh-agent-');
    assert.equal((await other.elevate()).status, 200);
    const work = path.join(other.home, 'work');
    assert.equal((await other.launch('claude', work, 'requester')).status, 200);
    const tokenFile = path.join(work, 'token');
    for (let i = 0; i < 150 && !fs.existsSync(tokenFile); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
    const session = fs.readFileSync(tokenFile, 'utf8').trim();
    const created = await fetch(`${other.base}/api/session-actions/@self/request`, {method: 'POST',
      headers: {Authorization: `MeshSession ${session}`, 'Content-Type': 'application/json'}, body: JSON.stringify({action: 'create', preset: 'codex'})});
    assert.equal(created.status, 202, await created.clone().text());
    const id = ((await created.json()) as {request: {id: string}}).request.id;
    const tab = 'a'.repeat(32);
    const claim = await other.post(`/api/session-actions/${id}/claim`, {tab_nonce: tab}, other.owner(false));
    assert.equal(claim.status, 200, await claim.clone().text());
    const {claim_nonce} = await claim.json() as {claim_nonce: string};
    assert.equal((await other.save(['claude'], [work])).status, 200, 'codex is disabled now');
    const config = await fetch(`${other.base}/api/config`, {headers: other.owner(false)});
    const {launch} = await config.json() as {launch: {agent_options_revision: string}};
    const decision = await other.post(`/api/session-actions/${id}/decision`,
      {approve: true, claim_nonce, options_revision: launch.agent_options_revision}, other.owner(false));
    const outcome = await decision.json() as {request: {state: string; result: {error?: string}}};
    assert.equal(outcome.request.state, 'failed');
    assert.equal(outcome.request.result.error, 'Agent codex is disabled in the configuration', JSON.stringify(outcome));
  });
});
