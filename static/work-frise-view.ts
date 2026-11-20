// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The "Frise" tab: a simple timeline. One bar per task from its creation to its end (done, or today for an open task),
 * a marker for the due date and one for the estimate; a task without a usable creation date has no bar. Every date is
 * also written as text under the title, so nothing depends on the drawing.
 */

import { FRISE_LEGEND_STATUSES, STATUSES, axisPercent, axisSide, buildFrise, friseBarStyle } from './work-derive.ts';
import type { Frise, FriseRow } from './work-derive.ts';
import { button, el, formatDate, notice, omittedNote, setAttributes, statusBadge } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';
import type { ProjectDoc } from './work-types.ts';

function place(node: HTMLElement, frise: Frise, ms: number): void {
  node.style.setProperty('--at', `${axisPercent(frise, ms).toFixed(2)}%`);
}

function marker(ctx: ViewContext, frise: Frise, kind: 'due' | 'eta', ms: number): HTMLElement {
  const node = el('span', `work-mark work-mark-${kind}`);
  place(node, frise, ms);
  setAttributes(node, { 'aria-hidden': 'true', title: ctx.t(kind === 'due' ? 'work.frise.due' : 'work.frise.eta') });
  return node;
}

function statusText(ctx: ViewContext, status: string): string {
  return (STATUSES as readonly string[]).includes(status) ? ctx.t(`work.status.${status}`) : status;
}

function bar(ctx: ViewContext, frise: Frise, row: FriseRow): HTMLElement | null {
  if (row.start === null || row.end === null) return null;
  const node = el('span', `work-bar-span ${friseBarStyle(row.task.status).cls}`);
  const name = ctx.t('work.frise.barStatus', { status: statusText(ctx, row.task.status) });
  setAttributes(node, { role: 'img', 'aria-label': name, title: name });
  const left = axisPercent(frise, row.start), right = axisPercent(frise, row.end);
  node.style.setProperty('--at', `${left.toFixed(2)}%`);
  node.style.setProperty('--len', `${Math.max(1, right - left).toFixed(2)}%`);
  return node;
}

/** A visible word at the edge of the track when a date of the row lies outside the axis (it is drawn at that edge). */
function clipMarks(ctx: ViewContext, frise: Frise, row: FriseRow): HTMLElement[] {
  const dates = [row.start, row.end, row.due, row.eta].filter((ms): ms is number => ms !== null);
  const marks: HTMLElement[] = [];
  if (dates.some(ms => axisSide(frise, ms) < 0)) marks.push(el('span', 'work-frise-clip work-frise-clip-before', `← ${ctx.t('work.frise.earlier')}`));
  if (dates.some(ms => axisSide(frise, ms) > 0)) marks.push(el('span', 'work-frise-clip work-frise-clip-after', `${ctx.t('work.frise.later')} →`));
  return marks;
}

function dateFacts(ctx: ViewContext, row: FriseRow): string {
  const { task } = row;
  const parts: string[] = [];
  if (row.start !== null) parts.push(ctx.t('work.frise.created', { date: formatDate(task.created, ctx.locale) }));
  if (task.doneAt && row.end !== null && row.end !== row.start) parts.push(ctx.t('work.frise.done', { date: formatDate(task.doneAt, ctx.locale) }));
  if (row.eta !== null) parts.push(ctx.t('work.frise.etaOn', { date: formatDate(task.eta, ctx.locale) }));
  if (row.due !== null) parts.push(ctx.t('work.frise.dueOn', { date: formatDate(task.due, ctx.locale) }));
  return parts.length > 0 ? parts.join(' · ') : ctx.t('work.frise.noDates');
}

function friseRow(ctx: ViewContext, frise: Frise, row: FriseRow): HTMLElement {
  const item = el('li', 'work-frise-row');
  const label = button('work-frise-label', '', () => ctx.selectTask(row.task.id),
    statusBadge(ctx.t, row.task.status), el('span', 'work-frise-title', row.task.title));
  label.setAttribute('data-task', row.task.id);
  if (ctx.selectedTask() === row.task.id) label.setAttribute('aria-current', 'true');
  const track = el('span', 'work-frise-track');
  const barNode = bar(ctx, frise, row);
  if (barNode) track.append(barNode);
  if (row.eta !== null) track.append(marker(ctx, frise, 'eta', row.eta));
  if (row.due !== null) track.append(marker(ctx, frise, 'due', row.due));
  track.append(...clipMarks(ctx, frise, row));
  item.append(label, track, el('span', 'work-frise-facts', dateFacts(ctx, row)));
  return item;
}

function axis(ctx: ViewContext, frise: Frise): HTMLElement {
  const today = el('span', 'work-frise-today', ctx.t('work.frise.today'));
  place(today, frise, frise.today);
  const edges = el('div', 'work-frise-edges', el('span', 'work-frise-edge', formatDate(new Date(frise.min).toISOString(), ctx.locale)),
    el('span', 'work-frise-edge', formatDate(new Date(frise.max).toISOString(), ctx.locale)));
  return el('div', 'work-frise-axis', el('div', 'work-frise-today-row', today), edges);   // "Today" has its own row: it cannot cover an edge date
}

/** One swatch and one word per status, drawn with the very classes of the bars. */
function statusLegend(ctx: ViewContext): HTMLElement {
  const list = el('ul', 'work-frise-status-legend');
  list.setAttribute('aria-label', ctx.t('work.frise.legendStatus'));
  for (const status of FRISE_LEGEND_STATUSES) {
    const swatch = el('span', `work-bar-swatch ${friseBarStyle(status).cls}`);
    swatch.setAttribute('aria-hidden', 'true');
    const item = el('li', `work-frise-status work-frise-status-${status}`, swatch, statusText(ctx, status));
    list.append(item);
  }
  return list;
}

export function renderFrise(ctx: ViewContext, doc: ProjectDoc): HTMLElement {
  const root = el('div', 'work-frise');
  if (doc.tasks.length === 0) return notice('work-empty', ctx.t('work.frise.empty'));
  const frise = buildFrise(doc.tasks, ctx.nowMs());
  const list = el('ul', 'work-frise-list');
  list.style.setProperty('--today', `${axisPercent(frise, frise.today).toFixed(2)}%`);
  for (const row of frise.rows) list.append(friseRow(ctx, frise, row));
  root.append(axis(ctx, frise), el('p', 'work-frise-legend', ctx.t('work.frise.legend')), statusLegend(ctx), list, omittedNote(ctx.t, doc.omitted.tasks));
  return root;
}
