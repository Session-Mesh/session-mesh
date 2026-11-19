// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** What the view shows instead of data: loading, an empty tracker, a failed read. No jargon, always a way out. */

import type { WorkError } from './work-api.ts';
import { button, el } from './work-dom.ts';
import type { Translate } from './work-dom.ts';

export type ErrorActions = Readonly<{ retry: () => void; legacy?: () => void; back?: () => void }>;

export function loadingBlock(t: Translate): HTMLElement {
  const node = el('p', 'work-loading', t('work.loading'));
  node.setAttribute('role', 'status');
  return node;
}

const STATUS_KINDS: readonly string[] = ['no-tracker', 'not-available', 'busy', 'unavailable'];

type Wording = Readonly<{ title: string; text: string }>;

function wording(t: Translate, error: WorkError): Wording {
  if (error.kind === 'no-tracker') return { title: t('work.empty.title'), text: t('work.empty.noTracker') };
  if (error.kind === 'not-available') return { title: t('work.error.title'), text: t('work.error.notAvailable') };
  if (error.kind === 'busy') return { title: t('work.error.title'), text: t('work.error.busy') };
  if (error.kind === 'unavailable') return { title: t('work.error.title'), text: t('work.error.unavailable') };
  if (error.kind === 'missing') return { title: t('work.error.title'), text: t('work.error.missing') };
  if (error.kind === 'timeout') return { title: t('work.error.title'), text: t('work.error.timeout') };
  if (error.kind === 'network') return { title: t('work.error.title'), text: t('work.error.network') };
  if (error.kind === 'invalid' || error.kind === 'shape') return { title: t('work.error.title'), text: t('work.error.shape') };
  return { title: t('work.error.title'), text: t('work.error.failed') };
}

/** The block for a failed read: a title, one plain sentence, the HTTP status for support, and the actions that make sense. */
export function errorBlock(t: Translate, error: WorkError, actions: ErrorActions): HTMLElement {
  const words = wording(t, error);
  const root = el('div', 'work-error');
  root.setAttribute('role', STATUS_KINDS.includes(error.kind) ? 'status' : 'alert');
  root.dataset.kind = error.kind;
  const row = el('div', 'work-actions');
  if (error.retry) row.append(button('btn', t('work.retry'), actions.retry));
  if (actions.back) row.append(button('btn', t('work.back'), actions.back));
  if (actions.legacy) row.append(button('btn', t('work.useOldView'), actions.legacy));
  root.append(el('h2', 'work-error-title', words.title), el('p', 'work-error-text', words.text));
  if (error.status > 0) root.append(el('p', 'work-error-status work-mute', t('work.error.status', { status: error.status })));
  root.append(row);
  return root;
}
