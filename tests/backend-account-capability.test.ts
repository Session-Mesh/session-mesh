// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Run the actual app's narrow capability/lifecycle block with controlled responses.
// Unlike a browser fetch, these response bodies deliberately ignore cancellation:
// the late-body tests exercise the app's fence, not just Chromium's abort behavior.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const block = app.slice(app.indexOf('let backendAccountPanel = null;'), app.indexOf('// Local transport owns local account navigation.'));
assert.ok(block.startsWith('let backendAccountPanel = null;') && block.includes('whenTranslated('));
const lifecycle = app.slice(app.indexOf('let meshContext = null;'), app.indexOf('// The work view\'s bundle once loaded'));

function fixture(request: (url: string, init: RequestInit) => Promise<unknown>) {
  const entries = [{hidden: true}, {hidden: true}], retries = [{hidden: true}, {hidden: true}];
  const handlers: Record<string, () => void> = {};
  let panels = 0, opened = 0, disposed = 0, timeout: (() => void) | undefined;
  const context = vm.createContext({AbortController, t: (key: string) => key,
    fetch: request, document: {body: {}, querySelectorAll: (selector: string) => selector.includes('retry') ? retries : entries},
    $: (selector: string) => ({addEventListener: (_event: string, handler: () => void) => { handlers[selector] = handler; }}),
    whenTranslated: () => undefined,
    setTimeout: (callback: () => void) => { timeout = callback; return 1; }, clearTimeout: () => { timeout = undefined; },
    MeshPaneActions: {
      createBackendAccountApi: () => ({}),
      createBackendAccountPanel: () => { panels++; return {open() { opened++; }, dispose() { disposed++; }}; },
    },
  });
  vm.runInContext(lifecycle + block, context);
  return {entries, retries, panels: () => panels, opened: () => opened, disposed: () => disposed,
    run: (code: string) => vm.runInContext(code, context), click: () => handlers['#btn-accounts']!(), expire: () => timeout!()};
}
const response = (value: unknown, status = 200, contentType = 'application/json') => ({
  ok: status === 200, headers: new Headers({'Content-Type': contentType}), json: async () => value,
});
const enabled = {capabilities: {account_settings: true}};

test('capability check uses local lifecycle and explicit true only, never account probes or fallback', async () => {
  for (const value of [{}, null, {capabilities: {}}, {capabilities: {account_settings: false}},
    {capabilities: {account_settings: 'true'}}, {capabilities: {account_settings: 1}}, enabled]) {
    const requests: [string, RequestInit][] = [];
    const lab = fixture(async (url, init) => { requests.push([url, init]); return response(value); });
    await lab.run('startBackendAccountSettings()'); lab.click();
    assert.equal(requests.length, 0); assert.equal(lab.panels(), 0);
    lab.run('meshContext = Object.freeze({});'); await lab.run('startBackendAccountSettings()');
    assert.equal(requests.length, 1); const [url, init] = requests[0]!;
    assert.equal(url, '/api/config'); assert.equal(init.body, undefined);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.mode, 'same-origin');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(lab.panels(), value === enabled ? 1 : 0);
    assert.deepEqual(lab.entries.map(e => e.hidden), value === enabled ? [false, false] : [true, true]);
    assert.deepEqual(lab.retries.map(e => e.hidden), [true, true]);
    lab.run('meshStopped = true; disposeBackendAccountSettings();'); lab.click();
    await lab.run('startBackendAccountSettings()');
    assert.equal(requests.length, 1); assert.deepEqual(lab.entries.map(e => e.hidden), [true, true]);
    assert.equal(lab.opened(), 0); assert.equal(lab.disposed(), value === enabled ? 1 : 0);
  }
});

test('refused, malformed, non-JSON and failed config reads leave both entries hidden', async () => {
  for (const read of [
    async () => response(enabled, 401), async () => response(enabled, 403), async () => response(enabled, 503),
    async () => response(enabled, 200, 'text/html'),
    async () => ({...response(enabled), json: async () => { throw new Error('malformed'); }}),
    async () => { throw new Error('unavailable'); },
  ]) {
    const lab = fixture(read); lab.run('meshContext = {};'); await lab.run('startBackendAccountSettings()');
    assert.equal(lab.panels(), 0); assert.deepEqual(lab.entries.map(e => e.hidden), [true, true]);
    assert.deepEqual(lab.retries.map(e => e.hidden), [false, false]);
  }
});

test('disposal or timeout fences a late capability body even when the transport ignores abort', async () => {
  for (const reason of ['dispose', 'timeout']) {
    let finish!: (value: unknown) => void, signal!: AbortSignal;
    const body = new Promise(resolve => { finish = resolve; });
    const lab = fixture(async (_url, init) => { signal = init.signal!; return {...response(enabled), json: () => body}; });
    lab.run('meshContext = {};'); const pending = lab.run('startBackendAccountSettings()');
    await Promise.resolve();
    if (reason === 'dispose') lab.run('disposeBackendAccountSettings();'); else lab.expire();
    assert.equal(signal.aborted, true);
    finish({...enabled, private_marker: 'not-public'}); await pending;
    assert.equal(lab.panels(), 0); assert.deepEqual(lab.entries.map(e => e.hidden), [true, true]);
  }
});

test('a newer observed negative config fences an older in-flight positive startup body', async () => {
  let finish!: (value: unknown) => void;
  const body = new Promise(resolve => { finish = resolve; });
  const lab = fixture(async () => ({...response(enabled), json: () => body}));
  lab.run('meshContext = {};');
  const pending = lab.run('startBackendAccountSettings()');
  await Promise.resolve();
  lab.run('observeBackendAccountConfig({capabilities: {account_settings: false}})');
  finish(enabled); await pending;
  assert.equal(lab.panels(), 0);
  assert.deepEqual(lab.entries.map(e => e.hidden), [true, true]);
  lab.run('observeBackendAccountConfig({capabilities: {account_settings: true}})');
  assert.equal(lab.panels(), 1);
  assert.deepEqual(lab.entries.map(e => e.hidden), [false, false]);
});

test('static desktop and mobile account entries are hidden even before JavaScript starts', () => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  for (const match of ['id="btn-accounts"', 'data-mobile-action="btn-accounts"']) {
    const tag = html.split('\n').find(line => line.includes(match));
    assert.ok(tag); assert.match(tag, /\bhidden\b/);
  }
});
