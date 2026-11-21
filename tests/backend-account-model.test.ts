// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BACKENDS, parseProfilesReply, parsePolicyReply, effectiveConfirmation, pairKey,
  createBackendAccountController, type Backend, type Profile, type Policy} from '../static/backend-account-model.ts';

const digest = 'a'.repeat(64);
const reply = (data: unknown) => ({version: 1, ok: true, data});
const profile = (id: string, backend: Backend = 'claude'): Profile =>
  ({backend, id, label: id, context_revision: digest, enabled: true, switch_qualified: false});
const policy = (global: 'ask' | 'skip' = 'ask'): Policy => ({version: 1, revision: 0, global, pairs: []});
const listing = (profiles = [profile('a'), profile('b'), profile('c')]) =>
  reply({configured: true, registry_revision: digest, profiles});
const defer = () => { let resolve!: (v: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return {promise, resolve}; };

test('strict public schemas accept all four backend-qualified namespaces, never private fields', () => {
  const profiles = BACKENDS.flatMap(backend => [profile('a', backend), profile('b', backend)]);
  assert.equal(parseProfilesReply(listing(profiles)).profiles.length, 8);
  for (const extra of [{roots: {}}, {credentials: 'private'}, {path: '/private'}]) {
    assert.throws(() => parseProfilesReply(listing([{...profile('a'), ...extra}])));
  }
  for (const bad of [{...profile('a'), backend: 'shell'}, {...profile('a'), id: 'default'},
    {...profile('a'), context_revision: 'unknown'}, {...profile('a'), id: 'a\n'}, {...profile('a'), context_revision: digest + '\n'}, {...profile('a'), switch_qualified: 'yes'},
    {...profile('a'), label: '\ninvalid'}, {...profile('a'), label: '\ud800'}]) {
    assert.throws(() => parseProfilesReply(listing([bad as Profile])));
  }
  assert.throws(() => parseProfilesReply(listing([profile('a'), {...profile('b'), label: 'A'}])));
  assert.throws(() => parseProfilesReply({...listing(), version: 2}));
  assert.throws(() => parseProfilesReply({...listing(), credentials: 'private'}));
  assert.throws(() => parseProfilesReply(reply({configured: false, registry_revision: null, profiles: [profile('a')]})));
  assert.deepEqual(parseProfilesReply(reply({configured: false, registry_revision: null, profiles: []})).profiles, []);
  assert.throws(() => parsePolicyReply(reply({...policy(), revision: Number.MAX_SAFE_INTEGER + 1})));
  assert.throws(() => parsePolicyReply(reply({...policy(), version: 2})));
  const a = {backend: 'claude', id: 'a', context_revision: digest}, b = {...a, id: 'b'};
  for (const pairs of [[{a, b: a, confirmation: 'skip'}], [{a, b: {...b, backend: 'pi'}, confirmation: 'skip'}],
    [{a: {...a, roots: {}}, b, confirmation: 'ask'}], [{a, b, confirmation: 'unknown'}]]) {
    assert.throws(() => parsePolicyReply(reply({...policy(), pairs})));
  }
});

test('public labels match the canonical alias Unicode rules', () => {
  for (const label of ['é'.repeat(24), '😀'.repeat(24), '界'.repeat(24), 'A\u00a0']) {
    assert.equal(parseProfilesReply(listing([{...profile('a'), label}])).profiles[0]!.label, label);
  }
  for (const label of ['x'.repeat(25), '😀'.repeat(25), 'ab\u202e', 'ab\u200b', ' Work ', '\u00a0']) {
    assert.throws(() => parseProfilesReply(listing([{...profile('a'), label}])));
  }
});

test('pairs are unordered, backend-scoped and nontransitive; stale Skip falls back, stale Ask restricts', () => {
  for (const backend of BACKENDS) {
    const a = profile('a', backend), b = profile('b', backend), c = profile('c', backend);
    const registry = parseProfilesReply(listing([a, b, c]));
    const p: Policy = {...policy(), pairs: [{a, b, confirmation: 'skip'}]};
    assert.equal(pairKey(a, b), pairKey(b, a));
    assert.equal(effectiveConfirmation(p, registry, b, a), 'skip');
    assert.equal(effectiveConfirmation(p, registry, a, c), 'ask');
    const changed = {...a, context_revision: 'b'.repeat(64)}, changedRegistry = parseProfilesReply(listing([changed, b, c]));
    assert.equal(effectiveConfirmation(p, changedRegistry, changed, b), 'ask');
    assert.throws(() => effectiveConfirmation(p, registry, changed, b));
    assert.throws(() => effectiveConfirmation(p, registry, profile('unknown', backend), b));
    const strict: Policy = {...p, global: 'skip', pairs: [{a, b, confirmation: 'ask'}]};
    assert.equal(effectiveConfirmation(strict, changedRegistry, changed, b), 'ask');
    assert.throws(() => effectiveConfirmation(p, registry, a, a));
    assert.throws(() => effectiveConfirmation(p, registry, a, profile('b', backend === 'pi' ? 'codex' : 'pi')));
    assert.throws(() => parsePolicyReply(reply({...p, pairs: [p.pairs[0], {a: b, b: a, confirmation: 'ask'}]})));
    // Native policy references have exactly these three fields (not public profile fields).
    const ref = ({backend, id, context_revision}: Profile) => ({backend, id, context_revision});
    assert.equal(parsePolicyReply(reply({...p, pairs: [{a: ref(a), b: ref(b), confirmation: 'skip'}]})).pairs.length, 1);
    assert.throws(() => parsePolicyReply(reply(p)));
  }
});

test('opening/selecting is read-only; mutations carry explicit native scope/revisions and validate their reply', async () => {
  let current = policy('skip'); const calls: unknown[] = [];
  const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(current)}),
    mutate: async request => { calls.push(request); current = {...current, revision: current.revision + 1, global: request.op === 'consent.reset' ? 'ask' : current.global}; return reply(current); }});
  await controller.open();
  assert.equal(calls.length, 0);
  assert.equal(await controller.savePair(profile('missing'), profile('b'), 'ask'), false);
  assert.equal(await controller.savePair(profile('a', 'pi'), profile('b'), 'ask'), false);
  assert.equal(await controller.savePair({...profile('a'), context_revision: 'b'.repeat(64)}, profile('b'), 'ask'), false);
  assert.equal(calls.length, 0);
  assert.equal(await controller.reset(), true);
  assert.deepEqual(calls, [{version: 1, op: 'consent.reset', expected_revision: 0}]);
  assert.equal(controller.state.snapshot?.policy.global, 'ask');
  controller.close();
});

test('set/remove canonicalize IDs; retired rules can be removed without a registry revision', async () => {
  const a = profile('a'), b = profile('b');
  const ref = ({backend, id, context_revision}: Profile) => ({backend, id, context_revision});
  let current: Policy = policy(); const calls: unknown[] = [];
  const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(current)}), mutate: async request => {
    calls.push(request);
    current = {...current, revision: current.revision + 1, pairs: request.op === 'consent.set_pair' ? [{a: ref(a), b: ref(b), confirmation: 'ask'}] : []};
    return reply(current);
  }});
  await controller.open();
  assert.equal(await controller.savePair(b, a, 'ask'), true);
  assert.deepEqual(calls[0], {version: 1, op: 'consent.set_pair', backend: 'claude', source_id: 'a', target_id: 'b',
    registry_revision: digest, expected_revision: 0, confirmation: 'ask'});
  assert.equal(await controller.removePair(current.pairs[0]!), true);
  assert.deepEqual(calls[1], {version: 1, op: 'consent.remove_pair', backend: 'claude', source_id: 'a', target_id: 'b', expected_revision: 1});
  controller.close();
});

test('conflicts require an explicit refresh/review, never retry; errors do not echo private diagnostics', async () => {
  for (const code of ['consent-revision-conflict', 'profile-registry-changed', 'unknown-profile']) {
    let mutations = 0;
    const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(policy())}),
      mutate: async () => { mutations++; return {version: 1, ok: false, code}; }});
    await controller.open();
    assert.equal(await controller.saveGlobal('skip'), false);
    assert.equal(controller.state.phase, 'conflict');
    assert.equal(await controller.saveGlobal('skip'), false);
    assert.equal(mutations, 1);
    await controller.refresh();
    assert.equal(controller.state.phase, 'ready');
    controller.close();
  }
  assert.throws(() => parsePolicyReply({version: 1, ok: false, code: '/private/credentials'}), /invalid-response/);
});

test('writes are single-flight; late responses after close/reopen cannot change the current generation', async () => {
  const pending = defer(); let loads = 0; let mutations = 0;
  const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply({...policy(), revision: loads++})}),
    mutate: async () => { mutations++; return pending.promise; }});
  await controller.open();
  const write = controller.saveGlobal('skip');
  assert.equal(controller.state.phase, 'saving');
  assert.equal(await controller.reset(), false);
  assert.equal(mutations, 1);
  controller.close(); await controller.open();
  pending.resolve(reply({...policy('skip'), revision: 1}));
  await write;
  assert.equal(controller.state.snapshot?.policy.global, 'ask');
  assert.equal(controller.state.snapshot?.policy.revision, 1);
  assert.equal(mutations, 1);
  controller.close();
});

test('late loads, malformed mutation success and bounded uncertain writes fail closed', async () => {
  const old = defer(); let count = 0;
  const controller = createBackendAccountController({load: async () => ++count === 1 ? old.promise as never : {profiles: listing(), policy: reply(policy())},
    mutate: async () => reply({...policy('skip'), revision: 9})});
  const first = controller.open(); await Promise.resolve(); controller.close(); await controller.open();
  old.resolve({profiles: listing(), policy: reply({...policy('skip'), revision: 3})}); await first;
  assert.equal(controller.state.snapshot?.policy.global, 'ask');
  assert.equal(await controller.saveGlobal('skip'), false);
  assert.equal(controller.state.phase, 'error');
  controller.close();
  const timeout = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(policy())}),
    mutate: async () => new Promise(() => undefined), timeoutMs: 10});
  await timeout.open(); assert.equal(await timeout.reset(), false);
  assert.equal(timeout.state.phase, 'error'); assert.equal(await timeout.reset(), false); timeout.close();
});
