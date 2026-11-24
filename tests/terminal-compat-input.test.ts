// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {createHumanInputLease, createPasteDelivery, humanInputClientId} from '../static/pane-actions.ts';
import {sendsSize} from '../static/terminal-size-owner.ts';

test('wire lease ids isolate adjacent IEEE-754 incarnations without losing tab entropy or reconnect stability', () => {
  const tab = 'a'.repeat(32), name = 'n'.repeat(32);
  const first = humanInputClientId(tab, Number.MAX_SAFE_INTEGER, name, 1234567890);
  const second = humanInputClientId(tab, Number.MAX_SAFE_INTEGER, name, 1234567890.0000002);
  assert.equal(first.length, 94); assert.match(first, /^[A-Za-z0-9_.:-]{8,96}$/);
  assert.ok(first.startsWith(tab + '_')); assert.notEqual(first, second);
  assert.equal(first, humanInputClientId(tab, Number.MAX_SAFE_INTEGER, name, 1234567890));
  assert.notEqual(first, humanInputClientId(tab, Number.MAX_SAFE_INTEGER, name, null));
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => humanInputClientId(tab, 1, name, value));
  const leases = new Map<string, boolean>();
  const lease = (id: string) => createHumanInputLease({clientId: id,
    control: (key, dirty) => {leases.set(key, dirty);}, data() {}});
  const old = lease(first), fresh = lease(second);
  old.write(Uint8Array.of(97)); fresh.write(Uint8Array.of(98));
  old.atomic(Uint8Array.of(13));
  assert.equal(leases.get(first), false);
  assert.equal(leases.get(second), true, 'old H(false) cannot clear fresh H(true) on an unfenced host');
});

const app = fs.readFileSync('static/app.js', 'utf8');
test('all captured paste destinations reject an unverified transport, including delayed Enter after revocation', () => {
  const callbacks: (() => void)[] = [], wire: Uint8Array[] = [];
  let bound = false;
  const socket = {readyState: 1}, connection = {ws: socket, name: 'alpha', created: 1,
    terminal: {isBound: () => bound}};
  const pane = {conn: connection, inputLease: {write: (bytes: Uint8Array) => {wire.push(bytes); return true;}},
    deferReplayPaste: (_binding: unknown, _text: string, resume: () => void) => ({start: resume, settle() {}}),
    term: {paste: (text: string) => context.paneInput.onData(pane, text, () => {})}};
  const context = vm.createContext({MeshPaneActions: {createPasteDelivery}, paneTargets: {valid: () => true},
    localTerminalSocketReady: () => true, enc: new TextEncoder(), composeOwner: null,
    setTimeout: (fn: () => void) => {callbacks.push(fn);}, cdlg: {open: false}});
  vm.runInContext(app.slice(app.indexOf('const paneInput = '), app.indexOf('const paneMenuHolds = '))
    + ';globalThis.paneInput = paneInput;', context);
  const target = {kind: 'mesh', pane, name: 'alpha', created: 1};
  assert.equal(context.paneInput.capture(pane, target), null);
  bound = true;
  const captured = context.paneInput.capture(pane, target); assert.ok(captured);
  let result: any;
  context.paneInput.deliver(captured, 'KEPT-DRAFT', true, (value: unknown) => {result = value;});
  assert.equal(wire.length, 1);
  bound = false; callbacks.shift()!();
  assert.equal(wire.length, 1, 'no delayed Enter after losing verified transport');
  assert.notEqual(result.kind, 'submitted');
});

test('limited phone line and composer/picker refusals preserve their draft and explain why', async () => {
  const line = {value: 'KEPT-DRAFT'}, notices: string[] = [];
  const pane = {conn: {terminal: {limited: true}}};
  const context = vm.createContext({line, active: pane, linePending: null, lineRecovery: null,
    flash: (key: string) => {notices.push(key);}, t: (key: string) => key,
    localActionUnavailable: () => false});
  for (const [start, end] of [['async function sendLine()', 'function directBackspace()'],
    ['function openCompose(', 'function retireComposeOwner('],
    ['function captureTerminalDestination(', 'function releasePickerDestination(']])
    vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end)), context);
  await context.sendLine();
  assert.equal(context.openCompose('other draft'), false);
  assert.equal(context.captureTerminalDestination(pane), null);
  assert.equal(line.value, 'KEPT-DRAFT');
  assert.deepEqual(notices, Array(3).fill('terminal.limitedInput'));
});

test('unverified live keyboard I/O is immediate only; queued input is cancelled rather than flushed later', () => {
  const notices: string[] = [], sent: number[][] = [];
  const context = vm.createContext({localMeshEffectsAllowed: () => true, enc: new TextEncoder(),
    completesInput: () => false, flash: (key: string) => {notices.push(key);}, t: (key: string) => key});
  const methods = app.slice(app.indexOf('  sendRaw(bytes,'), app.indexOf('  inputLeaseFor(name)'));
  const flush = app.slice(app.indexOf('  flushReplayInput(c)'), app.indexOf('  deferReplayPaste('));
  vm.runInContext(`class Pane {${methods}\n${flush}};globalThis.pane = new Pane();`, context);
  const pane = context.pane;
  const c: any = {ws: {}, terminal: {isOpen: () => true, isBound: () => false}, replaying: false};
  pane.conn = c; pane.inputLease = {write: (bytes: Uint8Array) => {sent.push([...bytes]); return true;},
    defer() {throw Error('unverified transport must not reserve a deferred operation');}};
  assert.equal(pane.sendRaw(Uint8Array.of(97)), true);
  c.replaying = true;
  assert.equal(pane.sendRaw(Uint8Array.of(98)), false);
  let cancelled = false;
  c.queuedHumanInput = [{socket: c.ws, input: {cancel: () => {cancelled = true;}, flush() {throw Error('unsafe flush');}}}];
  c.replaying = false; pane.flushReplayInput(c);
  assert.equal(cancelled, true); assert.deepEqual(sent, [[97]]);
  assert.deepEqual(notices, ['terminal.limitedInput']);
});

test('limited output is admitted to the parser without granting automatic protocol replies', () => {
  let admit: (binding: unknown) => boolean = () => false, onData: (text: string) => void = () => {};
  let human = false;
  const sent: string[] = [];
  const terminal = {isOpen: () => true, isBound: () => false, queueInput() {throw Error('unverified automatic D');}};
  const connection = {name: 'alpha', created: 1, terminal};
  const binding = {connection, terminal, view: 1};
  const context = vm.createContext({localMeshEffectsAllowed: () => true, ctrlArmed: false,
    paneInput: {onData: (_pane: unknown, _data: string, ordinary: () => void) => ordinary()},
    MeshPaneActions: {createTerminalInputOrigin: (_core: unknown, _parser: unknown, admission: typeof admit) => {
      admit = admission; return {consume: () => human, target: () => binding};
    }}});
  const wire = app.slice(app.indexOf('  wire() {'), app.indexOf('    // file paths of viewable documents'));
  vm.runInContext(`class Pane {${wire}\n}};globalThis.pane = new Pane();`, context);
  const pane = context.pane;
  pane.conn = connection; pane.actionView = 1;
  pane.term = {_core: {}, onData: (callback: typeof onData) => {onData = callback;}};
  pane.wireReplayInput = () => {}; pane.filterFocusReport = () => false; pane.send = (text: string) => {sent.push(text);};
  pane.wire();
  assert.equal(admit(binding), true, 'rendering must not require automation authority');
  onData('\x1b[1;1R'); assert.deepEqual(sent, []);
  human = true; onData('x'); assert.deepEqual(sent, ['x']);
  human = false;
  Object.assign(connection, {closed: true});
  assert.equal(admit(binding), true, 'received output still renders after this socket closes');
  onData('\x1b[1;1R'); assert.deepEqual(sent, ['x'], 'closed output cannot send a terminal reply');
  pane.actionView++;
  assert.equal(admit(binding), false, 'output for a retired view never renders in its replacement');
});

for (const outcome of ['release', 'initial', 'reclaimed', 'changed']) test(`size ownership ${outcome} during replay is settled after refitting`, () => {
  const writes: unknown[] = [];
  const context = vm.createContext({localMeshEffectsAllowed: () => true, MeshPaneActions: {sendsSize}});
  const sizing = app.slice(app.indexOf('  sendSize(force'), app.indexOf('  // The size the pane\'s area fits'));
  const replay = app.slice(app.indexOf('  ownSize()'), app.indexOf('  // A socket\'s first frame'));
  vm.runInContext(`class Pane {${sizing}\n${replay}};globalThis.pane = new Pane();`, context);
  const pane = context.pane;
  pane.termEl = {hidden: false};
  pane.term = {rows: 37, cols: 101, resize(cols: number, rows: number) {this.cols = cols; this.rows = rows;}};
  pane.refit = () => {
    if (outcome === 'changed') {pane.term.rows = 25; pane.term.cols = 90;}
    pane.sendSize();
  };
  const c = pane.conn = {name: 'A', created: 1, replaySize: {rows: 24, cols: 80},
    lastSize: {rows: 24, cols: 80}, pty: {rows: 37, cols: 101, owner: 'none'},
    terminal: {isOpen: () => true, isBound: () => true,
      resize: (...args: unknown[]) => writes.push(args)}};
  pane.applyPtySize(c, outcome === 'initial');
  assert.deepEqual(writes, []);
  if (outcome === 'reclaimed') {c.pty.owner = 'other'; pane.applyPtySize(c);}
  pane.leaveReplayGeometry(c);
  assert.equal(writes.length, outcome === 'release' || outcome === 'changed' ? 1 : 0,
    'a deferred release claims unchanged dimensions, without duplicating an initial claim or taking another owner');
});
