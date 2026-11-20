// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The one path by which the page's question surfaces learn that the open questions changed. Two readers keep their
 * own copy: the Projects view (static/work-view.ts: entry screen, Questions tab, task sheet) and the session marker
 * (static/work-session-marker.ts: the "? n" of session rows and headers). Each publishes here what it learned, and
 * each hears what the other published:
 *   - the view, after an answer it sent was recorded (or found already answered): `answered`;
 *   - either one, after a read whose count of open questions differs from the last count published (null: the read
 *     failed, the badge shows nothing).
 * A reader never hears its own messages, and a count equal to the last one is not published, so two readers that
 * agree send nothing more. Both live in the same bundle (static/work-view.js), so the page holds one channel.
 */

export type QuestionsSource = 'view' | 'marker';

export type QuestionsChange = Readonly<{
  source: QuestionsSource;
  /** The question the owner just answered, when that is the news. */
  answered?: string;
  /** The open questions count a read found, null after a failed read; absent when the message carries no count. */
  openQuestions?: number | null;
}>;

export type QuestionsListener = (change: QuestionsChange) => void;

export type QuestionsSync = Readonly<{
  /** Tell the other readers. A count equal to the last published one is dropped (unless `answered` is set). */
  publish: (change: QuestionsChange) => void;
  /** Hear the other readers' messages; returns the way to stop. */
  subscribe: (source: QuestionsSource, listener: QuestionsListener) => () => void;
  /** The last count published, undefined before the first one. */
  lastCount: () => number | null | undefined;
}>;

export function createQuestionsSync(): QuestionsSync {
  const listeners = new Set<Readonly<{ source: QuestionsSource; listener: QuestionsListener }>>();
  let last: number | null | undefined;
  return {
    publish: change => {
      const counted = change.openQuestions !== undefined;
      if (!change.answered && (!counted || change.openQuestions === last)) return;
      if (counted) last = change.openQuestions;
      for (const entry of [...listeners]) if (entry.source !== change.source) entry.listener(change);
    },
    subscribe: (source, listener) => {
      const entry = { source, listener };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
    lastCount: () => last,
  };
}

/** The channel of the page: the view and the marker take it unless a test gives them their own. */
export const pageQuestionsSync: QuestionsSync = createQuestionsSync();
