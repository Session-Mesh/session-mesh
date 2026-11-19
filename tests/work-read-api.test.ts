// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// POST /api/work/v1 against the real server on a free port, a temporary MESH_CONF_DIR and a
// fictional tracker repository (a copy of the worklog fixture). The default Mesh port and the
// owner's data directories are never used.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, describe, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON ?? '';
const READER = process.env.MESH_WORK_READ_CMD
  ?? path.join(ROOT, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const FIXTURE = path.join(ROOT, 'ocaml/worklog/test/fixture');
// MESH_REQUIRE_WORK_READ=1 turns a missing prerequisite into a failure instead of a skip.
const skip = (!PYTHON || !fs.existsSync(READER)) && !process.env.MESH_REQUIRE_WORK_READ
  ? 'MESH_PYTHON and a built work-read (dune build work_read/bin/work_read_main.exe) are required' : false;

interface Running { origin: string; token: string; stop: () => Promise<void>; temp: string; wl: string }

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

async function start(extra: Record<string, string>): Promise<Running> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-work-api-'));
  const port = await freePort();
  const conf = path.join(temp, 'conf'), runtime = path.join(temp, 'run'), wl = path.join(temp, 'tracker');
  fs.mkdirSync(conf, { mode: 0o700 });
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.cpSync(FIXTURE, wl, { recursive: true });
  fs.writeFileSync(path.join(wl, 'events', '2026-11.hostc.jsonl'), [
    '{"ts":"2026-11-09T10:01:00Z","task":"T-3c4d","type":"session_linked","agent":"codex","session":"s-new","cwd":"/srv/zed/secretrepo","host":"hostc","repo":"/srv/zed/secretrepo","branch":"feat/x"}',
    '{"ts":"2026-11-09T10:02:00Z","task":"T-3c4d","type":"question","id":"N-0000abcd","text":"Which slot?","agent":"codex","session":"s-new"}',
  ].join('\n') + '\n');
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'),
    XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_DATA_HOME: path.join(temp, 'data'), XDG_RUNTIME_DIR: runtime,
    MESH_CONF_DIR: conf, MESH_CACHE_DIR: path.join(temp, 'cache'), MESH_RUNTIME_DIR: runtime,
    MESH_HOST: '127.0.0.1', MESH_PORT: String(port), MESH_AUTH_MODE: 'legacy', PYTHONDONTWRITEBYTECODE: '1',
    WL_HOME: wl, MESH_WORK_READ_CMD: READER,
    // Generous by default: a loaded machine must not turn a real read into a 504.
    MESH_WORK_READ_TIMEOUT: process.env.MESH_WORK_READ_TIMEOUT ?? '10', ...extra,
  };
  let diagnostics = '';
  const child: ChildProcess = spawn(PYTHON, ['server.py'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    assert.equal(child.exitCode, null, `server exited: ${diagnostics}`);
    try { ready = (await fetch(origin + '/login')).ok; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.ok(ready, `server did not start: ${diagnostics}`);
  const token = fs.readFileSync(path.join(conf, 'token'), 'utf8').trim();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  };
  return { origin, token, stop, temp, wl };
}

async function call(server: Running, body: unknown, auth: Record<string, string> | null = null, raw?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(auth ?? { authorization: `Bearer ${server.token}` }) };
  const response = await fetch(server.origin + '/api/work/v1', { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, contentType: response.headers.get('content-type') ?? '', json: () => JSON.parse(text) };
}

describe('POST /api/work/v1 with the real program', { skip }, () => {
  let server: Running;
  before(async () => { server = await start({}); });
  after(async () => { await server?.stop(); });

  test('needs the owner credential', async () => {
    assert.equal((await call(server, { op: 'products' }, {})).status, 401);
    assert.equal((await call(server, { op: 'products' }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call(server, { op: 'products' }, { authorization: 'MeshSession not-a-real-token' })).status, 401);
    assert.equal((await fetch(server.origin + '/api/work/v1')).status, 401);
  });

  test('returns the documents of the program unchanged', async () => {
    const products = await call(server, { op: 'products' });
    assert.equal(products.status, 200);
    assert.equal(products.json().command, 'products');
    const projects = await call(server, { op: 'projects', args: { product: 'relay' } });
    assert.deepEqual(projects.json().projects.map((p: { id: string }) => p.id), ['P-5e6f']);
    const project = await call(server, { op: 'project', args: { id: 'P-5e6f' } });
    assert.equal(project.json().project.title, 'Delivery rollout');
    const task = await call(server, { op: 'task', args: { id: 'T-3c4d' } });
    assert.equal(task.json().open_questions, 1);
    const sessions = await call(server, { op: 'sessions-of', args: { project: 'P-5e6f' } });
    assert.deepEqual(sessions.json().sessions.map((s: { name: string }) => s.name).sort(), ['s-new', 's-old']);
    const resume = await call(server, { op: 'resume', args: { all: true } });
    assert.equal(resume.status, 200);
    assert.ok(Array.isArray(resume.json().todo));
  });

  test('refuses an unknown op and unknown or malformed arguments with an invalid_input document', async () => {
    for (const body of [
      { op: 'nope' }, { op: 5 }, {}, { op: 'products', args: { extra: 'x' } }, { op: 'projects', args: [] },
      { op: 'projects', args: { product: 5 } }, { op: 'projects', args: { product: '' } },
      { op: 'projects', args: { all: 'yes' } }, { op: 'projects', args: { all: false } },
      { op: 'projects', args: { product: 'a'.repeat(101) } }, { op: 'task', args: { argv: ['--help'] } },
      { op: 'sessions-of', args: { id: 'T-1a2b' } }, { op: 'task', args: { id: 'T-1a2b\u0000x' } },
      { op: 'task', args: { id: '\ud800' } }, { op: 'products', extra: 1 },
    ]) {
      const reply = await call(server, body);
      assert.equal(reply.status, 400, JSON.stringify(body));
      assert.equal(reply.json().error.code, 'invalid_input', JSON.stringify(body));
    }
    for (const raw of ['not json', '[1]', JSON.stringify({ op: 'products' }) + ' '.repeat(5000)]) {
      const reply = await call(server, null, null, raw);
      assert.equal(reply.status, 400, raw.slice(0, 40));
      assert.equal(reply.json().error.code, 'invalid_input');
    }
  });

  test('passes the program its own refusals and never lets a value become an option', async () => {
    for (const args of [{ id: '--all' }, { id: 'P-zzzz' }, { id: 'T-1a2b' }, { id: '../../etc/passwd' }]) {
      const reply = await call(server, { op: 'project', args });
      assert.equal(reply.status, 400, JSON.stringify(args));
      assert.equal(reply.json().error.code, 'invalid_input');
    }
    for (const [op, raw] of [
      ['projects', '{"op":"projects","args":{"id":"--all"}}'],
      ['projects', '{"op":"projects","args":{"id":"--product","id":"relay"}}'],
      ['sessions-of', '{"op":"sessions-of","args":{"id":"--task","id":"T-3c4d"}}'],
      ['projects', '{"op":"projects","args":{"product":"a","product":"b"}}'],
    ]) {
      const reply = await call(server, null, null, raw);
      assert.equal(reply.status, 400, `${op} ${raw}`);
      assert.equal(reply.json().error.code, 'invalid_input');
    }
    const missing = await call(server, { op: 'project', args: { id: 'P-ffff' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().error.code, 'not_found');
    const noArgument = await call(server, { op: 'sessions-of', args: {} });
    assert.equal(noArgument.status, 400);
  });

  test('leaks no absolute path, folder or home directory', async () => {
    const forbidden = [server.temp, server.wl, '/srv/zed', '/work/relay', os.tmpdir()];
    for (const body of [
      { op: 'products' }, { op: 'projects', args: { all: true } }, { op: 'project', args: { id: 'P-5e6f' } },
      { op: 'task', args: { id: 'T-3c4d' } }, { op: 'resume', args: {} }, { op: 'sessions-of', args: { product: 'relay' } },
      { op: 'task', args: { id: 'T-ffff' } },
    ]) {
      const reply = await call(server, body);
      for (const needle of forbidden) assert.ok(!reply.text.includes(needle), `${JSON.stringify(body)} leaks ${needle}`);
    }
    const task = (await call(server, { op: 'task', args: { id: 'T-3c4d' } })).json();
    assert.equal(task.sessions.find((s: { name: string }) => s.name === 's-new').repo, 'secretrepo');
  });
});

describe('POST /api/work/v1 limits', { skip }, () => {
  let server: Running;
  let slow: string;
  let background: string;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-work-fake-'));
    slow = path.join(dir, 'fake-work-read');
    background = path.join(dir, 'background.pid');
    // A stand-in that reads the request on standard input, as work-read --request does.
    fs.writeFileSync(slow, [
      '#!/bin/sh', 'read -r body', 'case "$body" in',
      `  *'"op":"project"'*) exec sleep 30;;`,
      `  *'"op":"products"'*) exec head -c 3000000 /dev/zero;;`,
      `  *'"op":"task"'*) echo '{"error":{"code":"internal","message":"x"}}'; exit 7;;`,
      `  *'"op":"resume"'*'"all"'*) printf '{"partial":'; exit 0;;`,
      `  *'"op":"resume"'*'"empty"'*) exit 0;;`,
      `  *'"op":"resume"'*'"killed"'*) kill -9 $$;;`,
      // A detached child that does not hold the output: only the process group kill stops it.
      `  *'"op":"sessions-of"'*) sleep 30 >/dev/null 2>&1 & echo $! > '${background}'; echo '{"ok":true}';;`,
      `  *) echo '{"ok":true}';;`, 'esac', '',
    ].join('\n'), { mode: 0o755 });
    server = await start({ MESH_WORK_READ_CMD: slow, MESH_WORK_READ_TIMEOUT: '10' });
  });
  after(async () => { await server?.stop(); fs.rmSync(path.dirname(slow), { recursive: true, force: true }); });

  test('a program that does not finish is stopped after one timeout', async () => {
    const started = Date.now();
    const reply = await call(server, { op: 'project', args: { id: 'P-5e6f' } });
    assert.equal(reply.status, 504);
    assert.equal(reply.json().error.code, 'timeout');
    assert.ok(Date.now() - started < 20000, `took ${Date.now() - started} ms`);
  });

  test('an output over the cap is refused, not relayed', async () => {
    const reply = await call(server, { op: 'products' });
    assert.equal(reply.status, 502);
    assert.ok(reply.text.length < 1000);
    assert.equal(reply.json().error.code, 'output_too_large');
  });

  test('a process left behind by the program is stopped with it', async () => {
    const reply = await call(server, { op: 'sessions-of', args: { product: 'relay' } });
    assert.equal(reply.status, 200);
    const pid = Number(fs.readFileSync(background, 'utf8').trim());
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, `background process ${pid} survived`);
  });

  test('a failing program is a 502 with its own document', async () => {
    const reply = await call(server, { op: 'task', args: { id: 'T-1a2b' } });
    assert.equal(reply.status, 502);
    assert.equal(reply.json().error.code, 'internal');
  });

  test('an empty output, a partial line and a signal kill are a JSON 502, never a relayed body', async () => {
    for (const args of [{ product: 'empty' }, { all: true }, { product: 'killed' }]) {
      const reply = await call(server, { op: 'resume', args });
      assert.equal(reply.status, 502, JSON.stringify(args));
      assert.match(reply.contentType, /application\/json/);
      assert.equal(reply.json().error.code, 'internal');
    }
  });

  test('concurrency is bounded and a slot is freed afterwards', async () => {
    const replies = await Promise.all(Array.from({ length: 7 }, () => call(server, { op: 'project', args: { id: 'P-5e6f' } })));
    const statuses = replies.map(r => r.status);
    assert.ok(statuses.includes(503), `statuses: ${statuses}`);
    assert.ok(statuses.filter(s => s === 504).length <= 4, `statuses: ${statuses}`);
    const later = await call(server, { op: 'resume', args: {} });
    assert.equal(later.status, 200);
  });
});

describe('POST /api/work/v1 configuration', { skip }, () => {
  let server: Running;
  // A relative program path is refused, not looked up elsewhere; a malformed timeout keeps the default.
  before(async () => { server = await start({ MESH_WORK_READ_CMD: 'work-read', MESH_WORK_READ_TIMEOUT: 'abc' }); });
  after(async () => { await server?.stop(); });

  test('a bad MESH_WORK_READ_CMD is a 503, and the server still starts', async () => {
    const reply = await call(server, { op: 'products' });
    assert.equal(reply.status, 503);
    assert.equal(reply.json().error.code, 'not_available');
  });
});
