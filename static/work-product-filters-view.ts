// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The filter bar of a product's Board and Timeline: a search field, then one foldable list of checkboxes per filter
 * (project, status, priority, owner, tag; a filter no task gives a value to is left out), "Clear the filters" and
 * the number of tasks shown; one list unfolded at a time. Native controls only: `Tab` reaches each, `Space` ticks, `Enter` on a list's name
 * unfolds it. The bar keeps its controls while the operator types; `change` hears every new set of filters.
 */

import { STATUSES } from './work-derive.ts';
import { button, el, setAttributes } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { EMPTY_FILTERS, FILTER_KEYS, NO_PROJECT, choices, filtersActive } from './work-product-filters.ts';
import type { Choice, FilterKey, Filters } from './work-product-filters.ts';
import type { ProductDoc } from './work-product-parse.ts';

/** How long after the last keystroke the search applies. */
export const SEARCH_DELAY_MS = 150;

export type FilterBar = Readonly<{
  root: HTMLElement;
  /** Say how many tasks are shown out of how many read. */
  shown: (count: number, total: number) => void;
}>;

function choiceLabel(ctx: ViewContext, key: FilterKey, choice: Choice): string {
  if (key === 'projects' && choice.value === NO_PROJECT) return ctx.t('work.noProject');
  if (key === 'statuses') return (STATUSES as readonly string[]).includes(choice.value) ? ctx.t(`work.status.${choice.value}`) : choice.value;
  return choice.label ?? choice.value;
}

type Group = Readonly<{ key: FilterKey; root: HTMLDetailsElement; boxes: readonly HTMLInputElement[]; summary: HTMLElement }>;

function summaryText(ctx: ViewContext, key: FilterKey, picked: number): string {
  const name = ctx.t(`work.product.filter.${key}`);
  return picked > 0 ? `${name} (${picked})` : name;
}

function filterGroup(ctx: ViewContext, doc: ProductDoc, key: FilterKey, filters: Filters, changed: () => void): Group | null {
  const list = choices(doc, key, filters);
  if (list.length === 0) return null;
  const root = el('details', 'work-filter');
  root.setAttribute('data-filter', key);
  const summary = el('summary', 'work-filter-name', summaryText(ctx, key, filters[key].length));
  const fieldset = el('fieldset', 'work-filter-choices', el('legend', 'sr-only', ctx.t(`work.product.filter.${key}`)));
  const boxes = list.map(choice => {
    const box = el('input', 'work-filter-box');
    box.type = 'checkbox';
    box.value = choice.value;
    box.checked = filters[key].includes(choice.value);
    box.addEventListener('change', changed);
    fieldset.append(el('label', 'work-filter-choice', box, el('span', 'work-filter-label', choiceLabel(ctx, key, choice)),
      el('span', 'work-count', String(choice.count))));
    return box;
  });
  root.append(summary, fieldset);
  return { key, root, boxes, summary };
}

/** The filters the controls hold now. */
function read(search: HTMLInputElement, groups: readonly Group[]): Filters {
  const picked = (key: FilterKey): string[] =>
    groups.find(group => group.key === key)?.boxes.filter(box => box.checked).map(box => box.value) ?? [];
  return { projects: picked('projects'), statuses: picked('statuses'), priorities: picked('priorities'), owners: picked('owners'),
    tags: picked('tags'), text: search.value };
}

function searchField(ctx: ViewContext, filters: Filters): HTMLInputElement {
  const search = el('input', 'work-filter-search');
  search.type = 'search';
  search.value = filters.text;
  setAttributes(search, { 'aria-label': ctx.t('work.product.search'), placeholder: ctx.t('work.product.search'), maxlength: '200' });
  return search;
}

export function renderFilterBar(ctx: ViewContext, doc: ProductDoc, filters: Filters, change: (next: Filters) => void): FilterBar {
  const search = searchField(ctx, filters);
  const count = el('p', 'work-filter-count');
  count.setAttribute('role', 'status');
  const groups: Group[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = button('btn work-filter-clear', ctx.t('work.product.clear'), () => apply(EMPTY_FILTERS, true));
  const apply = (next: Filters, reset = false): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (reset) {
      search.value = '';
      for (const group of groups) for (const box of group.boxes) box.checked = false;
    }
    for (const group of groups) group.summary.textContent = summaryText(ctx, group.key, next[group.key].length);
    clear.hidden = !filtersActive(next);
    change(next);
  };
  const changed = (): void => apply(read(search, groups));
  for (const key of FILTER_KEYS) {
    const group = filterGroup(ctx, doc, key, filters, changed);
    if (group) groups.push(group);
  }
  // One list unfolded at a time: on a phone an unfolded list pushes the tasks down.
  for (const group of groups) {
    group.root.addEventListener('toggle', () => {
      if (group.root.open) for (const other of groups) if (other !== group) other.root.open = false;
    });
  }
  search.addEventListener('input', () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(changed, SEARCH_DELAY_MS);
  });
  clear.hidden = !filtersActive(filters);
  const root = el('div', 'work-filters', search, ...groups.map(group => group.root), clear, count);
  setAttributes(root, { role: 'group', 'aria-label': ctx.t('work.product.filters') });
  return { root, shown: (shown, total) => { count.textContent = ctx.t('work.product.shown', { n: shown, total }); } };
}
