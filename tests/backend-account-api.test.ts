// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBackendAccountApi} from '../static/backend-account-api.ts';
import {createBackendAccountController, type ConsentMutation} from '../static/backend-account-model.ts';

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
test('alias request uses only the fixed authenticated POST and sends metadata without transport credentials', async()=>{
  const calls:[string,RequestInit][]=[];
  const api=createBackendAccountApi(async(url,init)=>{calls.push([url,init]);return reply();});
  const profile={backend:'pi' as const,id:'new',label:'New',roots:{config:'/fixture/config',history:'/fixture/history'}};
  await api.create!({version:1,op:'profiles.create',registry_revision:null,profile},signal());
  assert.equal(calls.length,1);
  assert.equal(calls[0]![0],'/api/accounts/profiles/create');
  assert.equal(calls[0]![1].credentials,'same-origin');
  assert.deepEqual(JSON.parse(String(calls[0]![1].body)),{registry_revision:null,profile});
  assert.deepEqual(calls[0]![1].headers,{Accept:'application/json','Content-Type':'application/json'});
});
test('a native conflict remains a native reply, not a transport retry', async () => {
  let calls = 0;
  const api = createBackendAccountApi(async () => {calls++; return reply(409);});
  const response = await api.mutate({version: 1, op: 'consent.reset', expected_revision: 0}, signal()) as any;
  assert.equal(response.code, 'consent-revision-conflict'); assert.equal(calls, 1);
});

test('the companion route media-type refusal is certain and never retried', async () => {
  let writes = 0;
  const api = createBackendAccountApi(async () => {
    writes++;
    return new Response(JSON.stringify({version: 1, ok: false, http_status: 415, code: 'unsupported-media-type'}),
      {status: 415, headers: {'Content-Type': 'application/json'}});
  });
  const controller = createBackendAccountController({mutate: api.mutate, load: async () => ({
    profiles: {version: 1, ok: true, data: {configured: false, registry_revision: null, profiles: []}},
    policy: {version: 1, ok: true, data: {version: 1, revision: 0, global: 'ask', pairs: []}},
  })});
  await controller.open();
  assert.equal(await controller.saveGlobal('skip'), false);
  assert.equal(controller.state.phase, 'refused');
  assert.equal(await controller.reset(), false); assert.equal(writes, 1); controller.close();
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

test('401/403 reads remain read failures; submitted writes remain uncertain without an authoritative ACK', async () => {
  for (const status of [401, 403]) {
    let calls = 0, reading = true;
    const api = createBackendAccountApi(async () => {
      calls++;
      if (!reading || calls === 1) return new Response('not authenticated', {status});
      throw new Error('a refused profile read must not start a policy read');
    });
    const controller = createBackendAccountController({...api});
    await controller.open(); assert.equal(calls, 1); assert.equal(controller.state.phase, 'error');
    assert.equal(controller.state.snapshot, null, 'the panel selects loadError, not uncertain-write text');
    controller.close(); reading = false;
    const writer = createBackendAccountController({mutate: api.mutate, load: async () => ({
      profiles: {version: 1, ok: true, data: {configured: false, registry_revision: null, profiles: []}},
      policy: {version: 1, ok: true, data: {version: 1, revision: 0, global: 'ask', pairs: []}},
    })});
    await writer.open(); assert.equal(await writer.saveGlobal('skip'), false);
    assert.equal(writer.state.phase, 'error'); assert.notEqual(writer.state.snapshot, null);
    assert.equal(await writer.reset(), false); assert.equal(calls, 2); writer.close();
  }
});
