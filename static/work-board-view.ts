// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** The "Tableau" tab: the `columns` of the project document as four columns (one vertical list on a phone). */

import { el, notice, omittedNote } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import { taskCard } from './work-task-card.ts';
import type { ColumnKey, ProjectDoc, TaskRow } from './work-types.ts';

const COLUMNS: readonly ColumnKey[] = ['todo', 'inProgress', 'blocked', 'done', 'other'];
/** Names of the columns in the `columns_omitted` object of the document. */
const OMITTED_NAME: Readonly<Record<ColumnKey, string>> = { todo: 'todo', inProgress: 'in_progress', blocked: 'blocked', done: 'done', other: 'other' };

function column(ctx: ViewContext, key: ColumnKey, rows: readonly TaskRow[], missing: number): HTMLElement {
  const root = el('section', `work-column work-column-${key}`);
  const heading = el('h3', 'work-column-title', ctx.t(`work.col.${key}`), el('span', 'work-count', String(rows.length + missing)));
  root.append(heading);
  const list = el('div', 'work-card-list');
  for (const row of rows) list.append(taskCard(ctx, row));
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
    grid.append(column(ctx, key, rows, missing));
  }
  root.append(grid, omittedNote(ctx.t, doc.omitted.tasks));
  return root;
}
