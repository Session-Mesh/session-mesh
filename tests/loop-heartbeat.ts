// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Whether a server's event loop keeps answering while a load runs. A probe process sends an
// unauthenticated request every 20 ms, which the server refuses on its event loop: a probe's round trip
// includes the time the loop was held.
//
// The rule comes from measurements of tests/sessions-state.test.ts. On a busy machine a few probes are
// slow and the rest are not: on CI the worst probe was 47 to 190 ms; locally, with twice as many busy
// processes as cores, 4 to 6 probes in 130 to 150 were over 50 ms, the worst 95 to 213 ms, and one probe
// in ten waited 23 to 32 ms or more. With the listing run on the event loop instead of a worker (the
// regression this guards against), the loop is held at every round: 18 to 24 probes in 110 were over
// 50 ms and one in ten waited 118 to 136 ms or more; a loop held once per window held a probe 450 to 620 ms.
// A window is stalled when a probe waited STALL_MS or more, or when one probe in ten waited BUSY_P90_MS or
// more. A stalled window is measured once more, and only two stalled windows in a row fail: a busy moment
// of the machine passes, a loop held at every round stalls every window. A probe that waited FREEZE_MS or
// more fails at once, without a second window: the slowest probe seen without the regression waited
// 397 ms (20 runs in parallel with 32 busy processes on 32 threads), so a freeze that long is not noise.
//
// Limits: a probe arrives while a hold is under way and waits less than the hold, so a bound of N ms
// catches holds from about N + 20 ms. Holds shorter than about 420 ms pass unless one probe in ten is
// slowed by 60 ms or more; holds from about 420 ms to about 1.5 s pass when only one window sees them.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

export const STALL_MS = Number(process.env.MESH_TEST_LOOP_STALL_MS || 400);
export const BUSY_P90_MS = 60;
export const FREEZE_MS = 1500;

const PROBE = `
  const lags = []; const end = performance.now() + Number(process.argv[2]);
  (async () => {
    while (performance.now() < end) {
      const sent = performance.now();
      if ((await fetch(process.argv[1])).status !== 401) process.exit(2);
      lags.push(performance.now() - sent);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    console.log(JSON.stringify(lags));
  })();`;

/** The probes' round trips in ms, over `windowMs`, while `load` runs until the time (performance.now())
 * it is given. The probes run in a process of their own: the caller decoding answers does not delay them. */
export async function heartbeat(url: string, windowMs: number, load: (end: number) => Promise<void>): Promise<number[]> {
  const probe = spawn(process.execPath, ['-e', PROBE, url, String(windowMs)], {stdio: ['ignore', 'pipe', 'inherit']});
  let output = '';
  probe.stdout!.on('data', chunk => { output += chunk; });
  const closed = new Promise<number | null>(resolve => probe.on('close', resolve));
  await load(performance.now() + windowMs);
  assert.equal(await closed, 0, 'every probe was refused with 401');
  const lags = JSON.parse(output) as number[];
  assert.ok(lags.length >= windowMs / 200, `${lags.length} probes in ${windowMs} ms`);
  return lags;
}

export type Window = {probes: number; p90: number; worst: number; stalled: string | null};

/** A window's figures, and why it counts as stalled (null: it does not). */
export function judge(lags: number[], stallMs = STALL_MS): Window {
  const sorted = [...lags].sort((a, b) => a - b);
  const p90 = Math.round(sorted[Math.floor(0.9 * (sorted.length - 1))]!);
  const worst = Math.round(sorted.at(-1)!);
  const stalled = worst >= stallMs ? `a probe waited ${worst} ms (bound ${stallMs} ms)`
    : p90 >= BUSY_P90_MS ? `one probe in ten waited ${p90} ms or more (bound ${BUSY_P90_MS} ms)` : null;
  return {probes: lags.length, p90, worst, stalled};
}

/** Fails when a probe waited FREEZE_MS or more, or when a window of load is stalled and so is the next
 * one; else the windows measured. */
export async function assertLoopAnswers(url: string, windowMs: number, load: (end: number) => Promise<void>,
  stallMs = STALL_MS): Promise<Window[]> {
  const windows: Window[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const window = judge(await heartbeat(url, windowMs, load), stallMs);
    windows.push(window);
    console.log(`heartbeat: ${window.probes} probes, p90 ${window.p90} ms, worst ${window.worst} ms`
      + (window.stalled ? `: stalled, ${window.stalled}` : ''));
    if (window.worst >= FREEZE_MS) assert.fail(`the event loop froze: a probe waited ${window.worst} ms (bound ${FREEZE_MS} ms)`);
    if (!window.stalled) return windows;
  }
  assert.fail(`the event loop stalled: ${windows.map(window => window.stalled).join('; then ')}`);
}
