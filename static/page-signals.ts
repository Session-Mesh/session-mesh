// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What the page tells a poller about itself: a hidden tab polls at most every `hiddenMs`, and
// becoming visible or getting the network back asks for an answer at once; going offline is
// reported so the status line can say it rather than show a series of failures.

export const HIDDEN_INTERVAL_MS = 30_000;

type Listen = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type PageSignalsInput = {
  win: Listen & { navigator?: { onLine?: boolean } };
  doc: Listen & { hidden: boolean };
  wake: () => void;   // ask for an answer now (the poller's `request`)
  changed: () => void;   // the offline flag changed: redraw what shows it
  hiddenMs?: number;
};

export type PageSignals = {
  offline(): boolean;
  minDelayMs(): number;   // the poller's floor: `hiddenMs` while the page is hidden, else 0
  dispose(): void;
};

export function watchPageSignals(input: PageSignalsInput): PageSignals {
  const hiddenMs = input.hiddenMs ?? HIDDEN_INTERVAL_MS;
  let offline = input.win.navigator?.onLine === false;
  const onVisibility = () => { if (!input.doc.hidden) input.wake(); };
  const onOnline = () => { offline = false; input.changed(); input.wake(); };
  const onOffline = () => { offline = true; input.changed(); };
  input.doc.addEventListener("visibilitychange", onVisibility);
  input.win.addEventListener("online", onOnline);
  input.win.addEventListener("offline", onOffline);
  return {
    offline: () => offline,
    minDelayMs: () => (input.doc.hidden ? hiddenMs : 0),
    dispose() {
      input.doc.removeEventListener("visibilitychange", onVisibility);
      input.win.removeEventListener("online", onOnline);
      input.win.removeEventListener("offline", onOffline);
    },
  };
}
