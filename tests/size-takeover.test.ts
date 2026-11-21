// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// When a browser takes the shared PTY size by itself (static/size-takeover.ts, bundled into
// pane-actions.js): in the automatic mode, on an activation by the person using this device,
// never from a timer, a resize or a page that merely stays visible; at most once per gap.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SIZE_TAKEOVER_KEY, TAKEOVER_GAP_MS, type TakeoverInput, shouldTakeSize, showsSizeBanner,
  sizeTakeoverMode} from '../static/size-takeover.ts';

const base: TakeoverInput = {mode: 'auto', owner: 'other', event: 'pointerdown', trusted: true,
  visible: true, focused: true, activated: true, now: 10_000, lastTake: null};
const take = (change: Partial<TakeoverInput>): boolean => shouldTakeSize({...base, ...change});

test('the stored preference: "manual" only on request, automatic otherwise', () => {
  assert.equal(SIZE_TAKEOVER_KEY, 'sizeTakeover');
  assert.equal(sizeTakeoverMode('manual'), 'manual');
  for (const stored of ['auto', undefined, null, true, 'Manual', 0, {}]) assert.equal(sizeTakeoverMode(stored), 'auto');
});

test('an input in the terminal takes the size from another device in the automatic mode', () => {
  for (const event of ['pointerdown', 'keydown', 'touchstart']) assert.equal(take({event}), true, event);
  assert.equal(take({event: 'keydown', focused: false}), true, 'a key or a touch is this device in use');
  assert.equal(take({event: 'touchstart', activated: false}), true, 'the event itself is the action');
});

test('the manual mode never takes by itself', () => {
  for (const event of ['pointerdown', 'keydown', 'touchstart', 'focus', 'visibilitychange'])
    assert.equal(take({mode: 'manual', event}), false, event);
});

test('nothing to take: this device owns the size, nobody does, or the host has no owner rule', () => {
  for (const owner of ['you', 'none', null] as const) assert.equal(take({owner}), false, String(owner));
});

test('a page that is hidden, or an event the page made up, takes nothing', () => {
  assert.equal(take({visible: false}), false);
  assert.equal(take({trusted: false}), false);
  assert.equal(take({event: 'visibilitychange', trusted: false}), false);
});

test('focus and the page shown again count only with the window focus, just after an action here', () => {
  for (const event of ['focus', 'visibilitychange']) {
    assert.equal(take({event}), true, event);
    assert.equal(take({event, focused: false}), false, `${event} without the window focus`);
    assert.equal(take({event, activated: false}), false, `${event} the page caused by itself (an agent's panel)`);
  }
});

test('a resize, a timer or any other event never takes the size', () => {
  for (const event of ['resize', 'timer', 'blur', 'scroll', 'wheel', 'pointermove', 'message', 'online', ''])
    assert.equal(take({event}), false, event);
});

test('at most once per gap: activations in quick succession take once', () => {
  assert.ok(TAKEOVER_GAP_MS >= 1000 && TAKEOVER_GAP_MS <= 5000, String(TAKEOVER_GAP_MS));
  assert.equal(take({lastTake: base.now - 1}), false);
  assert.equal(take({lastTake: base.now - TAKEOVER_GAP_MS + 1}), false);
  assert.equal(take({lastTake: base.now - TAKEOVER_GAP_MS}), true);
  assert.equal(take({lastTake: base.now - 60_000}), true);
});

test('the banner is shown in the manual mode only', () => {
  assert.equal(showsSizeBanner('manual', true), true);
  assert.equal(showsSizeBanner('manual', false), false);
  assert.equal(showsSizeBanner('auto', true), false);
  assert.equal(showsSizeBanner('auto', false), false);
});
