// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sessions this device knew at its last listing, kept in the browser and shown, as loading,
// until the server answers. What is kept is limited to what identifies and places a session: its
// name, the owner's own label (never a title an agent or a transcript produced), folder, working
// directory, agent type and conversation id, activity to the minute, and a
// positive ACK capability bound to the exact created incarnation. No negative
// (legacy) capability is cached: only a fresh listing may select raw input.
//
// A stored value is read back as untrusted input (another script of the origin could have written
// it, and it reaches the sidebar's markup): every field is type-checked and bounded, the agent type
// must be a known one, and a row that fails is dropped.

import type { Row } from "./sessions-contract.ts";

export type KnownAgent = { type: string; session_id: string | null };
export type KnownRow = {
  id: string; name: string; created: number | null; cwd: string; label: string; folder: string | null;
  agent: KnownAgent | null; known_agent: string | null; activity: number;
  pty_capabilities?: ["acknowledged_input_v1" | "acknowledged_input_v2"];
};
export type Known = { home: string; folders: string[]; rows: KnownRow[] };

export const KNOWN_LIMIT = 500;
const FOLDER_LIMIT = 200;
/** The agent types the server reports (discover.py); any other stored value is dropped. */
export const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set(["claude", "codex", "pi", "opencode", "gemini", "agy", "copilot", "vibe"]);
// Session names, folders, known agents and conversation ids: printable, no markup characters.
const SAFE_NAME = /^[^\u0000-\u001f<>"'`&]+$/;

const object = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown, max = 4096): string | null => typeof value === "string" && value.length <= max ? value : null;
const name = (value: unknown, max: number): string | null => {
  const found = text(value, max);
  return found && SAFE_NAME.test(found) ? found : null;
};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function agentOf(value: unknown): KnownAgent | null {
  const agent = object(value);
  if (!agent || typeof agent.type !== "string" || !KNOWN_AGENT_TYPES.has(agent.type)) return null;
  return { type: agent.type, session_id: name(agent.session_id, 128) };
}

/** One row as it is stored, from a listing row or a stored one; null when it cannot be kept. */
export function knownRow(row: Row): KnownRow | null {
  const id = name(row.name, 256);
  if (!id || (row.id !== undefined && row.id !== id)) return null;
  const activity = finite(row.activity);
  const created = finite(row.created);
  // This is only an optimistic, incarnation-bound ACK hint. Never remember
  // negative capability (or infer legacy input from a missing/malformed hint).
  const capabilities = row.pty_capabilities;
  const ack = created !== null && created > 0 && Array.isArray(capabilities)
    && capabilities.length <= 16 && capabilities.every((value) => typeof value === "string")
    && new Set(capabilities).size === capabilities.length;
  const version = ack && (capabilities.includes("acknowledged_input_v2") ? "acknowledged_input_v2"
    : capabilities.includes("acknowledged_input_v1") ? "acknowledged_input_v1" : null);
  return {
    id, name: id, created, cwd: text(row.cwd) ?? "", label: text(row.label, 256) ?? "",
    folder: name(row.folder, 256), agent: agentOf(row.agent), known_agent: name(row.known_agent, 64),
    activity: activity === null ? 0 : Math.floor(activity / 60) * 60,
    ...(version ? { pty_capabilities: [version] as ["acknowledged_input_v1" | "acknowledged_input_v2"] } : {}),
  };
}

const folderList = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .map((folder) => name(folder, 256)).filter((folder): folder is string => folder !== null).slice(0, FOLDER_LIMIT);

/** The part of a listing worth keeping on this device. Provisional rows are never stored back. */
export function knownFrom(listing: Row): Known | null {
  if (!Array.isArray(listing.mesh)) return null;
  const rows: KnownRow[] = [];
  for (const row of (listing.mesh as unknown[]).slice(0, KNOWN_LIMIT)) {
    const source = object(row);
    if (!source || source.kind !== "mesh" || source.provisional === true) continue;
    const kept = knownRow(source);
    if (kept) rows.push(kept);
  }
  return { home: text(listing.home) ?? "", folders: folderList(listing.folders), rows };
}

/**
 * Whether a page may store its known sessions. Signing out (in any tab of the browser) records its
 * time; a page started before that time is a page of the signed-out account, whose answers may still
 * arrive, and never writes again. A page started after it (a new sign-in) may.
 */
export function mayRemember(signedOutAt: unknown, pageStartedAt: number): boolean {
  return typeof signedOutAt !== "number" || !Number.isFinite(signedOutAt) || signedOutAt < pageStartedAt;
}

/** A stored Known value, re-validated field by field; null when it is absent or not a Known at all. */
export function readKnown(raw: unknown): Known | null {
  const value = object(raw);
  if (!value || !Array.isArray(value.rows) || typeof value.home !== "string") return null;
  const rows = (value.rows as unknown[]).slice(0, KNOWN_LIMIT).map((row) => {
    const source = object(row);
    return source ? knownRow(source) : null;
  }).filter((row): row is KnownRow => row !== null);
  return { home: text(value.home) ?? "", folders: folderList(value.folders), rows };
}

/** The listing the page shows before the server answers: the known rows, each marked provisional (loading). */
export function provisionalListing(known: Known | null, extraNames: readonly string[] = []): Row {
  const rows: Row[] = (known?.rows ?? []).map((row) => ({ ...row, kind: "mesh", attached: 0, provisional: true }));
  const names = new Set(rows.map((row) => row.name));
  for (const extra of extraNames) {
    if (names.has(extra) || !name(extra, 256)) continue;
    names.add(extra);
    rows.push({ id: extra, name: extra, created: null, cwd: "", label: "", folder: null, agent: null, known_agent: null,
      activity: 0, kind: "mesh", attached: 0, provisional: true });
  }
  return { mesh: rows, external: [], folders: known?.folders ?? [], home: known?.home ?? "", provisional: true };
}
