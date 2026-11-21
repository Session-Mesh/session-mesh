// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHumanInputLease, createHumanInputScope} from '../static/pane-actions.ts';

test('disposing a clean lease invalidates only its own claim without changing the shared revision', () => {
  const scope = createHumanInputScope(), writes: number[][] = [];
  const make = (clientId: string) => createHumanInputLease({clientId, scope,
    control() {}, data(bytes) {writes.push([...bytes]);}});
  const first = make('first'), second = make('second');
  const oldClaim = first.claim(), currentClaim = second.claim();
  assert.ok(oldClaim && currentClaim);
  const revision = scope.revision;
  first.dispose();
  assert.equal(oldClaim.valid(), false);
  assert.equal(oldClaim.write(Uint8Array.of(65)), false);
  assert.equal(scope.revision, revision);
  assert.equal(currentClaim.valid(), true);
  assert.deepEqual(writes, []);
  second.dispose();
});

test('accepted unfinished D stays locally dirty when advisory acquisition fails from clean state', () => {
  const events: (boolean | number[])[] = [];
  const lease = createHumanInputLease({clientId: 'human', control(_id, dirty) {
    events.push(dirty); if (dirty) throw Error('optional H unavailable');
  }, data(bytes) {events.push([...bytes]);}});
  assert.equal(lease.write(Uint8Array.of(97)), true);
  assert.equal(lease.dirty, true); assert.equal(lease.inputDirty, true); assert.equal(lease.claim(), null);
  assert.equal(lease.atomic(Uint8Array.of(13)), true);
  assert.equal(lease.dirty, false);
  assert.deepEqual(events, [true, [97], [13], false]);
});

test('retired deferred input writes on its original transport before releasing the queue barrier', () => {
  const scope = createHumanInputScope(), frames: number[][] = [];
  const lease = createHumanInputLease({clientId: 'original', scope, control() {}, data(bytes) {frames.push([...bytes]);}});
  const input = lease.defer(Uint8Array.of(13), true);
  lease.retire();
  assert.equal(lease.inputDirty, true);
  assert.equal(input.flush(), true);
  assert.deepEqual(frames, [[13]]);
  assert.equal(lease.inputDirty, false);
  assert.equal(scope.adopt({control() {}, data() {throw Error('retired clean lease must be gone');}}), null);
});

test('a failed clean H after completed D retries only H(false) after reconnect', () => {
  const controls: boolean[] = [], frames: number[][] = [];
  let fail = true;
  const lease = createHumanInputLease({clientId: 'human', control(_id, dirty) {
    controls.push(dirty); if (!dirty && fail) throw Error('one lost release');
  }, data(bytes) {frames.push([...bytes]);}});
  assert.equal(lease.atomic(Uint8Array.of(13)), true);
  assert.equal(lease.dirty, true, 'the advisory barrier stays held until its clean release can be retried');
  assert.equal(lease.releasePending, true);
  fail = false; lease.reconnect();
  assert.equal(lease.dirty, false); assert.equal(lease.releasePending, false);
  assert.deepEqual(controls, [true, false, false]);
  assert.deepEqual(frames, [[13]], 'reconnect must not replay completed D');
});

test('actual D failure remains dirty and reconnect advertises H(true)', () => {
  const controls: boolean[] = [];
  const lease = createHumanInputLease({clientId: 'human', control(_id, dirty) {controls.push(dirty);},
    data() {throw Error('D failed');}});
  assert.equal(lease.atomic(Uint8Array.of(13)), false);
  assert.equal(lease.dirty, true); lease.reconnect();
  assert.deepEqual(controls, [true, true]);
});

test('a retired lease with a pending clean release is adopted for H retry without D replay', () => {
  const scope = createHumanInputScope(), controls: boolean[] = [];
  let writes = 0;
  const lease = createHumanInputLease({clientId: 'human', scope, control(_id, dirty) {if (!dirty) throw Error('lost clean release');}, data() {writes++;}});
  const release = lease.retain();
  assert.equal(lease.atomic(Uint8Array.of(13)), true);
  lease.retire(); release();
  assert.equal(lease.releasePending, true); assert.equal(lease.dirty, true);
  assert.equal(scope.adopt({control(_id, dirty) {controls.push(dirty);}, data() {throw Error('D must never replay');}}), lease);
  lease.reconnect(); assert.equal(lease.releasePending, false);
  assert.deepEqual(controls, [false]); assert.equal(writes, 1);
});

for (const failReassert of [false, true]) test(`new human input reasserts H(true) after an uncertain clean release (${failReassert ? 'advisory failure' : 'success'})`, () => {
  const events: (boolean | number[])[] = [];
  let acquisitions = 0;
  const lease = createHumanInputLease({clientId: 'human', control(_id, dirty) {
    events.push(dirty);
    if (!dirty) throw Error('H(false) may have reached the host');
    if (++acquisitions === 2 && failReassert) throw Error('uncertain advisory acquisition');
  }, data(bytes) {events.push([...bytes]);}});
  assert.equal(lease.atomic(Uint8Array.of(13)), true);
  assert.equal(lease.releasePending, true);
  assert.equal(lease.write(Uint8Array.of(120)), true);
  assert.deepEqual(events, [true, [13], false, true, [120]], 'reacquire the host barrier before new incomplete D');
  assert.equal(lease.dirty, true); assert.equal(lease.releasePending, false);
  lease.reconnect();
  assert.deepEqual(events.at(-1), true, 'the newer unfinished line must stay dirty without any D replay');
});
