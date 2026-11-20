// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The way back inside the Projects view. The view has three levels: the entry screen (0), a project on one of its
 * tabs (1), and a task sheet over that tab (2). Each level above the entry screen owns one entry of the browser
 * history, pushed with the page's own URL, so that the browser's Back (and a phone's back gesture) goes up one level
 * instead of leaving the page. The view goes up by its own buttons and by Escape too; it then tells this module the
 * level it now shows, and the entries above it are taken back silently. So at most two entries are ever added, and
 * leaving the view (`at(0)`) takes them all back. No data is kept in the history: only the level number.
 */

export type NavLevel = 0 | 1 | 2;

/** What the module needs of `window.history`. */
export type HistoryPort = Readonly<{
  pushState: (state: unknown) => void;
  go: (delta: number) => void;
}>;

const KEY = 'meshWorkLevel';

/** The level an entry of the history stands for: ours carry it, any other entry is the entry screen. */
export function levelOf(state: unknown): NavLevel {
  const value = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[KEY] : undefined;
  return value === 1 || value === 2 ? value : 0;
}

export type WorkNav = Readonly<{
  /** The view now shows `level`: add the entries up to it, or take back those above it. */
  at: (level: NavLevel) => void;
  /** The level the history stands at. */
  level: () => NavLevel;
  /** Call on `popstate`: the level the view must now show, or null when nothing is to be done (an entry this module
   *  took back itself, or a forward move, which is undone). */
  popped: (state: unknown) => NavLevel | null;
}>;

/**
 * `history.go` lands later (a task of the browser), so an entry pushed before it lands would be the one it moves
 * from: closing the view and opening it again at once could then go back past the page. So while a move of this
 * module is under way, a new level is only noted, and reached once the move has landed (its popstate came).
 */
export function createWorkNav(port: HistoryPort): WorkNav {
  let level: NavLevel = 0;
  /** The popstate events still due to this module's own `go`. */
  let moving = 0;
  let wanted: NavLevel | null = null;
  const back = (levels: number): void => { moving++; port.go(-levels); };
  const reach = (next: NavLevel): void => {
    if (next < level) { back(level - next); level = next; return; }
    while (level < next) { level = (level + 1) as NavLevel; port.pushState({ [KEY]: level }); }
  };
  return {
    at: next => {
      if (moving > 0) wanted = next; else reach(next);
    },
    level: () => level,
    popped: state => {
      if (moving > 0) {
        moving--;
        if (moving === 0 && wanted !== null) { const next = wanted; wanted = null; reach(next); }
        return null;
      }
      const target = levelOf(state);
      if (target < level) { level = target; return target; }
      if (target > level) back(target - level);   // forward to a place the view no longer shows: go back to it
      return null;
    },
  };
}

/** The history of the page as a port. The page's other writer of the history (the layout hash, app.js) keeps the
 *  state of the entry it replaces. */
export function browserHistory(): HistoryPort {
  return {
    pushState: state => window.history.pushState(state, ''),
    go: delta => window.history.go(delta),
  };
}

/** Escape in a text field that holds text leaves it alone: the owner's draft is not dropped by going up a level. */
export function escapeKeepsField(target: EventTarget | null): boolean {
  return (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.value !== '';
}

/** The tabs of a project view are hidden while the sheet is shown (a phone layout): closing the sheet then puts
 *  back where the tab was scrolled. */
export function tabsHidden(projectRoot: HTMLElement): boolean {
  return projectRoot.querySelector<HTMLElement>('.work-main')?.offsetParent === null;
}

/** The element that scrolls the view (the nearest ancestor that scrolls), or the page's scrolling element. */
export function scrollerOf(node: HTMLElement): HTMLElement {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
