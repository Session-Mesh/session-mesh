// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The tree of the Projects view's left rail (pure, no DOM): the zones in the order of the taxonomy, their products
 * (a child product under its parent, as on the entry screen, static/work-derive.ts entryTree) and the projects of each
 * product. A project whose product the products document does not list stands in a last zone of its own. Each node
 * carries the counters the entry screen shows: the open tasks of the product's tree or of the project (the documents'
 * counts) and the open questions of the classification of the entry screen (static/work-questions-triage.ts) of the
 * questions last read, or null when none were read; a product's questions, like its tasks, include its child
 * products'. static/work-tree-view.ts draws it.
 */

import type { EntryCategory, EntryProduct } from './work-derive.ts';
import type { Triage } from './work-questions-triage.ts';
import type { ProjectsDoc, ProjectSummary } from './work-types.ts';

export type TreeKind = 'zone' | 'product' | 'project';

export type TreeNode = Readonly<{
  /** Unique in the tree: the kind and the id (`zone:atacama`, `product:relay`, `project:P-1a2b`). */
  key: string;
  kind: TreeKind;
  /** The zone key (empty for the zone of the projects of no listed product), the product id or the project id. */
  id: string;
  /** The zone name, the product id or the project title; empty for the zone of the projects of no listed product. */
  label: string;
  openTasks: number;
  /** The open questions, or null when no question was read. */
  questions: number | null;
  children: readonly TreeNode[];
}>;

/** The first item of the tree: the entry screen (the pending questions and the overview). */
export const ENTRY_KEY = 'entry';

export const treeKey = (kind: TreeKind, id: string): string => `${kind}:${id}`;

/** The open questions per zone, product and project, as the entry screen classifies them. */
export type QuestionCounts = Readonly<{
  zones: ReadonlyMap<string, number>; products: ReadonlyMap<string, number>; projects: ReadonlyMap<string, number>;
}>;

function add(map: Map<string, number>, key: string | null, count: number): void {
  if (key !== null) map.set(key, (map.get(key) ?? 0) + count);
}

/** The counts of the groups of a classification of the open questions (the ones the entry screen shows). */
export function questionCounts(triage: Triage): QuestionCounts {
  const zones = new Map<string, number>(), products = new Map<string, number>(), projects = new Map<string, number>();
  for (const zone of triage.zones) {
    add(zones, zone.key, zone.count);
    for (const product of zone.products) {
      add(products, product.product, product.count);
      for (const project of product.projects) add(projects, project.project, project.count);
    }
  }
  return { zones, products, projects };
}

const countOf = (counts: QuestionCounts | null, map: keyof QuestionCounts, id: string): number | null =>
  counts ? counts[map].get(id) ?? 0 : null;

function projectNode(project: ProjectSummary, counts: QuestionCounts | null): TreeNode {
  return { key: treeKey('project', project.id), kind: 'project', id: project.id, label: project.title || project.id,
    openTasks: project.counts.open, questions: countOf(counts, 'projects', project.id), children: [] };
}

const sum = (nodes: readonly TreeNode[], pick: (node: TreeNode) => number | null): number =>
  nodes.reduce((total, node) => total + (pick(node) ?? 0), 0);

/** A product covers its child products: its open tasks are its tree's (the document's count), its open questions its
 *  own and those of its child products, so both counters of a row have the same scope. */
function productNode(node: EntryProduct, counts: QuestionCounts | null): TreeNode {
  const id = node.product.id, own = countOf(counts, 'products', id);
  const products = node.children.map(child => productNode(child, counts));
  return { key: treeKey('product', id), kind: 'product', id, label: id, openTasks: node.product.tree.open,
    questions: own === null ? null : own + sum(products, child => child.questions),
    children: [...node.projects.map(project => projectNode(project, counts)), ...products] };
}

/** The products listed anywhere in the entry tree. */
function listedProducts(categories: readonly EntryCategory[]): Set<string> {
  const listed = new Set<string>();
  const visit = (node: EntryProduct): void => { listed.add(node.product.id); node.children.forEach(visit); };
  for (const category of categories) category.products.forEach(visit);
  return listed;
}

/** The tree of the rail: the zones with products (taxonomy order), then the projects of no listed product. */
export function buildTree(categories: readonly EntryCategory[], projects: ProjectsDoc, counts: QuestionCounts | null): readonly TreeNode[] {
  const zones: TreeNode[] = categories.filter(category => category.products.length > 0).map(category => {
    const children = category.products.map(product => productNode(product, counts));
    return { key: treeKey('zone', category.key), kind: 'zone', id: category.key, label: category.name || category.key,
      openTasks: sum(children, node => node.openTasks), questions: countOf(counts, 'zones', category.key), children };
  });
  const listed = listedProducts(categories);
  const orphans = projects.projects.filter(project => !listed.has(project.product)).map(project => projectNode(project, counts));
  if (orphans.length === 0) return zones;
  return [...zones, { key: treeKey('zone', ''), kind: 'zone', id: '', label: '', openTasks: sum(orphans, node => node.openTasks),
    questions: counts ? sum(orphans, node => node.questions) : null, children: orphans }];
}

/** The keys unfolded the first time: every zone (the products stay folded). */
export function seedOpen(tree: readonly TreeNode[]): string[] {
  return tree.map(node => node.key);
}

/** The keys the owner sees, top to bottom: the entry item, then each node whose ancestors are all unfolded. */
export function visibleKeys(tree: readonly TreeNode[], open: ReadonlySet<string>): string[] {
  const keys: string[] = [ENTRY_KEY];
  const visit = (node: TreeNode): void => {
    keys.push(node.key);
    if (open.has(node.key)) node.children.forEach(visit);
  };
  tree.forEach(visit);
  return keys;
}

/** The node of `key` and the keys of its ancestors (the zone first), or null when the tree has no such node. */
export function locate(tree: readonly TreeNode[], key: string): Readonly<{ node: TreeNode; ancestors: readonly string[] }> | null {
  const walk = (nodes: readonly TreeNode[], above: readonly string[]): ReturnType<typeof locate> => {
    for (const node of nodes) {
      if (node.key === key) return { node, ancestors: above };
      const found = walk(node.children, [...above, node.key]);
      if (found) return found;
    }
    return null;
  };
  return walk(tree, []);
}

/** The product of `id` in the entry tree, at any depth, or null. */
export function findProduct(categories: readonly EntryCategory[], id: string): EntryProduct | null {
  const walk = (nodes: readonly EntryProduct[]): EntryProduct | null => {
    for (const node of nodes) {
      if (node.product.id === id) return node;
      const found = walk(node.children);
      if (found) return found;
    }
    return null;
  };
  for (const category of categories) {
    const found = walk(category.products);
    if (found) return found;
  }
  return null;
}

const holds = (node: EntryProduct, id: string): boolean => node.product.id === id || node.children.some(child => holds(child, id));

/** The product of the entry tree's first level whose tree holds product `id` (its row on the overview), or null when
 *  no listed product is `id`. */
export function topProduct(categories: readonly EntryCategory[], id: string): string | null {
  for (const category of categories) {
    const top = category.products.find(node => holds(node, id));
    if (top) return top.product.id;
  }
  return null;
}

/** The keys of `keys` that name a node of the tree, in their order: an item gone from the documents is dropped. */
export function liveKeys(tree: readonly TreeNode[], keys: Iterable<string>): string[] {
  const known = new Set<string>();
  const visit = (node: TreeNode): void => { known.add(node.key); node.children.forEach(visit); };
  tree.forEach(visit);
  return [...keys].filter(key => known.has(key));
}

export type MoveKey ='ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/** The key the focus moves to among the visible keys; the first when `current` is not visible. */
export function moveFocus(visible: readonly string[], current: string | null, move: MoveKey): string | null {
  if (visible.length === 0) return null;
  const index = current === null ? -1 : visible.indexOf(current);
  if (move === 'Home' || index < 0) return visible[0]!;
  if (move === 'End') return visible[visible.length - 1]!;
  const next = move === 'ArrowDown' ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0);
  return visible[next]!;
}
