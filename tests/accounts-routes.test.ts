// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The owner's account-profile and confirmation-preference routes (docs/backend-account-profiles.md, "HTTP
// routes"): GET /api/accounts/profiles, GET /api/accounts/consent and POST /api/accounts/consent/{set-global,
// set-pair,remove-pair,reset}. Each one runs `mesh-profile --http <op>` and relays its envelope with the status
// the helper named. Four throwaway servers, each with its own HOME and config folder on a free port: the real
// helper with a registry, the real helper without one, a missing helper, and a fake helper (a shell script that
// records what it was given and answers what a mode file says). `mesh-profile` comes from MESH_PROFILE_CMD or the
// dune build; MESH_REQUIRE_MESH_PROFILE=1 turns its absence into failures, as for tests/backend-profiles.test.ts.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, type Scratch, startMesh} from './mesh-server-lib.ts';

const CANDIDATE = path.join(REPO, 'ocaml/_build/default/bin/mesh_profile_main.exe');
const HELPER = process.env.MESH_PROFILE_CMD || (fs.existsSync(CANDIDATE) ? CANDIDATE : path.join(REPO, '_opam/bin/mesh-profile'));
const skip = fs.existsSync(HELPER) || process.env.MESH_REQUIRE_MESH_PROFILE ? false
  : `mesh-profile not built: dune build ./bin/mesh_profile_main.exe, or set MESH_PROFILE_CMD (${HELPER})`;

const READS = {'/api/accounts/profiles': 'profiles.list', '/api/accounts/consent': 'consent.get'} as const;
const WRITES = {'/api/accounts/consent/set-global': 'consent.set_global', '/api/accounts/consent/set-pair': 'consent.set_pair',
  '/api/accounts/consent/remove-pair': 'consent.remove_pair', '/api/accounts/consent/reset': 'consent.reset'} as const;
const ROUTES: [string, string][] = [...Object.keys(READS).map(p => ['GET', p] as [string, string]),
  ...Object.keys(WRITES).map(p => ['POST', p] as [string, string])];
const PUBLIC_KEYS = ['backend', 'context_revision', 'enabled', 'id', 'label', 'switch_qualified'];
const SENTINEL = 'accounts-routes-sentinel-7c1f';

type Reply = {status: number; text: string; json: any; type: string | null};
// Every body the servers sent back: none may name a folder of the throwaway homes.
const seen: string[] = [];

function ownerCookie(mesh: Mesh): string {
  return `mesh_auth=${createHmac('sha256', mesh.token()).update('session-mesh').digest('hex')}`;
}

async function call(mesh: Mesh, method: string, route: string, options: {
  body?: string | object; cookie?: string | null; headers?: Record<string, string>;
} = {}): Promise<Reply> {
  const headers: Record<string, string> = {...options.headers};
  const cookie = options.cookie === undefined ? ownerCookie(mesh) : options.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['Content-Type'] ??= 'application/json';
  }
  if (method !== 'GET' && method !== 'HEAD') headers.Origin ??= mesh.base;
  const response = await fetch(`${mesh.base}${route}`, {method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000)});
  const text = await response.text();
  seen.push(text);
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a framework answer is plain text */ }
  return {status: response.status, text, json, type: response.headers.get('content-type')};
}

/** The status of a request sent with node:http, which keeps a header value as given (fetch trims it). */
function rawCall(mesh: Mesh, method: string, route: string, headers: Record<string, string>): Promise<number> {
  const body = method === 'POST' ? '{"expected_revision":0}' : '';
  return new Promise((resolve, reject) => {
    const request = http.request(`${mesh.base}${route}`, {method, headers: {...headers, Cookie: ownerCookie(mesh),
      Origin: mesh.base, 'Content-Type': 'application/json', 'Content-Length': String(body.length)}}, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** A coded refusal or answer in the helper's envelope, with HTTP status === http_status. */
function envelope(reply: Reply, status: number, code?: string): void {
  assert.equal(reply.status, status, reply.text);
  assert.match(reply.type ?? '', /^application\/json/);
  assert.equal(reply.json?.http_status, status, reply.text);
  assert.equal(reply.json?.version, 1);
  assert.equal(reply.json?.ok, status === 200);
  if (code !== undefined) assert.equal(reply.json?.code, code, reply.text);
}

// Two Claude profiles and one Codex profile under the config folder, roots that exist, are owned and are 0700.
function registry(where: Scratch): void {
  fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
  fs.chmodSync(where.confDir, 0o700);
  const root = fs.realpathSync(where.confDir);
  const profile = (backend: string, id: string, label: string) => {
    const roles = backend === 'codex' ? ['config', 'state'] : ['config', 'history'];
    const roots = Object.fromEntries(roles.map(role => {
      const directory = path.join(root, 'profiles', backend, id, role);
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      return [role, fs.realpathSync(directory)];
    }));
    return {id, label, backend, enabled: true, roots};
  };
  const profiles = [profile('claude', 'alpha', 'Alpha'), profile('claude', 'beta', 'Beta'), profile('codex', 'alpha', 'Alpha')];
  fs.writeFileSync(path.join(root, 'backend-profiles.json'), JSON.stringify({version: 1, profiles}), {mode: 0o600});
}

// The fake helper: records its arguments, environment, standard input and pid, then answers per ./mode.
function fakeHelper(directory: string): string {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const script = path.join(directory, 'mesh-profile');
  const answers: Record<string, string> = {
    garbage: `echo 'not json'; exit 0`,
    mismatch: `echo '{"http_status":409,"version":1,"ok":true,"data":{}}'; exit 0`,
    exitcode: `echo '{"http_status":409,"version":1,"ok":false,"code":"consent-revision-conflict"}'; exit 0`,
    status: `echo '{"http_status":418,"version":1,"ok":false,"code":"teapot"}'; exit 1`,
    extra: `echo '{"http_status":409,"version":1,"ok":false,"code":"consent-revision-conflict","detail":"/x"}'; exit 1`,
    roots: `echo '{"http_status":200,"version":1,"ok":true,"data":{"configured":true,"registry_revision":null,"profiles":[`
      + `{"id":"a","label":"A","backend":"claude","enabled":true,"context_revision":"0","switch_qualified":false,"roots":{"config":"/x"}}]}}'; exit 0`,
    nonewline: `printf '%s' '{"http_status":200,"version":1,"ok":true,"data":{"version":1,"revision":0,"global":"ask","pairs":[]}}'; exit 0`,
    beside: `echo '{"http_status":200,"version":1,"ok":true,"data":{"configured":false,"registry_revision":null,"profiles":[],`
      + `"roots":{"config":"/x"}}}'; exit 0`,
    conflict: `echo '{"http_status":409,"version":1,"ok":false,"code":"consent-revision-conflict"}'; exit 1`,
    ok: `echo '{"http_status":200,"version":1,"ok":true,"data":{"version":1,"revision":0,"global":"ask","pairs":[]}}'; exit 0`,
    list: `echo '{"http_status":200,"version":1,"ok":true,"data":{"configured":false,"registry_revision":null,"profiles":[]}}'; exit 0`,
    sleep: 'exec sleep 60',
    // consent.* data that is not the store's policy: a folder instead, or a pair account with one more key.
    secret: `echo '{"http_status":200,"version":1,"ok":true,"data":{"path":"/some/secret"}}'; exit 0`,
    pairpath: `echo '{"http_status":200,"version":1,"ok":true,"data":{"version":1,"revision":2,"global":"skip","pairs":[`
      + `{"a":{"backend":"claude","id":"a","context_revision":"0","root":"/x"},"b":{"backend":"claude","id":"b",`
      + `"context_revision":"0"},"confirmation":"ask"}]}}'; exit 0`,
    revision: `echo '{"http_status":200,"version":1,"ok":true,"data":{"version":1,"revision":"/x","global":"ask","pairs":[]}}'; exit 0`,
    // A duplicated `data` (JSON keeps the last one, the relayed bytes hold both), `version`/`ok` of the wrong type,
    // and a known code under another status than the helper gives it.
    dupdata: `echo '{"http_status":200,"version":1,"ok":true,"data":{"path":"/x"},"data":{"version":1,"revision":0,`
      + `"global":"ask","pairs":[]}}'; exit 0`,
    types: `echo '{"http_status":503,"version":true,"ok":0,"code":"backend-store-busy"}'; exit 1`,
    codestatus: `echo '{"http_status":404,"version":1,"ok":false,"code":"consent-revision-conflict"}'; exit 1`,
    // A helper that answers after 2 s (the queue test), or after 6 s with its own coded busy answer (the store's
    // SQLite busy timeout is 5 s: the server must wait longer than that).
    hold: `sleep 2; echo '{"http_status":200,"version":1,"ok":true,"data":{"version":1,"revision":0,"global":"ask","pairs":[]}}'; exit 0`,
    storebusy: `sleep 6; echo '{"http_status":503,"version":1,"ok":false,"code":"backend-store-unavailable"}'; exit 1`,
    // The reply a test wrote to ./answer; a helper whose child outlives it (the whole process group must go).
    file: `cat "$d/answer"; exit 0`,
    orphan: `sleep 60 & echo $! > "$d/child"; wait`,
  };
  const cases = Object.entries(answers).map(([mode, action]) => `  ${mode}) ${action};;`).join('\n');
  fs.writeFileSync(script, `#!/bin/sh\nd='${directory}'\nprintf '%s\\n' "$@" > "$d/argv"\nenv > "$d/env"\n`
    + `cat > "$d/stdin"\necho $$ > "$d/pid"\ncase "$(cat "$d/mode")" in\n${cases}\nesac\nexit 3\n`, {mode: 0o700});
  return script;
}

let real: Mesh, empty: Mesh, missing: Mesh, fake: Mesh, fakeDir: string;

before(async () => {
  if (skip) return;
  const common = {MESH_PROFILE_CMD: undefined, ANTHROPIC_API_KEY: SENTINEL, MESH_TEST_ACCOUNTS_SENTINEL: SENTINEL};
  [real, empty, missing] = await Promise.all([
    startMesh('accounts-routes-real-', {...common, MESH_MESH_PROFILE_CMD: HELPER}, registry),
    startMesh('accounts-routes-empty-', {...common, MESH_MESH_PROFILE_CMD: HELPER},
      where => fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700})),
    startMesh('accounts-routes-missing-', {...common, MESH_MESH_PROFILE_CMD: '/nonexistent/mesh-profile'}),
  ]);
  let script = '';
  fake = await startMesh('accounts-routes-fake-', {...common}, where => {
    fakeDir = path.join(where.scratch, 'fake');
    script = fakeHelper(fakeDir);
    where.env.MESH_MESH_PROFILE_CMD = script;
  });
  assert.ok(script);
});
after(async () => {
  await Promise.all([real, empty, missing, fake].filter(Boolean).map(mesh => mesh.stop()));
});

describe('only the owner browser crosses', {skip}, () => {
  test('no cookie, a wrong cookie, the master Bearer token and a session token are 401 on every route', async () => {
    for (const [method, route] of ROUTES) {
      const body = method === 'POST' ? {expected_revision: 0} : undefined;
      assert.equal((await call(real, method, route, {body, cookie: null})).status, 401, `${method} ${route}`);
      assert.equal((await call(real, method, route, {body, cookie: `mesh_auth=${'0'.repeat(64)}`})).status, 401);
      // The master token alone, and alongside a valid cookie: consent is a browser decision.
      const bearer = {Authorization: `Bearer ${real.token()}`};
      assert.equal((await call(real, method, route, {body, cookie: null, headers: bearer})).status, 401);
      assert.equal((await call(real, method, route, {body, headers: bearer})).status, 401);
      assert.equal((await call(real, method, route, {body, headers: {Authorization: 'MeshSession forged.token'}})).status, 401);
    }
  });

  test('an empty or all-space Authorization header beside the valid cookie is 401 too', async () => {
    for (const [method, route] of ROUTES) {
      for (const value of ['', '   ']) {
        const reply = await rawCall(real, method, route, {Authorization: value});
        assert.equal(reply, 401, `${method} ${route} Authorization=${JSON.stringify(value)}`);
      }
    }
  });

  test('a foreign Origin is refused with the bare 403, reads included', async () => {
    for (const [method, route] of ROUTES) {
      const body = method === 'POST' ? {expected_revision: 0} : undefined;
      const reply = await call(real, method, route, {body, headers: {Origin: 'http://evil.example'}});
      assert.equal(reply.status, 403, `${method} ${route}`);
      assert.equal(reply.json, null, 'the refusal happens before the helper runs');
      // A browser request another site started, even without an Origin header.
      const site = await call(real, method, route, {body, headers: {Origin: '', 'Sec-Fetch-Site': 'cross-site'}});
      assert.equal(site.status, 403, `${method} ${route} cross-site`);
    }
  });

  test('an unknown method or path, and profiles.resolve, are not served', async () => {
    for (const [method, route] of [['PUT', '/api/accounts/profiles'], ['POST', '/api/accounts/profiles'],
      ['GET', '/api/accounts/consent/reset'], ['DELETE', '/api/accounts/consent']]) {
      assert.equal((await call(real, method!, route!, {body: method === 'GET' ? undefined : {}})).status, 405, `${method} ${route}`);
    }
    for (const route of ['/api/accounts/profiles/resolve', '/api/accounts/resolve', '/api/accounts/consent/resolve']) {
      for (const method of ['GET', 'POST']) {
        const reply = await call(real, method, route, {body: method === 'POST' ? {id: 'alpha', backend: 'claude', expected_context: null} : undefined});
        assert.equal(reply.status, 404, `${method} ${route}`);
      }
    }
    // Naming the operation in a body never selects it: the helper's --http mode refuses `op` and `version`.
    const named = await call(real, 'POST', '/api/accounts/consent/set-global',
      {body: {op: 'profiles.resolve', id: 'alpha', backend: 'claude', expected_context: null}});
    envelope(named, 400, 'invalid-request');
  });
});

describe('the request is bounded before the helper runs', {skip}, () => {
  test('a body over 16 KiB is 413 request-too-large', async () => {
    const reply = await call(real, 'POST', '/api/accounts/consent/set-global',
      {body: {expected_revision: 0, confirmation: 'ask', pad: 'x'.repeat(17 * 1024)}});
    envelope(reply, 413, 'request-too-large');
  });

  test('malformed JSON, a non-object body, a query and a wrong content type are refused', async () => {
    envelope(await call(real, 'POST', '/api/accounts/consent/reset', {body: '{"expected_revision":'}), 400, 'invalid-request');
    envelope(await call(real, 'POST', '/api/accounts/consent/reset', {body: '[]'}), 400, 'invalid-request');
    envelope(await call(real, 'POST', '/api/accounts/consent/reset', {body: ''}), 400, 'invalid-request');
    envelope(await call(real, 'GET', '/api/accounts/profiles?private=1'), 400, 'invalid-request');
    const form = await call(real, 'POST', '/api/accounts/consent/reset',
      {body: 'expected_revision=0', headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
    envelope(form, 415, 'unsupported-media-type');
  });
});

describe('the helper envelope is relayed with its own status', {skip}, () => {
  test('profiles.list lists ids and labels only, never a folder, and qualifies no switch', async () => {
    const reply = await call(real, 'GET', '/api/accounts/profiles');
    envelope(reply, 200);
    assert.equal(reply.json.data.configured, true);
    assert.match(reply.json.data.registry_revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(reply.json.data.profiles.map((p: any) => `${p.backend}:${p.id}:${p.label}`),
      ['claude:alpha:Alpha', 'claude:beta:Beta', 'codex:alpha:Alpha']);
    for (const profile of reply.json.data.profiles) {
      assert.deepEqual(Object.keys(profile).sort(), PUBLIC_KEYS);
      assert.equal(profile.switch_qualified, false);
    }
  });

  test('every write op, then a stale revision (409) and each coded refusal with its status', async () => {
    const policy = await call(real, 'GET', '/api/accounts/consent');
    envelope(policy, 200);
    assert.deepEqual(policy.json.data, {version: 1, revision: 0, global: 'ask', pairs: []});
    const list = (await call(real, 'GET', '/api/accounts/profiles')).json.data;
    const pair = {backend: 'claude', source_id: 'alpha', target_id: 'beta'};
    const write = (route: string, body: object) => call(real, 'POST', `/api/accounts/consent/${route}`, {body});
    let reply = await write('set-global', {expected_revision: 0, confirmation: 'skip'});
    envelope(reply, 200);
    assert.deepEqual([reply.json.data.revision, reply.json.data.global], [1, 'skip']);
    reply = await write('set-pair', {...pair, expected_revision: 1, registry_revision: list.registry_revision, confirmation: 'ask'});
    envelope(reply, 200);
    assert.equal(reply.json.data.pairs.length, 1);
    assert.equal(reply.json.data.pairs[0].confirmation, 'ask');
    envelope(await write('set-global', {expected_revision: 0, confirmation: 'ask'}), 409, 'consent-revision-conflict');
    envelope(await write('set-pair', {...pair, expected_revision: 2, registry_revision: '0'.repeat(64), confirmation: 'ask'}),
      409, 'profile-registry-changed');
    envelope(await write('set-pair', {...pair, target_id: 'gamma', expected_revision: 2, registry_revision: list.registry_revision,
      confirmation: 'ask'}), 404, 'unknown-profile');
    envelope(await write('remove-pair', {...pair, target_id: 'alpha', expected_revision: 2}), 400, 'invalid-account-pair');
    envelope(await write('set-global', {expected_revision: 2, confirmation: 'ask', extra: true}), 400, 'invalid-request');
    reply = await write('remove-pair', {...pair, expected_revision: 2});
    envelope(reply, 200);
    assert.deepEqual([reply.json.data.revision, reply.json.data.pairs], [3, []]);
    reply = await write('reset', {expected_revision: 3});
    envelope(reply, 200);
    assert.deepEqual([reply.json.data.revision, reply.json.data.global], [4, 'ask']);
    envelope(await call(real, 'GET', '/api/accounts/consent'), 200);
  });

  test('without a registry: configured false, and a pair is 404 profiles-unconfigured', async () => {
    const list = await call(empty, 'GET', '/api/accounts/profiles');
    envelope(list, 200);
    assert.deepEqual(list.json.data, {configured: false, registry_revision: null, profiles: []});
    envelope(await call(empty, 'POST', '/api/accounts/consent/set-pair', {body: {backend: 'claude', source_id: 'alpha',
      target_id: 'beta', expected_revision: 0, registry_revision: '0'.repeat(64), confirmation: 'skip'}}), 404, 'profiles-unconfigured');
  });
});

describe('fail closed', {skip}, () => {
  test('a missing helper is 503 backend-helper-unavailable on every route', async () => {
    for (const [method, route] of ROUTES) {
      envelope(await call(missing, method, route, {body: method === 'POST' ? {expected_revision: 0} : undefined}),
        503, 'backend-helper-unavailable');
    }
  });

  const mode = (name: string) => fs.writeFileSync(path.join(fakeDir, 'mode'), name);
  for (const [name, route] of [['garbage', '/api/accounts/consent'], ['mismatch', '/api/accounts/consent'],
    ['exitcode', '/api/accounts/consent'], ['status', '/api/accounts/consent'], ['extra', '/api/accounts/consent'],
    ['roots', '/api/accounts/profiles'], ['nonewline', '/api/accounts/consent'], ['beside', '/api/accounts/profiles'],
    ['secret', '/api/accounts/consent'], ['pairpath', '/api/accounts/consent'], ['revision', '/api/accounts/consent'],
    ['dupdata', '/api/accounts/consent'], ['types', '/api/accounts/consent'], ['codestatus', '/api/accounts/consent']]) {
    test(`a helper answer that is not its envelope (${name}) is 503, never relayed`, async () => {
      mode(name!);
      const reply = await call(fake, 'GET', route!);
      envelope(reply, 503, 'backend-helper-unavailable');
      assert.doesNotMatch(reply.text, /roots|detail|teapot|secret|\/x/);
    });
  }

  test('a write op whose data is not the policy is 503 too: each consent op has the closed policy shape', async () => {
    mode('secret');
    for (const route of Object.keys(WRITES)) {
      const reply = await call(fake, 'POST', route, {body: {expected_revision: 0}});
      envelope(reply, 503, 'backend-helper-unavailable');
      assert.doesNotMatch(reply.text, /secret/);
    }
  });

  test('the helper outlasts its own store busy timeout: its coded answer is relayed, not a server 503', async () => {
    mode('storebusy');
    envelope(await call(fake, 'POST', '/api/accounts/consent/reset', {body: {expected_revision: 0}}), 503, 'backend-store-unavailable');
  });

  test('a burst beyond four running and eight waiting is 503 busy at once, the rest is served', async () => {
    mode('hold');
    const replies = await Promise.all(Array.from({length: 16}, () => call(fake, 'GET', '/api/accounts/consent')));
    const busy = replies.filter(reply => reply.status === 503);
    for (const reply of busy) envelope(reply, 503, 'busy');
    assert.equal(busy.length, 4, replies.map(reply => reply.status).join(' '));
    for (const reply of replies.filter(reply => reply.status !== 503)) envelope(reply, 200);
  });

  test('a refusal keeps its status: a 409 is never turned into a 200', async () => {
    mode('conflict');
    envelope(await call(fake, 'POST', '/api/accounts/consent/reset', {body: {expected_revision: 0}}), 409, 'consent-revision-conflict');
    mode('ok');
    envelope(await call(fake, 'POST', '/api/accounts/consent/reset', {body: {expected_revision: 0}}), 200);
  });

  test('a helper that does not answer in time is 503, and its process is gone', async () => {
    mode('sleep');
    const started = performance.now();
    envelope(await call(fake, 'GET', '/api/accounts/consent'), 503, 'backend-helper-unavailable');
    assert.ok(performance.now() - started < 15000);
    const pid = Number(fs.readFileSync(path.join(fakeDir, 'pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  test('a helper that does not answer in time takes its whole process group: its child is gone too', async () => {
    mode('orphan');
    envelope(await call(fake, 'GET', '/api/accounts/consent'), 503, 'backend-helper-unavailable');
    const child = Number(fs.readFileSync(path.join(fakeDir, 'child'), 'utf8'));
    const alive = () => { try { return process.kill(child, 0); } catch (error: any) { if (error.code === 'ESRCH') return false; throw error; } };
    for (let waited = 0; alive() && waited < 3000; waited += 100) await new Promise(done => setTimeout(done, 100));
    assert.equal(alive() && process.kill(child, 'SIGKILL'), false, 'the helper child outlived the timeout');
  });
});

// A helper reply written to ./answer: a public listing or a consent policy with one field changed.
const DIGEST = 'c'.repeat(64);
const answer = (data: object) => JSON.stringify({http_status: 200, version: 1, ok: true, data});
const profile = (change: object) => ({id: 'alpha', label: 'Alpha', backend: 'claude', enabled: true,
  context_revision: DIGEST, switch_qualified: false, ...change});
const listing = (change = {}, top = {}) => answer({configured: true, registry_revision: DIGEST, profiles: [profile(change)], ...top});
const policy = (a: object = {}, b: object = {}) => answer({version: 1, revision: 1, global: 'ask', pairs: [{
  a: {backend: 'claude', id: 'alpha', context_revision: DIGEST, ...a},
  b: {backend: 'claude', id: 'beta', context_revision: DIGEST, ...b}, confirmation: 'skip'}]});
function answered(route: string, text: string): Promise<Reply> {
  for (const [name, value] of [['answer', `${text}\n`], ['mode', 'file']]) fs.writeFileSync(path.join(fakeDir, name!), value!);
  return call(fake, 'GET', route);
}

describe('the relayed data has the types and ids the helper gives', {skip}, () => {
  test('a well-formed listing and policy are relayed', async () => {
    for (const text of [listing(), listing({id: 'a'.repeat(32), enabled: false})]) envelope(await answered('/api/accounts/profiles', text), 200);
    for (const text of [policy(), policy({id: 'a-0'}, {id: 'z'.repeat(32)})]) envelope(await answered('/api/accounts/consent', text), 200);
  });

  for (const [name, text] of [
    ['configured is a folder', listing({}, {configured: '/home/u/secret'})],
    ['configured is NaN', listing({}, {configured: 'NAN'}).replace('"NAN"', 'NaN')],
    ['configured is 1', listing({}, {configured: 1})],
    ['registry_revision is an object', listing({}, {registry_revision: {roots: {config: '/x'}}})],
    ['registry_revision is upper-case hex', listing({}, {registry_revision: 'C'.repeat(64)})],
    ['registry_revision is 63 hex digits', listing({}, {registry_revision: 'c'.repeat(63)})],
    ['enabled is 1', listing({enabled: 1})], ['enabled is a string', listing({enabled: 'true'})],
    ['backend is unknown', listing({backend: '/x'})], ['id is a path', listing({id: '/x'})],
    ['id is the reserved one', listing({id: 'default'})], ['context_revision is not a digest', listing({context_revision: '0'})],
    ['switch_qualified is true (the route never claims a switch)', listing({switch_qualified: true})],
  ]) {
    test(`profiles.list: ${name} is 503, never relayed`, async () => {
      const reply = await answered('/api/accounts/profiles', text!);
      envelope(reply, 503, 'backend-helper-unavailable');
      assert.doesNotMatch(reply.text, /secret|\/x|NaN/);
    });
  }

  for (const [name, text] of [
    ['an id that is a path', policy({id: '/x'})], ['a 900 KB id', policy({id: 'a'.repeat(900_000)})],
    ['an id of 33 characters', policy({id: 'a'.repeat(33)})], ['a lone surrogate', policy({id: '\ud800'})],
    ['a control character', policy({id: 'al\u0007pha'})], ['an upper-case id', policy({id: 'Alpha'})],
    ['the reserved id', policy({id: 'default'})], ['an empty id', policy({id: ''})],
    ['a pair of one account', policy({}, {id: 'alpha'})], ['a pair across backends', policy({}, {backend: 'codex'})],
    ['a context revision that is not a digest', policy({context_revision: '0'})],
  ]) {
    test(`consent: ${name} is 503, never relayed`, async () => {
      const reply = await answered('/api/accounts/consent', text!);
      envelope(reply, 503, 'backend-helper-unavailable');
      assert.doesNotMatch(reply.text, /\/x|aaaa|alpha/);
    });
  }

  test('the server accepts exactly the ids the helper accepts', async () => {
    const helper: Record<string, boolean> = {}, server: Record<string, boolean> = {};
    for (const id of ['alpha', 'a', '-', '0', 'a-b', 'a'.repeat(32), 'a'.repeat(33), 'default', 'Default', 'defaults',
      'Alpha', 'a_b', 'a.b', 'a b', '/x', '../x', '\u00e9', '\ud800', 'a\u0007', 'a\u2028', 'a\n', '']) {
      // The helper checks both ids before the registry digest: a valid id reaches profile-registry-changed.
      const reply = await call(real, 'POST', '/api/accounts/consent/set-pair', {body: {backend: 'claude', source_id: id,
        target_id: 'zz-other', expected_revision: 0, registry_revision: '0'.repeat(64), confirmation: 'ask'}});
      assert.ok([400, 409].includes(reply.status), reply.text);
      helper[JSON.stringify(id)] = reply.json?.code === 'profile-registry-changed';
      server[JSON.stringify(id)] = (await answered('/api/accounts/consent', policy({id}, {id: 'zz-other'}))).status === 200;
    }
    assert.deepEqual(server, helper);
    assert.ok(Object.values(helper).includes(true) && Object.values(helper).includes(false));
  });
});

describe('the helper runs as a closed argv with a scrubbed environment', {skip}, () => {
  test('argv is --http <op>, the body is passed unchanged, the environment names only the config folder', async () => {
    fs.writeFileSync(path.join(fakeDir, 'mode'), 'ok');
    const body = '{"expected_revision":7,"confirmation":"ask"}';
    envelope(await call(fake, 'POST', '/api/accounts/consent/set-global', {body}), 200);
    assert.equal(fs.readFileSync(path.join(fakeDir, 'argv'), 'utf8'), '--http\nconsent.set_global\n');
    assert.equal(fs.readFileSync(path.join(fakeDir, 'stdin'), 'utf8'), body);
    const env = fs.readFileSync(path.join(fakeDir, 'env'), 'utf8');
    assert.ok(!env.includes(SENTINEL), 'a server variable reached the helper');
    assert.match(env, new RegExp(`^MESH_CONF_DIR=${fake.confDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    const names = env.split('\n').filter(Boolean).map(line => line.split('=')[0]!);
    assert.deepEqual(names.filter(name => /^(MESH_|HOME$|XDG_|ANTHROPIC|OPENAI|CLAUDE|CODEX)/.test(name)), ['MESH_CONF_DIR']);
    fs.writeFileSync(path.join(fakeDir, 'mode'), 'list');
    envelope(await call(fake, 'GET', '/api/accounts/profiles'), 200);
    assert.equal(fs.readFileSync(path.join(fakeDir, 'argv'), 'utf8'), '--http\nprofiles.list\n');
    assert.equal(fs.readFileSync(path.join(fakeDir, 'stdin'), 'utf8'), '{}');
  });
});

/** server.py's code -> status table, whatever its spacing or quoting; an entry it cannot read is a failure. */
function serverCodes(source: string): Record<string, number> {
  const block = /_ACCOUNTS_CODE_STATUS = \{([\s\S]*?)\}/.exec(source)?.[1] ?? '';
  const entries = [...block.matchAll(/["']([a-z0-9-]+)["']\s*:\s*(\d{3})/g)];
  assert.equal(entries.length, [...block.matchAll(/["'][^"']*["']/g)].length, `unread entries in ${block}`);
  return Object.fromEntries(entries.map(m => [m[1], Number(m[2])]));
}

describe('scope', {skip}, () => {
  test('the code table is read whatever its spacing or quoting', () => {
    assert.deepEqual(serverCodes(`_ACCOUNTS_CODE_STATUS = {\n "a-b": 409,"x":409, 'y' :404,\n\t"z"\n:\t400}`), {'a-b': 409, x: 409, y: 404, z: 400});
  });

  test('no response named a folder of the throwaway homes', () => {
    assert.ok(seen.length > 40);
    for (const mesh of [real, empty, missing, fake]) {
      for (const folder of new Set([mesh.scratch, fs.realpathSync(mesh.scratch)])) {
        assert.ok(!seen.some(text => text.includes(folder)), `a response named ${folder}`);
      }
    }
  });

  test('server.py runs mesh-profile from the accounts routes only, never from a session action or a switch', () => {
    const source = fs.readFileSync(path.join(REPO, 'server.py'), 'utf8');
    assert.equal(source.match(/work_command\("mesh-profile"\)/g)?.length, 1);
    const lines = source.split('\n');
    const callers = lines.flatMap((line, index) => {
      if (!line.includes('_profile_run(') || /^(async )?def _profile_run\(/.test(line)) return [];
      const owner = lines.slice(0, index).reverse().find(above => /^(async )?def /.test(above));
      return [/def (\w+)/.exec(owner ?? '')?.[1]];
    });
    assert.deepEqual(callers, ['api_accounts']);
    assert.doesNotMatch(source, /"profiles\.resolve"/, 'profiles.resolve is never named by the server');
  });

  test('the server knows each refusal code under the status the helper gives it, no more and no less', () => {
    const ocaml = fs.readFileSync(path.join(REPO, 'ocaml/bin/mesh_profile_main.ml'), 'utf8');
    const mapping = /let http_status = function([\s\S]*?)\| Error _ -> 503/.exec(ocaml)?.[1] ?? '';
    const helper: Record<string, number> = {};
    for (const arm of mapping.split(/\|\s*Error\b/).slice(1)) {
      const status = Number(/->\s*(\d{3})/.exec(arm)?.[1]);
      for (const code of arm.matchAll(/"([a-z0-9-]+)"/g)) helper[code[1]!] = status;
    }
    const server = serverCodes(fs.readFileSync(path.join(REPO, 'server.py'), 'utf8'));
    assert.ok(Object.keys(helper).length >= 14, JSON.stringify(helper));
    assert.deepEqual(server, helper);
  });
});
