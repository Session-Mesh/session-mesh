// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {execFile, execFileSync, spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

test('real Pi keeps parallel profiles isolated across exact resumes', {timeout: 75000}, async t => {
  const pi = process.env.MESH_PI_CMD || 'pi';
  const version = spawnSync(pi, ['--version'], {encoding: 'utf8', timeout: 5000});
  if (version.error?.code === 'ENOENT' && !process.env.MESH_PI_CMD) {
    t.skip('Pi is not installed');
    return;
  }
  assert.equal(version.status, 0, String(version.error ?? version.stderr));

  const root = await mkdtemp(join(tmpdir(), 'mesh-pi-parallel-'));
  const requests: {authorization?: string; messages: unknown}[] = [];
  const reports: {source: string; session: string; pid: number}[] = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === '/api/event' && request.headers.authorization === 'MeshSession fixture-token') {
        const {detail} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reports.push(detail);
        response.writeHead(200).end();
        return;
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const {messages} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({authorization: request.headers.authorization, messages});
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const reply = {id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fake',
        choices: [{index: 0, delta: {role: 'assistant', content: 'fixture reply'}, finish_reason: 'stop'}]};
      response.end('data: ' + JSON.stringify(reply) + '\n\ndata: [DONE]\n\n');
    } catch {
      response.writeHead(400).end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      model.once('error', reject);
      model.listen(0, '127.0.0.1', resolve);
    });
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    const runs = await Promise.allSettled(['alpha', 'beta'].map(async name => {
      const profile = join(root, name);
      const history = join(profile, 'history');
      await mkdir(history, {recursive: true});
      await writeFile(join(profile, 'models.json'), JSON.stringify({providers: {'test-local': {
        baseUrl: 'http://127.0.0.1:' + address.port + '/v1', api: 'openai-completions',
        apiKey: 'fixture-' + name, models: [{id: 'fake'}],
      }}}));
      const send = (message: string, transcript?: string) => new Promise<string>((resolve, reject) => {
        const args = ['pi', '--print', '--offline', '--no-mcp', '--no-extensions', '--no-skills',
          '--no-context-files', '--provider', 'test-local', '--model', 'fake'];
        if (transcript) args.push('--session', transcript);
        args.push(message);
        const env = {HOME: profile, PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', MESH_PORT: String(address.port),
          MESH_SESSION_TOKEN: 'fixture-token'};
        const command = execFileSync(process.env.MESH_PYTHON || 'python3', ['-c', [
          'import os, shlex, shutil, sys',
          'import agentmcp, pimcp, server',
          'agentmcp.BOARD_MCP = sys.argv[4]',
          'pimcp.binary = lambda environ: shutil.which(sys.argv[1])',
          'runtime = pimcp.prepare(sys.argv[2], os.environ)',
          'print(server._pi_command(shlex.join(sys.argv[5:]), runtime, sys.argv[3]))',
        ].join('\n'), pi, profile + '-mesh', history, process.execPath, ...args], {env, encoding: 'utf8', timeout: 5000});
        const child = execFile('/bin/sh', ['-c', command], {cwd: profile, timeout: 15000, env},
        (error, stdout, stderr) => error ? reject(new Error(stderr, {cause: error})) : resolve(stdout));
        child.stdin?.end();
      });
      assert.match(await send('original-' + name), /fixture reply/);
      const files = await readdir(history);
      assert.equal(files.length, 1);
      assert.match(await send('continue-' + name, join(history, files[0])), /fixture reply/);
      assert.deepEqual(await readdir(history), files);
      return JSON.parse((await readFile(join(history, files[0]), 'utf8')).split('\n', 1)[0]).id as string;
    }));
    for (const run of runs) {
      if (run.status === 'rejected') throw run.reason;
      const matching = reports.filter(report => report.source === 'pi' && report.session === run.value);
      assert.equal(new Set(matching.map(report => report.pid)).size, 2, 'launch and resume each report the exact transcript');
    }
    assert.equal(requests.length, 4);
    for (const [name, other] of [['alpha', 'beta'], ['beta', 'alpha']]) {
      const turns = requests.filter(request => request.authorization === 'Bearer fixture-' + name);
      assert.equal(turns.length, 2);
      const resumed = JSON.stringify(turns[1].messages);
      assert.ok(resumed.includes('original-' + name));
      assert.ok(resumed.includes('continue-' + name));
      assert.ok(!resumed.includes('original-' + other));
    }
  } finally {
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});
