// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {test} from 'node:test';
import {startTestPtyhost} from './helpers/managed-test-ptyhost.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {REPO, startMesh} from './mesh-server-lib.ts';
import {attach, request, waitFor} from './ptyhost-wire-lib.ts';
import {switchSource, switchTargets} from '../static/account-switch-picker.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

for (const initiator of ['agent', 'operator'] as const)
test(`real Pi ${initiator} switch keeps its shell and conversation`, {timeout: 90000}, async t => {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v pi'], {encoding: 'utf8'});
  const pi = probe.stdout.trim();
  const tools = ['fd', 'rg'].map(tool => [tool, spawnSync('/bin/sh', ['-c', 'command -v ' + tool], {encoding: 'utf8'}).stdout.trim()]);
  const platform = process.env.MESH_MESH_PLATFORM_CMD ??
    path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
  if (process.platform !== 'linux' || !pi || !fs.existsSync(platform) || tools.some(([, executable]) => !executable)) {
    t.skip('requires Pi, fd, rg, the native account helper and Linux process identities');
    return;
  }

  const turns: {authorization?: string; messages: unknown}[] = [];
  const inference = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    turns.push({authorization: req.headers.authorization, messages: JSON.parse(Buffer.concat(chunks)).messages});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const reply = {id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fake',
      choices: [{index: 0, delta: {role: 'assistant', content: 'fixture reply'}, finish_reason: 'stop'}]};
    res.end('data: ' + JSON.stringify(reply) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => inference.listen(0, '127.0.0.1', resolve));
  let mesh: Awaited<ReturnType<typeof startMesh>> | undefined;
  let host: ReturnType<typeof startTestPtyhost> | undefined;
  let terminal: Awaited<ReturnType<typeof attach>> | undefined;
  try {
    const address = inference.address();
    assert.ok(address && typeof address !== 'string');
    let bin = '', shell = '';
    const histories: Record<string, string> = {};
    mesh = await startMesh('pi-native-switch-', {
      MESH_MESH_PLATFORM_CMD: platform, MESH_SESSION: undefined, MESH_SESSION_TOKEN: undefined,
    }, where => {
      const home = fs.realpathSync(where.home);
      bin = path.join(home, 'bin');
      shell = path.join(bin, 'fixture-shell');
      fs.mkdirSync(bin, {recursive: true, mode: 0o700});
      for (const [tool, executable] of tools) fs.symlinkSync(executable, path.join(bin, tool));
      fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
      fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', {mode: 0o700});
      fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
      fs.writeFileSync(path.join(bin, 'pi'), [
        '#!/bin/sh',
        'if [ "$1" = --version ]; then exec ' + quote(pi) + ' --version; fi',
        'export PATH=' + quote(bin + ':/usr/bin:/bin'),
        'umask 077',
        'printf "%s" "$MESH_SESSION_TOKEN" > .fixture-token',
        'exec ' + quote(pi) + ' "$@" --offline --no-mcp --no-skills --no-context-files --no-extensions --no-approve --provider test-local --model fake',
        '',
      ].join('\n'), {mode: 0o700});
      const profiles = ['source', 'target'].map(id => {
        const config = path.join(home, id, 'config'), history = path.join(home, id, 'history');
        for (const directory of [config, history]) fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        fs.writeFileSync(path.join(config, 'models.json'), JSON.stringify({providers: {'test-local': {
          baseUrl: 'http://127.0.0.1:' + address.port + '/v1', api: 'openai-completions',
          apiKey: 'fixture-' + id, models: [{id: 'fake'}],
        }}}), {mode: 0o600});
        histories[id] = history;
        return {id, label: id, backend: 'pi', enabled: true, roots: {config, history}};
      });
      fs.writeFileSync(path.join(where.confDir, 'backend-profiles.json'), JSON.stringify({version: 1, profiles}), {mode: 0o600});
      where.env.PATH = bin + ':' + process.env.PATH;
      where.env.MESH_BIN_DIR = bin;
      where.env.SHELL = shell;
    });
    const socket = path.join(mesh.home, 'run/session-mesh/ptyhost.sock');
    host = startTestPtyhost(nativePtyhost(), {cwd: REPO, stdio: 'ignore',
      env: {HOME: mesh.home, PATH: bin + ':' + process.env.PATH, SHELL: shell,
        LANG: 'C.UTF-8', XDG_RUNTIME_DIR: path.join(mesh.home, 'run')}}, socket);
    await host.ready;
    const login = await fetch(mesh.base + '/login', {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const owner = {Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'};
    const post = (url: string, body: object, headers: Record<string, string> = owner) => fetch(mesh!.base + url, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const launched = await post('/api/new', {preset: 'pi', cwd: mesh.home, name: 'pi-switch', account: 'source'});
    assert.equal(launched.status, 200, await launched.clone().text());
    const tokenFile = path.join(mesh.home, '.fixture-token');
    await waitFor('Pi launcher has its session capability', 10000, () => fs.existsSync(tokenFile));
    const token = fs.readFileSync(tokenFile, 'utf8');
    const name = 'pi-switch';
    terminal = await attach(socket, name);
    const activePi = async () => {
      const response = await fetch(mesh!.base + '/api/sessions', {headers: owner});
      const {mesh: inventory} = await response.json();
      return inventory.find((session: any) => session.id === name);
    };
    await waitFor('Pi startup is complete', 15000, async () => (await activePi())?.agent?.identity_source === 'pi_hook');
    terminal.send('D', Buffer.from('source-conversation'));
    await waitFor('source prompt rendered', 10000, () => terminal!.output().includes('source-conversation'));
    terminal.send('D', Buffer.from('\r'));
    await waitFor('source completion', 10000, () => terminal!.output().includes('fixture reply')).catch(error => {
      throw new Error(JSON.stringify(terminal!.output().slice(-900)), {cause: error});
    });
    const [before] = await request(socket, {op: 'list'}) as Record<string, unknown>[];
    terminal.close();
    terminal = undefined;
    await waitFor('legacy fixture attachment closed', 5000, async () => {
      const [session] = await request(socket, {op: 'list'}) as {attached: number}[];
      return session.attached === 0;
    });
    if (initiator === 'operator') {
      await waitFor('Pi source idle after the completed turn', 10000, async () => {
        const session = await activePi();
        return session?.agent?.status === 'idle' && session.agent.identity_source === 'pi_hook'
          && session.switch_qualified === true;
      });
      const observed = await activePi();
      const source = switchSource(observed, true);
      assert.ok(source, 'the picker can bind its source using the real inventory');
      const profiles = await fetch(mesh.base + '/api/accounts/profiles', {headers: owner});
      assert.equal(profiles.status, 200);
      const {data} = await profiles.json();
      const targets = switchTargets(source, data.profiles);
      assert.deepEqual(targets.map(p => p.id), ['target']);
      const route = '/api/session-actions/operator/switch';
      const accepted = await post(route, {source, target: targets[0]!});
      assert.equal(accepted.status, 202, await accepted.clone().text());
      const {request: receipt} = await accepted.json();
      await waitFor('operator Pi switch completes', 15000, async () => {
        const response = await fetch(`${mesh!.base}${route}/${receipt.id}`, {headers: owner});
        assert.equal(response.status, 200);
        const {request: observed} = await response.json();
        assert.notEqual(observed.state, 'failed', JSON.stringify(observed));
        return observed.state === 'completed';
      });
    } else {
      const ask = await post('/api/session-actions/@self/request', {action: 'switch_account', account: 'target'},
        {'Content-Type': 'application/json', Authorization: 'MeshSession ' + token});
      assert.equal(ask.status, 202, await ask.clone().text());
      const {request: pending} = await ask.json();
      const claim = await post('/api/session-actions/' + pending.id + '/claim', {tab_nonce: 'b'.repeat(32)});
      assert.equal(claim.status, 200, await claim.clone().text());
      const {claim_nonce} = await claim.json();
      const decision = await post('/api/session-actions/' + pending.id + '/decision', {approve: true, claim_nonce});
      assert.equal(decision.status, 200, await decision.clone().text());
      const {request: decided} = await decision.json();
      assert.equal(decided.state, 'completed', JSON.stringify(decided));
    }
    const [after] = await request(socket, {op: 'list'}) as Record<string, unknown>[];
    assert.equal(after.name, name);
    assert.equal(after.pid, before.pid);
    assert.notEqual(after.created, before.created);
    const [transcript] = fs.readdirSync(histories.source).filter(file => file.endsWith('.jsonl'));
    assert.equal(fs.existsSync(path.join(histories.target, transcript)), true);
    terminal = await attach(socket, name);
    await waitFor('replacement prompt', 15000, async () => {
      const session = await activePi();
      return session?.created === after.created && session.agent?.identity_source === 'pi_hook';
    });
    terminal.send('D', Buffer.from('target-continuation'));
    await waitFor('replacement prompt rendered', 10000, () => terminal!.output().includes('target-continuation'));
    terminal.send('D', Buffer.from('\r'));
    await waitFor('target inference', 10000, () => turns.length === 2);
    assert.equal(turns[0].authorization, 'Bearer fixture-source');
    assert.equal(turns[1].authorization, 'Bearer fixture-target');
    assert.match(JSON.stringify(turns[1].messages), /source-conversation/);
    assert.match(JSON.stringify(turns[1].messages), /target-continuation/);
  } finally {
    terminal?.close();
    try { await host?.stop(); } finally {
      await mesh?.stop();
      await new Promise<void>(resolve => inference.close(() => resolve()));
    }
  }
});
