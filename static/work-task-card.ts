// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { button, el, formatDate, priorityTag, setAttributes, statusBadge } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { Blocker, TaskRow } from './work-types.ts';

function blockerLine(ctx: ViewContext, blocker: Blocker): HTMLElement {
  const text = blocker.on ? ctx.t('work.blockerOn', { text: blocker.text, on: blocker.on }) : blocker.text;
  return el('span', 'work-card-blocker', ctx.t('work.blockedBecause', { text }));
}

function metaParts(ctx: ViewContext, row: TaskRow): string[] {
  const parts = [row.id];
  if (row.track) parts.push(ctx.t('work.trackValue', { track: row.track }));
  if (row.owner) parts.push(row.owner);
  if (row.due) parts.push(ctx.t('work.dueOn', { date: formatDate(row.due, ctx.locale) }));
  if (row.daysSinceActivity !== null) parts.push(ctx.t('work.daysAgo', { n: row.daysSinceActivity }));
  return parts;
}

/** A task as a button: status word, title, priority, then one line of facts. Opens the detail pane. */
export function taskCard(ctx: ViewContext, row: TaskRow, extra?: HTMLElement): HTMLButtonElement {
  const head = el('span', 'work-card-head', statusBadge(ctx.t, row.status), el('span', 'work-card-title', row.title), priorityTag(row.priority));
  const card = button('work-card', '', () => ctx.selectTask(row.id), head, el('span', 'work-card-meta', metaParts(ctx, row).join(' · ')));
  for (const blocker of row.openBlockers) card.append(blockerLine(ctx, blocker));
  if (row.openBlockers.length === 0 && row.lastNote && row.daysSinceActivity !== null) {
    card.append(el('span', 'work-card-note', ctx.t('work.lastNote', { text: row.lastNote })));
  }
  if (extra) card.append(extra);
  setAttributes(card, { 'data-task': row.id });
  if (ctx.selectedTask() === row.id) card.setAttribute('aria-current', 'true');
  return card;
}

/** A list of cards, or nothing when there are none. */
export function taskList(ctx: ViewContext, rows: readonly TaskRow[]): HTMLElement {
  const list = el('div', 'work-card-list');
  for (const row of rows) list.append(taskCard(ctx, row));
  return list;
}
