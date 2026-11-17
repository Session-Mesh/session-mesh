// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptyhostArgv } from './ptyhost-command.ts';
import { REPO, scratchHome, runServer, stopServer } from './mesh-server-lib.ts';

export async function checkProjectBridge(): Promise<void> {
  const where = await scratchHome('mesh-project-bridge-');
  const { child: server, result } = await runServer(where);
  assert.ok(result.listened, result.output);
  const [hostProgram, ...hostArgs] = ptyhostArgv();
  const host = spawn(hostProgram, hostArgs, {
    cwd: REPO, env: { ...where.env, SHELL: '/bin/sh' }, stdio: 'ignore' });
  try {
    const socketPath = path.join(where.home, 'run', 'session-mesh', 'ptyhost.sock');
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await new Promise<boolean>(resolve => {
        const socket = net.connect(socketPath, () => { socket.destroy(); resolve(true); });
        socket.on('error', () => resolve(false));
      });
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'the native PTY host starts');
    const origin = `http://127.0.0.1:${where.port}`;
    const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    const endpoint = origin + '/api/projects/v1';
    const send = (body: string, headers: Record<string, string> = {}) => fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers }, body });
    const capability = JSON.stringify({ op: 'project_capabilities', version: 1 });
    assert.equal((await send(capability)).status, 401, 'route requires owner authority');
    const owner = { Authorization: 'Bearer ' + token };
    const forwarded = await send(capability, owner);
    assert.equal(forwarded.status, 200, 'the user request reaches the native host through the real bridge');
    const reply = await forwarded.json() as { kind?: string; op?: string; status?: string };
    assert.deepEqual([reply.kind, reply.op, reply.status], ['mesh-project-reply', 'project_capabilities', 'ok']);
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
      body: new URLSearchParams({ token }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    assert.equal((await send(capability, { Cookie: cookie, Authorization: 'MeshSession ms1.invalid' })).status, 401);
    assert.equal((await send(capability, { Cookie: cookie, Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await send('{"op":"kill","name":"unused"}', owner)).status, 400, 'closed project op allowlist');
    assert.equal((await send('[]', owner)).status, 400);
    assert.equal((await send('{', owner)).status, 400);
    assert.equal((await send(JSON.stringify({ op: 'project_create', padding: 'x'.repeat(131072) }), owner)).status, 413);
    const sessions = await fetch(origin + '/api/sessions', { headers: { ...owner, Connection: 'close' } });
    assert.equal(sessions.status, 200, 'Sessions remains available');
    await sessions.arrayBuffer();
  } finally {
    await stopServer(server);
    if (host.exitCode === null && host.signalCode === null) {
      const stopped = once(host, 'exit'); host.kill('SIGTERM');
      const timeout = setTimeout(() => host.kill('SIGKILL'), 3000);
      await stopped; clearTimeout(timeout);
    }
    fs.rmSync(where.scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkProjectBridge(); process.stdout.write('project bridge checks passed\n'); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = error instanceof assert.AssertionError ? 1 : 2; }
}
