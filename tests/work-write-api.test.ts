// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The write op of POST /api/work/v1 (`answer`, relayed to work-write) against the real server on a free port, a
// temporary MESH_CONF_DIR and a fictional tracker (a copy of the worklog fixture). The write is for the owner's
// signed-in browser only: the cookie, never a master Bearer token, never a session token, never a foreign Origin.
// The default Mesh port and the owner's data directories are never used.
// Needs MESH_PYTHON and the built programs (MESH_WORK_WRITE_CMD / MESH_WORK_READ_CMD, default: the dune build
// output); MESH_REQUIRE_WORK_READ=1 makes a missing one a failure. The real session-token case also needs a PTY
// host (MESH_PTYHOST_CMD).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, describe, test } from 'node:test';
import { startMesh as startHarness, type Mesh as HarnessMesh } from './http-harness.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON ?? '';
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(ROOT, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const READER = process.env.MESH_WORK_READ_CMD || path.join(ROOT, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const FIXTURE = path.join(ROOT, 'ocaml/worklog/test/fixture');
const skip = (!PYTHON || !fs.existsSync(WRITER) || !fs.existsSync(READER)) && !process.env.MESH_REQUIRE_WORK_READ
  ? 'MESH_PYTHON and built work-write and work-read are required' : false;
const QUESTIONS = ['N-0000a0b1', 'N-0000a0b2', 'N-0000a0b3', 'N-0000a0b4'];

interface Running { origin: string; token: string; cookie: string; wl: string; stop: () => Promise<void> }

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

function tracker(temp: string): string {
  const wl = path.join(temp, 'tracker');
  fs.cpSync(FIXTURE, wl, { recursive: true });
  const lines = QUESTIONS.map(id => JSON.stringify({ ts: '2026-11-09T10:02:00Z', task: 'T-3c4d', type: 'question', id, text: `Question ${id}?`, agent: 'codex', session: 's-new' }));
  // The last question already has a relayed answer, as a forged one would be.
  lines.push(JSON.stringify({ ts: '2026-11-09T10:03:00Z', task: 'T-3c4d', type: 'answer', question: QUESTIONS[3], text: 'forged', by: 'owner', agent: 'codex', session: 's-new' }));
  fs.writeFileSync(path.join(wl, 'events', '2026-11.hostq.jsonl'), lines.join('\n') + '\n');
  return wl;
}

async function start(extra: Record<string, string>): Promise<Running> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-work-write-'));
  const port = await freePort();
  const conf = path.join(temp, 'conf'), runtime = path.join(temp, 'run'), wl = tracker(temp);
  fs.mkdirSync(conf, { mode: 0o700 });
  fs.mkdirSync(runtime, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: temp, XDG_CONFIG_HOME: path.join(temp, 'config'),
    XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_DATA_HOME: path.join(temp, 'data'), XDG_RUNTIME_DIR: runtime,
    MESH_CONF_DIR: conf, MESH_CACHE_DIR: path.join(temp, 'cache'), MESH_RUNTIME_DIR: runtime,
    MESH_HOST: '127.0.0.1', MESH_PORT: String(port), MESH_AUTH_MODE: 'legacy', PYTHONDONTWRITEBYTECODE: '1',
    WL_HOME: wl, MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER,
    MESH_WORK_READ_TIMEOUT: process.env.MESH_WORK_READ_TIMEOUT ?? '30', ...extra,
  };
  let diagnostics = '';
  const child: ChildProcess = spawn(PYTHON, ['server.py'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 400 && !ready; i++) {
    assert.equal(child.exitCode, null, `server exited: ${diagnostics}`);
    try { ready = (await fetch(origin + '/login')).ok; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.ok(ready, `server did not start: ${diagnostics}`);
  const token = fs.readFileSync(path.join(conf, 'token'), 'utf8').trim();
  // The owner cookie at generation 0 (the contract tests/http-harness.ts also relies on).
  const cookie = `mesh_auth=${createHmac('sha256', token).update('session-mesh').digest('hex')}`;
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
  return { origin, token, cookie, wl, stop };
}

type Reply = { status: number; text: string; json: () => any };

async function post(base: string, body: unknown, headers: Record<string, string>, raw?: string): Promise<Reply> {
  const response = await fetch(base + '/api/work/v1', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

const answer = (question: string, text: string) => ({ op: 'answer', args: { question, text } });

function answerEvents(wl: string): Record<string, unknown>[] {
  const dir = path.join(wl, 'events');
  return fs.readdirSync(dir).sort().flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })   // the fixture holds a malformed line on purpose
    .filter(event => event !== null && event.type === 'answer');
}

describe('POST /api/work/v1 write op with the real work-write', { skip }, () => {
  let server: Running;
  let owner: Record<string, string>;
  before(async () => { server = await start({}); owner = { cookie: server.cookie, origin: server.origin }; });
  after(async () => { await server?.stop(); });

  test('the master Bearer token, a session token, both together with the cookie, and no credential are refused; nothing is written', async () => {
    for (const headers of [
      { authorization: `Bearer ${server.token}` },
      { authorization: 'MeshSession not-a-real-token' },
      { cookie: server.cookie, authorization: `Bearer ${server.token}` },
      { cookie: server.cookie, authorization: 'MeshSession not-a-real-token' },
      {},
    ]) {
      const reply = await post(server.origin, answer(QUESTIONS[0]!, 'yes'), headers);
      assert.equal(reply.status, 401, JSON.stringify(Object.keys(headers)));
    }
    assert.equal(answerEvents(server.wl).length, 1, 'only the seeded relayed answer');
  });

  test('a foreign Origin is refused even with the owner cookie', async () => {
    const reply = await post(server.origin, answer(QUESTIONS[0]!, 'yes'), { cookie: server.cookie, origin: 'https://evil.example' });
    assert.equal(reply.status, 403);
    assert.equal(answerEvents(server.wl).length, 1);
  });

  test('the owner cookie records the answer as owner-verified; work-read then shows it', async () => {
    const reply = await post(server.origin, answer(QUESTIONS[0]!, 'Use <b>8443</b>'), owner);
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json(), { schema: 1, command: 'answer', id: QUESTIONS[0], state: 'answered', owner_verified: true, duplicate: false });
    const written = answerEvents(server.wl).at(-1)!;
    assert.deepEqual([written.by, written.via, written.agent, written.session], ['owner', 'owner-web', undefined, undefined]);
    // Reads keep working with the master token, as before.
    const task = await post(server.origin, { op: 'task', args: { id: 'T-3c4d' } }, { authorization: `Bearer ${server.token}` });
    assert.equal(task.status, 200);
    const question = task.json().questions.find((q: { id: string }) => q.id === QUESTIONS[0]);
    assert.equal(question.state, 'answered');
    assert.equal(question.answers[0].owner_verified, true);
    assert.equal(question.answers[0].text, 'Use <b>8443</b>');
  });

  test('the same answer again is a duplicate; another is 409 already_answered', async () => {
    await post(server.origin, answer(QUESTIONS[1]!, 'first'), owner);
    const again = await post(server.origin, answer(QUESTIONS[1]!, 'first'), owner);
    assert.equal(again.status, 200);
    assert.equal(again.json().duplicate, true);
    const other = await post(server.origin, answer(QUESTIONS[1]!, 'second'), owner);
    assert.equal(other.status, 409);
    assert.equal(other.json().error.code, 'already_answered');
  });

  test('a relayed answer does not lock the owner out: the owner supersedes it', async () => {
    const reply = await post(server.origin, answer(QUESTIONS[3]!, 'the real answer'), owner);
    assert.equal(reply.status, 200, reply.text);
    const task = (await post(server.origin, { op: 'task', args: { id: 'T-3c4d' } }, owner)).json();
    const answers = task.questions.find((q: { id: string }) => q.id === QUESTIONS[3]).answers;
    assert.deepEqual(answers.map((a: { text: string; superseded?: boolean; owner_verified?: boolean }) => [a.text, !!a.superseded, !!a.owner_verified]),
      [['forged', true, false], ['the real answer', false, true]]);
  });

  test('hostile and malformed requests are 400 and write nothing', async () => {
    const before = answerEvents(server.wl).length;
    for (const body of [
      answer(QUESTIONS[2]!, 'a\u0000b'), answer(QUESTIONS[2]!, 'a\u001b[2Jb'), answer(QUESTIONS[2]!, 'a\r\nb'),
      answer(QUESTIONS[2]!, 'a‮b'), answer(QUESTIONS[2]!, 'a​b'), answer(QUESTIONS[2]!, '  '),
      answer(QUESTIONS[2]!, 'x'.repeat(2001)), answer('../../etc/passwd', 'x'), { op: 'answer', args: { question: QUESTIONS[2], text: 'x', by: 'admin' } },
    ]) {
      const reply = await post(server.origin, body, owner);
      assert.equal(reply.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(reply.json().error.code, 'invalid_input');
    }
    for (const raw of [`{"op":"answer","args":{"question":"${QUESTIONS[2]}","text":"\\ud800"}}`,
      `{"op":"answer","op":"answer","args":{"question":"${QUESTIONS[2]}","text":"x"}}`,
      JSON.stringify(answer(QUESTIONS[2]!, 'x'.repeat(13000))), JSON.stringify(answer(QUESTIONS[2]!, 'x'.repeat(2 * 1024 * 1024)))]) {
      const reply = await post(server.origin, null, owner, raw);
      assert.equal(reply.status, 400, raw.slice(0, 80));
    }
    assert.equal(answerEvents(server.wl).length, before);
  });
});

describe('POST /api/work/v1 write op without work-write', { skip }, () => {
  let server: Running;
  before(async () => { server = await start({ MESH_WORK_WRITE_CMD: path.join(os.tmpdir(), 'no-such-work-write') }); });
  after(async () => { await server?.stop(); });

  test('the owner gets 503 not_available; reads still work; the credential check comes first', async () => {
    const reply = await post(server.origin, answer(QUESTIONS[0]!, 'yes'), { cookie: server.cookie, origin: server.origin });
    assert.equal(reply.status, 503);
    assert.deepEqual([reply.json().error.code, reply.json().error.message], ['not_available', 'work-write is not installed']);
    assert.equal((await post(server.origin, answer(QUESTIONS[0]!, 'yes'), { authorization: `Bearer ${server.token}` })).status, 401);
    assert.equal((await post(server.origin, { op: 'products' }, { cookie: server.cookie })).status, 200);
  });
});

// A real session token, as an agent in a Mesh session holds it (MESH_SESSION_TOKEN): refused for the write op.
const sessionSkip = skip || (process.env.MESH_PTYHOST_CMD ? false : 'a PTY host (MESH_PTYHOST_CMD) is required for a real session token');

describe('POST /api/work/v1 write op with a real session token', { skip: sessionSkip }, () => {
  let mesh: HarnessMesh;
  let scratch: string;
  const saved = process.env.WL_HOME;
  before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-work-write-session-'));
    process.env.WL_HOME = tracker(scratch);   // the harness passes the environment on: never the owner's data
    mesh = await startHarness({ session: true });
  });
  after(async () => {
    await mesh?.stop();
    if (saved === undefined) delete process.env.WL_HOME; else process.env.WL_HOME = saved;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('an agent session token is 401 and nothing is written', { timeout: 120000 }, async () => {
    assert.ok(mesh.sessionToken, 'the harness started an agent session');
    const reply = await post(mesh.base, answer(QUESTIONS[0]!, 'agent says yes'),
      { authorization: `MeshSession ${mesh.sessionToken}`, origin: mesh.base });
    assert.equal(reply.status, 401);
    assert.equal(answerEvents(process.env.WL_HOME!).length, 1);
  });
});
