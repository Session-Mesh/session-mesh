// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterEvents, identityKey, parseSnapshot} from '../static/flow-model.ts';

const a = {id: 'agent', created: 2, agent: 'codex'};
const old = {id: 'agent', created: 1, agent: 'codex'};
const b = {id: 'other', created: 3, agent: 'claude'};
const events = [
  {id: '2', kind: 'message', time: 20, source: a, target: b},
  {id: '1', kind: 'create', time: 10, source: old, target: b},
] as const;

test('validates and orders the server event snapshot without message contents', () => {
  const result = parseSnapshot({events, truncated: true});
  assert.ok(result);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.events.map(event => event.id), ['1', '2']);
  assert.equal(identityKey(a) === identityKey(old), false);
});

test('focus uses the exact session incarnation, and has no arbitrary fallback', () => {
  const snapshot = parseSnapshot({events, truncated: false}); assert.ok(snapshot);
  assert.deepEqual(filterEvents(snapshot.events, a, 'current', 0, 'all').map(event => event.id), ['2']);
  assert.deepEqual(filterEvents(snapshot.events, null, 'current', 0, 'all'), []);
  assert.deepEqual(filterEvents(snapshot.events, null, 'all', 0, 'all').map(event => event.id), ['1', '2']);
  assert.deepEqual(filterEvents(snapshot.events, null, 'all', 15, 'message').map(event => event.id), ['2']);
});

test('rejects malformed or ambiguous snapshots instead of drawing invented relations', () => {
  for (const raw of [null, {}, {events, truncated: 'false'}, {events: [events[0], events[0]], truncated: false},
    {events: [{...events[0], time: NaN}], truncated: false},
    {events: [{...events[0], source: {id: 'a', created: null, agent: 'codex'}}], truncated: false},
    {events: [{...events[0], kind: 'unknown'}], truncated: false},
    {events: [{...events[0], target: events[0].source}], truncated: false}]) assert.equal(parseSnapshot(raw), null);
});
