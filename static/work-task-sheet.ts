// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The task sheet of the Projects view's project and product pages (static/work-view.ts): the detail of one task shown over the
 * project's tab, at level 2 of the way back (static/work-nav.ts), read again after an answer, closed back to the tab
 * scrolled where it was with the focus on the control that opened it.
 */

import type { WorkApi } from './work-api.ts';
import { renderDetail } from './work-detail-view.ts';
import { button, el, focusFirst, markSelected } from './work-dom.ts';
import type { Translate, ViewContext } from './work-dom.ts';
import { errorBlock, loadingBlock, recordedButUnread } from './work-error-view.ts';
import { scrollerOf, tabsHidden } from './work-nav.ts';
import type { WorkNav } from './work-nav.ts';
import { nameSheetBack } from './work-project-view.ts';
import type { SheetView } from './work-project-view.ts';
import { fillDrafts, unsentDrafts } from './work-view-drafts.ts';
import type { ViewMemory } from './work-view-memory.ts';

/** After an answer (or on opening the sheet at a question, `fresh`): the question, and whether focus goes to it once
 *  the task is read. */
export type AfterAnswer = Readonly<{ question: string; focus: boolean; fresh?: boolean }>;

export type TaskSheetHost = Readonly<{
  api: WorkApi;
  t: Translate;
  ctx: ViewContext;
  nav: WorkNav;
  memory: ViewMemory;
  /** The view's request generation: a read started under another one is not shown. */
  generation: () => number;
  /** The project or product view shown, or null. */
  view: () => SheetView | null;
}>;

export class TaskSheet {
  /** The task whose sheet is open. */
  selected: string | null = null;
  /** Where the tab was scrolled when the sheet covered it (a phone), put back when the sheet closes. */
  tabScroll: number | null = null;
  private sheetBack: HTMLElement | null = null;
  private controller: AbortController | null = null;
  private sequence = 0;
  private snapshot: string | null = null;
  private previewScope: AbortController | null = null;

  constructor(private readonly host: TaskSheetHost) {}

  /** The read of the sheet under way is not shown. */
  stop(): void { this.previewScope?.abort(); this.previewScope = null; this.controller?.abort(); this.sequence++; }

  /** A tab shown: the sheet's way back names it. */
  tabShown(view: SheetView): void { if (this.sheetBack) nameSheetBack(this.host.t, this.sheetBack, view); }

  /** `resuming` (the sheet the owner left): a task gone since closes the sheet. False when the task could not be read
   *  (a view moved meanwhile is not a failure); after an answer the sheet then says it is recorded, with "Try again". */
  async select(id: string, after?: AfterAnswer, resuming = false): Promise<boolean> {
    const view = this.host.view();
    if (!view) return true;
    this.previewScope?.abort(); this.previewScope = null;
    this.selected = id;
    markSelected(view.root, id);
    if (view.detailSlot.hidden) this.tabScroll = scrollerOf(view.root).scrollTop;
    if (!after || after.fresh) view.detailSlot.replaceChildren(this.closeButton(view), loadingBlock(this.host.t));
    view.showDetail(true);
    this.host.nav.at(2);
    this.host.memory.note();
    const token = this.host.generation(), sequence = ++this.sequence;
    this.controller?.abort();
    this.controller = new AbortController();
    const result = await this.host.api.task(id, this.controller.signal);
    if (token !== this.host.generation() || sequence !== this.sequence || this.selected !== id) return true;
    if (!result.ok && resuming && result.error.kind === 'missing') { this.close(view); return true; }
    if (!result.ok && after && !after.fresh) {
      const slot = view.detailSlot;
      recordedButUnread(this.host.t, slot, after.question, result.error, () => void this.select(id, after), slot.querySelector('.work-detail-close'));
    } else if (!result.ok) {
      view.detailSlot.replaceChildren(this.closeButton(view), errorBlock(this.host.t, result.error, { retry: () => void this.select(id) }));
    }
    if (!result.ok) return false;
    this.snapshot = JSON.stringify(result.value);
    this.previewScope = new AbortController();
    const body = renderDetail({ ...this.host.ctx, previewSignal: this.previewScope.signal }, result.value);
    // The reload after an answer keeps what the owner was typing under the other questions; the drafts kept while
    // away (this sheet's, or one typed in another place) come back too.
    if (after && !after.fresh) fillDrafts(body, unsentDrafts(view.detailSlot, after.question));
    this.host.memory.fill(body);
    view.detailSlot.replaceChildren(this.closeButton(view), body);
    if (after && !after.focus) return true;
    const question = after ? body.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(after.question)}"]`) : null;
    focusFirst(question ?? body.querySelector<HTMLElement>('.work-detail-heading'));
    return true;
  }

  /** Read the open task without disturbing an answer or the control currently in use. */
  async refreshInBackground(signal: AbortSignal | undefined, idle: () => boolean): Promise<void> {
    const view = this.host.view(), id = this.selected, snapshot = this.snapshot;
    if (!view || !id || snapshot === null || view.detailSlot.hidden || !view.detailSlot.querySelector('.work-detail')) return;
    const token = this.host.generation(), sequence = this.sequence;
    const result = await this.host.api.task(id, signal);
    if (token !== this.host.generation() || sequence !== this.sequence || this.selected !== id || this.host.view() !== view || view.detailSlot.hidden) return;
    const slot = view.detailSlot;
    const status = (text: string | null): void => {
      let node = slot.querySelector<HTMLElement>('.work-sheet-refresh-status');
      if (!text) { node?.remove(); return; }
      if (!node) {
        node = el('p', 'work-mute work-sheet-refresh-status');
        node.setAttribute('role', 'status');
        slot.querySelector('.work-detail-close')?.after(node);
      }
      node.textContent = text;
    };
    if (!result.ok) { status(this.host.t('work.autoRefreshUnavailable')); return; }
    const next = JSON.stringify(result.value);
    if (next === this.snapshot) { status(null); return; }
    const drafts = unsentDrafts(slot, '');
    const focused = document.activeElement;
    const headingFocused = focused === slot.querySelector('.work-detail-heading');
    const backFocused = focused === slot.querySelector('.work-detail-close');
    if (!idle() || (slot.contains(focused) && !headingFocused && !backFocused) || drafts.size > 0 || slot.querySelector('.work-answer-input[readonly]')) {
      status(this.host.t('work.sheetUpdatesPending'));
      return;
    }
    const opened = [...slot.querySelectorAll<HTMLDetailsElement>('.work-answer-history[open]')]
      .map(node => node.closest<HTMLElement>('[data-question-id]')?.dataset.questionId).filter((value): value is string => !!value);
    const scroll = slot.scrollTop, main = scrollerOf(view.root), mainScroll = main.scrollTop;
    this.previewScope?.abort();
    this.previewScope = new AbortController();
    const body = renderDetail({ ...this.host.ctx, previewSignal: this.previewScope.signal }, result.value);
    fillDrafts(body, drafts);
    this.host.memory.fill(body);
    for (const id of opened) {
      const question = body.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(id)}"]`);
      const details = question?.querySelector<HTMLDetailsElement>('.work-answer-history');
      if (details) details.open = true;
    }
    status(null);
    slot.querySelector('.work-detail')?.replaceWith(body);
    if (headingFocused) focusFirst(body.querySelector<HTMLElement>('.work-detail-heading'), true);
    slot.scrollTop = scroll;
    main.scrollTop = mainScroll;
    this.snapshot = next;
  }

  /** The sheet's way back: it names the tab it returns to (and, for a screen reader, the project). */
  private closeButton(view: SheetView): HTMLElement {
    this.sheetBack = button('btn work-detail-close', '', () => this.close(view));
    nameSheetBack(this.host.t, this.sheetBack, view);
    return this.sheetBack;
  }

  /** Back from the sheet to the tab it covered, scrolled where it was, focus on the control that opened it. */
  close(view: SheetView): void {
    const previous = this.selected, restore = tabsHidden(view.root) ? this.tabScroll : null;
    this.selected = null; this.tabScroll = null; this.sheetBack = null;
    this.stop();
    this.host.nav.at(1);
    markSelected(view.root, null);
    view.showDetail(false);
    view.detailSlot.replaceChildren();
    if (restore !== null) scrollerOf(view.root).scrollTop = restore;
    this.host.memory.note();
    // The control that opened the sheet is in the tab shown (a card, or a task heading of the Questions tab).
    const selector = `[data-task="${CSS.escape(previous ?? '')}"]`;
    const shown = [...view.root.querySelectorAll<HTMLElement>(selector)].find(node => !node.closest('[hidden]')) ?? null;
    if (previous) focusFirst(view.currentPanel().querySelector<HTMLElement>(selector) ?? shown
      ?? view.currentPanel(), restore !== null);   // a task past those drawn ("Show more"): its tab
  }

  /** Close the sheet shown over the project's tab (Escape, Back); false when none is shown. */
  closeShown(): boolean {
    const view = this.host.view(), shown = view !== null && !view.detailSlot.hidden;
    if (shown) this.close(view);
    return shown;
  }
}
