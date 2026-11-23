// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The "Tableau" tab: the `columns` of the project document as four columns (one vertical list on a phone). */

import { button, el, focusFirst, notice, omittedNote } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { taskCard } from './work-task-card.ts';
import type { ColumnKey, ProjectDoc, TaskRow } from './work-types.ts';

const COLUMNS: readonly ColumnKey[] = ['todo', 'inProgress', 'blocked', 'done', 'other'];
/** Names of the columns in the `columns_omitted` object of the document. */
const OMITTED_NAME: Readonly<Record<ColumnKey, string>> = { todo: 'todo', inProgress: 'in_progress', blocked: 'blocked', done: 'done', other: 'other' };

/** How a column shows its cards: at most `limit` at first, then as many more per "Show more"; `extra` adds a line
 *  to a card (the project of a task on a product's board). */
export type ColumnOptions = Readonly<{ limit?: number; initial?: number; extra?: (row: TaskRow) => HTMLElement | null }>;

function cards(ctx: ViewContext, list: HTMLElement, rows: readonly TaskRow[], options: ColumnOptions): void {
  const step = options.limit ?? rows.length;
  const more = (from: number, amount = step): void => {
    for (const row of rows.slice(from, from + amount)) list.append(taskCard(ctx, row, options.extra?.(row) ?? undefined));
    if (from + amount >= rows.length) return;
    const left = rows.length - from - amount;
    const showMore = button('btn work-more', ctx.t('work.product.showMore', { n: Math.min(step, left) }), () => {
      showMore.remove();
      more(from + amount);
      focusFirst(list.querySelectorAll<HTMLElement>('.work-card')[from + amount] ?? null);
    });
    list.append(showMore);
  };
  more(0, options.initial ?? step);
}

/** A column: its name and counter (`count`, by default the cards and the missing ones), its cards, a note of the
 *  missing ones. */
export function boardColumn(ctx: ViewContext, key: ColumnKey, rows: readonly TaskRow[], missing: number,
  options: ColumnOptions & Readonly<{ count?: number }> = {}): HTMLElement {
  const root = el('section', `work-column work-column-${key}`);
  const heading = el('h3', 'work-column-title', ctx.t(`work.col.${key}`), el('span', 'work-count', String(options.count ?? rows.length + missing)));
  root.append(heading);
  const list = el('div', 'work-card-list');
  cards(ctx, list, rows, options);
  if (rows.length === 0 && missing === 0) list.append(el('p', 'work-column-empty', ctx.t('work.col.empty')));
  if (missing > 0) list.append(notice('work-omitted', ctx.t('work.col.missing', { n: missing })));
  root.append(list);
  return root;
}

export function renderBoard(ctx: ViewContext, doc: ProjectDoc): HTMLElement {
  const byId = new Map(doc.tasks.map(task => [task.id, task] as const));
  const root = el('div', 'work-board');
  const grid = el('div', 'work-columns');
  for (const key of COLUMNS) {
    const ids = doc.columns[key];
    const rows = ids.map(id => byId.get(id)).filter((row): row is TaskRow => row !== undefined);
    const missing = ids.length - rows.length + (doc.omitted['columns.' + OMITTED_NAME[key]] ?? 0);
    // "other" is a guard for hand-edited data: shown only when it holds something
    if (key === 'other' && rows.length + missing === 0) continue;
    grid.append(boardColumn(ctx, key, rows, missing));
  }
  root.append(grid, omittedNote(ctx.t, doc.omitted.tasks));
  return root;
}
