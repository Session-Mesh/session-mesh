// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The one place that knows the field names of the progressive /api/sessions contract
// (docs/sessions-loading.md; the server's side: docs/sessions-api.md). Every field is optional: a
// listing without them is the current, complete answer, and every row in it is ready. A rename on
// the server side changes this file only.

export type Row = Record<string, unknown>;
export type RowState = "loading" | "ready" | "slow" | "unreachable" | "error";
const ROW_STATES: ReadonlySet<string> = new Set(["loading", "ready", "slow", "unreachable", "error"]);
// `unreachable` is the page's own judgement (its PTY host is silent): a server's `state` never says it.
const SERVER_ROW_STATES: ReadonlySet<string> = new Set(["loading", "ready", "slow", "error"]);
export const RETRYABLE: ReadonlySet<RowState> = new Set(["slow", "unreachable", "error"]);

const object = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * A row's state. `provisional` (known on this device, not listed yet) comes first; then the page's
 * own judgement: `hostSilent` (the PTY host does not answer, so every listed row is the last known
 * one) or the row's `rowState`; then the server's `state` (an `unreachable` one is ignored: only the
 * page decides that; the background-list server sends no per-row `state`), then `ready: false`.
 */
export function rowState(row: Row, hostSilent = false): RowState {
  if (row.provisional === true) return "loading";
  if (hostSilent === true) return "unreachable";   // strict: rows.map(rowState) passes an index here
  if (typeof row.rowState === "string" && ROW_STATES.has(row.rowState)) return row.rowState as RowState;
  if (typeof row.state === "string" && SERVER_ROW_STATES.has(row.state)) return row.state as RowState;
  if (row.ready === false) return "loading";
  return "ready";
}

/**
 * Whether the row may be acted on as observed fact (closing, renaming or filing it). A provisional
 * row, a row the server has not described yet (`ready: false`, or a `state` other than `ready`),
 * every row of a pending listing, and every row while the page judges the PTY host silent (the rows
 * are then the last known ones) are not.
 */
export function authoritative(row: Row, listing: Row | null, hostSilent = false): boolean {
  if (hostSilent === true || row.provisional === true || row.ready === false || typeof row.rowState === "string") return false;
  if (typeof row.state === "string" && SERVER_ROW_STATES.has(row.state) && row.state !== "ready") return false;
  return !pending(listing);
}

/** The server's listing is a skeleton (its management view says "pending"). */
export function pending(listing: Row | null): boolean {
  return object(listing?.management)?.state === "pending";
}

/**
 * Whether the page keeps showing the sessions it knows (`shown` is its provisional listing) instead
 * of `next`: a server that has not listed its sessions yet answers an empty, incomplete, pending
 * listing, which says nothing about them.
 */
export function holdKnownRows(next: Row | null, shown: Row | null): boolean {
  return shown?.provisional === true && Array.isArray(next?.mesh) && next.mesh.length === 0
    && next.complete === false && pending(next);
}

export const PHASES = ["focus", "recent", "rest"] as const;
export type Progress = { total: number; ready: number; phase: string | null };

/** Ready / total sessions: the server's `counts` when present and coherent, else counted on the rows. */
export function progress(listing: Row | null, rows: readonly Row[]): Progress {
  const counts = object(listing?.counts);
  const counted = rows.filter((row) => rowState(row) === "ready").length;
  let total = count(counts?.total) ?? rows.length;
  let ready = count(counts?.ready) ?? counted;
  if (ready > total) { total = rows.length; ready = counted; }
  const phase = typeof listing?.phase === "string" && (PHASES as readonly string[]).includes(listing.phase) ? listing.phase : null;
  return { total, ready, phase };
}

/** The PTY host did not answer the server's listing (the server then lists no session and forgets none). */
export function hostSilent(listing: Row | null): boolean {
  if (!listing) return false;
  return listing.host === "silent" || object(listing.management)?.state === "unavailable" || listing.ptyhost === false;
}

/** The PTY host restarted since the server's previous round (its sessions may be offered for restore). */
export const hostRestarted = (listing: Row | null): boolean => listing?.host === "restarted";

/** False only when the server says some rows are still being described (poll sooner then). */
export const complete = (listing: Row | null): boolean => listing?.complete !== false;

/** The listing's generation, when the server numbers them (and so accepts `since` and `focus`). */
export function generation(listing: Row | null): number | null {
  return count(listing?.generation);
}

export const FOCUS_LIMIT = 64;
const URL_BUDGET = 4096;

/**
 * The listing URL. `since` and `focus` are sent only to a server that numbers its listings: an older
 * one (or a test fixture) gets the exact URL it always got. A `fresh` request (one a caller asked
 * for after changing something) carries no `since`: a server answers a `since` request at once from
 * its last published list, without reading the PTY host's list, which may not hold the caller's change
 * yet; without `since` it waits until a read of that list started after the request is published
 * (docs/sessions-api.md). `focus` is ignored by that server.
 */
export function inventoryUrl(path: string, last: Row | null, focus: readonly string[], fresh = false): { url: string; since: number | null } {
  const known = generation(last);
  if (known === null) return { url: path, since: null };
  const since = fresh ? null : known;
  const params = new URLSearchParams(since === null ? {} : { since: String(since) });
  let names = "";
  for (const name of focus.slice(0, FOCUS_LIMIT)) {
    const next = names ? `${names},${name}` : name;
    if (encodeURIComponent(next).length > URL_BUDGET) break;
    names = next;
  }
  if (names) params.set("focus", names);
  return { url: `${path}?${params}`, since };
}

/**
 * The listing to apply. An answer to `since=G` carries only the rows changed after G and the names in
 * `removed`; it is merged into the previous listing by session id. An answer whose generation went
 * back (the server restarted) is a full one. Anything else is taken as it is. A changed row without a
 * string `id` cannot be merged: it is dropped and handed to `onDropped` (the page's debug log).
 */
export function mergeListing(previous: Row | null, next: Row, since: number | null, onDropped?: (row: unknown) => void): Row {
  const now = generation(next);
  if (since === null || now === null || now < since || !previous || !Array.isArray(previous.mesh) || !Array.isArray(next.mesh)) return next;
  if (next.full === true) return next;
  const removed = new Set(Array.isArray(next.removed) ? next.removed.filter((name): name is string => typeof name === "string") : []);
  const changed = new Map<string, Row>();
  for (const row of next.mesh as Row[]) {
    if (typeof row?.id === "string") changed.set(row.id, row);
    else onDropped?.(row);
  }
  const mesh: Row[] = [];
  for (const row of previous.mesh as Row[]) {
    const id = typeof row?.id === "string" ? row.id : "";
    if (removed.has(id)) continue;
    mesh.push(changed.get(id) ?? row);
    changed.delete(id);
  }
  mesh.unshift(...changed.values());
  // The server's order (server.list_sessions): sessions never moved first, newest on top, then by rank.
  const order = (row: Row) => typeof row.rank === "number" ? [1, row.rank] : [0, -(typeof row.created === "number" ? row.created : 0)];
  if (mesh.some((row) => "rank" in row)) {
    mesh.sort((a, b) => { const [x0, x1] = order(a), [y0, y1] = order(b); return (x0! - y0!) || (x1! - y1!); });
  }
  return { ...previous, ...next, mesh, external: Array.isArray(next.external) ? next.external : previous.external };
}
