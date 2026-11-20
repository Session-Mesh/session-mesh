// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The page's cache of known tracker ids, behind the references of the terminal (static/terminal-references.ts): an id
 * printed in a terminal is a link only when it is known here. It is filled by one read of `ids` (docs/work-read.md)
 * through the page's read slots (static/work-api.ts). The page calls `tick` after each session listing it applies
 * while terminals are shown; a read starts only when the page is visible, none is in flight, and the last one started
 * at least a minute ago (or `refresh` asked for one, as the Projects view does when it opens). A lookup never reads: a
 * known id and an unknown one are both answered from the last read, so text full of ids sends nothing.
 *
 * It holds ids and titles only, in memory, and sends them nowhere. A missing reader program, one that does not know
 * the request (an older install) or a refused credential empties it and stops the reads for the page's life; any
 * other failure empties it until a later read succeeds (no tracker, no links), except `busy`, which keeps it.
 */

import { createWorkApi } from './work-api.ts';
import type { WorkApi, WorkApiOptions, WorkFetch, WorkResult } from './work-api.ts';
import type { KnownIds, ReferenceEntry } from './work-references-parse.ts';

export { parseIds } from './work-references-parse.ts';
export type { KnownIds, ReferenceEntry, ReferenceKind } from './work-references-parse.ts';

export type ReferencesOptions = Readonly<{
  request: WorkFetch;
  visible?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  api?: WorkApiOptions;
}>;

export type ReferencesController = Readonly<{
  /** Read when it is due (see above). */
  tick: () => void;
  /** Read at the next tick whatever the time. */
  refresh: () => void;
  /** The known entry of an id (`T-1a2b`), or null; never a request. */
  lookup: (id: string) => ReferenceEntry | null;
  /** Forget every id and stop reading (the credential is gone, or the page leaves). */
  stop: () => void;
}>;

export const REFERENCES_INTERVAL_MS = 60_000;
const EMPTY: KnownIds = new Map();

class References implements ReferencesController {
  private readonly api: WorkApi;
  private known: KnownIds = EMPTY;
  private lastStart = -Infinity;
  private due = true;
  private inFlight = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly options: ReferencesOptions;

  constructor(options: ReferencesOptions) {
    this.options = options;
    this.api = createWorkApi(options.request, undefined, options.api);
  }

  tick = (): void => {
    const now = (this.options.now ?? Date.now)();
    if (this.stopped || this.inFlight || !(this.options.visible?.() ?? true)) return;
    if (!this.due && now - this.lastStart < (this.options.intervalMs ?? REFERENCES_INTERVAL_MS)) return;
    this.due = false; this.inFlight = true; this.lastStart = now;
    void this.api.ids(this.controller.signal).then(result => this.settle(result), () => this.settle(null))
      .finally(() => { this.inFlight = false; });
  };

  refresh = (): void => { this.due = true; };

  lookup = (id: string): ReferenceEntry | null => this.known.get(id) ?? null;

  stop = (): void => { this.stopped = true; this.known = EMPTY; this.controller.abort(); };

  private settle(result: WorkResult<KnownIds> | null): void {
    if (this.stopped) return;
    if (result?.ok) { this.known = result.value; return; }
    const kind = result?.error.kind ?? 'failed';
    if (kind === 'busy' || kind === 'aborted') return;
    if (kind === 'not-available' || kind === 'invalid' || kind === 'auth') return this.stop();
    this.known = EMPTY;
  }
}

export function createReferences(options: ReferencesOptions): ReferencesController {
  return new References(options);
}
