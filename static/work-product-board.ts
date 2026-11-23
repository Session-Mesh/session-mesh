// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Board and Timeline tabs of a product's view: every task of the product and of its child products (the
 * `product` document), filtered (static/work-product-filters.ts). They are drawn by the project's own pieces with a
 * product scope: the board's columns (static/work-board-view.ts) with the task's project on each card, the timeline's
 * axis, legend and rows (static/work-frise-view.ts) grouped by project, each group foldable. A column or a group shows
 * its first tasks and a "Show more" button: a product of a thousand tasks draws a few hundred cards at most.
 */

import { boardColumn } from './work-board-view.ts';
import { axisPercent, buildFrise } from './work-derive.ts';
import { button, el, focusFirst, notice, setAttributes } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { friseHead, friseRow } from './work-frise-view.ts';
import { boardColumns, filterTasks, filtersActive, groupByProject, projectLabel } from './work-product-filters.ts';
import type { Filters, ProjectGroup } from './work-product-filters.ts';
import type { ProductDoc } from './work-product-parse.ts';
import type { TaskRow } from './work-types.ts';

/** The cards a column, or the rows a timeline group, shows before "Show more". */
export const PAGE = 50;

/** The note of a list the server cut: the product's view is then partial, and the filters only see the tasks read. */
export function partialNotice(ctx: ViewContext, doc: ProductDoc): HTMLElement | null {
  if (!doc.truncated) return null;
  const total = doc.tasks.length + doc.omittedTasks;
  return notice('work-omitted work-product-partial', ctx.t('work.product.partial', { n: doc.tasks.length, total }));
}

function projectTag(ctx: ViewContext, doc: ProductDoc, row: TaskRow): HTMLElement {
  const label = projectLabel(doc, row);
  const tag = el('span', 'work-card-project', label ?? ctx.t('work.noProject'));
  tag.setAttribute('data-project', row.project ?? '');
  return tag;
}

export function renderProductBoard(ctx: ViewContext, doc: ProductDoc, filters: Filters, shown: ReadonlyMap<string, number> = new Map()): HTMLElement {
  const grid = el('div', 'work-columns');
  for (const column of boardColumns(doc, filters)) {
    // "other" is a guard for hand-edited data: shown only when it holds something
    if (column.key === 'other' && column.count === 0) continue;
    grid.append(boardColumn(ctx, column.key, column.rows, column.missing,
      { count: column.count, limit: PAGE, initial: Math.max(PAGE, shown.get(column.key) ?? PAGE), extra: row => projectTag(ctx, doc, row) }));
  }
  return el('div', 'work-board work-product-board', grid);
}

/** The rows of a group, the first ones, then a "Show more" button for the next ones (each row drawn when shown). */
function groupRows(ctx: ViewContext, list: HTMLElement, tasks: readonly TaskRow[], draw: (task: TaskRow) => HTMLElement, initial: number): void {
  const more = (from: number, amount = PAGE): void => {
    const drawn = tasks.slice(from, from + amount).map(draw);
    list.append(...drawn);
    if (from + amount >= tasks.length) return;
    const item = el('li', 'work-frise-more');
    const showMore = button('btn work-more', ctx.t('work.product.showMore', { n: Math.min(PAGE, tasks.length - from - amount) }), () => {
      item.remove();
      more(from + amount);
      focusFirst(list.querySelectorAll<HTMLElement>('.work-frise-label')[from + amount] ?? null);
    });
    item.append(showMore);
    list.append(item);
  };
  more(0, initial);
}

/** A project's group: a heading button that folds it (its state kept in `folded`), its rows. */
function friseGroup(ctx: ViewContext, group: ProjectGroup, draw: (task: TaskRow) => HTMLElement, folded: Set<string>, shown: number): HTMLElement {
  const section = el('section', 'work-pfrise-group');
  section.setAttribute('data-project', group.project);
  const list = el('ul', 'work-frise-list');
  const name = group.title ?? ctx.t('work.noProject');
  const toggle = button('work-pfrise-toggle', '', () => {
    const fold = !folded.has(group.project);
    if (fold) folded.add(group.project); else folded.delete(group.project);
    list.hidden = fold;
    toggle.setAttribute('aria-expanded', String(!fold));
  }, el('span', 'work-pfrise-chev'), el('span', 'work-pfrise-name', name), el('span', 'work-count', String(group.tasks.length)));
  list.hidden = folded.has(group.project);
  setAttributes(toggle, { 'aria-expanded': String(!list.hidden) });
  groupRows(ctx, list, group.tasks, draw, shown);
  section.append(el('h3', 'work-pfrise-head', toggle), list);
  return section;
}

/** The timeline of the tasks shown, one axis for all, grouped by project. `folded`: the groups folded (kept by the
 *  caller while the view lives). */
export function renderProductFrise(ctx: ViewContext, doc: ProductDoc, filters: Filters, folded: Set<string>, shown: ReadonlyMap<string, number> = new Map()): HTMLElement {
  const tasks = filterTasks(doc, filters);
  if (tasks.length === 0) return notice('work-empty', ctx.t(filtersActive(filters) ? 'work.product.noMatch' : 'work.frise.empty'));
  const frise = buildFrise(tasks, ctx.nowMs());
  const rows = new Map(frise.rows.map(row => [row.task.id, row] as const));
  const root = el('div', 'work-frise work-product-frise', ...friseHead(ctx, frise));
  if (frise.rows.every(row => row.start === null && row.due === null && row.eta === null)) {
    root.append(notice('work-empty', ctx.t('work.product.noDates')));
  }
  for (const group of groupByProject(doc, frise.rows.map(row => row.task))) {
    root.append(friseGroup(ctx, group, task => friseRow(ctx, frise, rows.get(task.id)!), folded, Math.max(PAGE, shown.get(group.project) ?? PAGE)));
  }
  const today = `${axisPercent(frise, frise.today).toFixed(2)}%`;   // the line of today on every track
  for (const list of root.querySelectorAll<HTMLElement>('.work-frise-list')) list.style.setProperty('--today', today);
  return root;
}
