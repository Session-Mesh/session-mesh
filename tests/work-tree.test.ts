// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tree of the Projects view's left rail (static/work-tree.ts): zones in taxonomy order, products (a child under
// its parent) and projects, the counters it reuses from the documents and from the entry screen's classification of
// the questions, the projects of no listed product, and the moves of the keyboard. The rail itself runs in
// tests/work-rail-tree-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { entryTree } from '../static/work-derive.ts';
import { triageQuestions } from '../static/work-questions-triage.ts';
import {
  ENTRY_KEY, buildTree, findProduct, locate, moveFocus, questionCounts, seedOpen, treeKey, visibleKeys,
} from '../static/work-tree.ts';
import type { TreeNode } from '../static/work-tree.ts';
import type { Counts, Product, ProductsDoc, ProjectSummary, ProjectsDoc, Question } from '../static/work-types.ts';

const counts = (open: number, done = 0): Counts => ({ open, done, blockedTasks: 0, dependencyOpenTasks: 0, blockers: 0, progress: null });
/** `own` and `tree` differ on purpose: the rail counts the product's tree (its children included), as the entry screen. */
const product = (id: string, tree: number, parent: string | null = null): Product =>
  ({ id, parent, own: counts(100 + tree, 7), tree: counts(tree, 9), projects: 0, noProjectOpen: 0 });
const project = (id: string, title: string, of: string, open: number): ProjectSummary =>
  ({ id, title, product: of, status: 'active', quarter: null, owner: null, counts: counts(open, 50), lastActivity: null });

const PRODUCTS: ProductsDoc = { truncated: false, categories: [
  { key: 'atlas', name: 'Atlas', products: [product('relay', 5), product('relay-agent', 2, 'relay'), product('gateway', 0)] },
  { key: 'empty', name: 'Empty', products: [] },
  { key: 'home', name: '', products: [product('garden', 3)] },
] };
const PROJECTS: ProjectsDoc = { total: 5, truncated: false, noProject: [], projects: [
  project('P-0001', 'Delivery rollout', 'relay', 3),
  project('P-0002', 'Agent split', 'relay-agent', 2),
  project('P-0003', 'Spring beds', 'garden', 1),
  project('P-0004', '<img src=x onerror=alert(1)>', 'unlisted', 4),
  project('P-0005', '', 'unlisted', 0),
] };

const ask = (id: string, open: boolean, about: string, projectId: string | null, of: string, category: string): Question => ({
  id, open, text: `${id}?`, options: [], kind: 'text', assumption: null, about, askedBy: null, askedByAgent: null, askedBySession: 's',
  askedAt: '2026-11-08T09:00:00Z', answers: [], ownerAnswered: false,
  context: { taskTitle: 'A task', project: projectId, projectTitle: null, product: of, category },
});
const QUESTIONS: Question[] = [
  ask('N-1', true, 'T-0001', 'P-0001', 'relay', 'atlas'),
  ask('N-2', true, 'T-0002', 'P-0001', 'relay', 'atlas'),
  ask('N-3', true, 'T-0003', null, 'relay', 'atlas'),
  ask('N-4', true, 'T-0004', 'P-0003', 'garden', 'home'),
  ask('N-5', false, 'T-0005', 'P-0003', 'garden', 'home'),   // answered: never counted
];
const ZONES = PRODUCTS.categories.map(category => ({ key: category.key, name: category.name }));
const tree = (withQuestions: boolean): readonly TreeNode[] => buildTree(entryTree(PRODUCTS, PROJECTS), PROJECTS,
  withQuestions ? questionCounts(triageQuestions(QUESTIONS, ZONES)) : null);
const node = (nodes: readonly TreeNode[], key: string): TreeNode => {
  const found = locate(nodes, key);
  assert.ok(found, `${key} is in the tree`);
  return found.node;
};

describe('the tree of the rail', () => {
  test('zones in taxonomy order, products under them, a child product under its parent, projects under products', () => {
    const nodes = tree(false);
    assert.deepEqual(nodes.map(zone => zone.key), ['zone:atlas', 'zone:home', 'zone:'], 'the empty zone is left out, the unlisted last');
    const atlas = nodes[0]!;
    assert.deepEqual(atlas.children.map(child => child.key), ['product:relay', 'product:gateway']);
    assert.deepEqual(node(nodes, 'product:relay').children.map(child => child.key), ['project:P-0001', 'product:relay-agent']);
    assert.deepEqual(node(nodes, 'product:relay-agent').children.map(child => child.key), ['project:P-0002']);
    assert.deepEqual(node(nodes, 'product:gateway').children, [], 'a product without projects is a leaf');
    assert.equal(node(nodes, 'zone:home').label, 'home', 'a zone without a name is named by its key');
    assert.equal(node(nodes, 'project:P-0001').label, 'Delivery rollout');
    assert.equal(node(nodes, 'project:P-0001').kind, 'project');
  });

  test('the open tasks are the documents\' counts: the product\'s tree, the project\'s open tasks, the zone\'s sum', () => {
    const nodes = tree(false);
    assert.equal(node(nodes, 'product:relay').openTasks, 5, 'tree.open, not own.open nor done');
    assert.equal(node(nodes, 'product:relay-agent').openTasks, 2);
    assert.equal(node(nodes, 'project:P-0001').openTasks, 3, 'counts.open, not done');
    assert.equal(node(nodes, 'zone:atlas').openTasks, 5, 'the top products only: a child is in its parent\'s tree');
    assert.equal(node(nodes, 'zone:').openTasks, 4);
  });

  test('the open questions are the entry screen\'s classification of the questions read, none before a read', () => {
    for (const key of ['zone:atlas', 'product:relay', 'project:P-0001']) assert.equal(node(tree(false), key).questions, null, key);
    const nodes = tree(true);
    assert.equal(node(nodes, 'zone:atlas').questions, 3);
    assert.equal(node(nodes, 'product:relay').questions, 3, 'a task of the product in no project counts too');
    assert.equal(node(nodes, 'project:P-0001').questions, 2);
    assert.equal(node(nodes, 'product:gateway').questions, 0);
    assert.equal(node(nodes, 'zone:home').questions, 1, 'an answered question is not counted');
    assert.equal(node(nodes, 'project:P-0003').questions, 1);
    assert.equal(node(nodes, 'zone:').questions, 0);
  });

  test('projects of no listed product stand in a last zone; hostile names are kept as text', () => {
    const other = node(tree(false), 'zone:');
    assert.equal(other.label, '', 'the view names it');
    assert.deepEqual(other.children.map(child => child.label), ['<img src=x onerror=alert(1)>', 'P-0005'], 'an empty title shows the id');
    assert.deepEqual(buildTree(entryTree(PRODUCTS, { ...PROJECTS, projects: PROJECTS.projects.slice(0, 3) }), PROJECTS, null)
      .map(zone => zone.key).includes('zone:'), true, 'the zone is drawn from the projects given');
    const empty = buildTree([], { total: 0, truncated: false, noProject: [], projects: [] }, null);
    assert.deepEqual(empty, [], 'no product, no project: an empty tree');
    const odd = buildTree(entryTree({ truncated: false, categories: [{ key: 'a b', name: '"quoted"', products: [product('x"]y', 1)] }] },
      { ...PROJECTS, projects: [] }), { ...PROJECTS, projects: [] }, null);
    assert.equal(node(odd, 'product:x"]y').label, 'x"]y');
    assert.equal(node(odd, 'zone:a b').label, '"quoted"');
  });

  test('the keys the owner sees follow the unfolded items; locate gives the ancestors', () => {
    const nodes = tree(false);
    assert.deepEqual(seedOpen(nodes), ['zone:atlas', 'zone:home', 'zone:']);
    const open = new Set(seedOpen(nodes));
    assert.deepEqual(visibleKeys(nodes, open), [ENTRY_KEY, 'zone:atlas', 'product:relay', 'product:gateway', 'zone:home', 'product:garden',
      'zone:', 'project:P-0004', 'project:P-0005']);
    open.add('product:relay');
    assert.deepEqual(visibleKeys(nodes, open).slice(2, 6), ['product:relay', 'project:P-0001', 'product:relay-agent', 'product:gateway']);
    assert.deepEqual(locate(nodes, 'project:P-0002')?.ancestors, ['zone:atlas', 'product:relay', 'product:relay-agent']);
    assert.equal(locate(nodes, 'project:P-9999'), null);
    assert.equal(treeKey('project', 'P-1'), 'project:P-1');
  });

  test('the focus moves by one, to the first and the last; it stays at the ends', () => {
    const keys = ['entry', 'a', 'b', 'c'];
    assert.equal(moveFocus(keys, 'a', 'ArrowDown'), 'b');
    assert.equal(moveFocus(keys, 'a', 'ArrowUp'), 'entry');
    assert.equal(moveFocus(keys, 'entry', 'ArrowUp'), 'entry');
    assert.equal(moveFocus(keys, 'c', 'ArrowDown'), 'c');
    assert.equal(moveFocus(keys, 'b', 'Home'), 'entry');
    assert.equal(moveFocus(keys, 'b', 'End'), 'c');
    assert.equal(moveFocus(keys, 'gone', 'ArrowDown'), 'entry');
    assert.equal(moveFocus([], 'a', 'ArrowDown'), null);
  });

  test('a product is found at any depth', () => {
    const categories = entryTree(PRODUCTS, PROJECTS);
    assert.equal(findProduct(categories, 'relay-agent')?.product.id, 'relay-agent');
    assert.equal(findProduct(categories, 'garden')?.projects[0]?.id, 'P-0003');
    assert.equal(findProduct(categories, 'unlisted'), null);
  });
});
