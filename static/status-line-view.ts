// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Drawing a status line into a reserved-height box, and keeping it current while it shows elapsed
// time. Only the message is in the polite live region, and it changes only when the state does:
// the detail (a clock time that changes at each retry) and the elapsed seconds are visual only,
// never announced.

import type { StatusLine, StatusParam, StatusText } from "./sessions-status.ts";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type StatusViewOptions = {
  box: HTMLElement;
  translate: Translate;
  onRetry: () => void;
  read: (now: number) => { line: StatusLine | null; ticking: boolean };   // the line to show now
  now: () => number;
  timers: { setInterval(run: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  classPrefix?: string;   // "sessions-status": its -text, -detail, -retry children
  keys?: { elapsed: string; retry: string };
};

export type StatusView = { render(): void; dispose(): void };

const DEFAULT_KEYS = { elapsed: "sessions.status.elapsed", retry: "sessions.status.retryNow" };

function translated(text: StatusText, translate: Translate): string {
  const value = (param: StatusParam) => (typeof param === "object" ? translate(param.key) : param);
  return translate(text.key, Object.fromEntries(Object.entries(text.params).map(([name, param]) => [name, value(param)])));
}

function child(box: HTMLElement, className: string, tag: string, setup: (el: HTMLElement) => void): HTMLElement {
  const found = box.querySelector<HTMLElement>(`:scope > .${className}`);
  if (found) return found;
  const el = box.ownerDocument.createElement(tag);
  el.className = className;
  setup(el);
  box.append(el);
  return el;
}

const setText = (el: HTMLElement, text: string) => { if (el.textContent !== text) el.textContent = text; };

/** Draw `line` into the box: message (announced), detail and elapsed seconds (visual), retry button. */
function draw(options: StatusViewOptions, line: StatusLine | null, now: number): void {
  const { box, translate } = options;
  const prefix = options.classPrefix ?? "sessions-status";
  const keys = options.keys ?? DEFAULT_KEYS;
  const message = child(box, `${prefix}-text`, "span", (el) => { el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); });
  const detail = child(box, `${prefix}-detail`, "span", (el) => el.setAttribute("aria-hidden", "true"));
  const retry = child(box, `${prefix}-retry`, "button", (el) => {
    (el as HTMLButtonElement).type = "button";
    el.addEventListener("click", () => options.onRetry());
  });
  setText(message, line ? translated(line, translate) : "");
  const seconds = line?.since != null ? Math.max(0, Math.floor((now - line.since) / 1000)) : null;
  const parts = [line?.detail ? translated(line.detail, translate) : "",
    seconds !== null && seconds >= 1 ? translate(keys.elapsed, { seconds }) : ""].filter(Boolean);
  setText(detail, parts.join(" · "));
  box.dataset.tone = line?.tone ?? "";
  box.classList.toggle("idle", !line);
  retry.hidden = !line?.retry;
  setText(retry, translate(keys.retry));
}

/** A status line kept current: `render` after each change; it ticks once a second while it must. */
export function createStatusView(options: StatusViewOptions): StatusView {
  let ticker: unknown = null;
  const stopTicking = () => { if (ticker !== null) options.timers.clearInterval(ticker); ticker = null; };
  const render = () => {
    const now = options.now();
    const { line, ticking } = options.read(now);
    draw(options, line, now);
    if (ticking && ticker === null) ticker = options.timers.setInterval(render, 1000);
    if (!ticking) stopTicking();
  };
  return { render, dispose: stopTicking };
}
