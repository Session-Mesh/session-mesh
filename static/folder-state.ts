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
