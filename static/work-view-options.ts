// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * What the page gives the Projects view (static/work-view.ts) when it mounts it, and what it gets back to drive it.
 */

import type { WorkFetch } from './work-api.ts';
import type { Translate } from './work-dom.ts';
import type { HistoryPort } from './work-nav.ts';
import type { QuestionsSync } from './work-questions-sync.ts';
import type { WorkTarget } from './work-session-questions.ts';

export type WorkViewOptions = Readonly<{
  root: HTMLElement;
  request: WorkFetch;
  translate: Translate;
  /** Called when the owner asks for the old workspace (from an empty state). */
  onLegacy: () => void;
  /** Called when the reader program is not installed; returns true when the host took over (the view then shows nothing more). */
  onNotAvailable?: () => boolean;
  /** The number of open questions of the tracker each time the view reads it (the entry screen, Refresh, an answer
   *  sent), or null when that read failed. The view never reads it on a timer. */
  onOpenQuestions?: (count: number | null) => void;
  now?: () => number;
  locale?: string;
  /** The browser history (static/work-nav.ts); the page's by default. */
  history?: HistoryPort;
  /** The questions channel shared with the session marker (static/work-questions-sync.ts); the page's by default. */
  sync?: QuestionsSync;
}>;

/** `open` shows the view as the owner left it, in this page or before a reload of this tab (the entry screen the first
 *  time), or the place a target names: the sheet of a task in its project's Questions tab, the Questions tab of a
 *  project, or the entry screen. `forget` drops that memory and the unsent drafts (the browser signs out). */
export type WorkViewController = Readonly<{ open: (target?: WorkTarget) => void; close: () => void; destroy: () => void;
  forget: () => void }>;
