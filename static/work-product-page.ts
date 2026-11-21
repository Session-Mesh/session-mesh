// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * A product's view (level 1 of the way back, like a project): its name and progress (the counts of the products
 * document, the very numbers of the left rail), three tabs, Overview (its projects, its "no project" line, its child
 * products), Board and Timeline (every task of the product and of its child products, read with the `product`
 * document when one of them is first shown, under one filter bar), and the task sheet pane (static/work-task-sheet.ts)
 * that a card or a row opens, as on a project's tabs.
 */

import type { WorkResult } from './work-api.ts';
import type { EntryProduct } from './work-derive.ts';
import { button, el, progressBlock } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { productOverview } from './work-entry-view.ts';
import type { EntryHandlers } from './work-entry-view.ts';
import { errorBlock, loadingBlock } from './work-error-view.ts';
import { partialNotice, renderProductBoard, renderProductFrise } from './work-product-board.ts';
import { filterTasks } from './work-product-filters.ts';
import type { Filters } from './work-product-filters.ts';
import { renderFilterBar } from './work-product-filters-view.ts';
import type { FilterBar } from './work-product-filters-view.ts';
import type { ProductDoc } from './work-product-parse.ts';
import { nextTab, panelFor, tabButton } from './work-project-view.ts';
import type { SheetView } from './work-project-view.ts';

export const PRODUCT_TABS = ['overview', 'board', 'frise'] as const;
export type ProductTab = (typeof PRODUCT_TABS)[number];
export const productTab = (value: string | null): ProductTab =>
  PRODUCT_TABS.find(key => key === value) ?? 'overview';

export type ProductPageOptions = Readonly<{
  ctx: ViewContext;
  handlers: EntryHandlers & Readonly<{ back: () => void }>;
  node: EntryProduct;
  tab: ProductTab;
  filters: Filters;
  /** The filters changed (to keep them with the place). */
  onFilters: (filters: Filters) => void;
  /** A tab was shown, the first one included. */
  onTab: (key: ProductTab) => void;
  /** Read the `product` document; null when the view moved on meanwhile (the answer is then not shown). */
  load: () => Promise<WorkResult<ProductDoc> | null>;
}>;

export type ProductView = Omit<SheetView, 'current'> & Readonly<{
  id: string;
  current: () => ProductTab;
  activate: (key: ProductTab, focus: boolean) => void;
  /** Settles once the tab shown first is drawn (for Board and Timeline, once the document is read or failed). */
  ready: Promise<void>;
}>;

type Tabs = Readonly<{ list: HTMLElement; buttons: Map<ProductTab, HTMLButtonElement>; panels: Map<ProductTab, HTMLElement> }>;

function tabStrip(ctx: ViewContext): Tabs {
  const list = el('div', 'work-tabs');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', ctx.t('work.product.tabsLabel'));
  const buttons = new Map<ProductTab, HTMLButtonElement>(), panels = new Map<ProductTab, HTMLElement>();
  for (const key of PRODUCT_TABS) { buttons.set(key, tabButton(ctx, key)); panels.set(key, panelFor(key)); list.append(buttons.get(key)!); }
  return { list, buttons, panels };
}

function header(options: ProductPageOptions): HTMLElement {
  const { ctx, handlers, node } = options;
  return el('div', 'work-product-head', el('div', 'work-actions', button('btn work-back', ctx.t('work.back'), handlers.back)),
    el('h2', 'work-product-title', el('span', 'work-entry-name', node.product.id), progressBlock(ctx.t, node.product.tree)));
}

/** The Board and Timeline of the document read, filtered; the filter bar says how many tasks pass. */
class TaskTabs {
  private doc: ProductDoc | null = null;
  private bar: FilterBar | null = null;
  private loading: Promise<void> | null = null;
  private readonly folded = new Set<string>();
  /** The task tabs drawn for the filters in force: shown again as they are ("Show more" pages kept). */
  private readonly drawn = new Set<'board' | 'frise'>();
  readonly barSlot = el('div', 'work-filter-slot');

  constructor(private readonly options: ProductPageOptions, private filters: Filters,
    private readonly panels: Map<ProductTab, HTMLElement>, private readonly shownTab: () => ProductTab) {}

  /** Draw a task tab, reading the document first when it is not read yet. */
  show(key: 'board' | 'frise'): Promise<void> {
    if (this.doc) { if (!this.drawn.has(key)) this.draw(key); return Promise.resolve(); }
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    for (const key of ['board', 'frise'] as const) this.panels.get(key)!.replaceChildren(loadingBlock(this.options.ctx.t));
    const result = await this.options.load();
    this.loading = null;
    if (!result) return;
    if (!result.ok) {
      const retry = (): void => void this.show(this.taskTab());
      for (const key of ['board', 'frise'] as const) this.panels.get(key)!.replaceChildren(errorBlock(this.options.ctx.t, result.error, { retry }));
      return;
    }
    this.doc = result.value;
    this.bar = renderFilterBar(this.options.ctx, this.doc, this.filters, next => this.filtered(next));
    this.barSlot.replaceChildren(this.bar.root);
    this.barSlot.hidden = this.shownTab() === 'overview';
    this.draw(this.taskTab());
  }

  private taskTab(): 'board' | 'frise' { return this.shownTab() === 'frise' ? 'frise' : 'board'; }

  private filtered(next: Filters): void {
    this.filters = next;
    this.options.onFilters(next);
    this.drawn.clear();
    this.draw(this.taskTab());
    this.panels.get(this.taskTab() === 'board' ? 'frise' : 'board')!.replaceChildren();   // drawn again when shown
  }

  private draw(key: 'board' | 'frise'): void {
    const doc = this.doc;
    if (!doc) return;
    const { ctx } = this.options;
    const body = key === 'board' ? renderProductBoard(ctx, doc, this.filters) : renderProductFrise(ctx, doc, this.filters, this.folded);
    this.panels.get(key)!.replaceChildren(...[partialNotice(ctx, doc), body].filter((node): node is HTMLElement => node !== null));
    this.drawn.add(key);
    this.bar?.shown(filterTasks(doc, this.filters).length, doc.tasks.length);
  }

  /** The tab shown changed: the bar is shown on Board and Timeline only. */
  tabChanged(key: ProductTab): void { this.barSlot.hidden = key === 'overview' || this.bar === null; }
}

export function renderProductPage(options: ProductPageOptions): ProductView {
  const { ctx, node } = options;
  const tabs = tabStrip(ctx);
  let currentKey: ProductTab = options.tab;
  const tasks = new TaskTabs(options, options.filters, tabs.panels, () => currentKey);
  tasks.barSlot.hidden = true;
  tabs.panels.get('overview')!.append(productOverview(options.handlers, node));
  const activate = (key: ProductTab, focus: boolean): Promise<void> => {
    currentKey = key;
    for (const [name, tab] of tabs.buttons) {
      tab.setAttribute('aria-selected', String(name === key));
      tab.tabIndex = name === key ? 0 : -1;
      tabs.panels.get(name)!.hidden = name !== key;
    }
    tasks.tabChanged(key);
    const drawn = key === 'overview' ? Promise.resolve() : tasks.show(key);
    if (focus) tabs.buttons.get(key)!.focus();
    options.onTab(key);
    return drawn;
  };
  for (const [key, tab] of tabs.buttons) {
    tab.addEventListener('click', () => void activate(key, false));
    tab.addEventListener('keydown', event => {
      const target = nextTab(PRODUCT_TABS, key, event);
      if (target) { event.preventDefault(); void activate(target, true); }
    });
  }
  const detailSlot = el('aside', 'work-detail-pane');
  detailSlot.hidden = true;
  detailSlot.setAttribute('aria-label', ctx.t('work.detail.label'));
  const main = el('div', 'work-main', tabs.list, tasks.barSlot, ...tabs.panels.values());
  const split = el('div', 'work-split', main, detailSlot);
  const root = el('div', 'work-product-view', header(options), split);
  root.setAttribute('data-product', node.product.id);
  const ready = activate(options.tab, false);
  return { root, id: node.product.id, title: node.product.id, detailSlot, ready, current: () => currentKey,
    currentPanel: () => tabs.panels.get(currentKey)!, activate: (key, focus) => void activate(key, focus),
    showDetail: open => { detailSlot.hidden = !open; split.classList.toggle('detail-open', open); } };
}
