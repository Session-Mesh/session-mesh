// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// HTTPS on a VPN address through a reverse proxy (docs/operations.md, "HTTPS on a VPN address with a
// reverse proxy"). The real server.py runs on a throwaway port and home, listening on loopback only and
// WITHOUT MESH_TRUST_PROXY; a Node HTTPS proxy with a throwaway certificate behaves like Caddy's
// reverse_proxy defaults (Host kept, X-Forwarded-For/-Proto/-Host written by the proxy). Caddy itself is
// not run here. The websocket upgrade that reaches a terminal needs the native PTY host
// (MESH_PTYHOST_CMD) and is skipped without it; the origin checks of the websocket route run either way.
import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {after, before, describe, test} from 'node:test';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {type TlsProxy, startTlsProxy, viaProxy, webSocketHandshake} from './helpers/tls-reverse-proxy.ts';
import {type Mesh, startMesh} from './mesh-server-lib.ts';

const execFileAsync = promisify(execFile);
const NO_PROXY_SETTING = {MESH_TRUST_PROXY: undefined};
const form = {'Content-Type': 'application/x-www-form-urlencoded'};

async function signIn(proxy: TlsProxy, token: string): Promise<string> {
  const reply = await viaProxy(proxy, 'POST', '/login', form, new URLSearchParams({token}).toString());
  assert.equal(reply.status, 302);
  return String(reply.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
}

describe('the server behind an HTTPS reverse proxy that keeps Host', () => {
  let mesh: Mesh;
  let proxy: TlsProxy;
  let cookie = '';

  before(async () => {
    mesh = await startMesh('vpn-tls-', NO_PROXY_SETTING);
    proxy = await startTlsProxy(mesh.port);
  });
  after(async () => { await proxy?.stop(); await mesh?.stop(); });

  test('the server listens on loopback only and does not trust proxy headers by setting', async () => {
    assert.equal(mesh.base, `http://127.0.0.1:${mesh.port}`);
    cookie = await signIn(proxy, mesh.token());
    const config = JSON.parse((await viaProxy(proxy, 'GET', '/api/config', {Cookie: cookie})).body.toString());
    assert.equal(config.network.loopback_only, true);
    assert.equal(config.network.trust_proxy, false);
  });

  test('the login page, the manifest and the service worker load without a cookie', async () => {
    assert.equal((await viaProxy(proxy, 'GET', '/login')).status, 200);
    assert.equal((await viaProxy(proxy, 'GET', '/manifest.webmanifest')).status, 200);
    const worker = await viaProxy(proxy, 'GET', '/sw.js');
    assert.equal(worker.status, 200);
    assert.match(String(worker.headers['content-type']), /javascript/);
    const page = await viaProxy(proxy, 'GET', '/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login');
  });

  test('signing in with the token sets a Secure, HttpOnly, SameSite=Strict cookie', async () => {
    const reply = await viaProxy(proxy, 'POST', '/login', form, new URLSearchParams({token: mesh.token()}).toString());
    assert.equal(reply.status, 302);
    const setCookie = String(reply.headers['set-cookie']?.[0]);
    assert.match(setCookie, /;\s*Secure/i);
    assert.match(setCookie, /;\s*HttpOnly/i);
    assert.match(setCookie, /;\s*SameSite=Strict/i);
    const wrong = await viaProxy(proxy, 'POST', '/login', form, new URLSearchParams({token: 'not-the-token'}).toString());
    assert.equal(wrong.headers['set-cookie'], undefined);
  });

  test('the same login straight on loopback HTTP gives a cookie without Secure: Secure comes from X-Forwarded-Proto', async () => {
    const reply = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual', headers: form,
      body: new URLSearchParams({token: mesh.token()})});
    assert.doesNotMatch(String(reply.headers.get('set-cookie')), /Secure/i);
  });

  test('an authenticated call sees the https scheme and the host the browser used', async () => {
    const reply = await viaProxy(proxy, 'GET', '/api/config', {Cookie: cookie});
    assert.equal(reply.status, 200);
    const {network} = JSON.parse(reply.body.toString());
    assert.equal(network.request_scheme, 'https');
    assert.equal(network.request_host, `127.0.0.1:${proxy.port}`);
    assert.equal((await viaProxy(proxy, 'GET', '/api/config')).status, 401);
  });

  test('the proxy sent what the server needs: Host kept, X-Forwarded-Host equal to it, proto https', () => {
    const sent = proxy.forwarded.at(-1)!;
    assert.equal(sent.host, `127.0.0.1:${proxy.port}`);
    assert.equal(sent['x-forwarded-host'], sent.host);
    assert.equal(sent['x-forwarded-proto'], 'https');
    assert.ok(sent['x-forwarded-for']);
  });

  test('forged X-Forwarded-Host, -Proto and -For from a client are replaced by the proxy, and change nothing for the server', async () => {
    const reply = await viaProxy(proxy, 'GET', '/api/config', {Cookie: cookie, 'X-Forwarded-Host': 'attacker.example.com',
      'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '203.0.113.9'});
    const sent = proxy.forwarded.at(-1)!;
    assert.equal(sent['x-forwarded-host'], `127.0.0.1:${proxy.port}`);
    assert.equal(sent['x-forwarded-proto'], 'https');
    assert.notEqual(sent['x-forwarded-for'], '203.0.113.9');
    assert.equal(reply.status, 200);
    const {network} = JSON.parse(reply.body.toString());
    assert.equal(network.request_scheme, 'https');
    assert.equal(network.request_host, `127.0.0.1:${proxy.port}`);
  });

  // The documented step 3 of "Checking that it works": the token file ends with a newline, which the pipe removes.
  const curlOk = spawnSync('curl', ['--version']).status === 0;
  test('the documented command-line login works with the newline removed and fails with the raw token file', {skip: curlOk ? false : 'curl is not installed'}, async () => {
    const tokenFile = path.join(mesh.confDir, 'token');
    assert.ok(fs.readFileSync(tokenFile, 'utf8').endsWith('\n'), 'the token file ends with a newline');
    const caFile = path.join(mesh.scratch, 'proxy-ca.pem');
    fs.writeFileSync(caFile, proxy.ca);
    const url = `${proxy.origin}/login`;
    // Asynchronous on purpose: the proxy runs in this process, so a blocking spawn would deadlock it.
    const run = async (script: string) => (await execFileAsync('sh', ['-c', script, 'sh', tokenFile, caFile, url])).stdout;
    const documented = await run(`tr -d '\\n' < "$1" | curl -si --cacert "$2" --data-urlencode token@- "$3"`);
    assert.match(documented, /^HTTP\/[\d.]+ 302/);
    const cookieLine = documented.split(/\r?\n/).find(line => /^set-cookie:/i.test(line)) ?? '';
    assert.match(cookieLine, /Secure/i);
    assert.match(cookieLine, /HttpOnly/i);
    assert.match(cookieLine, /SameSite=Strict/i);
    const raw = await run(`curl -si --cacert "$2" --data-urlencode token@"$1" "$3"`);
    assert.match(raw, /location: \/login\?bad=1/i);
    assert.doesNotMatch(raw, /^set-cookie:/im);
  });

  test('a same-origin POST is accepted; another origin, another scheme, or a lookalike host is refused', async () => {
    const json = (origin: string | undefined) => ({Cookie: cookie, 'Content-Type': 'application/json',
      ...(origin ? {Origin: origin} : {})});
    const body = JSON.stringify({path: mesh.home});
    assert.equal((await viaProxy(proxy, 'POST', '/api/ls', json(proxy.origin), body)).status, 200);
    assert.equal((await viaProxy(proxy, 'POST', '/api/ls', json(undefined), body)).status, 200, 'no Origin: a command-line client');
    for (const origin of ['https://attacker.example.com', `http://127.0.0.1:${proxy.port}`, `https://127.0.0.1:${proxy.port + 1}`]) {
      assert.equal((await viaProxy(proxy, 'POST', '/api/ls', json(origin), body)).status, 403, origin);
    }
  });

  test('an upload of more than one network chunk goes through, and a cross-origin one does not', async () => {
    const payload = Buffer.alloc(1024 * 1024, 'm');
    const headers = (origin: string) => ({Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream'});
    const refused = await viaProxy(proxy, 'POST', '/api/upload?name=big.bin', headers('https://attacker.example.com'), payload);
    assert.equal(refused.status, 403);
    const accepted = await viaProxy(proxy, 'POST', '/api/upload?name=big.bin', headers(proxy.origin), payload);
    assert.equal(accepted.status, 200);
    const stored = JSON.parse(accepted.body.toString()).path as string;
    assert.ok(stored.startsWith(mesh.home), stored);
    assert.deepEqual(fs.readFileSync(stored), payload);
  });

  test('a websocket upgrade from another origin is refused; the page origin gets past the check', async () => {
    const socketPath = '/ws/nothing?rows=24&cols=80';
    assert.equal(await webSocketHandshake(proxy, socketPath, {Cookie: cookie, Origin: 'https://attacker.example.com'}), 403);
    assert.equal(await webSocketHandshake(proxy, socketPath, {Cookie: cookie, Origin: `http://127.0.0.1:${proxy.port}`}), 403);
    // No PTY host here: a permitted request ends at "no such session" (404), never at the origin check (403).
    assert.equal(await webSocketHandshake(proxy, socketPath, {Cookie: cookie, Origin: proxy.origin}), 404);
    assert.equal(await webSocketHandshake(proxy, socketPath, {Origin: proxy.origin}), 401);
  });
});

describe('a terminal websocket through the proxy', {skip: process.env.MESH_PTYHOST_CMD ? false : 'MESH_PTYHOST_CMD (the native PTY host) is not set'}, () => {
  let lab: AgentMesh;
  let proxy: TlsProxy;

  before(async () => {
    lab = await AgentMesh.start('vpn-tls-ws-', ['alpha']);
    proxy = await startTlsProxy(lab.mesh.port);
  });
  after(async () => { await proxy?.stop(); await lab?.stop(); });

  test('the upgrade of an existing session is accepted from the page origin', async () => {
    const cookie = await signIn(proxy, lab.mesh.token());
    const status = await webSocketHandshake(proxy, '/ws/alpha?rows=24&cols=80', {Cookie: cookie, Origin: proxy.origin});
    assert.equal(status, 101);
    const foreign = await webSocketHandshake(proxy, '/ws/alpha?rows=24&cols=80', {Cookie: cookie, Origin: 'https://attacker.example.com'});
    assert.equal(foreign, 403);
  });
});
