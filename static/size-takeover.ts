// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Who takes the shared PTY size, per browser (bundled into pane-actions.js, so the page loads no
// new file). The PTY host keeps its rule (terminal-size-owner.ts, ocaml/lib/mesh_pty_size.mli):
// the first attachment owns the size and only an explicit take-over moves it. This module only
// decides when this browser sends that take-over by itself.
//
// "auto" (the default): the device the person uses takes the size when they use it: a pointer
// press, a key or a touch in the terminal, the phone input line or key bar; or the terminal
// getting the focus, or the page shown again, these two only while this window has the focus and
// the person has just acted on this page (the browser's transient user activation). The page
// also focuses the terminal by itself (a panel an agent opens, a dialog closed): that focus alone
// is not a person here. Never from a timer, a resize or a page that merely stays visible, so two
// open devices do not fight: the size moves only when a person acts on the other one. At most one
// take-over per TAKEOVER_GAP_MS per pane.
// "manual": as before, a banner offers to take the size back and only its button does.

import type { PtySizeOwner } from "./terminal-size-owner.ts";

export type SizeTakeoverMode = "auto" | "manual";
/** The client store key (per browser, as copyOnSelect). */
export const SIZE_TAKEOVER_KEY = "sizeTakeover";
export const TAKEOVER_GAP_MS = 2000;

export const sizeTakeoverMode = (stored: unknown): SizeTakeoverMode => stored === "manual" ? "manual" : "auto";

/** The events that mean "a person acts on this device", wherever this window's focus is. */
const INPUT_EVENTS: readonly string[] = ["pointerdown", "keydown", "touchstart"];
/** The events that mean it only while this window has the focus, just after a person's action. */
const FOCUS_EVENTS: readonly string[] = ["focus", "visibilitychange"];

export interface TakeoverInput {
  readonly mode: SizeTakeoverMode;
  /** The PTY size owner the host last announced; null: a host without the owner rule. */
  readonly owner: PtySizeOwner | null;
  /** The DOM event's type. */
  readonly event: string;
  /** The event came from the browser (isTrusted), not from a script. */
  readonly trusted: boolean;
  /** document.visibilityState is "visible". */
  readonly visible: boolean;
  /** document.hasFocus(). */
  readonly focused: boolean;
  /** navigator.userActivation.isActive: a person acted on this page a moment ago (false where unknown). */
  readonly activated: boolean;
  readonly now: number;
  /** When this pane last took the size by itself; null: never. */
  readonly lastTake: number | null;
}

export function shouldTakeSize(input: TakeoverInput): boolean {
  if (input.mode !== "auto" || input.owner !== "other" || !input.trusted || !input.visible) return false;
  const activation = INPUT_EVENTS.includes(input.event) || (FOCUS_EVENTS.includes(input.event) && input.focused && input.activated);
  return activation && (input.lastTake === null || input.now - input.lastTake >= TAKEOVER_GAP_MS);
}

/** The "Take the size back" banner, when the pane follows another device's size. */
export const showsSizeBanner = (mode: SizeTakeoverMode, differs: boolean): boolean => mode === "manual" && differs;

/** Calls `activate` with each activation event inside `root` (capture: focus does not bubble). */
export function listenForActivation(root: HTMLElement, activate: (event: Event) => void): void {
  for (const type of [...INPUT_EVENTS, "focus"]) root.addEventListener(type, activate, { capture: true, passive: true });
}

export type SizeTakeoverTranslate = (key: string) => string;
export type SizeTakeoverPorts = Readonly<{
  get: () => SizeTakeoverMode;
  set: (mode: SizeTakeoverMode) => void;
}>;

/** The Configuration card: two radio buttons, applied at once to this browser. */
export function sizeTakeoverCard(doc: Document, t: SizeTakeoverTranslate, ports: SizeTakeoverPorts): HTMLElement {
  const card = doc.createElement("section");
  card.className = "config-section config-card config-size-takeover"; card.dataset.section = "size-takeover";
  const fieldset = doc.createElement("fieldset"), legend = doc.createElement("legend"), help = doc.createElement("p");
  legend.textContent = t("config.sizeTakeover.title");
  help.className = "mute small"; help.id = "config-size-takeover-help"; help.textContent = t("config.sizeTakeover.help");
  fieldset.setAttribute("aria-describedby", help.id);
  fieldset.append(legend);
  const current = ports.get();
  for (const mode of ["auto", "manual"] as const) {
    const label = doc.createElement("label"), input = doc.createElement("input"), text = doc.createElement("span");
    label.className = "config-choice";
    input.type = "radio"; input.name = "size-takeover"; input.value = mode; input.checked = mode === current;
    input.addEventListener("change", () => { if (input.checked) ports.set(mode); });
    text.textContent = t(`config.sizeTakeover.${mode}`);
    label.append(input, text); fieldset.append(label);
  }
  card.append(fieldset, help);
  return card;
}
