// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// While the PTY host does not answer the server, the server lists either no session (and forgets
// none) or the rows of its last listing (`host: "silent"`). Either way those rows are only the last
// known ones: the page shows them marked unreachable, and nothing acts on them. A session closed from
// this page is not among them; an observed listing says itself what is gone, so it clears that memory.
//
// A server may call its host silent after a short wait (1 s for the background-list server,
// docs/sessions-api.md), so one silent answer with rows may be an ordinary slow round. The page
// therefore believes a silence only after
// SILENT_ANSWERS consecutive silent answers, or SILENT_AFTER_MS after the first one; an empty silent
// listing has nothing else to show, so it is believed at once.

import { hostSilent, type Row } from "./sessions-contract.ts";

export const SILENT_ANSWERS = 2;
export const SILENT_AFTER_MS = 3000;

export type HostSilence<T extends Row> = {
  noteClosed(name: string): void;
  /** Called with each listing before it replaces `previous` (the rows shown until now). */
  update(next: Row, previous: readonly T[], observed: boolean): void;
  /** The rows to show: the listing's own, or the kept ones (unreachable) while the host is silent. */
  shown(listed: readonly T[]): readonly T[];
  /** Whether the page takes the host as silent now (rows not actionable, the status line says so). */
  silent(): boolean;
};

export function createHostSilence<T extends Row>(now: () => number = Date.now): HostSilence<T> {
  let kept: T[] = [];
  let streak = 0;
  let since: number | null = null;
  let emptyAnswer = false;
  const closed = new Set<string>();
  const silent = () => streak > 0 && (emptyAnswer || streak >= SILENT_ANSWERS || now() - (since ?? now()) >= SILENT_AFTER_MS);
  return {
    noteClosed: (name) => { closed.add(name); },
    update(next, previous, observed) {
      const listed = (Array.isArray(next.mesh) ? next.mesh : []) as T[];
      if (!hostSilent(next)) {
        streak = 0; since = null; kept = [];
      } else {
        streak += 1;
        since ??= now();
        emptyAnswer = listed.length === 0;
        const last = listed.length ? listed : kept.length ? kept : previous;
        kept = last.filter((row) => !closed.has(String(row.name))).map((row) => ({ ...row, rowState: "unreachable" }));
      }
      if (observed) closed.clear();
    },
    shown: (listed) => (silent() ? kept : listed),
    silent,
  };
}
