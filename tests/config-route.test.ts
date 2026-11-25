// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// GET /api/config: the owner's read-only configuration. It is for the owner's browser cookie
// alone (a session token, the master Bearer token, or any Authorization header beside the cookie
// is refused), it takes no parameter, it changes nothing, and it never carries a secret: no token,
// cookie, key, file content or path of a secret file. Run on a throwaway server and PTY host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';

let lab: AgentMesh;
let mesh: AgentMesh['mesh'];
let cookie = '';
let body = '';
let report: Record<string, any> = {};

before(async () => {
  lab = await AgentMesh.start('cfg-', ['alpha']);
  ({mesh, cookie} = lab);
  // A push subscription and a VAPID key exist on disk: their contents must stay out of the answer.
  fs.writeFileSync(path.join(mesh.confDir, 'vapid.pem'),
    '-----BEGIN PRIVATE KEY-----\nCANARY-VAPID-KEY\n-----END PRIVATE KEY-----\n', {mode: 0o600});
  fs.writeFileSync(path.join(mesh.confDir, 'push.json'), JSON.stringify([
    {endpoint: 'https://fcm.googleapis.com/fcm/send/CANARY-ENDPOINT', keys: {p256dh: 'CANARY-P256', auth: 'CANARY-AUTH'}},
  ]));
  const response = await fetch(`${mesh.base}/api/config`, {headers: {Cookie: cookie}});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  body = await response.text();
  report = JSON.parse(body);
});
after(async () => { await lab?.stop(); });

describe('GET /api/config', () => {
  const url = () => `${mesh.base}/api/config`;

  test('only the owner cookie reaches it: no cookie, master token, session token, or a header beside the cookie', async () => {
    const alpha = lab.agents.alpha!;
    assert.equal((await fetch(url())).status, 401);
    assert.equal((await fetch(url(), {headers: {Authorization: `Bearer ${mesh.token()}`}})).status, 401);
    assert.equal((await fetch(url(), {headers: {Authorization: `MeshSession ${alpha.token}`}})).status, 401);
    assert.equal((await fetch(url(), {headers: {Cookie: cookie, Authorization: `MeshSession ${alpha.token}`}})).status, 401);
    assert.equal((await fetch(url(), {headers: {Cookie: cookie, Authorization: `Bearer ${mesh.token()}`}})).status, 401);
    assert.equal((await fetch(url(), {headers: {Cookie: cookie}})).status, 200);
  });

  test('it takes no query, and nothing but GET', async () => {
    assert.equal((await fetch(`${url()}?x=1`, {headers: {Cookie: cookie}})).status, 400);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(url(), {method, headers: {Cookie: cookie, Origin: mesh.base}});
      assert.equal(response.status, 405, method);
    }
  });

  test('it reports the effective paths of this server', () => {
    const {paths} = report;
    assert.equal(paths.config_dir, mesh.confDir);
    assert.equal(paths.cache_dir, path.join(mesh.home, '.cache', 'session-mesh'));
    assert.equal(paths.uploads_dir, path.join(mesh.home, '.cache', 'session-mesh', 'uploads'));
    assert.equal(paths.host_socket, path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'));
    assert.equal(paths.host_socket_present, true);
    assert.equal(paths.runtime_dir, path.join(mesh.home, 'run'));
    assert.ok(path.isAbsolute(paths.install_dir));
    assert.ok(fs.existsSync(path.join(paths.install_dir, 'server.py')));
    assert.equal(path.basename(paths.mesh_open), 'mesh-open');
    let openExecutable = false;
    try {
      fs.accessSync(paths.mesh_open, fs.constants.X_OK);
      openExecutable = fs.statSync(paths.mesh_open).isFile();
    } catch { /* A source checkout can run the web server without mesh-open installed. */ }
    assert.equal(paths.mesh_open_present, openExecutable);
    assert.equal(typeof paths.board_mcp_present, 'boolean');
  });

  test('it reports the version, the terminal host, the agents, the network and the notifications', () => {
    assert.match(report.version.client, /^[0-9a-f]{12}$/);
    assert.equal(report.version.install_name, path.basename(report.paths.install_dir));
    assert.equal(report.version.commit, undefined, 'no git internals are read');
    assert.equal(report.host.running, true);
    assert.equal(report.host.kind, 'native');
    assert.equal(report.host.version, null, 'no binary is run to learn a version');
    assert.ok(report.host.capabilities.includes('agent_wake_v1'));
    assert.deepEqual(report.agents.map((agent: {agent: string}) => agent.agent),
      ['agy', 'claude', 'codex', 'copilot', 'gemini', 'opencode', 'pi', 'vibe']);
    assert.ok(report.agents.every((agent: {version: unknown}) => agent.version === null));
    assert.equal(report.agents.find((agent: {agent: string}) => agent.agent === 'claude').path !== null, true);
    assert.equal(report.network.port, mesh.port);
    assert.equal(report.network.loopback_only, true);
    assert.equal(report.network.tailscale, 'not-seen');
    assert.equal(report.notifications.subscriptions, 1, 'a count, never the subscription');
    assert.equal(report.notifications.vapid_key_present, true);
    assert.equal(report.paths.launch_settings, null, 'no settings file in this run');
    assert.equal(report.host.reply_valid, true);
  });

  test('it carries no secret: no token, cookie, key, subscription, nor path of a secret file', () => {
    const forbidden = [mesh.token(), cookie.split('=')[1]!, lab.agents.alpha!.token,
      'CANARY-ENDPOINT', 'CANARY-P256', 'CANARY-AUTH', 'CANARY-VAPID-KEY', 'BEGIN', 'PRIVATE KEY',
      'vapid.pem', 'push.json', 'session-requests', path.join(mesh.confDir, 'token'), 'cookie-generation'];
    for (const word of forbidden) assert.ok(!body.includes(word), `the answer must not contain ${word.slice(0, 12)}…`);
    const walk = (value: unknown, where: string): void => {
      if (typeof value === 'string') assert.ok(value.length <= 4096, where);
      else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${where}[${index}]`));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, `${where}.${key}`));
    };
    walk(report, 'config');
    // accounts: the operator's aliases as {id, label, claude, codex}, never a folder (session-accounts.test.ts)
    assert.deepEqual(report.accounts, []);
    assert.equal(typeof report.accounts_available, 'boolean');
    assert.deepEqual(Object.keys(report).sort(), ['accounts', 'accounts_available', 'agents', 'capabilities', 'elevation', 'host', 'launch', 'network', 'notifications', 'paths', 'runner_settings', 'version']);
    assert.deepEqual(report.capabilities, {account_settings: true});
  });
});
