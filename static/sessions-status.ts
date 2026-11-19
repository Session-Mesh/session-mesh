// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Where the session list stands, for the owner: which one line the status line above the sidebar
// list shows (static/status-line-view.ts draws it). The fields read from /api/sessions are
// documented in docs/sessions-loading.md; every one of them is optional, and a listing without them
// is complete and ready.

import type { PollerState } from "./single-flight-poller.ts";
import { complete, hostRestarted, hostSilent, progress, type Row } from "./sessions-contract.ts";

/** A parameter is a value, or `{ key }`: a message key the view translates. */
export type StatusParam = string | number | { key: string };
export type StatusText = { key: string; params: Record<string, StatusParam> };

export type StatusLine = StatusText & {
  // Shown next to the message but not announced: what changes at each retry or answer (a clock time).
  detail: StatusText | null;
  tone: "info" | "warn" | "bad";
  since: number | null;   // clock time the condition started: shown as elapsed seconds, not announced
  retry: boolean;   // offer "retry now"
};

export type StatusInput = {
  poller: PollerState;
  listing: Row | null;   // the last answer
  rows: readonly Row[];   // the mesh rows the page shows (before the first answer: this device's last listing)
  now: number;
  formatTime: (at: number) => string;
  offline?: boolean;   // the browser says the network is gone
  hostSilent?: boolean;   // the page's judgement (static/host-silence.ts); default: what the listing says
};

export const SLOW_AFTER_MS = 8000;
const PHASE_KEYS: Record<string, string> = {
  focus: "sessions.phase.focus", recent: "sessions.phase.recent", rest: "sessions.phase.rest",
};

const line = (key: string, tone: StatusLine["tone"], extra: Partial<StatusLine> = {}): StatusLine =>
  ({ key, params: {}, detail: null, tone, since: null, retry: false, ...extra });
const nextAttempt = (poller: PollerState, formatTime: (at: number) => string): StatusText | null =>
  poller.nextAttemptAt !== null ? { key: "sessions.status.nextAttempt", params: { time: formatTime(poller.nextAttemptAt) } } : null;

/** What the server (or the network) did to the last request, when that is the news. */
function serverLine({ poller, formatTime, offline }: StatusInput): StatusLine | null {
  if (offline) return line("sessions.status.offline", "bad", { retry: true });
  const restarted = () => poller.inFlightSince !== null && poller.restartSuspected
    ? line("sessions.status.restarted", "warn", { since: poller.inFlightSince }) : null;
  if (poller.failures === 0) return restarted();
  const status = poller.lastFailureStatus;
  if (status !== null && status < 500 && poller.everLoaded) {
    return line("sessions.status.refused", "warn", { params: { status }, detail: nextAttempt(poller, formatTime), retry: true });
  }
  // A retry under way after a failure: "restarted" if the server went away, else what the listing says.
  if (poller.inFlightSince !== null) return restarted();
  if (poller.lastFailureKind === "timeout") {
    return line("sessions.status.timeout", "warn", { detail: nextAttempt(poller, formatTime), retry: true });
  }
  const detail = nextAttempt(poller, formatTime);
  return line(detail ? "sessions.status.serverDown" : "sessions.status.serverDownNow", "bad", { detail, retry: true });
}

const loadingLine = (rows: readonly Row[], since: number | null): StatusLine =>
  rows.length ? line("sessions.status.loadingKnown", "info", { params: { n: rows.length }, since })
    : line("sessions.status.loading", "info", { since });

/**
 * Sessions being described: the announced message changes only with the phase (a coarse step); the
 * count changes at every answer, so it is in the detail, which is not announced.
 */
function progressLine(ready: number, total: number, phase: string | null): StatusLine {
  const phaseKey = phase ? PHASE_KEYS[phase] : undefined;
  return line(phaseKey ? "sessions.status.describingPhase" : "sessions.status.describing", "info", {
    params: phaseKey ? { phase: { key: phaseKey } } : {},
    detail: { key: "sessions.status.readyCount", params: { ready, total } },
  });
}

/** What the answers say about the sessions, once the server is answering. */
function listingLine({ poller, listing, rows, now, formatTime, hostSilent: silent }: StatusInput): StatusLine | null {
  const waiting = poller.inFlightSince;
  if (waiting !== null && !poller.everLoaded) return loadingLine(rows, waiting);
  if (silent ?? hostSilent(listing)) return line("sessions.status.hostSilent", "warn", { retry: true });
  if (hostRestarted(listing)) return line("sessions.status.hostRestarted", "info");
  // The server answered before it listed anything (empty, incomplete): still loading.
  if (!complete(listing) && Array.isArray(listing?.mesh) && listing.mesh.length === 0) return loadingLine(rows, null);
  const { total, ready, phase } = progress(listing, rows);
  if (ready < total) return progressLine(ready, total, phase);
  if (waiting !== null && now - waiting >= SLOW_AFTER_MS && poller.lastSuccessAt !== null) {
    return line("sessions.status.slow", "info", { since: waiting,
      detail: { key: "sessions.status.listAsOf", params: { time: formatTime(poller.lastSuccessAt) } } });
  }
  return null;
}

/**
 * The one line to show, or null when everything is listed and ready. In order: offline, the
 * server's failure or restart, an answer the page could not apply, then what the listing says.
 */
export function statusLine(input: StatusInput): StatusLine | null {
  if (input.poller.stopped) return null;
  const server = serverLine(input);
  if (server) return server;
  if (input.poller.clientError) return line("sessions.status.clientError", "warn", { retry: true });
  return listingLine(input);
}

/** Whether the line must be recomputed every second: it shows elapsed time, or a wait may turn slow. */
export const statusTicks = (shown: StatusLine | null, poller: PollerState): boolean =>
  shown?.since != null || poller.inFlightSince !== null;
