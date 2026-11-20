// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Projects view's memory of the owner's place and unsent drafts (static/work-view-state.ts): what it stores, the
// bounds, and that anything else in the storage reads as the empty state without throwing. The page runs it in
// tests/work-view-state-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EMPTY_STATE, ENTRY_PLACE, MAX_DRAFTS, MAX_DRAFT_CHARS, MAX_STATE_CHARS, STATE_KEY, STATE_SCHEMA,
  clearState, loadState, parseState, saveState, serializeState, withDraft, withPlace,
} from '../static/work-view-state.ts';
import type { Draft, Place, StoragePort, ViewState } from '../static/work-view-state.ts';

const PLACE: Place = { project: 'P-7a7a', tab: 'board', task: 'T-7b7b', scroll: 420, sheetScroll: 30, tabScroll: 812, expanded: ['relay', 'kiln'] };
const draft = (text: string, at: number, extra: Partial<Draft> = {}): Draft => ({ text, picked: [], edit: false, at, ...extra });

function memoryStorage(): StoragePort & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, removeItem: key => { items.delete(key); } };
}

const sample = (): ViewState => {
  let state = withPlace(EMPTY_STATE, PLACE);
  state = withDraft(state, 'N-0000d001', draft('first draft, fictional', 1000));
  state = withDraft(state, 'N-0000d004', draft('second draft', 2000, { picked: ['Option A', 'Option B'] }));
  return withDraft(state, 'N-0000d005', draft('a corrected answer', 3000, { edit: true }));
};

describe('the stored state', () => {
  test('a round trip keeps the place and every draft, under one key of sessionStorage', () => {
    const storage = memoryStorage();
    saveState(() => storage, sample());
    assert.deepEqual([...storage.items.keys()], [STATE_KEY]);
    const back = loadState(() => storage);
    assert.deepEqual(back.place, PLACE);
    assert.deepEqual([...back.drafts.keys()].sort(), ['N-0000d001', 'N-0000d004', 'N-0000d005']);
    assert.deepEqual(back.drafts.get('N-0000d004'), draft('second draft', 2000, { picked: ['Option A', 'Option B'] }));
    assert.equal(back.drafts.get('N-0000d005')?.edit, true);
    assert.equal(JSON.parse(storage.items.get(STATE_KEY) ?? '{}').schema, STATE_SCHEMA);
  });

  test('an emptied field, or a sent answer, removes its draft; an empty state removes the key', () => {
    const storage = memoryStorage();
    let state = sample();
    state = withDraft(state, 'N-0000d001', null);
    state = withDraft(state, 'N-0000d004', draft('', 4000));   // emptied, nothing ticked
    assert.deepEqual([...state.drafts.keys()], ['N-0000d005']);
    state = withDraft(withPlace(state, ENTRY_PLACE), 'N-0000d005', null);
    storage.setItem(STATE_KEY, 'stale');
    saveState(() => storage, state);
    assert.equal(storage.items.has(STATE_KEY), false);
  });

  test('the size is bounded: the oldest drafts go first, the newest stay whole', () => {
    let state = withPlace(EMPTY_STATE, PLACE);
    for (let index = 0; index < 60; index++) state = withDraft(state, `N-${String(index).padStart(8, '0')}`, draft('x'.repeat(3000), index));
    const text = serializeState(state);
    assert.ok(text.length <= MAX_STATE_CHARS, `stored ${text.length} chars`);
    const back = parseState(text);
    assert.ok(back.drafts.size > 0 && back.drafts.size <= MAX_DRAFTS);
    assert.ok(back.drafts.has('N-00000059'), 'the newest kept');
    assert.equal(back.drafts.has('N-00000000'), false, 'the oldest dropped');
    for (const kept of back.drafts.values()) assert.equal(kept.text.length, 3000, 'never cut');
    assert.deepEqual(back.place, PLACE);
  });

  test('a draft longer than the field allows is not one of ours', () => {
    const state = withDraft(EMPTY_STATE, 'N-1', draft('y'.repeat(MAX_DRAFT_CHARS + 1), 1));
    assert.equal(state.drafts.size, 0);
  });

  test('corrupt, foreign or oversized values read as the empty state, never throw', () => {
    for (const raw of [null, '', '{', 'null', '[]', '42', '"text"', '{"schema":1', JSON.stringify({ drafts: {} }),
      'x'.repeat(MAX_STATE_CHARS + 1), JSON.stringify({ schema: 1, place: 'nope', drafts: [] })]) {
      const state = parseState(raw);
      assert.deepEqual(state.place, ENTRY_PLACE, String(raw).slice(0, 40));
      assert.equal(state.drafts.size, 0);
    }
  });

  test('another schema version reads as the empty state', () => {
    const stored = JSON.parse(serializeState(sample()));
    for (const schema of [0, 2, '1', null]) {
      assert.deepEqual(parseState(JSON.stringify({ ...stored, schema })), EMPTY_STATE, `schema ${String(schema)}`);
    }
  });

  test('fields of the wrong shape are dropped one by one; the rest is kept', () => {
    const raw = JSON.stringify({ schema: STATE_SCHEMA,
      place: { project: 'P-1', tab: '<b>', task: 42, scroll: -5, sheetScroll: 'far', tabScroll: '1e999', expanded: ['ok', 7, '../x'] },
      drafts: { 'N-1': { text: 'kept', picked: ['a', 3], at: 9 }, 'not an id!': { text: 'dropped', at: 1 }, 'N-2': { text: 5 },
        'N-3': 'text', '__proto__': { text: 'dropped' } } });
    const state = parseState(raw);
    assert.deepEqual(state.place, { project: 'P-1', tab: null, task: null, scroll: 0, sheetScroll: 0, tabScroll: 0, expanded: ['ok'] });
    assert.deepEqual([...state.drafts], [['N-1', { text: 'kept', picked: ['a'], edit: false, at: 9 }]]);
  });

  test('a task or tab without a project is not a place: the entry screen', () => {
    const state = parseState(JSON.stringify({ schema: STATE_SCHEMA, place: { project: null, tab: 'board', task: 'T-1' }, drafts: {} }));
    assert.equal(state.place.task, null);
    assert.equal(state.place.tab, null);
  });

  test('signing out clears the key; a storage that refuses or is missing never throws', () => {
    const storage = memoryStorage();
    saveState(() => storage, sample());
    clearState(() => storage);
    assert.equal(storage.items.size, 0);
    const refusing: StoragePort = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('denied'); } };
    assert.deepEqual(loadState(() => refusing), EMPTY_STATE);
    assert.doesNotThrow(() => saveState(() => refusing, sample()));
    assert.doesNotThrow(() => clearState(() => refusing));
    assert.deepEqual(loadState(() => null), EMPTY_STATE);
    assert.deepEqual(loadState(() => { throw new Error('SecurityError'); }), EMPTY_STATE);
  });
});
