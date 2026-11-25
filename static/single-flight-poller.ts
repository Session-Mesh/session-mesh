// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A generic poller that keeps one request in flight at a time (the session list uses it through
// static/app.js; any other periodic fetch can).
//
// A listing can take tens of seconds on a loaded machine. A fixed interval sends a new request
// whatever the state of the previous one, and every tab feeds the server's queue that way. Here:
//   - at most one request is in flight; a timer tick that finds one running is skipped;
//   - an explicit request made while one runs waits for ONE follow-up request started after it,
//     shared by every caller that asked meanwhile; `load` is told the attempt was asked for
//     (`requested`), so it can ask the server for an answer that reflects what the caller changed;
//   - polls start every baseIntervalMs while answers are quick; once an answer is slow, the poller
//     stays idle at least as long as it took (never faster than the server answers), up to
//     maxIntervalMs; `minDelayMs` raises every scheduled delay (a hidden page polls less);
//   - after a failure the next attempt follows a bounded backoff whose time is published
//     (`nextAttemptAt`), so a caller can show it;
//   - outcomes are told apart: an HTTP or network failure, a request aborted by `timeoutMs` (the
//     server is slow, not gone) and an exception in `apply` (the caller's own bug: the server did
//     answer, so its state is left as answered and `clientError` is set).
// Answers cannot arrive out of order (one request at a time); `stop` aborts the one in flight and
// drops its answer.

export type LoadOutcome =
  | { kind: "loaded"; value: unknown }
  | { kind: "refused" }
  | { kind: "failed"; status: number | null };

/** What one attempt came to: the loader's outcome, or one of the two the poller itself observes. */
export type AttemptOutcome = LoadOutcome | { kind: "timeout" } | { kind: "apply-error"; error: unknown };

export type FailureKind = "http" | "network" | "timeout";

export type Clock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type PollerState = {
  inFlightSince: number | null;   // clock time the running request started, null when idle
  lastSuccessAt: number | null;   // last answer that was applied
  lastDurationMs: number | null;   // of the last answered request (success or HTTP failure)
  failures: number;   // consecutive failed attempts (HTTP, network or timeout)
  lastFailureStatus: number | null;   // HTTP status of the last failure, null otherwise
  lastFailureKind: FailureKind | null;
  clientError: boolean;   // the last answer could not be applied (an exception in `apply`)
  nextAttemptAt: number | null;   // when the next scheduled attempt starts, null when none is
  everLoaded: boolean;
  restartSuspected: boolean;   // the server went away (or said it restarts) since the last answer
  stopped: boolean;
};

export type PollerOptions<R> = {
  // `requested`: a caller asked for this attempt (start, request, a shared follow-up), not a timer.
  load: (signal: AbortSignal, attempt: { requested: boolean }) => Promise<LoadOutcome>;
  apply: (value: unknown) => R | Promise<R>;
  clock: Clock;
  baseIntervalMs?: number | (() => number);   // a function is read after each answer
  maxIntervalMs?: number;
  minDelayMs?: () => number;   // a floor for every scheduled delay, read when scheduling
  timeoutMs?: number | (() => number);   // read once per attempt
  onChange?: (state: PollerState) => void;
  onApplyError?: (error: unknown) => void;
};

export type Poller<R> = {
  start(): Promise<R | undefined>;
  request(): Promise<R | undefined>;
  noteRestart(): void;
  stop(): void;
  state(): PollerState;
};

export const BASE_INTERVAL_MS = 4000;
export const MAX_INTERVAL_MS = 60_000;
export const TIMEOUT_MS = 180_000;
const RETRY_STEPS_MS = [2000, 4000, 8000, 15_000];

/** Delay before attempt n+1 after n consecutive failures (n >= 1): 2, 4, 8, then 15 s. */
export function retryDelay(failures: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(failures, 1), RETRY_STEPS_MS.length) - 1] ?? 15_000;
}

/**
 * Delay between an answer and the next poll: requests start every `base` ms while answers are quick,
 * and the poller is idle at least as long as the last answer took once they are slow (at most half of
 * the time spent waiting on the server); never more than `max`.
 */
export function pollDelay(lastDurationMs: number | null, base = BASE_INTERVAL_MS, max = MAX_INTERVAL_MS): number {
  const took = lastDurationMs !== null && Number.isFinite(lastDurationMs) ? Math.max(0, lastDurationMs) : 0;
  return Math.min(max, Math.max(base - took, took));
}

/** A failure that says the server is not answering at all (as opposed to a refusal of this request). */
export const serverGone = (status: number | null): boolean => status === null || status === 502 || status === 503 || status === 504;

/** The state after an attempt that ended at `finished` (started at `started`). Pure. */
export function recordOutcome(state: PollerState, outcome: AttemptOutcome, started: number, finished: number): PollerState {
  if (outcome.kind === "refused") return { ...state };
  if (outcome.kind === "timeout") {
    return { ...state, failures: state.failures + 1, lastFailureStatus: null, lastFailureKind: "timeout" };
  }
  if (outcome.kind === "failed") {
    const http = outcome.status !== null;
    return { ...state, failures: state.failures + 1, lastFailureStatus: outcome.status, lastFailureKind: http ? "http" : "network",
      lastDurationMs: http ? finished - started : state.lastDurationMs,
      restartSuspected: state.restartSuspected || serverGone(outcome.status) };
  }
  // The server answered: loaded, or loaded and then refused by the caller's own `apply`.
  const answered = { ...state, lastDurationMs: finished - started, failures: 0, lastFailureStatus: null, lastFailureKind: null,
    restartSuspected: false };
  if (outcome.kind === "apply-error") return { ...answered, clientError: true };
  return { ...answered, lastSuccessAt: finished, everLoaded: true, clientError: false };
}

/** The delay before the next poll after `outcome`, `null` for none (a refusal stops polling). */
export function nextDelay(state: PollerState, outcome: AttemptOutcome, base: number, max: number): number | null {
  if (outcome.kind === "refused") return null;
  if (outcome.kind === "failed" || outcome.kind === "timeout") return retryDelay(state.failures);
  return pollDelay(state.lastDurationMs, base, max);
}

export const initialState = (): PollerState => ({
  inFlightSince: null, lastSuccessAt: null, lastDurationMs: null, failures: 0, lastFailureStatus: null, lastFailureKind: null,
  clientError: false, nextAttemptAt: null, everLoaded: false, restartSuspected: false, stopped: false,
});

type Waiter<R> = (result: R | undefined) => void;

type Core<R> = {
  options: PollerOptions<R>;
  state: PollerState;
  running: AbortController | null;
  current: Waiter<R>[];   // callers answered by the request in flight
  queued: Waiter<R>[] | null;   // callers waiting for the follow-up request
  timer: unknown;
};

function publish<R>(core: Core<R>): void {
  try { core.options.onChange?.({ ...core.state }); } catch { /* a status renderer never stops polling */ }
}

function unschedule<R>(core: Core<R>): void {
  if (core.timer !== null) core.options.clock.clearTimeout(core.timer);
  core.timer = null;
  core.state.nextAttemptAt = null;
}

function schedule<R>(core: Core<R>, delay: number): void {
  unschedule(core);
  if (core.state.stopped) return;
  const wait = Math.max(delay, core.options.minDelayMs?.() ?? 0);
  core.state.nextAttemptAt = core.options.clock.now() + wait;
  core.timer = core.options.clock.setTimeout(() => {
    core.timer = null;
    core.state.nextAttemptAt = null;
    if (!core.running) void run(core, []);
  }, wait);
}

/** One request: load, then apply. Never throws; every way it can end is an AttemptOutcome. */
async function attempt<R>(core: Core<R>, controller: AbortController, requested: boolean): Promise<{ outcome: AttemptOutcome; result: R | undefined }> {
  const { clock, load, apply } = core.options;
  let timedOut = false;
  const timeout = typeof core.options.timeoutMs === "function" ? core.options.timeoutMs() : core.options.timeoutMs ?? TIMEOUT_MS;
  const deadline = clock.setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  let outcome: LoadOutcome;
  try {
    outcome = await load(controller.signal, { requested });
  } catch {
    outcome = { kind: "failed", status: null };
  } finally {
    clock.clearTimeout(deadline);
  }
  if (timedOut) return { outcome: { kind: "timeout" }, result: undefined };
  if (outcome.kind !== "loaded" || controller.signal.aborted) return { outcome, result: undefined };
  try {
    return { outcome, result: await apply(outcome.value) };
  } catch (error) {
    try { core.options.onApplyError?.(error); } catch { /* reporting never stops polling */ }
    return { outcome: { kind: "apply-error", error }, result: undefined };
  }
}

async function run<R>(core: Core<R>, waiters: Waiter<R>[]): Promise<void> {
  unschedule(core);
  const controller = new AbortController();
  core.running = controller;
  core.current = waiters;
  const started = core.options.clock.now();
  core.state.inFlightSince = started;
  publish(core);
  const { outcome, result } = await attempt(core, controller, waiters.length > 0);
  if (core.state.stopped || core.running !== controller) return;
  core.running = null;
  core.state = { ...recordOutcome(core.state, outcome, started, core.options.clock.now()), inFlightSince: null };
  const answered = core.current;
  core.current = [];
  for (const resolve of answered) resolve(result);
  if (outcome.kind === "refused") { stop(core); return; }
  const follow = core.queued;
  core.queued = null;
  if (follow) { void run(core, follow); return; }
  const { baseIntervalMs, maxIntervalMs } = core.options;
  const base = typeof baseIntervalMs === "function" ? baseIntervalMs() : baseIntervalMs ?? BASE_INTERVAL_MS;
  schedule(core, nextDelay(core.state, outcome, base, maxIntervalMs ?? MAX_INTERVAL_MS) ?? 0);
  publish(core);
}

function request<R>(core: Core<R>): Promise<R | undefined> {
  if (core.state.stopped) return Promise.resolve(undefined);
  return new Promise<R | undefined>((resolve) => {
    if (core.running) { (core.queued ??= []).push(resolve); return; }
    void run(core, [resolve]);
  });
}

function stop<R>(core: Core<R>): void {
  if (core.state.stopped) return;
  core.state.stopped = true;
  unschedule(core);
  core.running?.abort();
  core.running = null;
  core.state.inFlightSince = null;
  for (const resolve of [...core.current, ...(core.queued ?? [])]) resolve(undefined);
  core.current = [];
  core.queued = null;
  publish(core);
}

export function createPoller<R>(options: PollerOptions<R>): Poller<R> {
  const core: Core<R> = { options, state: initialState(), running: null, current: [], queued: null, timer: null };
  return {
    start: () => request(core),
    request: () => request(core),
    noteRestart() {
      if (core.state.stopped || core.state.restartSuspected) return;
      core.state.restartSuspected = true;
      publish(core);
    },
    stop: () => stop(core),
    state: () => ({ ...core.state }),
  };
}
