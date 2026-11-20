// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * What the Projects view puts back when the owner comes back to it: the place (the project, its tab, the task sheet,
 * where they were scrolled, the products unfolded on the entry screen) and the unsent answer drafts of every question
 * the owner typed under, by question id. Kept in this tab's sessionStorage under one key, never in localStorage and
 * never sent anywhere: a draft may hold sensitive text, so it lives no longer than the tab and is removed when the
 * answer is sent, when the owner empties the field, and when the browser signs out (static/app.js, static/login.js).
 *
 * Pure apart from the storage port: reading never throws; a value that is corrupt, foreign, too large or of another
 * schema reads as the empty state, and a field that is not of the expected shape is dropped on its own.
 */

/** The sessionStorage key. static/login.js removes it by this name too. */
export const STATE_KEY = 'mesh.workView';
export const STATE_SCHEMA = 1;
/** The bound of the stored value, in UTF-16 units; the oldest drafts go first when it is exceeded. */
export const MAX_STATE_CHARS = 64 * 1024;
export const MAX_DRAFTS = 40;
/** The answer field holds at most 4000 UTF-16 units (work-answer-form.ts); a longer stored text is not ours. */
export const MAX_DRAFT_CHARS = 4000;
const MAX_PICKED = 32, MAX_EXPANDED = 200, MAX_ID = 64;

export type Draft = Readonly<{
  /** The text of the answer field. */
  text: string;
  /** The pre-built answers ticked, by value (answer forms with choices). */
  picked: readonly string[];
  /** A draft of the form that corrects an answer already given (rather than the first answer). */
  edit: boolean;
  /** When it was last typed (ms), to drop the oldest first. */
  at: number;
}>;

export type Place = Readonly<{
  /** The open project, or null for the entry screen. */
  project: string | null;
  tab: string | null;
  /** The task whose sheet is open. */
  task: string | null;
  /** Where the view's scroller stood, where the sheet's own pane stood, and where the tab stood under a sheet that
   *  covers it (a phone). */
  scroll: number;
  sheetScroll: number;
  tabScroll: number | null;
  /** The products unfolded on the entry screen; null until the owner's first visit seeds them. */
  expanded: readonly string[] | null;
}>;

export type ViewState = Readonly<{ place: Place; drafts: ReadonlyMap<string, Draft> }>;

/** What the module needs of `window.sessionStorage`. */
export type StoragePort = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

export const ENTRY_PLACE: Place = { project: null, tab: null, task: null, scroll: 0, sheetScroll: 0, tabScroll: null, expanded: null };
export const EMPTY_STATE: ViewState = { place: ENTRY_PLACE, drafts: new Map() };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
const idOrNull = (value: unknown): string | null => (isId(value) ? value : null);
const offset = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 1e7) : 0);
/** A time in epoch milliseconds (the latest a Date can hold), 0 for anything else. */
const stamp = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 8.64e15) : 0);

function ids(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isId).slice(0, max);
}

function readPlace(value: unknown): Place {
  if (!isRecord(value)) return ENTRY_PLACE;
  const project = idOrNull(value.project);
  return {
    project, tab: project ? idOrNull(value.tab) : null, task: project ? idOrNull(value.task) : null,
    scroll: offset(value.scroll), sheetScroll: offset(value.sheetScroll),
    tabScroll: value.tabScroll === null || value.tabScroll === undefined ? null : offset(value.tabScroll),
    expanded: ids(value.expanded, MAX_EXPANDED),
  };
}

function readDraft(value: unknown): Draft | null {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > MAX_DRAFT_CHARS) return null;
  const picked = Array.isArray(value.picked)
    ? value.picked.filter((item): item is string => typeof item === 'string' && item.length <= MAX_DRAFT_CHARS).slice(0, MAX_PICKED) : [];
  if (value.text === '' && picked.length === 0) return null;
  return { text: value.text, picked, edit: value.edit === true, at: stamp(value.at) };
}

function readDrafts(value: unknown): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  if (!isRecord(value)) return drafts;
  for (const [id, raw] of Object.entries(value)) {
    const draft = isId(id) ? readDraft(raw) : null;
    if (draft && drafts.size < MAX_DRAFTS) drafts.set(id, draft);
  }
  return drafts;
}

/** The state a stored value holds; the empty state for anything else. Never throws. */
export function parseState(raw: string | null): ViewState {
  if (typeof raw !== 'string' || raw.length > MAX_STATE_CHARS) return EMPTY_STATE;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return EMPTY_STATE; }
  if (!isRecord(value) || value.schema !== STATE_SCHEMA) return EMPTY_STATE;
  return { place: readPlace(value.place), drafts: readDrafts(value.drafts) };
}

const encode = (place: Place, drafts: ReadonlyArray<readonly [string, Draft]>): string =>
  JSON.stringify({ schema: STATE_SCHEMA, place, drafts: Object.fromEntries(drafts) });

/** The stored form of a state, within the bounds: the most recent drafts are kept, the oldest dropped first. */
export function serializeState(state: ViewState): string {
  const place = readPlace(state.place);   // the same bounds as a read
  const drafts = [...state.drafts].filter(([id, draft]) => isId(id) && readDraft(draft) !== null)
    .sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_DRAFTS);
  let text = encode(place, drafts);
  while (text.length > MAX_STATE_CHARS && drafts.length > 0) {
    drafts.pop();
    text = encode(place, drafts);
  }
  return text.length > MAX_STATE_CHARS ? encode(ENTRY_PLACE, []) : text;
}

/** The state with the draft of `question` set, or removed (null, or an empty field with nothing ticked). */
export function withDraft(state: ViewState, question: string, draft: Draft | null): ViewState {
  const drafts = new Map(state.drafts);
  const kept = draft ? readDraft(draft) : null;
  if (kept && isId(question)) drafts.set(question, kept); else drafts.delete(question);
  return { place: state.place, drafts };
}

export function withPlace(state: ViewState, place: Place): ViewState {
  return { place, drafts: state.drafts };
}

/** The stored state; the empty state when there is none, or no storage (a private window, storage refused). */
export function loadState(storage: () => StoragePort | null): ViewState {
  try { return parseState(storage()?.getItem(STATE_KEY) ?? null); } catch { return EMPTY_STATE; }
}

/** Store the state; an empty one removes the key. A storage that refuses (quota, disabled) leaves the state in memory only. */
export function saveState(storage: () => StoragePort | null, state: ViewState): void {
  try {
    const port = storage();
    if (!port) return;
    const empty = state.drafts.size === 0 && serializeState(state) === serializeState(EMPTY_STATE);
    if (empty) port.removeItem(STATE_KEY); else port.setItem(STATE_KEY, serializeState(state));
  } catch { /* the state stays in memory for this page */ }
}

export function clearState(storage: () => StoragePort | null): void {
  try { storage()?.removeItem(STATE_KEY); } catch { /* nothing stored, or nothing reachable */ }
}

/** The page's sessionStorage, or null when the browser refuses it. */
export function pageStorage(): StoragePort | null {
  try { return window.sessionStorage; } catch { return null; }
}
