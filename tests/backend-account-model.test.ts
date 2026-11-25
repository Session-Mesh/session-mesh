// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
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

test('provision neither uses the association transport nor accepts an enabled receipt', async () => {
  let writes = 0, reads = 0;
  const initial = {
    load: async () => { reads++; return {profiles: listing(), policy: reply(policy())}; },
    mutate: async () => reply(policy()),
    create: async () => { assert.fail('provision must not use the association transport'); },
  };
  const withoutPort = createBackendAccountController(initial);
  await withoutPort.open();
  assert.equal(await withoutPort.provisionProfile({backend: 'codex', label: 'New'}), false);
  const controller = createBackendAccountController({...initial,
    inspect: async () => assert.fail('invalid receipt cannot trigger inspection'),
    provision: {backends: ['codex'], write: async request => {
    writes++;
    return reply({registry_revision: 'b'.repeat(64),
      profile: {...profile('p-0123456789abcdef', 'codex'), label: request.profile.label}});
  }}});
  await controller.open();
  assert.equal(await controller.provisionProfile({backend: 'claude', label: 'New'}), false);
  assert.equal(await controller.provisionProfile({backend: 'codex', label: 'New'}), false);
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.state.provisionPending, 'provisionUncertain');
  assert.equal(writes, 1);
  assert.equal(reads, 2, 'malformed write receipt must not trigger a read-back');
  assert.equal(await controller.provisionProfile({backend: 'codex', label: 'New'}), false);
  assert.equal(writes, 1);
});

const requestedProvision = {backend: 'codex', label: 'Travel'} as const;
const newRevision = 'b'.repeat(64);
const provisioned = {...profile('p-0123456789abcdef', 'codex'), label: 'Travel', enabled: false};
const unconfigured = reply({configured:false, registry_revision:null, profiles:[]});

for (const append of [false, true]) for (const published of [false, true]) {
  test(`lost provision receipt stays blocked across inspection and reopen (${append ? 'append' : 'first'}, ${published ? 'published' : 'unpublished'})`, async () => {
    let loads = 0, inspections = 0, writes = 0;
    const old = append ? [profile('a')] : [];
    let current = append ? listing(old) : unconfigured;
    const controller = createBackendAccountController({
      load: async () => { loads++; return {profiles: current, policy: reply(policy())}; },
      mutate: async () => assert.fail('no mutation during read-back'),
      inspect:async () => { inspections++; return current; },
      provision: {backends:['codex'],
        write:async request => {
          writes++;
          assert.equal(request.registry_revision, append ? digest : null);
          if (published) current = reply({configured:true, registry_revision:newRevision, profiles:[...old, provisioned]});
          throw new Error('transport lost the reply');
        }},
    });
    await controller.open();
    assert.equal(await controller.provisionProfile(requestedProvision), false);
    assert.equal(inspections, 0);
    await controller.refresh();
    assert.equal(controller.state.provisionPending, 'provisionUncertain');
    assert.equal(controller.state.snapshot?.registry.profiles.length, old.length + Number(published));
    controller.close();
    await controller.open();
    assert.equal(controller.state.provisionPending, 'provisionUncertain');
    assert.equal(await controller.provisionProfile(requestedProvision), false);
    assert.deepEqual({loads, inspections, writes}, {loads:1, inspections:2, writes:1});
  });
}

test('confirmed provision receipt survives close and clears only on its exact registry read-back', async () => {
  let current = listing(), loads = 0, inspections = 0, writes = 0;
  const entered = defer();
  const controller = createBackendAccountController({
    load: async () => { loads++; return {profiles: current, policy: reply(policy())}; },
    mutate: async () => assert.fail('no mutation during read-back'),
    inspect:async () => {
      if (++inspections === 1) {
        entered.resolve(null);
        return new Promise(() => {});
      }
      return current;
    },
    provision: {backends:['codex'], write:async () => {
      writes++; return reply({registry_revision:newRevision, profile:provisioned});
    }},
  });
  await controller.open();
  const write = controller.provisionProfile(requestedProvision);
  await entered.promise;
  controller.close();
  assert.equal(await write, false);
  await controller.open();
  assert.equal(controller.state.provisionPending, 'provisionVerification');
  current = reply({configured:true, registry_revision:'c'.repeat(64), profiles:[provisioned]});
  await controller.refresh();
  assert.equal(controller.state.provisionPending, 'provisionVerification');
  current = reply({configured:true, registry_revision:newRevision, profiles:[{...provisioned, context_revision:'d'.repeat(64)}]});
  await controller.refresh();
  assert.equal(controller.state.provisionPending, 'provisionVerification');
  current = reply({configured:true, registry_revision:newRevision, profiles:[provisioned]});
  await controller.refresh();
  assert.equal(controller.state.phase, 'saved');
  assert.equal(controller.state.provisionPending, undefined);
  assert.deepEqual({loads, inspections, writes}, {loads:1, inspections:5, writes:1});
});

test('alias creation refreshes only after validated native success and retains snapshot on conflict', async () => {
  const roots = {config:'/fixtures/agent',history:'/fixtures/history'};
  const input = {backend:'claude' as const,id:'new',label:'New',roots};
  let current = listing(), calls: unknown[] = [], mode = 'conflict';
  const controller = createBackendAccountController({
    load: async () => ({profiles: current, policy: reply(policy())}),
    mutate: async () => reply(policy()),
    create: async request => {
      calls.push(request);
      if (mode === 'conflict') return {version:1,ok:false,code:'profile-registry-changed'};
      current = reply({configured:true,registry_revision:'b'.repeat(64),profiles:[...parseProfilesReply(current).profiles,{...profile('new'),label:'New'}]});
      return reply({registry_revision:'b'.repeat(64),profile:{...profile('new'),label:'New'}});
    },
  });
  await controller.open();
  assert.equal(await controller.createProfile(input),false);
  assert.equal(controller.state.phase,'conflict');
  assert.equal(controller.state.snapshot!.registry.profiles.length,3);
  assert.deepEqual(calls[0],{version:1,op:'profiles.create',registry_revision:digest,profile:input});
  await controller.refresh();
  mode = 'success';
  assert.equal(await controller.createProfile(input),true);
  assert.equal(controller.state.snapshot!.registry.profiles.length,4);
  assert.equal(controller.state.snapshot!.policy.revision,0);
});
test('native 503 publication uncertainty never declares an alias not saved or retries', async () => {
  let creates = 0, reads = 0;
  const controller = createBackendAccountController({
    load: async () => { reads++; return {profiles: listing(), policy: reply(policy())}; },
    mutate: async () => reply(policy()),
    create: async () => {
      creates++;
      return {http_status: 503, version: 1, ok: false, code: 'profile-publication-uncertain'};
    },
  });
  await controller.open();
  assert.equal(await controller.createProfile({backend: 'claude', id: 'new', label: 'New',
    roots: {config: '/fixtures/config', history: '/fixtures/history'}}), false);
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.state.snapshot?.registry.registry_revision, digest);
  assert.equal(creates, 1);
  assert.equal(reads, 1);
  await controller.refresh();
  assert.equal(reads, 2);
  assert.equal(creates, 1);
});

test('successful create receipt followed by refused read-back is uncertain, never a second write', async () => {
  const input = {backend: 'claude' as const, id: 'new', label: 'New',
    roots: {config: '/fixtures/config', history: '/fixtures/history'}};
  let creates = 0, reads = 0, refuseRead = true;
  const created = {...profile('new'), label: 'New'};
  const controller = createBackendAccountController({
    load: async () => {
      reads++;
      return {profiles: reads === 1 ? listing() : refuseRead
        ? {version: 1, ok: false, http_status: 503, code: 'busy'}
        : reply({configured: true, registry_revision: 'b'.repeat(64),
            profiles: [...parseProfilesReply(listing()).profiles, created]}),
      policy: reply(policy())};
    },
    mutate: async () => reply(policy()),
    create: async () => {
      creates++;
      return reply({registry_revision: 'b'.repeat(64), profile: created});
    },
  });
  await controller.open();
  assert.equal(await controller.createProfile(input), false);
  assert.equal(controller.state.phase, 'verification');
  assert.equal(controller.state.snapshot?.registry.registry_revision, digest);
  assert.equal(creates, 1);
  assert.equal(reads, 2);
  assert.equal(await controller.createProfile(input), false);
  assert.equal(creates, 1);
  refuseRead = false;
  await controller.refresh();
  assert.equal(controller.state.phase, 'ready');
  assert.equal(reads, 3);
  assert.equal(creates, 1);
  assert.equal(controller.state.snapshot!.registry.profiles.some(p => p.id === 'new'), true);
});

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

test('all 64 dual-backend aliases fit the bounded migrated registry', () => {
  const profiles = (['claude', 'codex'] as const).flatMap(backend =>
    Array.from({length: 64}, (_, index) => profile(`alias-${index}`, backend)));
  assert.equal(parseProfilesReply(listing(profiles)).profiles.length, 128);
  assert.throws(() => parseProfilesReply(listing([...profiles, profile('extra', 'pi')])));
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
  for (const code of ['consent-revision-conflict', 'profile-registry-changed', 'profile-context-changed', 'consent-rule-capacity', 'consent-revision-exhausted']) {
    let mutations = 0;
    const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(policy())}),
      mutate: async () => { mutations++; return {version: 1, ok: false, http_status: 409, code}; }});
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

test('closed native precommit refusals are not uncertain writes; codes and HTTP status must agree', async () => {
  const refused = {400: ['invalid-request', 'unsupported-request-version', 'invalid-account-pair', 'invalid-account-reference',
    'profile-backend-mismatch', 'unsupported-operation'], 404: ['unknown-profile', 'profiles-unconfigured'], 413: ['request-too-large'],
  503: ['disabled-profile', 'invalid-consent-policy', 'invalid-profile-config', 'unsafe-profile-roots', 'unsafe-configuration-root',
    'unsafe-backend-store', 'invalid-backend-state', 'unsupported-backend-store-version', 'backend-transaction-aborted',
    'backend-store-busy', 'backend-journal-capacity', 'busy']};
  for (const [http_status, codes] of Object.entries(refused)) for (const code of codes) {
    let calls = 0;
    const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(policy())}),
      mutate: async () => { calls++; return {version: 1, ok: false, http_status: Number(http_status), code}; }});
    await controller.open(); assert.equal(await controller.saveGlobal('skip'), false);
    assert.equal(controller.state.phase, 'refused', code);
    assert.equal(controller.state.snapshot?.policy.revision, 0);
    assert.equal(await controller.reset(), false); assert.equal(calls, 1);
    await controller.refresh(); assert.equal(controller.state.phase, 'ready'); assert.equal(calls, 1); controller.close();
  }
  for (const envelope of [
    {version: 1, ok: false, http_status: 503, code: 'backend-helper-unavailable'},
    {version: 1, ok: false, http_status: 503, code: 'backend-store-unavailable'},
    {version: 1, ok: false, http_status: 503, code: 'new-error-code'},
    {version: 1, ok: false, http_status: 503, code: 'invalid-request'},
    {version: 1, ok: false, http_status: 400, code: 'busy'},
    {version: 1, ok: false, http_status: 400, code: 'invalid-request', path: 'private'},
  ]) {
    const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(policy())}), mutate: async () => envelope});
    await controller.open(); assert.equal(await controller.reset(), false); assert.equal(controller.state.phase, 'error'); controller.close();
  }
});

test('helper unavailable after a committed write is uncertain even with a closed coded envelope', async () => {
  let committed = policy(), calls = 0;
  const controller = createBackendAccountController({load: async () => ({profiles: listing(), policy: reply(committed)}),
    mutate: async () => { calls++; committed = {...policy('skip'), revision: 1};
      return {version: 1, ok: false, http_status: 503, code: 'backend-helper-unavailable'}; }});
  await controller.open(); assert.equal(await controller.saveGlobal('skip'), false);
  assert.equal(controller.state.phase, 'error'); assert.equal(committed.global, 'skip');
  assert.equal(await controller.reset(), false); assert.equal(calls, 1);
  await controller.refresh(); assert.equal(controller.state.snapshot?.policy.global, 'skip'); assert.equal(calls, 1); controller.close();
});

test('EN/FR consent wording limits Skip to operator UI switches and retains unconditional session approval', () => {
  for (const lang of ['en', 'fr']) {
    const catalog = JSON.parse(readFileSync(new URL(`../static/i18n/${lang}.json`, import.meta.url), 'utf8'));
    const global = catalog['backendAccounts.globalWarning'], pair = catalog['backendAccounts.pairScope'];
    assert.match(catalog['backendAccounts.skip'], lang === 'en' ? /UI/i : /interface/i);
    for (const text of [global, pair]) {
      assert.match(text, lang === 'en' ? /operator.initiated.*UI/i : /initiées.*opérateur.*interface/i);
      assert.match(text, lang === 'en' ? /agent.*session.*always.*human approval.*v1/i : /agent.*session.*toujours.*approbation humaine.*v1/i);
    }
    assert.match(global, lang === 'en' ? /current and future compatible profiles/i : /profils compatibles actuels et futurs/i);
    assert.match(pair, lang === 'en' ? /remembered.*not proof.*human initiative/i : /mémorisée.*ne prouve pas.*initiative humaine/i);
    assert.match(catalog['backendAccounts.status.refused'], lang === 'en' ? /refused.*not saved.*refresh.*review/i : /refusée.*non enregistrée.*actualisez.*vérifiez/i);
  }
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
