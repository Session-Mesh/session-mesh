// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Read one explicitly selected Work task without leaving or mutating the current sheet. */
import { el, statusBadge } from './work-dom.ts';
import type { ViewContext } from './work-dom.ts';

export function dependencyPreview(ctx: ViewContext, id: string): HTMLElement {
  const details = el('details', 'work-dep-preview');
  const summary = el('summary', '', ctx.t('work.dep.preview', { id }));
  const content = el('div', 'work-dep-preview-content');
  details.append(summary, content);
  let controller: AbortController | null = null;
  let sequence = 0;
  details.addEventListener('toggle', () => {
    controller?.abort();
    const current = ++sequence;
    if (!details.open) { content.replaceChildren(); return; }
    controller = new AbortController();
    content.replaceChildren(el('p', '', ctx.t('work.dep.previewLoading')));
    void ctx.previewTask!(id, controller.signal).then(result => {
      if (current !== sequence || !details.open || !details.isConnected) return;
      if (!result.ok) { content.replaceChildren(el('p', '', ctx.t('work.dep.previewUnavailable'))); return; }
      const { task, projectTitle } = result.value;
      content.replaceChildren(el('strong', '', task.title), statusBadge(ctx.t, task.status),
        el('p', '', projectTitle ?? task.project ?? ctx.t('work.dep.previewNoProject')));
    }, () => {
      if (current === sequence && details.open && details.isConnected)
        content.replaceChildren(el('p', '', ctx.t('work.dep.previewUnavailable')));
    });
  });
  return details;
}
