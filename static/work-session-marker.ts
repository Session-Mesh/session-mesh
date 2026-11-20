// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The reads behind the session marker. The page calls `tick` after each session listing it applies (every few seconds);
 * a read starts only when the page is visible, none is in flight, and the last one started at least a minute ago (or
 * `refresh` asked for one). So an idle page sends about one request a minute, through the page's read slots
 * (static/work-api.ts). A tracker that cannot be read shows no marker and no error: a missing reader program, or one
 * that does not know the request (an older install), stops the reads for the page's life; any other failure clears
 * the markers until a later read succeeds, except `busy`, which keeps the last ones.
 */

import { createWorkApi } from './work-api.ts';
import type { WorkApiOptions, WorkApi, WorkFetch, WorkResult } from './work-api.ts';
import { markerIndex } from './work-session-questions.ts';
import type { SessionMarker, SessionQuestionsDoc } from './work-session-questions.ts';

export type SessionMarkerOptions = Readonly<{
  request: WorkFetch;
  /** Called after a read that changed the markers or the count. */
  onChange: () => void;
  visible?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  api?: WorkApiOptions;
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
  private index: ReadonlyMap<string, SessionMarker> = EMPTY;
  private total: number | null = null;
  private lastStart = -Infinity;
  private due = true;
  private inFlight = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly options: SessionMarkerOptions;

  constructor(options: SessionMarkerOptions) {
    this.options = options;
    this.api = createWorkApi(options.request, undefined, options.api);
  }

  tick = (): void => {
    const now = (this.options.now ?? Date.now)();
    if (this.stopped || this.inFlight || !(this.options.visible?.() ?? true)) return;
    if (!this.due && now - this.lastStart < (this.options.intervalMs ?? MARKER_INTERVAL_MS)) return;
    this.due = false; this.inFlight = true; this.lastStart = now;
    void this.api.sessionQuestions(this.controller.signal).then(result => this.settle(result), () => this.settle(null))
      .finally(() => { this.inFlight = false; });
  };

  refresh = (): void => { this.due = true; };

  marker = (name: string): SessionMarker | null => this.index.get(name) ?? null;

  openQuestions = (): number | null => this.total;

  stop = (): void => { this.stopped = true; this.controller.abort(); };

  private settle(result: WorkResult<SessionQuestionsDoc> | null): void {
    if (this.stopped) return;
    if (result?.ok) return this.show(markerIndex(result.value), result.value.openQuestions);
    const kind = result?.error.kind ?? 'failed';
    if (kind === 'busy' || kind === 'aborted') return;
    if (kind === 'not-available' || kind === 'invalid' || kind === 'auth') this.stopped = true;
    this.show(EMPTY, null);
  }

  private show(index: ReadonlyMap<string, SessionMarker>, total: number | null): void {
    if (sameMarkers(this.index, index) && this.total === total) return;
    this.index = index; this.total = total;
    this.options.onChange();
  }
}

export function createSessionMarker(options: SessionMarkerOptions): SessionMarkerController {
  return new SessionMarkers(options);
}
