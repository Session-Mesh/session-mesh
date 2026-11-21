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

const PLACE: Place = { project: 'P-7a7a', product: null, tab: 'board', task: 'T-7b7b', sheet: null, scroll: 420, sheetScroll: 30,
  tabScroll: 812, rail: ['zone:atacama', 'product:relay', 'product:kiln'], questionsOpen: true };
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

  test('drafts typed one after the other (epoch milliseconds) keep their order: the oldest goes first', () => {
    const start = Date.UTC(2026, 10, 20, 9, 0, 0);
    let state = EMPTY_STATE;
    for (let index = 0; index < MAX_DRAFTS + 5; index++) state = withDraft(state, `N-${index}`, draft(`draft ${index}`, start + index));
    const back = parseState(serializeState(state));
    assert.equal(back.drafts.size, MAX_DRAFTS);
    assert.equal(back.drafts.get(`N-${MAX_DRAFTS + 4}`)?.at, start + MAX_DRAFTS + 4, 'the newest kept, its time intact');
    for (let index = 0; index < 5; index++) assert.equal(back.drafts.has(`N-${index}`), false, `N-${index} (oldest) dropped`);
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
    for (const schema of [0, 3, '1', '2', null]) {
      assert.deepEqual(parseState(JSON.stringify({ ...stored, schema })), EMPTY_STATE, `schema ${String(schema)}`);
    }
  });

  test('fields of the wrong shape are dropped one by one; the rest is kept', () => {
    const raw = JSON.stringify({ schema: STATE_SCHEMA,
      place: { project: 'P-1', product: 'relay', tab: '<b>', task: 42, scroll: -5, sheetScroll: 'far', tabScroll: '1e999',
        rail: ['zone:ok', 7, '../x', { key: 'x' }, '', 'p'.repeat(65)] },
      drafts: { 'N-1': { text: 'kept', picked: ['a', 3], at: 9 }, 'not an id!': { text: 'dropped', at: 1 }, 'N-2': { text: 5 },
        'N-3': 'text', '__proto__': { text: 'dropped' } } });
    const state = parseState(raw);
    assert.deepEqual(state.place, { project: 'P-1', product: null, tab: null, task: null, sheet: null, scroll: 0, sheetScroll: 0,
      tabScroll: 0, rail: ['zone:ok'], questionsOpen: false });
    assert.deepEqual([...state.drafts], [['N-1', { text: 'kept', picked: ['a'], edit: false, at: 9 }]]);
  });

  test('a sheet opened from the entry screen (a task in no project, a question about nothing) is a place', () => {
    for (const sheet of [{ kind: 'task', id: 'T-9c0d' }, { kind: 'question', id: 'N-0000d031' }] as const) {
      const place: Place = { ...ENTRY_PLACE, sheet, scroll: 120 };
      assert.deepEqual(parseState(serializeState(withPlace(EMPTY_STATE, place))).place, place, sheet.kind);
    }
    const read = (place: object): Place => parseState(JSON.stringify({ schema: STATE_SCHEMA, place, drafts: {} })).place;
    assert.equal(read({ sheet: { kind: 'project', id: 'P-1' } }).sheet, null, 'another kind');
    assert.equal(read({ sheet: { kind: 'task', id: '<img>' } }).sheet, null, 'not an id');
    assert.equal(read({ sheet: 'T-9c0d' }).sheet, null, 'not a record');
    assert.equal(read({ project: 'P-7a7a', sheet: { kind: 'task', id: 'T-9c0d' } }).sheet, null, 'a project is shown, not a sheet');
  });

  test('the unfolded pending questions are kept in the same state, and alone are worth storing', () => {
    const storage = memoryStorage();
    saveState(() => storage, withPlace(EMPTY_STATE, { ...ENTRY_PLACE, questionsOpen: true }));
    assert.deepEqual([...storage.items.keys()], [STATE_KEY]);
    assert.equal(loadState(() => storage).place.questionsOpen, true);
    const read = (value: unknown): boolean =>
      parseState(JSON.stringify({ schema: STATE_SCHEMA, place: { questionsOpen: value }, drafts: {} })).place.questionsOpen;
    assert.deepEqual([read(true), read('1'), read(1), read(null)], [true, false, false, false]);
    clearState(() => storage);
    assert.equal(storage.items.size, 0);
  });

  test('a product view is a place, with the unfolded items of the rail; hostile values never throw', () => {
    const place: Place = { ...ENTRY_PLACE, product: 'relay', rail: ['zone:atacama', 'product:relay', 'zone:'], scroll: 64 };
    assert.deepEqual(parseState(serializeState(withPlace(EMPTY_STATE, place))).place, place);
    const read = (value: object): Place => parseState(JSON.stringify({ schema: STATE_SCHEMA, place: value, drafts: {} })).place;
    assert.equal(read({ product: '<img onerror=x>' }).product, null, 'not an id');
    assert.equal(read({ product: ['relay'] }).product, null, 'not a string');
    assert.equal(read({ project: 'P-1', product: 'relay' }).product, null, 'a project is shown, not a product');
    assert.equal(read({ product: 'relay', sheet: { kind: 'task', id: 'T-1' } }).product, null, 'a sheet is shown, not a product');
    assert.equal(read({ rail: 'zone:atacama' }).rail, null, 'not a list');
    assert.equal(read({ rail: Array.from({ length: 500 }, (_, index) => `product:p${index}`) }).rail?.length, 400, 'bounded');
    for (const hostile of [{ product: { toString: null } }, { rail: [null, {}, [], 1e999] }, { product: '__proto__', rail: ['__proto__'] }]) {
      assert.doesNotThrow(() => read(hostile));
    }
  });

  test('a state of schema 1 still reads: its drafts and place stay, the products it unfolded on the entry screen go', () => {
    const raw = JSON.stringify({ schema: 1, place: { project: 'P-7a7a', tab: 'board', task: null, scroll: 10, expanded: ['relay'] },
      drafts: { 'N-1': { text: 'kept', picked: [], at: 5 } } });
    const state = parseState(raw);
    assert.equal(state.place.project, 'P-7a7a');
    assert.equal(state.place.rail, null, 'the tree is folded as on a first visit');
    assert.equal(state.drafts.get('N-1')?.text, 'kept');
    assert.equal(JSON.parse(serializeState(state)).schema, 2, 'written again with the current schema');
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
