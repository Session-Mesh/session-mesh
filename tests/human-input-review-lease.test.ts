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

for (const anotherLease of [false, true]) test(`deferred completion preserves newer unfinished input on ${anotherLease ? 'another' : 'the same'} lease`, () => {
  const scope = createHumanInputScope(), events: (boolean | number[])[] = [];
  const make = (clientId: string) => createHumanInputLease({clientId, scope,
    control(_id, dirty) {events.push(dirty);}, data(bytes) {events.push([...bytes]);}});
  const lease = make('original');
  const deferred = lease.defer(Uint8Array.of(13), true);
  const newer = anotherLease ? make('newer') : lease;
  newer.write(Uint8Array.of(120));
  assert.equal(deferred.flush(), true, 'retained bytes still use their original transport');
  assert.equal(newer.dirty, true);
  assert.equal(scope.dirty, true);
  assert.equal(events.includes(false), false, 'an older completion cannot release newer unfinished input');
});

test('flushing an ordered deferred line and Enter releases its own completed input', () => {
  const events: (boolean | number[])[] = [];
  const lease = createHumanInputLease({clientId: 'original',
    control(_id, dirty) {events.push(dirty);}, data(bytes) {events.push([...bytes]);}});
  const line = lease.defer(Uint8Array.of(120), false), enter = lease.defer(Uint8Array.of(13), true);
  assert.equal(line.flush(), true);
  assert.equal(enter.flush(), true);
  assert.equal(lease.dirty, false, 'flushing earlier reservations is not newer human input');
  assert.deepEqual(events, [true, [120], [13], false]);
});

test('reserved chunks keep their original transport across rebinding and cannot write after cancellation', () => {
  const original: number[][] = [], replacement: number[][] = [];
  const lease = createHumanInputLease({clientId: 'original', control() {}, data(bytes) {original.push([...bytes]);}});
  const reserved = lease.defer(Uint8Array.of(120), false);
  lease.retire();
  lease.bind({control() {}, data(bytes) {replacement.push([...bytes]);}});
  assert.equal(reserved.write(Uint8Array.of(120), false), true);
  assert.equal(reserved.write(Uint8Array.of(13), true), true);
  reserved.cancel();
  assert.equal(reserved.write(Uint8Array.of(121), false), false);
  assert.equal(reserved.flush(), false);
  assert.deepEqual(original, [[120], [13]]);
  assert.deepEqual(replacement, []);
  assert.equal(lease.inputDirty, false);
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

test('cancelled later reservation does not keep an earlier completed input dirty', () => {
  const scope = createHumanInputScope(), events: (boolean | number[])[] = [];
  const lease = createHumanInputLease({clientId: 'human', scope,
    control(_id, dirty) {events.push(dirty);}, data(bytes) {events.push([...bytes]);}});
  assert.equal(lease.write(Uint8Array.of(97)), true);
  const enter = lease.defer(Uint8Array.of(13), true);
  const paste = lease.defer(Uint8Array.of(98), false);
  paste.cancel();
  assert.equal(enter.flush(), true);
  assert.deepEqual(events, [true, [97], [13], false]);
  assert.equal(lease.dirty, false);
});

test('cancelling the last reservation after Enter releases the completed input', () => {
  const controls: boolean[] = [], frames: number[][] = [];
  const lease = createHumanInputLease({clientId: 'human',
    control(_id, dirty) {controls.push(dirty);}, data(bytes) {frames.push([...bytes]);}});
  const enter = lease.defer(Uint8Array.of(13), true);
  const paste = lease.defer(Uint8Array.of(120), false);
  assert.equal(enter.flush(), true);
  assert.equal(lease.inputDirty, true);
  paste.cancel();
  assert.equal(lease.inputDirty, false);
  assert.deepEqual(controls, [true, false]);
  assert.deepEqual(frames, [[13]]);
});

test('cancelling a reservation never releases a later attempted write', () => {
  const controls: boolean[] = [];
  const lease = createHumanInputLease({clientId: 'human',
    control(_id, dirty) {controls.push(dirty);}, data() {}});
  const enter = lease.defer(Uint8Array.of(13), true);
  const paste = lease.defer(Uint8Array.of(120), false);
  assert.equal(enter.flush(), true);
  assert.equal(paste.write(Uint8Array.of(120), false), true);
  paste.cancel();
  assert.equal(lease.inputDirty, true);
  assert.deepEqual(controls, [true]);
});

test('cancelled reservation retries a failed release without replaying Enter', () => {
  const controls: boolean[] = [], frames: number[][] = [];
  let fail = true;
  const lease = createHumanInputLease({clientId: 'human',
    control(_id, dirty) {controls.push(dirty); if (!dirty && fail) throw Error('disconnected');},
    data(bytes) {frames.push([...bytes]);}});
  const enter = lease.defer(Uint8Array.of(13), true);
  const paste = lease.defer(Uint8Array.of(120), false);
  assert.equal(enter.flush(), true);
  paste.cancel();
  assert.equal(lease.releasePending, true);
  fail = false; lease.reconnect();
  assert.equal(lease.inputDirty, false);
  assert.deepEqual(controls, [true, false, false]);
  assert.deepEqual(frames, [[13]]);
});

test('reconnect acquisition is released when a later reservation is cancelled', () => {
  const controls: boolean[] = [];
  let fail = true;
  const lease = createHumanInputLease({clientId: 'human',
    control(_id, dirty) {if (dirty && fail) throw Error('disconnected'); controls.push(dirty);}, data() {}});
  const enter = lease.defer(Uint8Array.of(13), true);
  const paste = lease.defer(Uint8Array.of(120), false);
  assert.equal(enter.flush(), true);
  fail = false;
  lease.reconnect();
  paste.cancel();
  assert.deepEqual(controls, [true, false]);
  assert.equal(lease.inputDirty, false);
});

test('holding after deferred Enter survives cancellation of a later reservation', () => {
  const controls: boolean[] = [];
  const lease = createHumanInputLease({clientId: 'human',
    control(_id, dirty) {controls.push(dirty);}, data() {}});
  const enter = lease.defer(Uint8Array.of(13), true);
  const paste = lease.defer(Uint8Array.of(120), false);
  assert.equal(enter.flush(), true);
  lease.hold();
  paste.cancel();
  assert.equal(lease.inputDirty, true);
  assert.deepEqual(controls, [true]);
});

test('one completed lease releases independently of another lease input', () => {
  const scope = createHumanInputScope(), controls: string[] = [];
  const make = (clientId: string) => createHumanInputLease({clientId, scope,
    control(_id, dirty) {controls.push(`${clientId}:${dirty}`);}, data() {}});
  const a = make('a'), b = make('b');
  const enter = a.defer(Uint8Array.of(13), true);
  const paste = a.defer(Uint8Array.of(120), false);
  assert.equal(enter.flush(), true);
  assert.equal(b.write(Uint8Array.of(97)), true);
  paste.cancel();
  assert.equal(a.dirty, false);
  assert.equal(scope.dirty, true);
  assert.equal(b.atomic(Uint8Array.of(13)), true);
  assert.equal(scope.dirty, false);
  assert.deepEqual(controls, ['a:true', 'b:true', 'a:false', 'b:false']);
});

test("held acknowledged input blocks claims and retries only release after reconnect", () => {
  const events: boolean[] = [];
  let failRelease = true;
  const lease = createHumanInputLease({clientId: "actor", control(_id, dirty) {
    events.push(dirty);
    if (!dirty && failRelease) throw new Error("disconnected");
  }, data() { throw new Error("must not send data"); }});
  const oldClaim = lease.claim();
  assert.ok(oldClaim);
  lease.hold();
  assert.equal(oldClaim.valid(), false);
  assert.equal(lease.claim(), null);
  lease.release();
  assert.equal(lease.dirty, true);
  assert.equal(lease.releasePending, true);
  failRelease = false;
  lease.reconnect();
  assert.equal(lease.dirty, false);
  assert.equal(lease.releasePending, false);
  assert.deepEqual(events, [true, false, false]);
});
