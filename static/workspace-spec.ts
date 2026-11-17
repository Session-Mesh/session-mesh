// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Browser-local workspace persistence.  This is deliberately a closed data
// model: a layout describes panes already known to the Mesh; it is never an
// instruction to start a process, fetch a URL or resume a session.
export type PaneType = "terminal" | "board" | "document" | "history" | "unavailable";
export type UnavailableReason = "unknown-type" | "missing-target" | "ephemeral-pane";

export interface PaneSpec {
  readonly type: PaneType;
  readonly target: string | null;
  readonly back?: string;
  readonly unavailable?: UnavailableReason;
}
export interface WorkspaceColumnSpec {
  readonly grow: number;
  readonly active: number;
  readonly tabs: readonly PaneSpec[];
}
export interface WorkspaceSpecV2 {
  readonly version: 2;
  readonly active: { readonly column: number; readonly tab: number } | null;
  readonly columns: readonly WorkspaceColumnSpec[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const stringOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;
const legacyTypes = new Set(["terminal", "board", "document", "diff", "demo"]);
const isLegacyType = (value: unknown): value is "terminal" | "board" | "document" | "diff" | "demo" =>
  typeof value === "string" && legacyTypes.has(value);
const isV2Type = (value: unknown): value is PaneType =>
  typeof value === "string" && ["terminal", "board", "document", "history", "unavailable"].includes(value);

function v1Pane(value: unknown): PaneSpec | null {
  const input = record(value);
  if (!input || !isLegacyType(input.kind)) return input ? {
    type: "unavailable", target: null, unavailable: "unknown-type",
  } : null;
  const target = stringOrNull(input.id);
  const back = stringOrNull(input.back);
  const kind = input.kind;
  if (kind === "demo" || kind === "diff") return {
    type: "unavailable", target: null, unavailable: "ephemeral-pane",
  };
  const pane: PaneSpec = { type: kind, target };
  return back ? { ...pane, back } : pane;
}

function v2Pane(value: unknown): PaneSpec | null {
  const input = record(value);
  if (!input || typeof input.type !== "string") return null;
  const target = stringOrNull(input.target);
  const back = stringOrNull(input.back);
  const unavailable = input.unavailable;
  if (!isV2Type(input.type)) return {
    type: "unavailable", target: null, unavailable: "unknown-type",
  };
  if (input.type === "unavailable") {
    const reason: UnavailableReason = unavailable === "missing-target" || unavailable === "ephemeral-pane"
      ? unavailable : "unknown-type";
    return { type: "unavailable", target, unavailable: reason };
  }
  const pane: PaneSpec = { type: input.type, target };
  return back ? { ...pane, back } : pane;
}

function columns(value: unknown, decode: (tab: unknown) => PaneSpec | null): readonly WorkspaceColumnSpec[] | null {
  if (!Array.isArray(value)) return null;
  const result: WorkspaceColumnSpec[] = [];
  for (const rawColumn of value.slice(0, 3)) {
    const column = record(rawColumn);
    if (!column || !Array.isArray(column.tabs)) continue;
    const tabs = column.tabs.map(decode).filter((tab): tab is PaneSpec => tab !== null);
    if (tabs.length) result.push({ grow: finite(column.grow, 1), active: Math.max(0, Math.floor(finite(column.active, 0))), tabs });
  }
  return result.length ? result : null;
}

function activePosition(value: unknown, layout: readonly WorkspaceColumnSpec[]): WorkspaceSpecV2["active"] {
  const active = record(value);
  if (!active) return null;
  const column = Math.floor(finite(active.column, -1));
  const tab = Math.floor(finite(active.tab, -1));
  return column >= 0 && column < layout.length && tab >= 0 && tab < layout[column]!.tabs.length ? { column, tab } : null;
}

/** Deterministically upgrade legacy workspace.v1; no IO or authority. */
export function migrateV1(value: unknown): WorkspaceSpecV2 | null {
  const input = record(value);
  if (!input) return null;
  const layout = columns(input.columns, v1Pane);
  if (!layout) return null;
  const activeTarget = stringOrNull(input.active);
  let active: WorkspaceSpecV2["active"] = null;
  if (activeTarget) {
    for (let column = 0; column < layout.length && !active; column++) {
      const tab = layout[column]!.tabs.findIndex((pane) => pane.target === activeTarget);
      if (tab >= 0) active = { column, tab };
    }
  }
  return { version: 2, active, columns: layout };
}

/** Strictly read v2; unknown pane tags become inert unavailable slots. */
export function readV2(value: unknown): WorkspaceSpecV2 | null {
  const input = record(value);
  if (!input || input.version !== 2) return null;
  const layout = columns(input.columns, v2Pane);
  return layout ? { version: 2, active: activePosition(input.active, layout), columns: layout } : null;
}

/**
 * Convert missing targets to inert slots.  `available` is an observation from
 * the current Mesh inventory, not a launch callback, so restoration cannot
 * accidentally create or resume a session.
 */
export function reconcile(value: WorkspaceSpecV2, available: (target: string) => boolean): WorkspaceSpecV2 {
  return {
    ...value,
    columns: value.columns.map((column) => ({
      ...column,
      tabs: column.tabs.map((pane): PaneSpec => {
        if (pane.type === "unavailable" || pane.target === null || available(pane.target)) return pane;
        // Retain the opaque target for a later inventory refresh, but never
        // pass it to a launcher.  Consumers render this as an inert slot.
        return { type: "unavailable", target: pane.target, unavailable: "missing-target" };
      }),
    })),
  };
}
