// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The order in which sessions matter to this page, sent to the server as the listing's `focus`
// (docs/sessions-loading.md): the row whose retry was pressed, the panes on screen (the active one
// first), pinned conversations running now, recently active sessions, then the rows visible in the
// sidebar. Names only, without repeats, bounded.

export type PriorityInput = {
  focus: readonly string[];   // the panes on screen, the active one first
  pinned: readonly string[];   // pinned conversations running as these sessions
  recent: readonly { name: string; activity: number }[];
  visible: readonly string[];   // rows in the sidebar's viewport
  limit?: number;
  recentLimit?: number;
};
export const PRIORITY_LIMIT = 64;
const RECENT_LIMIT = 16;

/** Session names, most wanted first, without repeats: focus, pinned, recently active, visible. */
export function priorityNames(input: PriorityInput): string[] {
  const limit = input.limit ?? PRIORITY_LIMIT;
  const recent = [...input.recent].sort((a, b) => b.activity - a.activity).slice(0, input.recentLimit ?? RECENT_LIMIT)
    .map((row) => row.name);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [...input.focus, ...input.pinned, ...recent, ...input.visible]) {
    if (out.length >= limit) break;
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export type FocusInput = {
  retry: string | null;   // the row whose retry button was pressed
  active: string | null | undefined;   // the active pane's target
  panes: readonly (string | null | undefined)[];   // every pane's target
  pinned: readonly (string | null | undefined)[];   // the session each pin runs as, if any
  rows: readonly { id: string; activity?: unknown }[];   // the mesh rows listed
  visible: readonly string[];
  isSession: (id: string) => boolean;   // a mesh session of the listing (not a document, board or outside terminal)
};

/** The page's `focus` names from what it shows: only mesh sessions, in priority order. */
export function focusRequest(input: FocusInput): string[] {
  const sessions = (ids: readonly (string | null | undefined)[]) =>
    ids.filter((id): id is string => typeof id === "string" && id !== "" && input.isSession(id));
  const recent = input.rows.map((row) => ({ name: row.id, activity: typeof row.activity === "number" ? row.activity : 0 }));
  return priorityNames({ focus: sessions([input.retry, input.active, ...input.panes]), pinned: sessions(input.pinned), recent,
    visible: input.visible });
}
