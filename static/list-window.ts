// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A window over a long scrolled list: above `threshold` rows, each run of rows (a section, a folder)
// renders only the rows near the viewport, between spacers that keep the scroll height, so the DOM
// stays bounded. A row the owner holds (focused, being edited or dragged) is always rendered: alone,
// between spacers, when it is far from the viewport. Rows outside the window are not in the DOM:
// find-in-page and assistive technology do not see them (docs/sessions-loading.md).
// Generic: the caller names its row, holder and editing selectors.

export const VIRTUAL_THRESHOLD = 200;
export const DEFAULT_ROW_PX = 46;
const OVERSCAN = 8;
/** The attributes that key this module's own markup (add them to the morph's key attributes). */
export const WINDOW_KEY_ATTRIBUTES = ["data-vkey", "data-vpad"] as const;

export type WindowInput = {
  count: number;   // rows in this run
  rowHeight: number;   // estimated height of one row (px)
  runTop: number;   // offset of the run's first row from the top of the scrolled content (px)
  scrollTop: number;
  viewport: number;   // height of the scrolled box (px)
  overscan: number;   // extra rows rendered above and below the viewport
  keep?: readonly number[];   // row indexes that must be rendered (focused, dragged, edited)
};
export type RowRange = { start: number; end: number };
/** The ranges of rows to render, in order; `pads[i]` is the spacer before `ranges[i]`, the last one ends the run. */
export type RowWindow = { ranges: RowRange[]; pads: number[] };

function viewportRange(input: WindowInput, count: number, height: number): RowRange {
  const overscan = Math.max(0, Math.floor(input.overscan));
  const top = input.scrollTop - input.runTop;
  const start = Math.min(Math.max(0, Math.floor(top / height) - overscan), count);
  const end = Math.min(Math.max(start, Math.ceil((top + Math.max(0, input.viewport)) / height) + overscan), count);
  return { start, end };
}

function mergeRanges(ranges: RowRange[]): RowRange[] {
  const merged: RowRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** The rows to render: those near the viewport, plus each kept row on its own; spacers for the rest. */
export function computeWindow(input: WindowInput): RowWindow {
  const count = Math.max(0, Math.floor(input.count));
  const height = input.rowHeight > 0 && Number.isFinite(input.rowHeight) ? input.rowHeight : DEFAULT_ROW_PX;
  const kept = (input.keep ?? []).filter((index) => Number.isInteger(index) && index >= 0 && index < count)
    .map((index) => ({ start: index, end: index + 1 }));
  const ranges = mergeRanges([viewportRange(input, count, height), ...kept].filter((range) => range.end > range.start));
  const pads: number[] = [];
  let previous = 0;
  for (const range of ranges) { pads.push((range.start - previous) * height); previous = range.end; }
  pads.push((count - previous) * height);
  return { ranges, pads };
}

/** Rows shown by runs that are not folded. */
export const shownRowCount = (runs: readonly { size: number; folded: boolean }[]): number =>
  runs.reduce((sum, run) => sum + (run.folded ? 0 : run.size), 0);

export type ListWindowConfig = {
  box: HTMLElement;   // the scrolled list
  rowSelector: string;   // one row
  holderSelector: string;   // an element that is, or wraps, one row
  editingSelector: string;   // an inline editor inside a row
  idOf: (element: Element) => string | null;
  escape: (text: string) => string;   // for attribute values
  threshold?: number;
  overscan?: number;
};

export type ListWindow = {
  setRowCount(count: number): void;   // before drawing: decides whether the list is windowed
  windowed(): boolean;
  runHtml<T>(runKey: string, items: readonly T[], idOf: (item: T) => string, render: (item: T) => string): string;
  keep(element: Element): boolean;   // the morph's `keep`: a held row is never replaced by a scroll
  setDragged(id: string | null): void;
  measure(): void;   // after drawing: the average row height
  /** After drawing: whether a run now starts a row or more away from the offset its window assumed. */
  offsetsMoved(): boolean;
  visibleIds(limit: number, accept: (id: string) => boolean): string[];
};

/** The ids of the rows held by the owner: the focused one, the one being edited, the dragged one. */
function heldIds(config: ListWindowConfig, dragged: string | null): string[] {
  const rowId = (element: Element | null | undefined) => (element ? config.idOf(element) : null);
  const focused = config.box.ownerDocument.activeElement;
  return [rowId(focused && config.box.contains(focused) ? focused.closest(config.rowSelector) : null),
    rowId(config.box.querySelector(config.editingSelector)?.closest(config.rowSelector)), dragged]
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/** Offset of a run from the top of the scrolled content, from its last drawing (0 the first time). */
function runTop(box: HTMLElement, runKey: string): number {
  const run = [...box.querySelectorAll<HTMLElement>("[data-vkey]")].find((element) => element.dataset.vkey === runKey);
  return run ? run.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop : 0;
}

const pad = (px: number) => `<div class="vpad" data-vpad="gap" aria-hidden="true" style="height:${Math.round(px)}px"></div>`;

type RunInput<T> = { runKey: string; items: readonly T[]; idOf: (item: T) => string; render: (item: T) => string;
  rowHeight: number; held: readonly string[]; assumed: Map<string, number> };

function windowedRunHtml<T>(config: ListWindowConfig, run: RunInput<T>): string {
  const { box } = config;
  const top = runTop(box, run.runKey);
  run.assumed.set(run.runKey, top);
  const span = computeWindow({ count: run.items.length, rowHeight: run.rowHeight, runTop: top,
    scrollTop: box.scrollTop, viewport: box.clientHeight, overscan: config.overscan ?? OVERSCAN,
    keep: run.held.map((id) => run.items.findIndex((item) => run.idOf(item) === id)) });
  const parts = span.ranges.map((range, i) => pad(span.pads[i]!) + run.items.slice(range.start, range.end).map(run.render).join(""));
  return `<div class="vrun" data-vkey="${config.escape(run.runKey)}">${parts.join("")}${pad(span.pads.at(-1)!)}</div>`;
}

function visibleRowIds(config: ListWindowConfig, limit: number, accept: (id: string) => boolean): string[] {
  const { box } = config;
  if (box.hidden) return [];
  const { top, bottom } = box.getBoundingClientRect();
  const ids: string[] = [];
  for (const row of box.querySelectorAll(config.rowSelector)) {
    if (ids.length >= limit) break;
    const rect = row.getBoundingClientRect();
    const id = config.idOf(row);
    if (id && rect.bottom >= top && rect.top <= bottom && accept(id)) ids.push(id);
  }
  return ids;
}

export function createListWindow(config: ListWindowConfig): ListWindow {
  const { box } = config;
  let windowed = false, dragged: string | null = null, rowHeight = DEFAULT_ROW_PX;
  const assumed = new Map<string, number>();   // run key -> the offset its last window was computed for
  return {
    setRowCount(count) { windowed = count > (config.threshold ?? VIRTUAL_THRESHOLD); },
    windowed: () => windowed,
    runHtml: (runKey, items, idOf, render) => (windowed
      ? windowedRunHtml(config, { runKey, items, idOf, render, rowHeight, held: heldIds(config, dragged), assumed })
      : items.map(render).join("")),
    offsetsMoved() {
      const moved = [...assumed].some(([runKey, top]) => Math.abs(runTop(box, runKey) - top) >= rowHeight);
      assumed.clear();
      return moved;
    },
    keep(element) {
      if (!element.matches(config.holderSelector)) return false;
      const focused = box.ownerDocument.activeElement;
      return (focused !== null && element.contains(focused)) || element.querySelector(config.editingSelector) !== null
        || (dragged !== null && config.idOf(element) === dragged);
    },
    setDragged(id) { dragged = id; },
    measure() {
      const heights = [...box.querySelectorAll<HTMLElement>(config.rowSelector)].slice(0, 24)
        .map((row) => row.offsetHeight).filter((height) => height > 0);
      if (heights.length) rowHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
    },
    visibleIds: (limit, accept) => visibleRowIds(config, limit, accept),
  };
}
