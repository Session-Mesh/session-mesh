// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Real HTTP, resolver and PTY host; recording CLIs, not provider or resumability qualification.
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

const platform = process.env.MESH_MESH_PLATFORM_CMD ||
  path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const skip = fs.existsSync(platform) || process.env.MESH_REQUIRE_MESH_PLATFORM === '1'
  ? false : 'build mesh-platform or set MESH_MESH_PLATFORM_CMD';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('HTTP-selected four-backend launches reach the real PTY with the selected roots and revision', {skip, timeout: 60000}, async () => {
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
  let host: ChildProcess | undefined;
  const socket = path.join(mesh.home, 'run/session-mesh/ptyhost.sock');
  try {
    const argv = nativePtyhost();
    host = spawn(argv[0], argv.slice(1), {cwd: REPO, stdio: 'ignore',
      env: {HOME: mesh.home, PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: path.join(mesh.home, 'run')}});
    await waitFor('private native host', 10000, () => request(socket, {op: 'list'}).then(() => true, () => false));
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
    const recorded = () => fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
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
      if (agent === 'opencode') {
        for (const role of ['config', 'data', 'state', 'cache']) {
          assert.equal(call.env[`XDG_${role.toUpperCase()}_HOME`], roots[role]);
        }
        assert.equal(call.env.OPENCODE_DB, undefined);
        assert.equal(call.env.OPENCODE_CONFIG, undefined);
        assert.notEqual(call.env.OPENCODE_CONFIG_CONTENT, '{"ambient":true}');
      }
      if (agent === 'pi') {
        assert.equal(call.args[call.args.indexOf('--session-dir') + 1], roots.history);
        assert.equal(fs.realpathSync(path.join(call.env.PI_CODING_AGENT_DIR, 'sessions')),
          path.join(roots.config!, 'sessions'));
      }
    }
    const listed = await request(socket, {op: 'list'}) as Array<{name: string; meta: Record<string, string>}>;
    assert.equal(listed.length, 4);
    for (const session of listed) {
      assert.equal(session.meta.account, 'work');
      assert.match(session.meta.account_context_revision!, /^[a-f0-9]{64}$/);
    }
  } finally {
    if (host && host.exitCode === null && host.signalCode === null) {
      const closed = once(host, 'close');
      host.kill('SIGKILL');
      await closed;
    }
    await mesh.stop();
  }
});
