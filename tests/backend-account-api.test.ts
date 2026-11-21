// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBackendAccountApi} from '../static/backend-account-api.ts';
import type {ConsentMutation} from '../static/backend-account-model.ts';

const signal = () => new AbortController().signal;
const reply = (status = 200) => new Response(JSON.stringify({version: 1, ok: status === 200, http_status: status,
  ...(status === 200 ? {data: {}} : {code: 'consent-revision-conflict'})}), {status, headers: {'Content-Type': 'application/json'}});

test('loads only the agreed owner routes with page cookies, cancellation and no bearer', async () => {
  const calls: [string, RequestInit][] = [], abort = signal();
  const api = createBackendAccountApi(async (url, init) => {calls.push([url, init]); return reply();});
  await api.load(abort);
  assert.deepEqual(calls.map(([url]) => url), ['/api/accounts/profiles', '/api/accounts/consent']);
  for (const [, init] of calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.signal, abort); assert.equal(init.credentials, 'same-origin');
    assert.equal(init.mode, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.headers, {Accept: 'application/json'}); assert.equal(init.body, undefined);
  }
});
test('fixed mutation routes strip version/op and retain exact native CAS/backend fields', async () => {
  const calls: [string, RequestInit][] = [];
  const api = createBackendAccountApi(async (url, init) => {calls.push([url, init]); return reply();});
  const requests: ConsentMutation[] = [
    {version: 1, op: 'consent.set_global', expected_revision: 0, confirmation: 'skip'},
    {version: 1, op: 'consent.set_pair', expected_revision: 1, backend: 'pi', source_id: 'a', target_id: 'b', registry_revision: 'a'.repeat(64), confirmation: 'ask'},
    {version: 1, op: 'consent.remove_pair', expected_revision: 2, backend: 'pi', source_id: 'a', target_id: 'b'},
    {version: 1, op: 'consent.reset', expected_revision: 3},
  ];
  for (const request of requests) await api.mutate(request, signal());
  assert.deepEqual(calls.map(([url]) => url), ['/api/accounts/consent/set-global', '/api/accounts/consent/set-pair', '/api/accounts/consent/remove-pair', '/api/accounts/consent/reset']);
  calls.forEach(([, init], i) => {
    const {version: _version, op: _op, ...expected} = requests[i]!;
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(String(init.body)), expected);
    assert.deepEqual(init.headers, {Accept: 'application/json', 'Content-Type': 'application/json'});
  });
});
test('a native conflict remains a native reply, not a transport retry', async () => {
  let calls = 0;
  const api = createBackendAccountApi(async () => {calls++; return reply(409);});
  const response = await api.mutate({version: 1, op: 'consent.reset', expected_revision: 0}, signal()) as any;
  assert.equal(response.code, 'consent-revision-conflict'); assert.equal(calls, 1);
});
test('a refused profile listing never starts the consent read', async () => {
  let calls = 0;
  const api = createBackendAccountApi(async () => { calls++; return new Response(JSON.stringify({
    version: 1, ok: false, http_status: 503, code: 'invalid-profile-config',
  }), {status: 503, headers: {'Content-Type': 'application/json'}}); });
  await assert.rejects(api.load(signal())); assert.equal(calls, 1);
});
test('unauthenticated, non-JSON and contradictory responses refuse without fallback', async () => {
  for (const response of [new Response('unauthorized', {status: 401}), new Response('<html>', {status: 200}),
    new Response('{"version":1,"ok":true,"http_status":200,"data":{}}', {status: 409, headers: {'Content-Type': 'application/json'}})]) {
    let calls = 0; const api = createBackendAccountApi(async () => {calls++; return response;});
    await assert.rejects(api.load(signal())); assert.equal(calls, 1);
  }
});
test('aborted or unsupported requests do not reach the transport', async () => {
  let calls = 0; const api = createBackendAccountApi(async () => {calls++; return reply();});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(api.load(abort.signal));
  await assert.rejects(api.mutate({version: 1, op: 'switch.start', expected_revision: 0} as any, signal()));
  assert.equal(calls, 0);
});
