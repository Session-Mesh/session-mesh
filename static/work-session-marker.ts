// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The reads behind the session marker. The page calls `tick` after each session listing it applies (every few seconds);
 * a read starts only when the page is visible, none is in flight, and the last one started at least a minute ago (or
 * `refresh` asked for one). So an idle page sends about one request a minute, through the page's read slots
 * (static/work-api.ts). A tracker that cannot be read shows no marker and no error: a missing reader program, or one
 * that does not know the request (an older install), stops the reads for the page's life; any other failure clears
 * the markers until a later read succeeds, except `busy`, which keeps the last ones.
 *
 * The Projects view tells the marker through the questions channel (static/work-questions-sync.ts) when the owner
 * answered a question or when one of its reads found another count. The marker then drops the answered question at
 * once, discards a read started before that news, and reads again now (not a minute later); that read reports to the
 * page even when the markers did not change, since the view may have written another count (or none) meanwhile.
 */

import { createWorkApi } from './work-api.ts';
import type { WorkApiOptions, WorkApi, WorkFetch, WorkResult } from './work-api.ts';
import { pageQuestionsSync } from './work-questions-sync.ts';
import type { QuestionsChange, QuestionsSync } from './work-questions-sync.ts';
import { markerIndex, withoutAnswered } from './work-session-questions.ts';
import type { SessionMarker, SessionQuestionsDoc } from './work-session-questions.ts';

export type SessionMarkerOptions = Readonly<{
  request: WorkFetch;
  /** Called after a read that changed the markers or the count, and after any read the view's news asked for. */
  onChange: () => void;
  visible?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  api?: WorkApiOptions;
  /** The questions channel shared with the Projects view; the page's one by default. */
  sync?: QuestionsSync;
}>;

export type SessionMarkerController = Readonly<{
  /** Read when it is due (see above). */
  tick: () => void;
  /** Read at the next tick whatever the time, for example after the owner answered in the Projects view. */
  refresh: () => void;
  /** The marker of a session name, or null when it has no open question (or nothing could be read). */
  marker: (name: string) => SessionMarker | null;
  /** Every open question of the tracker as last read, or null when unknown. */
  openQuestions: () => number | null;
  stop: () => void;
}>;

export const MARKER_INTERVAL_MS = 60_000;
const EMPTY: ReadonlyMap<string, SessionMarker> = new Map();

/** Two marker maps show the same thing. */
function sameMarkers(left: ReadonlyMap<string, SessionMarker>, right: ReadonlyMap<string, SessionMarker>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, marker] of left) {
    const other = right.get(name);
    if (!other || other.count !== marker.count || JSON.stringify(other.target) !== JSON.stringify(marker.target)) return false;
  }
  return true;
}

class SessionMarkers implements SessionMarkerController {
  private readonly api: WorkApi;
  private readonly sync: QuestionsSync;
  private readonly unsubscribe: () => void;
  private doc: SessionQuestionsDoc | null = null;
  private index: ReadonlyMap<string, SessionMarker> = EMPTY;
  private total: number | null = null;
  private lastStart = -Infinity;
  private due = true;
  private inFlight = false;
  private stopped = false;
  /** Set by the view's news: the next settled read calls onChange even when nothing changed. */
  private force = false;
  /** Counts the view's news; a read started before the last one is discarded. */
  private epoch = 0;
  private readonly controller = new AbortController();
  private readonly options: SessionMarkerOptions;

  constructor(options: SessionMarkerOptions) {
    this.options = options;
    this.api = createWorkApi(options.request, undefined, options.api);
    this.sync = options.sync ?? pageQuestionsSync;
    this.unsubscribe = this.sync.subscribe('marker', change => this.heard(change));
  }

  tick = (): void => {
    const now = (this.options.now ?? Date.now)();
    if (this.stopped || this.inFlight || !(this.options.visible?.() ?? true)) return;
    if (!this.due && now - this.lastStart < (this.options.intervalMs ?? MARKER_INTERVAL_MS)) return;
    this.due = false; this.inFlight = true; this.lastStart = now;
    const epoch = this.epoch;
    void this.api.sessionQuestions(this.controller.signal).then(result => this.settle(result, epoch), () => this.settle(null, epoch))
      .finally(() => {
        this.inFlight = false;
        if (this.due && this.force) this.tick();   // news came during the read: read again now
      });
  };

  refresh = (): void => { this.due = true; };

  marker = (name: string): SessionMarker | null => this.index.get(name) ?? null;

  openQuestions = (): number | null => this.total;

  stop = (): void => { this.stopped = true; this.unsubscribe(); this.controller.abort(); };

  /** News from the view: drop an answered question now, then read again at once, whatever the time. */
  private heard(change: QuestionsChange): void {
    if (this.stopped) return;
    const without = change.answered && this.doc ? withoutAnswered(this.doc, change.answered) : null;
    if (without) { this.doc = without; this.show(markerIndex(without), without.openQuestions, false); }
    this.epoch++; this.due = true; this.force = true;
    this.tick();
  }

  private settle(result: WorkResult<SessionQuestionsDoc> | null, epoch: number): void {
    if (this.stopped || epoch !== this.epoch) return;
    if (result?.ok) {
      this.doc = result.value;
      return this.show(markerIndex(result.value), result.value.openQuestions, true);
    }
    const kind = result?.error.kind ?? 'failed';
    if (kind === 'busy' || kind === 'aborted') return;
    if (kind === 'not-available' || kind === 'invalid' || kind === 'auth') this.stopped = true;
    this.doc = null;
    this.show(EMPTY, null, true);
  }

  /** `read`: these markers come from a read (not from the view's news), so they settle a forced report and the
   *  view hears their count. */
  private show(index: ReadonlyMap<string, SessionMarker>, total: number | null, read: boolean): void {
    const forced = read && this.force;
    if (read) this.force = false;
    if (read) this.sync.publish({ source: 'marker', openQuestions: total });
    if (!forced && sameMarkers(this.index, index) && this.total === total) return;
    this.index = index; this.total = total;
    this.options.onChange();
  }
}

export function createSessionMarker(options: SessionMarkerOptions): SessionMarkerController {
  return new SessionMarkers(options);
}
