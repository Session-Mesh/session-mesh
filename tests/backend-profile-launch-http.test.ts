// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Real HTTP, resolver and PTY host; recording CLIs, not provider or resumability qualification.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {startTestPtyhost} from './helpers/managed-test-ptyhost.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

const platform = process.env.MESH_MESH_PLATFORM_CMD ||
  path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const skip = fs.existsSync(platform) || process.env.MESH_REQUIRE_MESH_PLATFORM === '1'
  ? false : 'build mesh-platform or set MESH_MESH_PLATFORM_CMD';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function inventory(root: string): unknown[] {
  const st = fs.lstatSync(root);
  const metadata = [st.dev, st.ino, st.mode];
  if (!st.isDirectory()) return [...metadata, fs.readFileSync(root)];
  return [...metadata, fs.readdirSync(root).sort().map(name => [name, inventory(path.join(root, name))])];
}

test('normal helper refuses managed creation and does not offer a host-provisioned profile', {skip, timeout:60000}, async () => {
  const helper = process.env.MESH_PROFILE_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_profile_main.exe');
  const mesh = await startMesh('accounts-provision-http-', {
    MESH_MESH_PLATFORM_CMD: platform, MESH_MESH_PROFILE_CMD: helper,
    MESH_SESSION: undefined, MESH_SESSION_TOKEN: undefined,
  }, where => {
    fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
    assert.deepEqual(fs.readdirSync(where.confDir), []);
  });
  let host: ReturnType<typeof startTestPtyhost> | undefined;
  const registry = path.join(mesh.confDir, 'backend-profiles.json');
  const socket = path.join(mesh.home, 'run/session-mesh/ptyhost.sock');
  try {
    const provision = (label: string, registry_revision: string | null) => {
      const result = spawnSync(helper, [], {
        input: JSON.stringify({version: 1, op: 'profiles.provision', registry_revision, profile: {backend: 'codex', label}}),
        encoding: 'utf8', timeout: 5000, env: {HOME: mesh.home, MESH_CONF_DIR: mesh.confDir, PATH: '/usr/bin:/bin'},
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout);
      return JSON.parse(result.stdout);
    };
    const acknowledge = () => {
      const call = (request: object) => {
        const result = spawnSync(helper, [], {input: JSON.stringify(request), encoding: 'utf8', timeout: 5000,
          env: {HOME: mesh.home, MESH_CONF_DIR: mesh.confDir, PATH: '/usr/bin:/bin'}});
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout);
        return JSON.parse(result.stdout);
      };
      const inspected = call({version: 1, op: 'profiles.provision-inspect'});
      assert.equal(inspected.data.outcome, 'published');
      assert.equal(call({version: 1, op: 'profiles.provision-acknowledge', proof: inspected.data.proof}).data.outcome, 'published');
    };
    const argv = nativePtyhost();
    host = startTestPtyhost(argv, {cwd: REPO, stdio: 'ignore',
      env: {HOME: mesh.home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: path.join(mesh.home, 'run')}}, socket);
    await host.ready;
    const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const headers = {Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'};
    assert.equal(fs.existsSync(registry), false);
    const inspect = async () => {
      const before = inventory(mesh.confDir);
      const response = await fetch(`${mesh.base}/api/accounts/profiles`, {headers});
      assert.equal(response.status, 200);
      const listing = await response.json();
      assert.deepEqual(inventory(mesh.confDir), before, 'registry inspection never initializes account state');
      return listing.data;
    };
    assert.equal((await inspect()).configured, false);
    const capabilities = await (await fetch(`${mesh.base}/api/config`, {headers})).json();
    assert.equal(capabilities.capabilities.profile_provision, undefined);
    assert.equal(capabilities.managed_profile_offers, undefined);
    const refused = await fetch(`${mesh.base}/api/accounts/profiles/provision`, {method:'POST', headers,
      body:JSON.stringify({registry_revision:null, profile:{backend:'codex',label:'Not qualified'}})});
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'profile-provision-unavailable');
    assert.equal(fs.existsSync(registry), false);
    const a = provision('First fixture', null).data;
    const pending = await fetch(`${mesh.base}/api/accounts/profiles/provision-inspect`, {headers});
    assert.equal(pending.status, 200);
    const proof = (await pending.json()).data.proof;
    const acknowledged = await fetch(`${mesh.base}/api/accounts/profiles/provision-acknowledge`,
      {method:'POST', headers, body:JSON.stringify({proof})});
    assert.equal(acknowledged.status, 200);
    const b = provision('Second fixture', a.registry_revision).data;
    acknowledge();
    const raw = JSON.parse(fs.readFileSync(registry, 'utf8'));
    assert.deepEqual(raw.profiles.map((p: {enabled: boolean}) => p.enabled), [false, false]);
    for (const row of raw.profiles) {
      assert.ok(fs.statSync(row.roots.state).isDirectory());
      assert.equal(fs.existsSync(path.join(row.roots.config, 'fixture-launch')), false);
    }
    assert.equal((await inspect()).configured, true);
    {
      assert.equal(fs.existsSync(path.join(mesh.confDir, 'backend-accounts.sqlite')), false);
      const inside = path.join(raw.profiles[0].roots.config, 'synthetic-note.txt');
      const control = path.join(mesh.home, 'public-note.txt');
      fs.writeFileSync(control, 'public document', {mode: 0o600});
      fs.writeFileSync(inside, 'synthetic private marker', {mode: 0o600});
      const sign = (target: string) => fetch(`${mesh.base}/api/view`, {method:'POST', headers,
        body:JSON.stringify({target})});
      const refused = await sign(inside);
      assert.equal(refused.status, 403);
      assert.doesNotMatch(await refused.text(), /synthetic private marker|\/view\//);
      const allowed = await sign(control);
      assert.equal(allowed.status, 200);
      const signed = new URL((await allowed.json()).url, mesh.base);
      assert.match(signed.pathname, /^\/view\//);
      const visible = await fetch(signed, {headers, redirect:'manual'});
      assert.equal(visible.status, 200);
      assert.match(await visible.text(), /public document/);
      fs.unlinkSync(control);
      fs.linkSync(inside, control);
      const denied = await fetch(signed, {headers, redirect:'manual'});
      assert.equal(denied.status, 403);
      assert.doesNotMatch(await denied.text(), /synthetic private marker/);
    }
    const config = async () => (await fetch(`${mesh.base}/api/config`, {headers})).json() as Promise<{accounts: {id: string; codex: boolean}[]}>;
    const launch = (name: string, account: string) => fetch(`${mesh.base}/api/new`, {method: 'POST', headers,
      body: JSON.stringify({preset: 'codex', name, cwd: mesh.home, account})});
    assert.ok(!(await config()).accounts.some(row => row.id === a.profile.id || row.id === b.profile.id));
    const hidden = await launch('hidden-profile', a.profile.id);
    assert.equal(hidden.status, 400, await hidden.text());
    assert.deepEqual(await request(socket, {op: 'list'}), []);

  } finally {
    try { await host?.stop(); } finally { await mesh.stop(); }
  }
});

test('HTTP launches use backend-qualified configuration and history roots', {skip, timeout: 60000}, async () => {
  let bin = '', record = '', profiles: Array<{backend: string; roots: Record<string, string>}> = [];
  const mesh = await startMesh('accounts-four-http-', {
    MESH_MESH_PLATFORM_CMD: platform, MESH_SESSION: undefined, MESH_SESSION_TOKEN: undefined,
  }, where => {
    bin = path.join(where.home, 'fixture-bin');
    record = path.join(where.home, 'launches.jsonl');
    fs.mkdirSync(bin, {mode: 0o700});
    fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
    const home = fs.realpathSync(where.home);
    profiles = ['claude', 'codex', 'opencode-v2', 'pi'].map(backend => {
      const roles = backend === 'opencode-v2' ? ['config', 'data', 'state', 'cache']
        : backend === 'codex' ? ['config', 'state'] : ['config', 'history'];
      const roots = Object.fromEntries(roles.map(role => {
        const directory = path.join(home, backend, role);
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        return [role, directory];
      }));
      return {backend, id: 'work', label: `${backend} Work`, enabled: true, roots};
    });
    fs.writeFileSync(path.join(where.confDir, 'backend-profiles.json'),
      JSON.stringify({version: 1, profiles}), {mode: 0o600});
    const executable = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log(name === 'pi' ? '1.3.0' : name === 'claude' ? '2.1.0 (Claude Code)' : '2.0.28-native1m.1');
  process.exit(0);
}
if (name === 'opencode' && args[0] === 'api') {
  console.log(JSON.stringify([{info: {mcp: {servers: {}}}}])); process.exit(0);
}
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const env = Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({name, args, env, session: process.env.MESH_SESSION}) + '\\n', {mode: 0o600});
setTimeout(() => {}, 30000);
`;
    for (const name of ['claude', 'codex', 'opencode', 'pi']) {
      fs.writeFileSync(path.join(bin, name), executable, {mode: 0o700});
    }
    fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
    fs.writeFileSync(path.join(where.home, '.profile'), [
      `export PATH=${quote(`${bin}:/usr/bin:/bin`)}`,
      'export OPENAI_API_KEY=fixture-default-openai ANTHROPIC_API_KEY=fixture-default-anthropic',
      `export OPENCODE_DB=${quote(path.join(home, 'ambient.db'))}`,
      `export OPENCODE_CONFIG=${quote(path.join(home, 'ambient.json'))}`,
      `export OPENCODE_CONFIG_CONTENT='{"ambient":true}'`,
      `export PI_CODING_AGENT_DIR=${quote(path.join(home, 'ambient-pi'))}`,
      ...['config', 'data', 'state', 'cache'].map(role =>
        `export XDG_${role.toUpperCase()}_HOME=${quote(path.join(home, `ambient-${role}`))}`),
      '',
    ].join('\n'), {mode: 0o600});
    where.env.PATH = `${bin}:/usr/bin:/bin`;
    where.env.MESH_BIN_DIR = bin;
    where.env.SHELL = '/bin/sh';
  });
  let host: ReturnType<typeof startTestPtyhost> | undefined;
  const socket = path.join(mesh.home, 'run/session-mesh/ptyhost.sock');
  try {
    const argv = nativePtyhost();
    host = startTestPtyhost(argv, {cwd: REPO, stdio: 'ignore',
      env: {HOME: mesh.home, PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: path.join(mesh.home, 'run')}}, socket);
    await host.ready;
    const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({token: mesh.token()})});
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const headers = {Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'};
    const config = await (await fetch(`${mesh.base}/api/config`, {headers})).json() as any;
    const offered = config.accounts.find((account: any) => account.id === 'work');
    assert.deepEqual([offered.claude, offered.codex, offered.opencode, offered.pi], [true, true, true, true]);
    for (const agent of ['claude', 'codex', 'opencode', 'pi']) {
      const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', headers,
        body: JSON.stringify({preset: agent, name: `selected-${agent}`, cwd: mesh.home, account: 'work'})});
      assert.equal(response.status, 200, await response.clone().text());
    }
    const recorded = () => {
      if (!fs.existsSync(record)) return [];
      // The last record can still be in flight while a fixture process appends it.
      return fs.readFileSync(record, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
    };
    await waitFor('all four recording agents', 10000, () => recorded().length === 4);
    const calls = recorded();
    for (const [index, agent] of ['claude', 'codex', 'opencode', 'pi'].entries()) {
      const call = calls.find(call => call.name === agent);
      assert.ok(call, agent);
      assert.equal(call.session, `selected-${agent}`);
      assert.equal(call.env.HOME, mesh.home, 'the runner HOME is preserved');
      assert.equal(call.env.OPENAI_API_KEY, undefined);
      assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
      const roots = profiles[index]!.roots;
      if (agent === 'claude') assert.equal(call.env.CLAUDE_CONFIG_DIR, roots.config);
      if (agent === 'codex') assert.equal(call.env.CODEX_HOME, roots.config);
      if (agent === 'pi') {
        const index = call.args.indexOf('--session-dir');
        assert.ok(index >= 0);
        assert.equal(call.args[index + 1], roots.history);
        assert.ok(call.env.PI_CODING_AGENT_DIR.startsWith(path.join(mesh.confDir, 'pi-agent-overlays') + path.sep));
        assert.equal(fs.realpathSync(path.join(call.env.PI_CODING_AGENT_DIR, 'sessions')),
          path.join(roots.config, 'sessions'));
      }
      if (agent === 'opencode') {
        for (const role of ['config', 'data', 'state', 'cache']) {
          assert.equal(call.env[`XDG_${role.toUpperCase()}_HOME`], roots[role]);
        }
        assert.equal(call.env.OPENCODE_DB, undefined);
        assert.equal(call.env.OPENCODE_CONFIG, undefined);
        assert.notEqual(call.env.OPENCODE_CONFIG_CONTENT, '{"ambient":true}');
      }
    }
    const listed = await request(socket, {op: 'list'}) as Array<{name: string; meta: Record<string, string>}>;
    assert.equal(listed.length, 4);
    for (const session of listed) {
      assert.equal(session.meta.account, 'work');
      assert.match(session.meta.account_context_revision!, /^[a-f0-9]{64}$/);
    }
  } finally {
    try { await host?.stop(); } finally { await mesh.stop(); }
  }
});
