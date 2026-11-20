// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The Projects view's memory of the owner's place and unsent drafts while away from it (static/work-view-state.ts
 * keeps them in sessionStorage). It hears the owner type and tick in the answer forms of its root and scroll the
 * view, writes the state a moment later, and at once when the view is left, the page hidden or unloaded. It never
 * reads the tracker and sends nothing anywhere.
 */

import { draftIn, fillDrafts, slotOf } from './work-view-drafts.ts';
import { EMPTY_STATE, clearState, loadState, pageStorage, saveState, withDraft, withPlace } from './work-view-state.ts';
import type { Place, StoragePort, ViewState } from './work-view-state.ts';

/** How long after the last keystroke the state is written. */
export const SAVE_DELAY_MS = 300;

export type ViewMemory = Readonly<{
  /** Where the owner was when last seen in the view. */
  place: () => Place;
  /** Put the stored drafts back into the answer forms of `scope`. */
  fill: (scope: HTMLElement) => void;
  /** The answer of `question` was recorded: its draft goes, now. */
  sent: (question: string) => void;
  /** The view now shows a place the owner moved to (or is leaving it): note it and write it. */
  note: () => void;
  /** Hear the scroll of the view (between `open` and `close`) or not. */
  listen: (on: boolean) => void;
  /** The browser signed out: forget everything, here and in the storage, and keep nothing from now on. */
  forget: () => void;
  dispose: () => void;
}>;

export type MemoryOptions = Readonly<{
  root: HTMLElement;
  /** The place the view shows now (its scroll as last heard, given). */
  current: (scroll: Scroll) => Place;
  /** The element the view scrolls in. */
  scroller: () => HTMLElement;
  storage?: () => StoragePort | null;
}>;

export type Scroll = Readonly<{ scroll: number; sheetScroll: number }>;

export function createViewMemory(options: MemoryOptions): ViewMemory {
  const storage = options.storage ?? pageStorage;
  let state: ViewState = loadState(storage), forgotten = false, listening = false;
  let scroll: Scroll = { scroll: 0, sheetScroll: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!forgotten) saveState(storage, state);
  };
  const later = (): void => { if (timer === null && !forgotten) timer = setTimeout(write, SAVE_DELAY_MS); };
  const note = (): void => { if (!forgotten && listening) state = withPlace(state, options.current(scroll)); };
  const typed = (event: Event): void => {
    const found = slotOf(event.target);
    if (!found || forgotten) return;
    state = withDraft(state, found.question, draftIn(found.slot, Date.now()));
    later();
  };
  // The Cancel of a correction drops its draft (the owner chose not to send it).
  const cancelled = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest('.work-answer-cancel') : null;
    const question = target?.closest<HTMLElement>('[data-work-answer-slot]')?.dataset.workAnswerSlot;
    if (question) { state = withDraft(state, question, null); later(); }
  };
  const scrolled = (event: Event): void => {
    if (!listening || !(event.target instanceof HTMLElement)) return;
    const scroller = options.scroller(), sheet = options.root.querySelector<HTMLElement>('.work-detail-pane');
    if (event.target === scroller) scroll = { ...scroll, scroll: scroller.scrollTop };
    else if (event.target === sheet && !sheet.hidden) scroll = { ...scroll, sheetScroll: sheet.scrollTop };
    else return;
    note(); later();
  };
  const hidden = (): void => { if (document.visibilityState === 'hidden') { note(); write(); } };
  const leaving = (): void => { note(); write(); };
  options.root.addEventListener('input', typed);
  options.root.addEventListener('change', typed);
  options.root.addEventListener('click', cancelled, true);
  document.addEventListener('scroll', scrolled, { capture: true, passive: true });
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', leaving);
  return {
    place: () => state.place,
    fill: scope => fillDrafts(scope, state.drafts),
    sent: question => { state = withDraft(state, question, null); write(); },
    note: () => { note(); write(); },
    listen: on => {
      if (on === listening) return;
      if (!on) { note(); write(); }   // the last place, before the view stops hearing its scroll
      listening = on;
      if (on) {   // where the view stands now (put back by a resume, or at the top of a place just opened)
        const sheet = options.root.querySelector<HTMLElement>('.work-detail-pane');
        scroll = { scroll: options.scroller().scrollTop, sheetScroll: sheet && !sheet.hidden ? sheet.scrollTop : 0 };
        note(); later();
      }
    },
    forget: () => {
      forgotten = true; state = EMPTY_STATE;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      clearState(storage);
    },
    dispose: () => {
      write();
      options.root.removeEventListener('input', typed);
      options.root.removeEventListener('change', typed);
      options.root.removeEventListener('click', cancelled, true);
      document.removeEventListener('scroll', scrolled, { capture: true });
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
    },
  };
}
