// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The folder field of the "New session" dialog, its pure part: the known folders (the allowed work
 * folders of GET /api/config, the runner's recent folders, the folders of the open sessions,
 * GET /api/dirs), their ranking for a typed text, the merge with the sub-folders listed while a path
 * is typed (see createFolderSuggester), the keys of the combobox (Tab completes, see tabKey), and the
 * one-time move of the recent folders an older version kept in this browser.
 *
 * Every check here is a convenience on the client: the server checks the folder again when the
 * session starts, and the listing (POST /api/ls) keeps its own roots and protections.
 */

const MAX_ROOTS = 16;
const MAX_PATH = 1024;
const MAX_KNOWN = 200;
const MAX_RECENT = 8;
export const FOLDER_SUGGESTION_LIMIT = 50;

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const usablePath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && (value.startsWith("/") || value.startsWith("~/"));

const withoutTrailingSlash = (path: string): string => path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;

/** `~` and `~/…` written with the home folder; trimmed, without a trailing slash (but `/` itself). */
export function expandHome(path: string, home: string): string {
  const text = path.trim();
  const expanded = text === "~" ? home : text.startsWith("~/") ? home + text.slice(1) : text;
  return withoutTrailingSlash(expanded);
}

/** The allowed work folders of a GET /api/config answer: none when the restriction is not configured. */
export function workspaceRoots(config: unknown): string[] {
  if (!isObject(config) || !isObject(config.launch) || config.launch.configured !== true) return [];
  const roots = config.launch.workspace_roots;
  if (!Array.isArray(roots)) return [];
  return roots.filter((root): root is string => usablePath(root) && root.startsWith("/"))
    .map(withoutTrailingSlash).slice(0, MAX_ROOTS);
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root === "/" ? "/" : root + "/");

/** The folder is one of the roots or inside one; any folder when no root is configured. */
export function insideRoots(path: string, roots: readonly string[], home: string): boolean {
  if (roots.length === 0) return true;
  const expanded = expandHome(path, home);
  return roots.some((root) => within(expanded, root));
}

/** The folder is a parent of a root: listing it is a way down to an allowed folder. */
export function leadsToRoot(path: string, roots: readonly string[], home: string): boolean {
  const expanded = expandHome(path, home);
  return roots.some((root) => root !== expanded && within(root, expanded));
}

export type KnownFolders = Readonly<{
  roots: readonly string[];
  recent: readonly string[];
  sessions: readonly string[];
  listed: readonly string[];
}>;

/** The folders offered before anything is typed: roots, recent, sessions, then GET /api/dirs; once each, inside the roots. */
export function knownFolderList(known: KnownFolders, home: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of [...known.roots, ...known.recent, ...known.sessions, ...known.listed]) {
    if (!usablePath(folder) || !insideRoots(folder, known.roots, home)) continue;
    const key = expandHome(folder, home);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(folder);
    if (out.length >= MAX_KNOWN) break;
  }
  return out;
}

/** `~` expanded, the trailing slash kept (it means "inside"), lower case: the text a folder is matched against. */
const typedKey = (typed: string, home: string): string => {
  const text = typed.trim();
  return (text === "~" || text.startsWith("~/") ? home + text.slice(1) : text).toLowerCase();
};

const inOrder = (wanted: string, text: string): boolean => {
  let at = 0;
  for (const char of wanted) {
    at = text.indexOf(char, at) + 1;
    if (at === 0) return false;
  }
  return true;
};

/** 0: the path starts with the text; 1: its last name does; 2: it contains the text; 3: it holds its letters in order; null: no match. */
export function matchScore(typed: string, folder: string, home: string): number | null {
  const wanted = typedKey(typed, home);
  const path = expandHome(folder, home).toLowerCase();
  if (path.startsWith(wanted)) return 0;
  if ((path.slice(path.lastIndexOf("/") + 1)).startsWith(wanted)) return 1;
  if (path.includes(wanted)) return 2;
  return inOrder(wanted, path) ? 3 : null;
}

/** The folders that match the text, best score first, the given order kept within a score. */
export function rankFolders(typed: string, folders: readonly string[], home: string, limit = FOLDER_SUGGESTION_LIMIT): string[] {
  if (typed.trim() === "") return folders.slice(0, limit);
  return folders
    .map((folder, index) => ({ folder, index, score: matchScore(typed, folder, home) }))
    .filter((entry): entry is { folder: string; index: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.folder);
}

/** What the list shows: the listed sub-folders as typed (inside the roots or on the way to one), then the ranked known folders. */
export function folderSuggestions(typed: string, known: readonly string[], walked: readonly string[], roots: readonly string[],
  home: string, limit = FOLDER_SUGGESTION_LIMIT): string[] {
  const reachable = walked.filter((folder) => insideRoots(folder, roots, home) || leadsToRoot(folder, roots, home));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of [...reachable, ...rankFolders(typed, known, home, limit)]) {
    const key = expandHome(folder, home);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(folder);
    if (out.length >= limit) break;
  }
  return out;
}

/** The recent folders an older version kept in this browser, cleaned of anything that is not a usable path. */
export function recentFolders(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter(usablePath).slice(0, MAX_RECENT) : [];
}

/** The runner's recent folders (`runner_settings.values.recent_folders` of GET /api/config), shared by every
 * device; the server records them when a session starts. Null from an older server, which has no such list. */
export function runnerRecentFolders(config: unknown): string[] | null {
  if (!isObject(config) || !isObject(config.runner_settings) || !isObject(config.runner_settings.values)) return null;
  const stored = config.runner_settings.values.recent_folders;
  return Array.isArray(stored) ? recentFolders(stored).filter((folder) => folder.startsWith("/")) : null;
}

/** The list this browser kept, as sent once to the runner (POST /api/dirs/recent): expanded, once each, at most 8. */
export function recentFoldersToImport(stored: unknown, home: string): string[] {
  const expanded = recentFolders(stored).map((folder) => expandHome(folder, home)).filter((folder) => folder.startsWith("/"));
  return [...new Set(expanded)].slice(0, MAX_RECENT);
}

/** After that request: drop the local copy once the runner answered for good (stored, refused, or this browser
 * signed out), keep it for the next try when the answer may change (no answer, a timeout, a server error). */
export function recentImportOutcome(status: number): "clear" | "keep" {
  return status === 0 || status === 408 || status === 429 || status >= 500 ? "keep" : "clear";
}

export type ComboState = Readonly<{ open: boolean; active: number; count: number }>;
export type ComboAction = Readonly<{ state: ComboState; accept: number | null; handled: boolean }>;

const closed = (state: ComboState): ComboState => ({ open: false, active: -1, count: state.count });
const moved = (state: ComboState, step: 1 | -1): ComboState => {
  const start = state.open && state.active >= 0 ? state.active + step : step === 1 ? 0 : state.count - 1;
  return { open: true, active: (start + state.count) % state.count, count: state.count };
};

/** One key on the folder field: the new list state, the option to accept, and whether the key is used up.
 * `open` is the wish to show the list; an open list with no option is not shown, so it is handled as closed. */
export function comboboxKey(wanted: ComboState, key: string): ComboAction {
  const state: ComboState = wanted.open && wanted.count === 0 ? closed(wanted) : wanted;
  const none: ComboAction = { state: wanted, accept: null, handled: false };
  switch (key) {
    case "ArrowDown":
    case "ArrowUp":
      return state.count === 0 ? none : { state: moved(state, key === "ArrowDown" ? 1 : -1), accept: null, handled: true };
    case "Enter":   // with no option chosen, Enter submits the form, as without the list
      if (!state.open) return none;
      return { state: closed(state), accept: state.active >= 0 ? state.active : null, handled: state.active >= 0 };
    case "Escape":
      return state.open ? { state: closed(state), accept: null, handled: true } : none;
    default:
      return none;   // Tab: tabKey
  }
}

export type TabContext = Readonly<{ suggestions: readonly string[]; value: string; typed: boolean; home: string }>;

/** Tab on the folder field completes like a shell: with the list shown, it accepts the chosen suggestion, else
 * the first one once something was typed, and keeps the focus. It lets the focus move on (the list closed) when
 * the list is not shown, there is no suggestion, the field already holds that suggestion (so a second Tab
 * leaves), or nothing was typed: the folder the dialog opened with is not replaced by a key meant to move on. */
export function tabKey(wanted: ComboState, context: TabContext): ComboAction {
  const shown = wanted.open && wanted.count > 0 && context.suggestions.length > 0;
  const index = !shown ? -1 : wanted.active >= 0 ? wanted.active : context.typed ? 0 : -1;
  const suggestion = context.suggestions[index];
  const moveOn: ComboAction = { state: closed(wanted), accept: null, handled: false };
  if (suggestion === undefined || expandHome(suggestion, context.home) === expandHome(context.value, context.home)) return moveOn;
  return { state: closed(wanted), accept: index, handled: true };
}
