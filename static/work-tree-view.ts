// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The left rail of the Projects view: the tree of static/work-tree.ts as an ARIA tree (role tree, treeitem, group),
 * in the sidebar the Sessions view lists its sessions in. One item takes the focus (Tab), the arrow keys move it, Right
 * and Left unfold and fold (or go to the first child and to the parent), Home and End go to the first and last item,
 * Enter and Space choose. Choosing the first item shows the entry screen, a product its view, a project its view;
 * choosing a zone folds or unfolds it. The item of the place the view shows is selected, its ancestors unfolded. The
 * unfolded items are the view's to keep (static/work-view-state.ts); this module only reports a change.
 */

import { entryTree } from './work-derive.ts';
import type { EntryCategory } from './work-derive.ts';
import { el, setAttributes } from './work-dom.ts';
import type { Translate } from './work-dom.ts';
import { triageQuestions } from './work-questions-triage.ts';
import { ENTRY_KEY, buildTree, liveKeys, locate, moveFocus, questionCounts, seedOpen, visibleKeys } from './work-tree.ts';
import type { MoveKey, TreeNode } from './work-tree.ts';
import type { ProductsDoc, ProjectsDoc, Question } from './work-types.ts';

export type RailChoice = Readonly<{ kind: 'entry' } | { kind: 'product' | 'project'; id: string }>;

export type RailHost = Readonly<{
  /** The element of the sidebar the tree is drawn in. */
  root: HTMLElement;
  t: Translate;
  /** The owner chose the entry item, a product or a project. */
  choose: (choice: RailChoice) => void;
  /** The unfolded items changed. */
  folded: () => void;
  /** The unfolded items kept from before, or null for the first visit (the zones are then unfolded). */
  open: readonly string[] | null;
}>;

const MOVES: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

type Docs = Readonly<{ products: ProductsDoc; projects: ProjectsDoc; categories: readonly EntryCategory[] }>;

export class WorkRail {
  private tree: readonly TreeNode[] = [];
  private docs: Docs | null = null;
  /** The open questions last read, or null before the first read. */
  private asked: readonly Question[] | null = null;
  private open: Set<string> | null;
  private selected: string | null = null;
  /** The item that takes the focus on Tab (and keeps it across a redraw). */
  private current: string = ENTRY_KEY;
  private readonly list = el('ul', 'work-tree');

  constructor(private readonly host: RailHost) {
    this.open = host.open ? new Set(host.open) : null;
    setAttributes(this.list, { role: 'tree', 'aria-label': host.t('work.tree.label') });
    this.list.addEventListener('keydown', event => this.keydown(event));
    this.list.addEventListener('click', event => this.click(event));
    // An item focused from elsewhere (the way back of the view) becomes the one Tab reaches.
    this.list.addEventListener('focusin', event => {
      const key = this.keyOf(event.target);
      if (key !== null && key !== this.current) this.focus(key);
    });
    host.root.replaceChildren(this.list);
  }

  /** The products and projects read: the tree is drawn again. The unfolded items gone from them are forgotten, unless
   *  a document was cut (an item left out may still exist). */
  entry(products: ProductsDoc, projects: ProjectsDoc): void {
    this.docs = { products, projects, categories: entryTree(products, projects) };
    this.rebuild();
    if (!this.open || products.truncated || projects.truncated) return;
    const live = liveKeys(this.tree, this.open);
    if (live.length === this.open.size) return;
    this.open = new Set(live);
    this.host.folded();
  }

  /** The open questions last read (the page the entry screen shows): their counts, classified as it does, are drawn. */
  questions(list: readonly Question[]): void {
    this.asked = list;
    this.rebuild();
  }

  /** Whether the products and projects were read. */
  hasEntry(): boolean { return this.docs !== null; }

  /** Snapshots used to avoid replacing focused tree items for unchanged reads. */
  documentsSnapshot(): string | null { return this.docs ? JSON.stringify([this.docs.products, this.docs.projects]) : null; }
  questionsSnapshot(): string | null { return this.asked ? JSON.stringify(this.asked) : null; }

  private rebuild(): void {
    const docs = this.docs;
    if (!docs) return;
    const zones = docs.products.categories.map(category => ({ key: category.key, name: category.name }));
    const titles = new Map(docs.projects.projects.map(project => [project.id, project.title] as const));
    const counts = this.asked ? questionCounts(triageQuestions(this.asked, zones, id => titles.get(id) ?? null)) : null;
    this.render(buildTree(docs.categories, docs.projects, counts));
  }

  private render(tree: readonly TreeNode[]): void {
    this.tree = tree;
    if (this.open === null && tree.length > 0) { this.open = new Set(seedOpen(tree)); this.host.folded(); }
    this.reveal(this.selected);
    this.draw();
  }

  /** Mark the item of the place shown (null: none), its ancestors unfolded. */
  select(key: string | null): void {
    this.selected = key;
    if (key !== null) this.current = key;
    this.reveal(key);
    this.draw();
  }

  /** The unfolded items, or null before the first tree. */
  openKeys(): string[] | null { return this.open ? [...this.open] : null; }

  private reveal(key: string | null): void {
    const found = key === null ? null : locate(this.tree, key);
    if (!found || !this.open) return;
    const missing = found.ancestors.filter(ancestor => !this.open!.has(ancestor));
    if (missing.length === 0) return;
    missing.forEach(ancestor => this.open!.add(ancestor));
    this.host.folded();
  }

  private draw(): void {
    const focused = this.list.contains(document.activeElement);
    const visible = visibleKeys(this.tree, this.open ?? new Set());
    if (!visible.includes(this.current)) this.current = this.selected !== null && visible.includes(this.selected) ? this.selected : ENTRY_KEY;
    const entry = this.item(ENTRY_KEY, 1, this.host.t('work.tree.overview'), null);
    this.list.replaceChildren(entry, ...this.tree.map(node => this.nodeItem(node, 1)));
    if (focused) this.itemOf(this.current)?.focus();
  }

  private nodeItem(node: TreeNode, level: number): HTMLElement {
    const item = this.item(node.key, level, node.label || this.host.t('work.tree.other'), node);
    if (node.children.length === 0) return item;
    const open = this.open?.has(node.key) === true;
    item.setAttribute('aria-expanded', String(open));
    if (open) {
      const group = el('ul', 'work-tree-group');
      group.setAttribute('role', 'group');
      group.append(...node.children.map(child => this.nodeItem(child, level + 1)));
      item.append(group);
    }
    return item;
  }

  private item(key: string, level: number, label: string, node: TreeNode | null): HTMLElement {
    const t = this.host.t, counts = el('span', 'work-tree-counts');
    const parts = [label];
    if (node && node.openTasks > 0) { counts.append(el('span', 'work-tree-tasks', String(node.openTasks))); parts.push(t('work.openTasks', { n: node.openTasks })); }
    if (node?.questions) {
      counts.append(el('span', 'work-tree-questions', t('work.tree.questionCount', { n: node.questions })));
      parts.push(t('work.questions.badge', { n: node.questions }));
    }
    const row = el('div', 'work-tree-row', el('span', 'work-tree-chev'), el('span', 'work-tree-name', label), counts);
    row.style.setProperty('--level', String(level));
    const item = el('li', `work-tree-item work-tree-${node?.kind ?? 'entry'}`, row);
    setAttributes(item, { role: 'treeitem', 'aria-level': String(level), 'aria-label': parts.join(', '), 'data-key': key,
      'aria-selected': String(key === this.selected), tabindex: key === this.current ? '0' : '-1' });
    return item;
  }

  /** The item of `key` when the owner can see it (the drawer of a phone open), or null. */
  shownItem(key: string): HTMLElement | null {
    const item = this.itemOf(key);
    return item && item.offsetParent !== null && item.getBoundingClientRect().right > 0 ? item : null;
  }

  private itemOf(key: string): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  }

  private keyOf(target: EventTarget | null): string | null {
    return target instanceof Element ? target.closest<HTMLElement>('.work-tree-item')?.dataset.key ?? null : null;
  }

  private focus(key: string | null): void {
    if (key === null) return;
    this.current = key;
    for (const node of this.list.querySelectorAll<HTMLElement>('.work-tree-item')) node.tabIndex = node.dataset.key === key ? 0 : -1;
    this.itemOf(key)?.focus();
  }

  private toggle(key: string, open: boolean): void {
    if (!this.open || this.open.has(key) === open) return;
    if (open) this.open.add(key); else this.open.delete(key);
    this.current = key;
    this.host.folded();
    this.draw();
    this.itemOf(key)?.focus();
  }

  /** Choose an item: the entry item, a product or a project is shown, a zone folds or unfolds. */
  private activate(key: string): void {
    const node = key === ENTRY_KEY ? null : locate(this.tree, key)?.node;
    if (key === ENTRY_KEY) this.host.choose({ kind: 'entry' });
    else if (node?.kind === 'zone') this.toggle(key, !this.open?.has(key));
    else if (node) this.host.choose({ kind: node.kind, id: node.id });
  }

  private click(event: MouseEvent): void {
    const key = this.keyOf(event.target);
    if (key === null) return;
    this.current = key;
    const node = locate(this.tree, key)?.node;
    const onChevron = event.target instanceof Element && event.target.closest('.work-tree-chev') !== null;
    if (onChevron && node && node.children.length > 0) this.toggle(key, !this.open?.has(key));
    else this.activate(key);
  }

  private keydown(event: KeyboardEvent): void {
    const key = this.keyOf(event.target);
    if (key === null || event.altKey || event.ctrlKey || event.metaKey) return;
    if (MOVES.has(event.key)) this.focus(moveFocus(visibleKeys(this.tree, this.open ?? new Set()), key, event.key as MoveKey));
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') this.sideways(key, event.key === 'ArrowRight');
    else if (event.key === 'Enter' || event.key === ' ') this.activate(key);
    else return;
    event.preventDefault();
  }

  /** Right unfolds, or goes to the first child of an unfolded item; Left folds, or goes to the parent. */
  private sideways(key: string, right: boolean): void {
    const found = key === ENTRY_KEY ? null : locate(this.tree, key);
    const parent = found?.ancestors[found.ancestors.length - 1] ?? null;
    const branch = found !== null && found.node.children.length > 0, open = this.open?.has(key) === true;
    if (right && branch && !open) this.toggle(key, true);
    else if (right && branch) this.focus(found.node.children[0]!.key);
    else if (!right && branch && open) this.toggle(key, false);
    else if (!right) this.focus(parent);
  }
}
