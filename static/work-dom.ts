// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * DOM building for the Projects view. Everything shown comes from tracker data written by people and agents, so no
 * HTML is ever built from a string: elements are created, and text goes through textContent / text nodes only.
 */

import { STATUSES, progressPercent } from './work-derive.ts';
import type { Counts } from './work-types.ts';
import type { WorkResult } from './work-api.ts';
import type { RecordedSessions } from './work-project-sessions.ts';
import type { AnswerSender } from './work-answer-form.ts';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type ViewContext = Readonly<{
  t: Translate;
  locale: string | undefined;
  nowMs: () => number;
  selectedTask: () => string | null;
  selectTask: (id: string) => void;
  projectSessions?: (id: string, signal: AbortSignal) => Promise<WorkResult<RecordedSessions>>;
  scopeSignal?: AbortSignal;
  /** Sends the owner's answer to an open question; null where the view offers no answer form. */
  answers: AnswerSender | null;
  /** Prefix of the element ids of answer forms, so that the same question shown twice (tab and sheet) keeps unique ids. */
  answerScope?: string;
}>;

export type Child = Node | string | null | undefined;

/** Create an element with a class and children; strings become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

export function setAttributes(node: Element, attributes: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
}

export function button(className: string, label: string, onClick: () => void, ...children: Child[]): HTMLButtonElement {
  const node = el('button', className, ...children);
  node.type = 'button';
  if (label) node.append(label);
  node.addEventListener('click', onClick);
  return node;
}

/** A status shown with its word first; the dot is a decoration, never the only signal. */
export function statusBadge(t: Translate, status: string): HTMLElement {
  const known = (STATUSES as readonly string[]).includes(status);
  const badge = el('span', `work-status work-st-${known ? status : 'unknown'}`);
  badge.append(el('span', 'work-dot'), known ? t(`work.status.${status}`) : status);
  return badge;
}

export function priorityTag(priority: string): HTMLElement | null {
  return priority ? el('span', `work-prio work-prio-${/^P[0-3]$/.test(priority) ? priority : 'other'}`, priority) : null;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** A short local date; the raw value when it is not a date. */
export function formatDate(value: string | null, locale: string | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const key = locale ?? '';
  let format = dateFormats.get(key);
  if (!format) {
    try { format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch {
      format = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    dateFormats.set(key, format);
  }
  return format.format(new Date(ms));
}

/** A timestamp in UTC (the tracker stores UTC); the zone is written out so nobody reads it as local time. */
export function formatDateTime(value: string | null, locale: string | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  try {
    return `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
      .format(new Date(ms))} UTC`;
  } catch { return value; }
}

/** The counts as the entry list and the project header show them: done over total, a bar, the blockers. */
export function progressBlock(t: Translate, counts: Counts): HTMLElement {
  const total = counts.open + counts.done;
  const percent = progressPercent(counts);
  const block = el('span', 'work-progress');
  block.append(el('span', 'work-progress-text', total === 0 ? t('work.noTasks') : t('work.doneOfTotal', { n: counts.done, done: counts.done, total })));
  const track = el('span', 'work-bar');
  const fill = el('span', 'work-bar-fill');
  fill.style.setProperty('--w', `${percent ?? 0}%`);
  track.append(fill);
  setAttributes(track, { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent ?? 0),
    'aria-label': t('work.progressLabel') });
  block.append(track, el('span', counts.blockers > 0 ? 'work-blockers has' : 'work-blockers', t('work.blockersCount', { n: counts.blockers })));
  return block;
}

export function notice(className: string, text: string, role: 'status' | 'alert' = 'status'): HTMLElement {
  const node = el('p', `work-notice ${className}`, text);
  node.setAttribute('role', role);
  return node;
}

/** A note about a list the server cut short (`<key>_omitted`), or an empty fragment. */
export function omittedNote(t: Translate, count: number | undefined): Node {
  return count ? notice('work-omitted', t('work.omitted', { n: count })) : document.createDocumentFragment();
}

/** Mark the control of task `id` as the one shown in the sheet (none when null). */
export function markSelected(scope: HTMLElement, id: string | null): void {
  for (const node of scope.querySelectorAll<HTMLElement>('[data-task]')) {
    if (node.getAttribute('data-task') === id) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current');
  }
}

/** Focus a node, made focusable when it is not; `preventScroll` when the caller already put the scroll back. */
export function focusFirst(node: HTMLElement | null, preventScroll = false): void {
  if (!node) return;
  if (!node.matches('button, a, input, select, textarea, [tabindex]')) node.tabIndex = -1;
  node.focus({ preventScroll });
}
