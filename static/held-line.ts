// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * A line typed in the phone's field before the session list has named the pane's session.
 *
 * A terminal pane attaches by name before the first listing, and the listing that follows a server
 * restart may still be incomplete (`management: pending`), so the pane may have no observed target
 * yet when Enter is pressed. The line is held instead of refused: `capture` is tried again after each
 * applied listing for as long as `waiting()` says one may still name the pane, within `limitMs`.
 *
 * The line is never sent elsewhere than where it was typed: `same()` must still hold (the pane is
 * the active one and shows the same session and view as when Enter was pressed) before any capture.
 * Every outcome other than `target` sends nothing, and the caller keeps the text.
 */
export type HeldLineEnd<T> =
  | { readonly kind: "target"; readonly target: T }
  | { readonly kind: "missing" }     // the listing settled the pane without naming it
  | { readonly kind: "moved" }       // the pane shows something else, or is no longer the active one
  | { readonly kind: "cancelled" }   // the owner cancelled the wait
  | { readonly kind: "late" };       // no listing named it within `limitMs`

export interface HeldLineTimers {
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface HeldLinePorts<T> {
  readonly capture: () => T | null;
  readonly waiting: () => boolean;
  readonly same: () => boolean;
  /** The next applied listing (or a failed attempt): resolves once it is over. */
  readonly listed: () => Promise<unknown>;
  readonly timers: HeldLineTimers;
  readonly limitMs: number;
  /** The least time between two listings asked for, so a fast failing request is not repeated in a loop. */
  readonly pauseMs: number;
}

export interface HeldLine<T> {
  readonly settled: Promise<HeldLineEnd<T>>;
  /** True when no target was captured at once: the line waits for a listing. */
  readonly waits: boolean;
  /** Ends the wait with `cancelled`. False when it had already ended. */
  readonly cancel: () => boolean;
}

export function holdLineForTarget<T>(ports: HeldLinePorts<T>): HeldLine<T> {
  let cancelled = false, late = false, over = false;
  let wake: (() => void) | null = null;
  const decide = (): HeldLineEnd<T> | null => {
    if (cancelled) return { kind: "cancelled" };
    if (!ports.same()) return { kind: "moved" };
    const target = ports.capture();
    if (target !== null) return { kind: "target", target };
    if (!ports.waiting()) return { kind: "missing" };
    return late ? { kind: "late" } : null;
  };
  const first = decide();
  if (first !== null) {
    over = true;
    return { settled: Promise.resolve(first), waits: false, cancel: () => false };
  }
  const limit = ports.timers.setTimeout(() => { late = true; wake?.(); }, ports.limitMs);
  const round = () => new Promise<void>((resolve) => {
    wake = resolve;
    const pause = new Promise<void>((done) => { ports.timers.setTimeout(done, ports.pauseMs); });
    void Promise.all([ports.listed().catch(() => undefined), pause]).then(() => resolve());
  });
  const settled = (async () => {
    for (;;) {
      await round();
      const end = decide();
      if (end !== null) {
        over = true;
        ports.timers.clearTimeout(limit);
        return end;
      }
    }
  })();
  const cancel = () => {
    if (over || cancelled) return false;
    cancelled = true;
    wake?.();
    return true;
  };
  return { settled, waits: true, cancel };
}
