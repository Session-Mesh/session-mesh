// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * Browser-local organization state which is safe to move out of app.js.
 *
 * The HTTP response remains untrusted at this boundary even though it comes
 * from the authenticated Mesh route: TypeScript types do not validate runtime
 * values.  DOM rendering and fetch orchestration intentionally stay in
 * app.js while the PWA split is incremental.
 */

export * from "./folder-suggest.ts";

export type FolderRename = Readonly<{
  old: string;
  new: string;
}>;

export type FolderRenameResponse = Readonly<{
  folder_rename: FolderRename;
}>;

type ObjectValue = Record<string, unknown>;

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFolderRename = (value: unknown): value is FolderRename =>
  isObject(value) && typeof value.old === "string" && typeof value.new === "string";

const isFolderRenameResponse = (value: unknown): value is FolderRenameResponse =>
  isObject(value) && isFolderRename(value.folder_rename);

const foldKey = (name: string): string => `dir:${name}`;

/** A strictly shaped receipt for the rename the caller just requested. */
export function folderRenameReceipt(response: unknown, expectedOld: string): FolderRename | null {
  if (!isFolderRenameResponse(response)) return null;
  const receipt = response.folder_rename;
  if (receipt.old !== expectedOld || !receipt.new) return null;
  return { old: receipt.old, new: receipt.new };
}

/** Move only the local folded-folder preference; all other browser state stays untouched. */
export function migrateFoldedFolder(folded: ReadonlySet<string>, rename: FolderRename): string[] {
  const oldKey = foldKey(rename.old);
  const newKey = foldKey(rename.new);
  return [...new Set([...folded].map((key) => key === oldKey ? newKey : key))];
}

/**
 * Folder suggestions for the "New session" dialog, computed from the listing the file tree already
 * uses (POST /api/ls): no dedicated server route.  The listing answers every entry of a folder
 * (files too, dotfiles included, at most 2000), so the filtering is done here.
 */
export type TypedPath = Readonly<{ directory: string; prefix: string }>;

export const SUGGESTION_LIMIT = 50;
const MAX_TYPED_LENGTH = 1024;

/** The folder to list and the start of the name being typed, for an absolute or `~/` text only. */
export function splitTypedPath(typed: string): TypedPath | null {
  const text = typed.trim();
  if (text.length === 0 || text.length > MAX_TYPED_LENGTH) return null;
  if (!text.startsWith("/") && !text.startsWith("~/")) return null;
  const slash = text.lastIndexOf("/");
  return { directory: text.slice(0, slash + 1), prefix: text.slice(slash + 1) };
}

/** The names of the sub-folders (links to folders included) of a listing answer, in answer order. */
export function listingFolderNames(response: unknown): string[] {
  if (!isObject(response) || !Array.isArray(response.entries)) return [];
  const names: string[] = [];
  for (const entry of response.entries) {
    if (isObject(entry) && entry.dir === true && typeof entry.name === "string" && entry.name.length > 0) names.push(entry.name);
  }
  return names;
}

const byName = (a: string, b: string): number =>
  a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0);

/** Folders whose name starts with the prefix (case-insensitive): the folder part as typed, the name as on disk; dotfolders only for a dot prefix. */
export function matchingFolders(typed: TypedPath, names: readonly string[], limit = SUGGESTION_LIMIT): string[] {
  const wanted = typed.prefix.toLowerCase();
  const withDots = typed.prefix.startsWith(".");
  return names
    .filter((name) => (withDots || !name.startsWith(".")) && name.toLowerCase().startsWith(wanted))
    .sort(byName)
    .slice(0, limit)
    .map((name) => typed.directory + name);
}

export type FolderSuggesterOptions = Readonly<{
  /** The listing answer of a folder, or null when it was refused or not found; throws on a network failure or an abort. */
  listFolder: (directory: string, signal?: unknown) => Promise<unknown>;
  /** A fresh AbortController (or alike): the listing for an older text is aborted when a newer text is typed. */
  createAbort?: () => Readonly<{ signal: unknown; abort: () => void }>;
  /** Receives the suggestions for the latest text only. */
  onSuggestions: (folders: string[]) => void;
  delayMs?: number;
  ttlMs?: number;
  now?: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}>;

export type FolderSuggester = Readonly<{
  input: (typed: string) => void;
  reset: () => void;
}>;

const CACHE_LIMIT = 30;

/** Debounced suggestions with a short-lived cache per folder (usable answers only, 30 folders at most); an answer to an older text is dropped. */
export function createFolderSuggester(options: FolderSuggesterOptions): FolderSuggester {
  const delayMs = options.delayMs ?? 150;
  const ttlMs = options.ttlMs ?? 5000;
  const now = options.now ?? Date.now;
  const { setTimer, clearTimer } = options;
  const cache = new Map<string, { at: number; names: string[] }>();
  let timer: unknown = null;
  let generation = 0;
  let resets = 0;
  let pending: Readonly<{ abort: () => void }> | null = null;

  const abortPending = (): void => {
    pending?.abort();
    pending = null;
  };

  const namesOf = async (directory: string): Promise<string[]> => {
    const hit = cache.get(directory);
    if (hit && now() - hit.at < ttlMs) return hit.names;
    const resetsBefore = resets;
    const controller = options.createAbort?.() ?? null;
    pending = controller;
    const answer = await (controller ? options.listFolder(directory, controller.signal) : options.listFolder(directory));
    if (pending === controller) pending = null;
    const names = listingFolderNames(answer);
    // not kept: asked before a reset, or refused / not found (null); a thrown network error never reaches here
    if (resetsBefore !== resets || answer === null) return names;
    cache.delete(directory);
    cache.set(directory, { at: now(), names });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return names;
  };

  const run = async (typedText: string, mine: number): Promise<void> => {
    const typed = splitTypedPath(typedText);
    let folders: string[] = [];
    if (typed) {
      try {
        folders = matchingFolders(typed, await namesOf(typed.directory));
      } catch {
        folders = [];
      }
    }
    if (mine === generation) options.onSuggestions(folders);
  };

  const cancelTimer = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  return {
    input(typed) {
      generation += 1;
      const mine = generation;
      cancelTimer();
      abortPending();
      if (!splitTypedPath(typed)) { options.onSuggestions([]); return; }
      timer = setTimer(() => { timer = null; void run(typed, mine); }, delayMs);
    },
    reset() {
      generation += 1;
      resets += 1;
      cancelTimer();
      abortPending();
      cache.clear();
    },
  };
}
