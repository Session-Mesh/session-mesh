// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The client of POST /api/work/v1 (work-api.ts) against a fake fetch.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWorkApi } from '../static/work-api.ts';

type Call = { url: string; init: RequestInit };

function fake(status: number, body: unknown, calls: Call[] = []) {
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { api: createWorkApi(request), calls };
}

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
