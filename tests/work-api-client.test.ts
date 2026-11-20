// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The client of POST /api/work/v1 (work-api.ts) against a fake fetch.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWorkApi, readSlots } from '../static/work-api.ts';

type Call = { url: string; init: RequestInit };

function fake(status: number, body: unknown, calls: Call[] = []) {
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { api: createWorkApi(request, undefined, { slots: readSlots(2), busyDelays: [] }), calls };
}

/** A fetch whose answers the test releases one by one, to see how many requests are in flight. */
function held() {
  const pending: { op: string; release: (status?: number, body?: unknown) => void }[] = [];
  const request = (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const op = String(JSON.parse(String(init.body)).op);
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    pending.push({ op, release: (status = 200, body = { categories: [], projects: [], questions: [] }) =>
      resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) });
  });
  return { request, pending };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const BUSY = { error: { code: 'busy', message: 'busy' } };

describe('the relay\'s program slots', () => {
  test('a page reads at most two documents at a time, in the order asked; a write does not wait for them', async () => {
    const { request, pending } = held();
    const api = createWorkApi(request, undefined, { slots: readSlots(2), busyDelays: [] });
    const results = [api.products(), api.projects(), api.openQuestions(), api.project('P-5e6f')];
    await tick();
    assert.deepEqual(pending.map(call => call.op), ['products', 'projects'], 'the third read waits for a free slot');
    const write = api.answer('N-1', 'x');
    await tick();
    assert.deepEqual(pending.map(call => call.op), ['products', 'projects', 'answer']);
    pending[1]!.release();
    await tick(); await tick();
    assert.deepEqual(pending.map(call => call.op), ['products', 'projects', 'answer', 'resume'], 'a free slot goes to the next read');
    pending[0]!.release(); await tick(); await tick();
    assert.deepEqual(pending.map(call => call.op), ['products', 'projects', 'answer', 'resume', 'project']);
    pending[3]!.release(); pending[4]!.release();
    pending[2]!.release(200, { id: 'N-1', owner_verified: true });
    assert.equal((await Promise.all(results)).length, 4);
    assert.equal((await write).ok, true);
  });

  test('the slots are shared by every client of the page by default', async () => {
    const { request, pending } = held();
    const first = createWorkApi(request, undefined, { busyDelays: [] }), second = createWorkApi(request, undefined, { busyDelays: [] });
    const results = [first.products(), second.products(), second.projects()];
    await tick();
    assert.equal(pending.length, 2, 'two clients of one page still read two at a time');
    pending[0]!.release(); await tick(); await tick();
    assert.equal(pending.length, 3);
    pending[1]!.release(); pending[2]!.release();
    await Promise.all(results);
  });

  test('a read refused as busy is tried again after a pause, a bounded number of times', async () => {
    let busyLeft = 2;
    const calls: string[] = [];
    const request = async (_url: string, init: RequestInit) => {
      calls.push(String(JSON.parse(String(init.body)).op));
      return busyLeft-- > 0 ? new Response(JSON.stringify(BUSY), { status: 503 }) : new Response(JSON.stringify({ questions: [] }));
    };
    const api = createWorkApi(request, undefined, { slots: readSlots(2), busyDelays: [0, 0, 0] });
    assert.equal((await api.openQuestions()).ok, true);
    assert.deepEqual(calls, ['resume', 'resume', 'resume']);
    busyLeft = 99; calls.length = 0;
    const result = await api.products();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'busy', 'after the last pause the error is shown');
    assert.equal(calls.length, 4, 'the first try and three more');
  });

  test('a write refused as busy is not sent again, and an abort during a pause stops the tries', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const request = async (_url: string, init: RequestInit) => {
      calls.push(String(JSON.parse(String(init.body)).op));
      return new Response(JSON.stringify(BUSY), { status: 503 });
    };
    const api = createWorkApi(request, undefined, { slots: readSlots(2), busyDelays: [10_000] });
    const answer = await api.answer('N-1', 'x');
    assert.equal(answer.ok, false);
    assert.deepEqual(calls, ['answer']);
    const started = Date.now();
    const read = api.products(controller.signal);
    setTimeout(() => controller.abort(), 20);
    const result = await read;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'aborted');
    assert.ok(Date.now() - started < 5_000, 'the pause ends with the abort');
    assert.deepEqual(calls, ['answer', 'products']);
  });
});

describe('request', () => {
  test('is a same-origin POST of one op with its arguments, with the page credentials', async () => {
    const { api, calls } = fake(200, { categories: [] });
    await api.products();
    await api.project('P-5e6f');
    await api.task('T-3c4d');
    assert.deepEqual(calls.map(call => call.url), ['/api/work/v1', '/api/work/v1', '/api/work/v1']);
    assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
      { op: 'products', args: {} }, { op: 'project', args: { id: 'P-5e6f' } }, { op: 'task', args: { id: 'T-3c4d' } }]);
    for (const call of calls) {
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.credentials, 'same-origin');
      assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
    }
  });

  test('the open questions are the unscoped resume op: no project, no product, nothing else', async () => {
    const { api, calls } = fake(200, { open_questions: 2, questions: [{ id: 'N-1', text: 'Port?', state: 'open' }] });
    const result = await api.openQuestions();
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { op: 'resume', args: {} });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.value.openQuestions, 2);
  });

  test('passes the abort signal on, and an aborted call is not an error to retry', async () => {
    const controller = new AbortController();
    const request = async (_url: string, init: RequestInit) => {
      controller.abort();
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('{}');
    };
    const result = await createWorkApi(request).projects(controller.signal);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual([result.error.kind, result.error.retry], ['aborted', false]);
  });
});

describe('outcomes', () => {
  const failing: [number, unknown, string, boolean][] = [
    [400, { error: { code: 'invalid_input', message: 'bad' } }, 'invalid', false],
    [404, { error: { code: 'not_found' } }, 'missing', false],
    [502, { error: { code: 'repository' } }, 'no-tracker', true],
    [502, { error: { code: 'malformed_data' } }, 'failed', true],
    [502, 'Bad Gateway', 'failed', true],
    [503, 'work-read is not installed', 'unavailable', true],
    [503, { error: { code: 'not_available', message: 'not installed' } }, 'not-available', true],
    [503, { error: { code: 'busy', message: 'busy' } }, 'busy', true],
    [503, { error: { code: 'something_else' } }, 'unavailable', true],
    [504, { error: { code: 'timeout', message: 'slow' } }, 'timeout', true],
    [502, { error: { code: 'output_too_large', message: 'big' } }, 'failed', true],
    [504, 'work-read took too long', 'timeout', true],
    [500, '', 'failed', true],
    [409, { error: { code: 'already_answered', message: 'x' } }, 'conflict', false],
    [401, '401: Unauthorized', 'auth', true],
    [403, '403: Forbidden', 'auth', true],
  ];
  for (const [status, body, kind, retry] of failing) {
    test(`HTTP ${status} ${typeof body === 'string' ? body : JSON.stringify(body)} is ${kind}`, async () => {
      const { api } = fake(status, body);
      const result = await api.project('P-5e6f');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.kind, kind);
        assert.equal(result.error.retry, retry);
        assert.equal(result.error.status, status);
      }
    });
  }

  test('a network failure is a retryable error, not a throw', async () => {
    const api = createWorkApi(async () => { throw new TypeError('Failed to fetch'); });
    const result = await api.products();
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual([result.error.kind, result.error.retry], ['network', true]);
  });

  test('a 200 that is not the expected document is a shape error', async () => {
    for (const body of [{}, [], 'null', '<html>', { projects: 3 }]) {
      const { api } = fake(200, body);
      const result = await api.projects();
      assert.equal(result.ok, false, JSON.stringify(body));
      if (!result.ok) assert.equal(result.error.kind, 'shape');
    }
  });

  test('an answer is the write op with the question and the text, and its receipt must claim owner verification', async () => {
    const calls: Call[] = [];
    const { api } = fake(200, { schema: 1, command: 'answer', id: 'N-0000a001', state: 'answered', owner_verified: true, duplicate: true }, calls);
    const result = await api.answer('N-0000a001', 'Use <b>8443</b>');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { op: 'answer', args: { question: 'N-0000a001', text: 'Use <b>8443</b>' } });
    assert.equal(calls[0]!.init.credentials, 'same-origin');
    assert.deepEqual(result, { ok: true, value: { id: 'N-0000a001', duplicate: true, uncommitted: false } });
    // A write whose git commit was skipped or failed is still recorded, and says so; only true counts.
    for (const [flag, expected] of [[true, true], ['true', false]] as const) {
      const reply = await fake(200, { id: 'N-0000a001', owner_verified: true, duplicate: false, uncommitted: flag }).api.answer('N-0000a001', 'x');
      assert.deepEqual(reply, { ok: true, value: { id: 'N-0000a001', duplicate: false, uncommitted: expected } });
    }
    for (const body of [{ id: 'N-0000a001' }, { id: 'N-0000a001', owner_verified: 'true' }, { owner_verified: true }, []]) {
      const reply = await fake(200, body).api.answer('N-0000a001', 'x');
      assert.equal(reply.ok, false, JSON.stringify(body));
      if (!reply.ok) assert.equal(reply.error.kind, 'shape');
    }
  });

  test('a good document is parsed, with unknown fields ignored', async () => {
    const { api } = fake(200, { projects: [{ id: 'P-1a', title: 'One', product: 'relay', surprise: 1 }], total: 1, no_project: [], truncated: true });
    const result = await api.projects();
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.projects[0]!.title, 'One');
      assert.equal(result.value.truncated, true);
    }
  });
});
