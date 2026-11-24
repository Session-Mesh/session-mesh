// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {test} from 'node:test';

// Exercise the actual app discovery functions without starting a browser or a server.
function fixture() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../static/app.js'), 'utf8');
  const begin = source.indexOf('let backendAccountPanel = null;');
  const end = source.indexOf('whenTranslated(() => { void startBackendAccountSettings(); });', begin);
  assert(begin >= 0 && end > begin);
  const entries = [{hidden: true, focused: false, focus() { this.focused = true; }},
    {hidden: true, focused: false, focus() { this.focused = true; }}];
  const retry = [{hidden: true}, {hidden: true}];
  const document = {body: {}, activeElement: null as null | {matches(selector: string): boolean},
    querySelectorAll: (selector: string) => selector.includes('#btn-accounts-retry') ? retry : entries,
    querySelector: (selector: string) => selector === '#btn-accounts' ? entries[0] : entries[1]};
  const calls: string[] = [];
  let request: () => Promise<unknown> = async () => { throw Error('offline'); };
  const sandbox = {AbortController, setTimeout, clearTimeout, document,
    localMeshEffectsAllowed: () => true,
    requestLocal: () => { calls.push('GET /api/config'); return request(); },
    MeshPaneActions: {createBackendAccountApi: () => ({}), createBackendAccountPanel: () => {
      calls.push('create panel'); return {dispose: () => calls.push('dispose panel')}; }}, t: (s: string) => s};
  const api = vm.runInNewContext(source.slice(begin, end) + `\n({startBackendAccountSettings, observeBackendAccountConfig, disposeBackendAccountSettings})`, sandbox) as {
    startBackendAccountSettings(): Promise<void>; observeBackendAccountConfig(config: unknown): void; disposeBackendAccountSettings(): void;
  };
  return {api, document, entries, retry, calls, respond: (next: typeof request) => {request = next;}};
}
const response = (status: number, value: unknown) => ({ok: status === 200, headers: {get: () => 'application/json'}, json: async () => value});

test('transient discovery failure exposes an explicit retry; a successful retry enables settings', async () => {
  const f = fixture();
  await f.api.startBackendAccountSettings();
  assert(f.retry.every(button => !button.hidden));
  assert(f.entries.every(button => button.hidden));
  f.respond(async () => response(200, {capabilities: {account_settings: true}}));
  await f.api.startBackendAccountSettings();
  assert(f.retry.every(button => button.hidden));
  assert(f.entries.every(button => !button.hidden));
  assert.deepEqual(f.calls, ['GET /api/config', 'GET /api/config', 'create panel']);
  await f.api.startBackendAccountSettings();
  assert.equal(f.calls.length, 3, 'a mounted panel and its drafts are untouched');
});

test('an explicit unsupported capability hides settings and retry', async () => {
  const f = fixture();
  f.respond(async () => response(200, {capabilities: {account_settings: false}}));
  await f.api.startBackendAccountSettings();
  assert(f.retry.every(button => button.hidden));
  assert(f.entries.every(button => button.hidden));
  assert.deepEqual(f.calls, ['GET /api/config']);
});

test('concurrent retry clicks share one request and a disposed late response cannot recreate settings', async () => {
  const f = fixture();
  let complete!: (value: unknown) => void;
  f.respond(() => new Promise(resolve => {complete = resolve;}));
  const first = f.api.startBackendAccountSettings();
  await f.api.startBackendAccountSettings();
  assert.deepEqual(f.calls, ['GET /api/config']);
  f.api.disposeBackendAccountSettings();
  complete(response(200, {capabilities: {account_settings: true}}));
  await first;
  assert(f.retry.every(button => button.hidden));
  assert(f.entries.every(button => button.hidden));
  assert.deepEqual(f.calls, ['GET /api/config']);
});

test('failed or malformed config replies remain retryable without exposing account settings', async () => {
  for (const reply of [response(503, {}), {ok: true, headers: {get: () => 'text/html'}, json: async () => ({})},
    {ok: true, headers: {get: () => 'application/json'}, json: async () => { throw Error('bad JSON'); }}]) {
    const f = fixture(); f.respond(async () => reply);
    await f.api.startBackendAccountSettings();
    assert(f.retry.every(button => !button.hidden));
    assert(f.entries.every(button => button.hidden));
  }
});


test('successful retry moves only its own focused control to the matching settings entry', async () => {
  for (const [selector, index] of [['#btn-accounts-retry', 0], ['[data-mobile-action="btn-accounts-retry"]', 1]] as const) {
    const f = fixture();
    f.document.activeElement = {matches: candidate => candidate === selector};
    f.respond(async () => response(200, {capabilities: {account_settings: true}}));
    await f.api.startBackendAccountSettings();
    assert.equal(f.entries[index].focused, true);
    assert.equal(f.entries[1 - index].focused, false);
  }
  const f = fixture();
  f.document.activeElement = {matches: () => false};
  f.respond(async () => response(200, {capabilities: {account_settings: true}}));
  await f.api.startBackendAccountSettings();
  assert(f.entries.every(button => !button.focused), 'unrelated focus remains untouched');
});
