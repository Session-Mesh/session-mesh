// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Which requests to open a pane (the listing's `opens`) a page handles on load. The page restores
// its panes before its first listing arrives, so an open requested meanwhile (after the page
// started, on the server's clock) is handled; only older ones are not replayed. An open without a
// time is old.

export type OpenRequest = { seq: number; at?: unknown };

/** The `seq` of the last open made before `startedOnServer` (seconds), 0 when there is none. */
export function openReplayCutoff(opens: readonly OpenRequest[], startedOnServer: number): number {
  const before = opens.filter((open) => typeof open.at !== "number" || open.at < startedOnServer);
  return before.at(-1)?.seq ?? 0;
}

/**
 * The cutoff after an answer: the one already set is kept; an answer without an `opens` array (a
 * server's skeleton or pre-listing answer) sets none, so the first answer that has one decides.
 */
export function replayCutoff(current: number | null, opens: unknown, startedOnServer: number): number | null {
  if (current !== null || !Array.isArray(opens)) return current;
  return openReplayCutoff(opens as OpenRequest[], startedOnServer);
}
