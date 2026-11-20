// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Which size a terminal pane shows when several browsers show the same session
// (bundled into pane-actions.js, so the page loads no new file).
//
// The PTY has one size. A program on the main screen (Claude Code's footer)
// redraws only its visible rows for the width it reads; a pane narrower than
// that width wraps each of those rows and keeps copies of the footer in its
// scrollback. So one attachment owns the size (the PTY host decides, see
// ocaml/lib/mesh_pty_size.mli) and the others display the PTY at its size,
// clipped, with a banner that offers to take the size back.

export type PtySizeOwner = "you" | "other" | "none";
export interface Geometry { readonly rows: number; readonly cols: number }
export interface PtySize extends Geometry { readonly owner: PtySizeOwner }

/** How a resize the page sends asks the host: "claim" applies only while no
 * other attachment owns the size; "take" is an explicit take-over; "keep"
 * (a redraw) applies and leaves the owner. */
export type SizeMode = "claim" | "take" | "keep";

const OWNERS: readonly string[] = ["you", "other", "none"];
const validDimension = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 2 && (value as number) <= 1000;

/** server.py's {t:"s", rows, cols, owner}; null for anything else. */
export function parsePtySize(text: string): PtySize | null {
  let message: unknown;
  try { message = JSON.parse(text); } catch { return null; }
  if (typeof message !== "object" || message === null) return null;
  const { t, rows, cols, owner } = message as Record<string, unknown>;
  if (t !== "s" || !validDimension(rows) || !validDimension(cols)
      || typeof owner !== "string" || !OWNERS.includes(owner)) return null;
  return { rows, cols, owner: owner as PtySizeOwner };
}

export interface SizePlan {
  /** The pane shows the PTY at its size instead of fitting its own. */
  readonly follow: boolean;
  /** The size xterm takes. */
  readonly term: Geometry;
  /** The pane's own size differs from the PTY's: offer to take it back. */
  readonly banner: boolean;
  /** Nobody owns the size: send this pane's size so it does. */
  readonly claim: boolean;
}

/**
 * The size a pane shows. `pty` is the last size the host announced (null: a
 * host without the size owner rule, where every pane fits its own size and
 * sends it, as before); `own` is the size the pane's area fits.
 */
export function sizePlan(pty: PtySize | null, own: Geometry): SizePlan {
  if (!pty || pty.owner !== "other") {
    return { follow: false, term: own, banner: false, claim: pty?.owner === "none" };
  }
  const banner = pty.rows !== own.rows || pty.cols !== own.cols;
  return { follow: true, term: { rows: pty.rows, cols: pty.cols }, banner, claim: false };
}

/** Whether a resize in `mode` is worth sending: a pane that follows another
 * owner sends only explicit take-overs and redraws. */
export function sendsSize(pty: PtySize | null, mode: SizeMode): boolean {
  return mode !== "claim" || pty?.owner !== "other";
}
