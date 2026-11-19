// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A phone line typed before the session list has named the pane's session (static/held-line.ts,
// used by sendLine in static/app.js): it waits for listings, bounded and cancellable, and is never
// captured for a pane that changed session or stopped being the active one during the wait.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {holdLineForTarget, type HeldLinePorts} from '../static/held-line.ts';

type Timer = {at: number; run: () => void; cleared: boolean};
function fakeClock() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    timers: {
      setTimeout: (run: () => void, ms: number) => { const timer = {at: now + ms, run, cleared: false}; timers.push(timer); return timer; },
      clearTimeout: (handle: unknown) => { (handle as Timer).cleared = true; },
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => !timer.cleared && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; next.cleared = true; next.run();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

type World = {listed: boolean; provisional: boolean; same: boolean; listings: number; release: (() => void) | null};
function ports(world: World, clock: ReturnType<typeof fakeClock>, instant = true): HeldLinePorts<string> {
  return {
    capture: () => (world.listed && world.same ? 'target' : null),
    waiting: () => world.provisional,
    same: () => world.same,
    listed: () => {
      world.listings += 1;
      if (instant) return Promise.resolve();
      return new Promise<void>((resolve) => { world.release = resolve; });
    },
    timers: clock.timers, limitMs: 5000, pauseMs: 250,
  };
}
const world = (over: Partial<World> = {}): World => ({listed: false, provisional: true, same: true, listings: 0, release: null, ...over});

test('captured at once: no wait and no listing asked for', async () => {
  const clock = fakeClock(), state = world({listed: true});
  const held = holdLineForTarget(ports(state, clock));
  assert.equal(held.waits, false);
  assert.deepEqual(await held.settled, {kind: 'target', target: 'target'});
  assert.equal(state.listings, 0);
});

test('a pane the listing already settled without a target: missing at once', async () => {
  const held = holdLineForTarget(ports(world({provisional: false}), fakeClock()));
  assert.equal(held.waits, false);
  assert.deepEqual(await held.settled, {kind: 'missing'});
});

test('the pane changed session during the wait: nothing is captured for the new one', async () => {
  const clock = fakeClock(), state = world();
  const held = holdLineForTarget(ports(state, clock, false));
  assert.equal(held.waits, true);
  state.same = false;            // the owner opened another session in the pane
  state.listed = true;           // and the listing then names the pane: capture would succeed
  state.release?.();
  await clock.advance(250);
  assert.deepEqual(await held.settled, {kind: 'moved'});
});

test('Cancel ends the wait at once and nothing is captured afterwards', async () => {
  const clock = fakeClock(), state = world();
  const held = holdLineForTarget(ports(state, clock, false));
  assert.equal(held.cancel(), true);
  assert.deepEqual(await held.settled, {kind: 'cancelled'});
  state.listed = true; state.release?.();
  await clock.advance(10_000);
  assert.equal(held.cancel(), false);
});

test('a listing that never comes: late after the bound, text kept by the caller', async () => {
  const clock = fakeClock(), state = world();
  const held = holdLineForTarget(ports(state, clock, false));
  let end: unknown = null;
  void held.settled.then((value) => { end = value; });
  await clock.advance(4999);
  assert.equal(end, null);
  await clock.advance(1);
  assert.deepEqual(end, {kind: 'late'});
});

test('an incomplete listing first (pane still provisional), the next one names it', async () => {
  const clock = fakeClock(), state = world();
  const held = holdLineForTarget(ports(state, clock, false));
  state.release?.();             // the skeleton: applied, but the pane stays provisional
  await clock.advance(250);
  assert.equal(state.listings, 2);
  state.listed = true; state.release?.();
  await clock.advance(250);
  assert.deepEqual(await held.settled, {kind: 'target', target: 'target'});
});

test('a listing that settles the pane without naming it: missing, no further request', async () => {
  const clock = fakeClock(), state = world();
  const held = holdLineForTarget(ports(state, clock, false));
  state.provisional = false; state.release?.();
  await clock.advance(250);
  assert.deepEqual(await held.settled, {kind: 'missing'});
  assert.equal(state.listings, 1);
});

test('fast failing listings are asked for at most once per pause', async () => {
  const clock = fakeClock(), state = world();
  const held = holdLineForTarget({...ports(state, clock), listed: () => { state.listings += 1; return Promise.reject(new Error('503')); }});
  await clock.advance(1000);
  assert.ok(state.listings <= 5, `listings: ${state.listings}`);
  await clock.advance(4000);
  assert.deepEqual(await held.settled, {kind: 'late'});
});
