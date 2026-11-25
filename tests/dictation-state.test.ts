// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRetainedLifetime} from '../static/dictation.ts';
import {createHumanInputLease, createHumanInputScope, createDictationModeObserver, createTerminalInputOrigin} from '../static/pane-actions.ts';
test('retaining an original channel outlives view, last release closes; force wins', () => {
  let closed = 0; const life = createRetainedLifetime(() => closed++);
  const release = life.retain(); life.detach(); assert.equal(closed, 0);
  release!(); release!(); assert.equal(closed, 1);
  const other = createRetainedLifetime(() => closed++); const late = other.retain();
  other.dispose(); late!(); assert.equal(closed, 2); assert.equal(other.retain(), null);
});
test('bound native transport preserves original client identity and shared dirty bit', () => {
  const normal: unknown[] = [], original: unknown[] = [];
  const lease = createHumanInputLease({clientId: 'same-client', control: (id, dirty) => normal.push([id, dirty]),
    data: bytes => normal.push(bytes)});
  const bound = {control: (id: string, dirty: boolean) => original.push([id, dirty]), data: (bytes: Uint8Array) => original.push(bytes)};
  lease.reconnect(); lease.write(new Uint8Array([1]), false, bound); assert.equal(lease.dirty, true);
  lease.write(new Uint8Array([13]), true, bound); assert.equal(lease.dirty, false);
  assert.deepEqual(original.filter(Array.isArray), [['same-client', true], ['same-client', false]]);
  assert.deepEqual(normal, [['same-client', false]]);
});

test('original mode observer is chunk-safe, handles string escapes/reset and bounded numeric parameter lists', () => {
  const context = {exports: {} as any, module: {exports: {} as any}, self: {}, process, setTimeout, clearTimeout};
  vm.runInNewContext(readFileSync('static/vendor/xterm.min.js', 'utf8'), context);
  const Terminal = context.exports.Terminal || context.module.exports.Terminal;
  const terminal = new Terminal();
  const mode = createDictationModeObserver(false, terminal), bytes = (text: string) => mode.bytes(new TextEncoder().encode(text));
  terminal.dispose();
  bytes('\x1b[?20'); bytes('04h'); assert.equal(mode.value, true);
  bytes('\x1b]title \x1b[?2004l\x07'); assert.equal(mode.value, false);
  bytes('\x1bPignored \x1b[?2004h\x1b\\'); assert.equal(mode.value, true);
  bytes('\x1bc'); assert.equal(mode.value, false);
  for (const char of '\x1b[?' + '1;'.repeat(2000) + '2004h') bytes(char);
  assert.equal(mode.value, false);
  mode.dispose();
});
test('native attempt detects even a completed foreign write on another lease', () => {
  const scope = createHumanInputScope(), controls: unknown[] = [];
  const transport = {control: (id: string, dirty: boolean) => controls.push([id, dirty]), data() {}};
  const a = createHumanInputLease({clientId: 'A', scope, ...transport});
  const b = createHumanInputLease({clientId: 'B', scope, ...transport});
  const attempt = a.claim()!; assert.equal(attempt.valid(), true);
  assert.equal(attempt.write(new Uint8Array([97]), false, transport), true);
  assert.equal(attempt.valid(), true); assert.equal(a.dirty, true);
  b.write(new Uint8Array([13]), true); assert.equal(b.dirty, false);
  assert.equal(attempt.valid(), false);
  assert.equal(attempt.write(new Uint8Array([13]), true, transport), false);
  assert.equal(a.dirty, true, 'voice must not complete dirty human input');
  assert.equal(a.revision, b.revision); assert.equal(b.claim(), null);
});

test('own native frames advance the token; failed/foreign attempts cannot release the dirty bit', () => {
  const scope = createHumanInputScope(), controls: unknown[] = [];
  const transport = {control: (id: string, dirty: boolean) => controls.push([id, dirty]), data() {}};
  const lease = createHumanInputLease({clientId: 'same-client', scope, ...transport}), attempt = lease.claim()!;
  assert.equal(attempt.write(new Uint8Array([97]), false, transport), true);
  assert.equal(attempt.write(new Uint8Array([13]), true, transport), true);
  assert.deepEqual(controls, [['same-client', true], ['same-client', false]]); assert.equal(lease.dirty, false);
  const pending = lease.claim()!;
  lease.write(new Uint8Array([98]), false, {...transport, data() {throw Error('uncertain');}});
  assert.equal(pending.valid(), false); assert.equal(lease.dirty, true);
});

test('clean lease observations retire only after their retained reference releases', () => {
  let empty = 0; const scope = createHumanInputScope(() => empty++);
  const lease = createHumanInputLease({clientId: 'original', scope, control() {}, data() {}});
  const release = lease.retain(); lease.retire(); assert.equal(empty, 0);
  release(); release(); assert.equal(empty, 1); assert.equal(lease.claim(), null);
  assert.equal(scope.dirty, false);
});

test('unsupported parser/origin shapes fail conservatively', () => {
  const mode = createDictationModeObserver(false, {}); assert.equal(mode.valid, false);
  mode.bytes(new Uint8Array([27, 91, 63, 50, 48, 48, 52, 104])); assert.equal(mode.value, false);
  const origin = createTerminalInputOrigin({}); assert.equal(origin.consume(), true); origin.dispose();
  const frozen = createTerminalInputOrigin({onUserInput: () => ({dispose() {}})}, Object.freeze({parse() {}}));
  assert.equal(frozen.consume(), true); frozen.dispose();
  const invalidSignal = createTerminalInputOrigin({onUserInput: () => ({})} as any, {parse() {}});
  assert.equal(invalidSignal.consume(), true); invalidSignal.dispose();
});
