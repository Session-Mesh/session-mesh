// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A product's Board and Timeline without a page: the `product` document as parsed (static/work-product-parse.ts),
// the filters, the columns and their counters, the groups of the timeline (static/work-product-filters.ts), and the
// filters kept with the place (static/work-view-state.ts). The page runs them in tests/work-product-board-browser.test.ts
// against the real work-read. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { entryTree } from '../static/work-derive.ts';
import {
  EMPTY_FILTERS, MAX_FILTERED_PRODUCTS, MAX_FILTER_TEXT, MAX_FILTER_VALUES, NO_PROJECT, boardColumns, choices, filterTasks,
  filtersOf, groupByProject, openOnBoard, readFilters, readProductFilters, withFilters,
} from '../static/work-product-filters.ts';
import type { Filters } from '../static/work-product-filters.ts';
import { parseProductDoc } from '../static/work-product-parse.ts';
import type { ProductDoc } from '../static/work-product-parse.ts';
import { buildTree, locate, treeKey } from '../static/work-tree.ts';
import { EMPTY_STATE, ENTRY_PLACE, STATE_SCHEMA, parseState, serializeState, withPlace } from '../static/work-view-state.ts';
import type { ProductsDoc, ProjectsDoc } from '../static/work-types.ts';

const HOSTILE = '<img src=x onerror=alert(1)> quay';
type RawTask = Record<string, unknown>;
const task = (id: string, status: string, column: string, extra: RawTask = {}): RawTask =>
  ({ id, title: `Task ${id}`, status, priority: 'P2', product: 'relay', column, created: '2026-11-01T00:00:00Z', ...extra });

/** relay holds relay-core: tasks of both, in two projects of relay, one project of another product a task names, and
 *  tasks in no project; the server counted 2 tasks more than it listed (one to do, one done). */
const RAW = {
  schema: 1, command: 'product', product: 'relay', scope: ['relay', 'relay-core'], truncated: true, tasks_omitted: 2,
  projects: [
    { id: 'P-0001', title: 'Harbour', product: 'relay', status: 'active', open: 2, done: 1 },
    { id: 'P-0002', title: HOSTILE, product: 'relay', status: 'active', open: 1, done: 0 },
    { id: 'P-0001', title: 'Duplicate', product: 'relay', status: 'active' },
    'not a project', { title: 'no id' },
  ],
  tasks: [
    task('T-0001', 'todo', 'todo', { project: 'P-0001', project_title: 'Harbour', owner: 'ana', tags: ['quay', 'quay', 7] }),
    task('T-0002', 'in_progress', 'in_progress', { project: 'P-0001', owner: 'ben', priority: 'P0', product: 'relay-core' }),
    task('T-0003', 'waiting', 'blocked', { project: 'P-0002', project_title: HOSTILE, tags: ['night'] }),
    task('T-0004', 'done', 'done', { project: 'P-0001' }),
    task('T-0005', 'todo', 'blocked', { product: 'relay-core', blockers: 1, owner: 'ana' }),
    task('T-0006', 'dropped', 'done', { project: 'P-0009', project_title: 'Elsewhere', created: null }),
    task('T-0001', 'done', 'done', { title: 'a repeated id' }),
    task('T-0007', 'weird', 'sideways'),
    { title: 'no id' }, 42, null,
  ],
  column_counts: { todo: 2, in_progress: 1, blocked: 2, done: 3, other: 1 },
};

const doc = (): ProductDoc => {
  const parsed = parseProductDoc(RAW);
  assert.ok(parsed);
  return parsed;
};
const ids = (rows: readonly { id: string }[]): string[] => rows.map(row => row.id);
const filters = (extra: Partial<Filters>): Filters => ({ ...EMPTY_FILTERS, ...extra });

describe('the product document', () => {
  test('rows are kept once, in the order read, with their column, tags and project titles; hostile entries are dropped', () => {
    const product = doc();
    assert.deepEqual(ids(product.tasks), ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0006', 'T-0007']);
    assert.equal(product.tasks[0]!.title, 'Task T-0001', 'a repeated id keeps its first row');
    assert.deepEqual(ids(product.projects), ['P-0001', 'P-0002']);
    assert.equal(product.columnOf.get('T-0005'), 'blocked', 'the server\'s column, never computed again');
    assert.equal(product.columnOf.get('T-0007'), 'other', 'an unknown column is "other"');
    assert.deepEqual(product.tagsOf.get('T-0001'), ['quay']);
    assert.equal(product.projectTitles.get('P-0002'), HOSTILE, 'a hostile title is kept as text');
    assert.equal(product.projectTitles.get('P-0009'), 'Elsewhere', 'a project of another product, named by its task');
    assert.deepEqual([product.truncated, product.omittedTasks], [true, 2]);
    assert.deepEqual(product.scope, ['relay', 'relay-core']);
  });

  test('anything that is not a product document is refused, never thrown', () => {
    for (const value of [null, 42, 'text', [], {}, { product: 'relay' }, { tasks: [] }, { product: 7, tasks: [] }, { product: '', tasks: [] }]) {
      assert.equal(parseProductDoc(value), null, JSON.stringify(value));
    }
    const odd = parseProductDoc({ product: 'relay', tasks: [], column_counts: { todo: -3, done: 'many', other: 1e999 }, scope: 'relay' });
    assert.deepEqual(odd?.columnCounts, { todo: 0, inProgress: 0, blocked: 0, done: 0, other: 0 });
    assert.deepEqual(odd?.scope, ['relay']);
  });
});

describe('filters', () => {
  test('each filter keeps the tasks of one of its values; several filters all apply', () => {
    const product = doc();
    assert.deepEqual(ids(filterTasks(product, filters({ projects: ['P-0001'] }))), ['T-0001', 'T-0002', 'T-0004']);
    assert.deepEqual(ids(filterTasks(product, filters({ projects: [NO_PROJECT] }))), ['T-0005', 'T-0007']);
    assert.deepEqual(ids(filterTasks(product, filters({ statuses: ['waiting', 'dropped'] }))), ['T-0003', 'T-0006']);
    assert.deepEqual(ids(filterTasks(product, filters({ priorities: ['P0'] }))), ['T-0002']);
    assert.deepEqual(ids(filterTasks(product, filters({ owners: ['ana'] }))), ['T-0001', 'T-0005']);
    assert.deepEqual(ids(filterTasks(product, filters({ tags: ['night'] }))), ['T-0003']);
    assert.deepEqual(ids(filterTasks(product, filters({ owners: ['ana'], projects: ['P-0001'] }))), ['T-0001']);
    assert.deepEqual(ids(filterTasks(product, filters({ text: '  t-0004 ' }))), ['T-0004'], 'the id, any case');
    assert.deepEqual(ids(filterTasks(product, filters({ text: 'task 000 7' }))), ['T-0007'], 'every word, in the title');
    assert.equal(filterTasks(product, EMPTY_FILTERS).length, product.tasks.length);
  });

  test('the choices: statuses in their order, projects in the document\'s, then those only tasks name, then no project', () => {
    const product = doc();
    assert.deepEqual(choices(product, 'statuses').map(choice => choice.value), ['todo', 'in_progress', 'waiting', 'done', 'dropped', 'weird']);
    assert.deepEqual(choices(product, 'projects').map(choice => [choice.value, choice.count]),
      [['P-0001', 3], ['P-0002', 1], ['P-0009', 1], [NO_PROJECT, 2]]);
    assert.deepEqual(choices(product, 'tags').map(choice => choice.value), ['night', 'quay']);
    assert.deepEqual(choices(product, 'owners', filters({ owners: ['gone'] })).map(choice => [choice.value, choice.count]),
      [['ana', 2], ['ben', 1], ['gone', 0]], 'a value chosen before stays, to be unticked');
  });

  test('stored filters are read without throwing, bounded, and hostile values dropped', () => {
    for (const value of [null, 7, 'x', [], { projects: 'P-1' }, { statuses: [null, {}, 1e999] }, { text: 5 }, { ['__proto__']: { text: 'x' } }]) {
      assert.doesNotThrow(() => readFilters(value));
    }
    const read = readFilters({ statuses: ['todo', 'nope', 'todo', '<b>'], owners: ['', 'ana', 'b‮ob', 'x'.repeat(101)],
      projects: [NO_PROJECT, 'P-1'], tags: Array.from({ length: 80 }, (_, index) => `t${index}`), text: 'y'.repeat(500) });
    assert.deepEqual(read.statuses, ['todo']);
    assert.deepEqual(read.owners, ['ana'], 'no empty value, no bidirectional character, nothing longer than 100');
    assert.deepEqual(read.projects, [NO_PROJECT, 'P-1']);
    assert.equal(read.tags.length, MAX_FILTER_VALUES);
    assert.equal(read.text.length, MAX_FILTER_TEXT);
    assert.equal(readFilters({ text: 'a\u0000b' }).text, '', 'a control character is not typed text');
  });
});

describe('the board', () => {
  test('without a filter each column counts every task of the server, the ones not read included', () => {
    const columns = boardColumns(doc(), EMPTY_FILTERS);
    assert.deepEqual(columns.map(column => [column.key, column.count, column.missing, ids(column.rows)]), [
      ['todo', 2, 1, ['T-0001']], ['inProgress', 1, 0, ['T-0002']], ['blocked', 2, 0, ['T-0003', 'T-0005']],
      ['done', 3, 1, ['T-0004', 'T-0006']], ['other', 1, 0, ['T-0007']],
    ]);
    assert.equal(openOnBoard(columns), 6);
  });

  test('with a filter a column counts the tasks read that pass, and says nothing is missing', () => {
    const columns = boardColumns(doc(), filters({ owners: ['ana'] }));
    assert.deepEqual(columns.map(column => [column.key, column.count, column.missing]),
      [['todo', 1, 0], ['inProgress', 0, 0], ['blocked', 1, 0], ['done', 0, 0], ['other', 0, 0]]);
  });

  test('the open columns add up to the rail\'s count of the product, which covers its child products', () => {
    const products: ProductsDoc = { truncated: false, categories: [{ key: 'platform', name: 'Platform', products: [
      { id: 'relay', parent: null, own: { open: 4, done: 1, blockedTasks: 0, dependencyOpenTasks: 0, blockers: 0, progress: null },
        tree: { open: 6, done: 3, blockedTasks: 2, dependencyOpenTasks: 0, blockers: 1, progress: null }, projects: 2, noProjectOpen: 1 },
      { id: 'relay-core', parent: 'relay', own: { open: 2, done: 0, blockedTasks: 1, dependencyOpenTasks: 0, blockers: 1, progress: null },
        tree: { open: 2, done: 0, blockedTasks: 1, dependencyOpenTasks: 0, blockers: 1, progress: null }, projects: 0, noProjectOpen: 1 },
    ] }] };
    const projects: ProjectsDoc = { projects: [], noProject: [], total: 0, truncated: false };
    const rail = locate(buildTree(entryTree(products, projects), projects, null), treeKey('product', 'relay'));
    assert.equal(rail?.node.openTasks, 6);
    assert.equal(openOnBoard(boardColumns(doc(), EMPTY_FILTERS)), rail?.node.openTasks);
  });
});

describe('the timeline groups', () => {
  test('by project: the document\'s order, then projects only tasks name, then no project; empty groups left out', () => {
    const product = doc();
    const groups = groupByProject(product, product.tasks);
    assert.deepEqual(groups.map(group => [group.project, group.title, ids(group.tasks)]), [
      ['P-0001', 'Harbour', ['T-0001', 'T-0002', 'T-0004']], ['P-0002', HOSTILE, ['T-0003']], ['P-0009', 'Elsewhere', ['T-0006']],
      [NO_PROJECT, null, ['T-0005', 'T-0007']],
    ]);
    assert.deepEqual(groupByProject(product, filterTasks(product, filters({ owners: ['ben'] }))).map(group => group.project), ['P-0001']);
  });
});

describe('filters kept with the place', () => {
  const isProduct = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z-]*$/.test(value);

  test('one set per product, the newest last, an emptied set removed, bounded', () => {
    let all = withFilters([], 'relay', filters({ owners: ['ana'] }));
    all = withFilters(all, 'gateway', filters({ text: 'quay' }));
    all = withFilters(all, 'relay', filters({ owners: ['ben'] }));
    assert.deepEqual(all.map(([id]) => id), ['gateway', 'relay']);
    assert.deepEqual(filtersOf(all, 'relay').owners, ['ben']);
    assert.deepEqual(filtersOf(all, 'kiln'), EMPTY_FILTERS);
    assert.deepEqual(withFilters(all, 'gateway', EMPTY_FILTERS).map(([id]) => id), ['relay']);
    for (let index = 0; index < 30; index++) all = withFilters(all, `p${String.fromCharCode(97 + index % 26)}${'x'.repeat(index)}`, filters({ text: 'a' }));
    assert.equal(all.length, MAX_FILTERED_PRODUCTS);
  });

  test('stored entries that are not ours are dropped, never thrown', () => {
    const stored = [['relay', { owners: ['ana'] }], ['<b>', { text: 'x' }], 'relay', [1, {}], ['gateway'], ['gateway', null],
      ['relay', { statuses: ['done'] }]];
    assert.deepEqual(readProductFilters(stored, isProduct), [['relay', { ...EMPTY_FILTERS, statuses: ['done'] }]]);
    assert.deepEqual(readProductFilters({ relay: {} }, isProduct), []);
  });

  test('a product place keeps its tab, its sheet and the filters across a reload; a state of schema 2 opens its overview', () => {
    const place = { ...ENTRY_PLACE, product: 'relay', tab: 'frise', task: 'T-0001',
      filters: [['relay', filters({ statuses: ['todo'], projects: [NO_PROJECT], text: 'quay' })] as const] };
    const read = parseState(serializeState(withPlace(EMPTY_STATE, place))).place;
    assert.deepEqual(read, place);
    assert.equal(JSON.parse(serializeState(withPlace(EMPTY_STATE, place))).schema, STATE_SCHEMA);
    const older = parseState(JSON.stringify({ schema: 2, place: { ...place }, drafts: {} })).place;
    assert.deepEqual([older.product, older.tab, older.task, older.filters], ['relay', null, null, []]);
  });

  test('filters too large for the store go before the place does', () => {
    const big = Array.from({ length: MAX_FILTERED_PRODUCTS }, (_, index) => [`p${'q'.repeat(index)}`,
      filters({ owners: Array.from({ length: MAX_FILTER_VALUES }, (_, value) => `${value}${'o'.repeat(98)}`) })] as const);
    const read = parseState(serializeState(withPlace(EMPTY_STATE, { ...ENTRY_PLACE, product: 'relay', filters: big }))).place;
    assert.deepEqual([read.product, read.filters], ['relay', []]);
  });
});
