// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How a terminal writes the replay its socket starts with (bundled into
// pane-actions.js, so the page loads no new file).
//
// The replay repeats the session's recent output (the host's last 2 MiB). On a
// first attach the terminal is empty; on a reconnection it already shows that
// output, so the replay is parsed from a reset terminal (RIS, ESC c, which also
// clears the scrollback) to show the history once.

const FULL_RESET = "\x1bc";
const MOUSE_TRACKING: Readonly<Record<string, string>> = {
  x10: "\x1b[?9h", vt200: "\x1b[?1000h", drag: "\x1b[?1002h", any: "\x1b[?1003h",
};
const MOUSE_ENCODING: Readonly<Record<string, string>> = { SGR: "\x1b[?1006h", SGR_PIXELS: "\x1b[?1016h" };
interface XtermState {
  readonly buffer?: { readonly active?: { readonly type?: string } };
  readonly modes?: {
    readonly applicationCursorKeysMode: boolean; readonly applicationKeypadMode: boolean;
    readonly bracketedPasteMode: boolean; readonly mouseTrackingMode: string; readonly sendFocusMode: boolean;
  };
  readonly _core?: { readonly coreMouseService?: { readonly activeEncoding?: string } };
}

/**
 * What a replay is written after, in the same write; null when it is written
 * as it comes, after what the terminal shows.
 *
 * - A first attach: a reset.
 * - A reconnection on the alternate screen: null. The program may have entered
 *   that screen before the output the replay holds; after a reset the replay
 *   would land in the normal buffer and its scrollback, the wheel would scroll
 *   instead of reaching the program, and a hidden cursor would show. Appended
 *   on the alternate screen, which has no scrollback, the repeated output is
 *   redrawn in place, as before.
 * - Any other reconnection: a reset, then the modes that only change how input
 *   is encoded, as the terminal has them now (a program sets them once, maybe
 *   before the output the replay holds, and the reset clears them); the replay
 *   overrides them if it changes them. Modes that change how output is drawn
 *   (insert, autowrap, origin, scroll region) are not set again: output
 *   produced without them would be drawn wrongly. The mouse encoding is not in
 *   xterm's public modes; it is read from its core.
 */
export function replayPrefix(term: object, reconnection: boolean): string | null {
  const { buffer, modes, _core: core } = term as XtermState;
  if (!reconnection) return FULL_RESET;
  if (buffer?.active?.type === "alternate") return null;
  if (!modes) return FULL_RESET;
  return [
    FULL_RESET,
    modes.applicationCursorKeysMode ? "\x1b[?1h" : "",
    modes.applicationKeypadMode ? "\x1b=" : "",
    modes.bracketedPasteMode ? "\x1b[?2004h" : "",
    MOUSE_TRACKING[modes.mouseTrackingMode] ?? "",
    MOUSE_ENCODING[core?.coreMouseService?.activeEncoding ?? ""] ?? "",
    modes.sendFocusMode ? "\x1b[?1004h" : "",
  ].join("");
}
