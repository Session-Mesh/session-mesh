// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import {createAcknowledgedInput, createHumanInputLease, createPasteDelivery, createTerminalInputOrigin, terminalReportsOnly} from '../static/pane-actions.ts';

const source = fs.readFileSync('static/app.js', 'utf8');
const start = source.indexOf('  async pasteClipboard() {');
const end = source.indexOf('  filesIn(files)', start);
assert.ok(start >= 0 && end > start);

function fixture(bound = true, acknowledged?: 1 | 2) {
  const state = {bound, effects: true, visible: true, reads: 0, pasted: [] as string[],
    writes: [] as string[], messages: [] as string[], released: 0, rawAttempts: 0};
  const resolves: ((text: string) => void)[] = [];
  let reject!: (error: Error) => void;
  const terminal = {isOpen: () => true, isBound: () => state.bound};
  const module = {exports: {} as any};
  const xterm = vm.createContext({module, exports: module.exports, self: {}, process, setTimeout, clearTimeout});
  vm.runInContext(fs.readFileSync('static/vendor/xterm.min.js', 'utf8'), xterm);
  const term = new module.exports.Terminal();
  term._core.textarea = {value: '', addEventListener() {}};
  const context = vm.createContext({navigator: {clipboard: {readText() {
    state.reads++; return new Promise<string>((done, fail) => {resolves.push(done); reject = fail;});
  }}}, localMeshEffectsAllowed: () => state.effects, t: (key: string) => key,
  flash: (text: string) => state.messages.push(text), enc: new TextEncoder(), ctrlArmed: false,
  completesInput: () => false, composeOwner: null, cdlg: {open: false},
  observePaneActions() {}, MeshPaneActions: {createPasteDelivery, createTerminalInputOrigin, terminalReportsOnly},
  paneTargets: {capture: () => ({}), valid: () => true, release: () => {state.released++;}},
  localTerminalSocketReady: () => true, setTimeout});
  const wire = source.slice(source.indexOf('  wire() {'), source.indexOf('    // file paths of viewable documents'));
  const queue = source.slice(source.indexOf('  cancelReplayInput(c)'), source.indexOf('  inputLeaseFor(name)'));
  vm.runInContext(`class Pane {${wire}\n}\n${queue}\n${source.slice(start, end)}};globalThis.pane = new Pane();`, context);
  vm.runInContext(source.slice(source.indexOf('const paneInput = '), source.indexOf('const paneMenuHolds = '))
    + ';globalThis.paneInput = paneInput;', context);
  const pane = context.pane;
  Object.assign(pane, {id: 'A', actionView: 1, actionDisposed: false, term,
    termEl: {hidden: false, getClientRects: () => state.visible ? [{}] : []},
    conn: {name: 'A', created: 1, ws: {}, terminal, closed: false, ended: false},
    wireReplayInput() {}, filterFocusReport: () => false, renderRetainedInput() {}});
  pane.inputLease = createHumanInputLease({clientId: 'clipboard', control() {},
    data(bytes) {
      if (acknowledged) {state.rawAttempts++; throw Error('input_ack_raw_disabled');}
      state.writes.push(new TextDecoder().decode(bytes));
    }});
  if (acknowledged) {
    const input = createAcknowledgedInput({version: acknowledged, attachmentId: 'clipboard', created: 1,
      send(frame) {state.writes.push(new TextDecoder().decode(frame.subarray(4)));}, state() {}});
    if (acknowledged === 1) input.connect(1, 'clipboard', true);
    else assert.equal(input.connectV2(1, 0, 1, 'a'.repeat(32), true), true);
    pane.inputAck = input;
    pane.inputAcks = new Map([['A\0' + 1, {input}]]);
  }
  const paste = term.paste.bind(term);
  term.paste = (text: string) => {state.pasted.push(text); paste(text);};
  pane.wire();
  return {pane, state, begin: () => pane.pasteClipboard() as Promise<void>,
    finish: (index = 0, text = 'clipboard sample') => resolves[index]?.(text),
    fail: () => reject(Error('clipboard denied'))};
}

test('a clipboard read pastes once into the unchanged verified attachment', async () => {
  const f = fixture(), pending = f.begin();
  f.finish(); await pending;
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.state.pasted, ['clipboard sample']);
});

for (const version of [1, 2] as const) {
  for (const bracketed of [false, true]) test(`idle ACK v${version} clipboard uses acknowledged input with bracketed paste ${bracketed}`, async () => {
    const f = fixture(true, version);
    await new Promise<void>(done => f.pane.term.write(`\x1b[?2004${bracketed ? 'h' : 'l'}`, done));
    const pending = f.begin(); f.finish(0, 'first\nsecond'); await pending;
    const expected = bracketed ? '\x1b[200~first\rsecond\x1b[201~' : 'first\rsecond';
    assert.deepEqual(f.state.pasted, ['first\nsecond']);
    assert.deepEqual(f.state.writes, [expected]);
    assert.equal(f.state.rawAttempts, 0);
    assert.equal(f.pane.inputAck.retainedText, expected);
    assert.equal(f.pane.conn.activeHumanInput, null);
    assert.equal(f.pane.conn.queuedHumanInput.length, 0);
  });
  test(`idle ACK v${version} refused clipboard leaves a clean lease`, async () => {
    const f = fixture(true, version);
    if (version === 1) f.pane.inputAck.connect(2, 'clipboard', true);
    else f.pane.inputAck.reject();
    const pending = f.begin(); f.finish(); await pending;
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.state.rawAttempts, 0);
    assert.equal(f.pane.inputLease.dirty, false);
    assert.equal(f.pane.conn.activeHumanInput, null);
    assert.equal(f.pane.conn.queuedHumanInput.length, 0);
  });
}

const changes: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  incarnation: f => {f.pane.conn = {...f.pane.conn, created: 2};},
  'in-place identity': f => {f.pane.conn.created = 2;},
  socket: f => {f.pane.conn.ws = {};},
  view: f => {f.pane.actionView++;},
  name: f => {f.pane.id = 'B';},
  terminal: f => {f.pane.term = {paste: text => f.state.pasted.push(text)};},
  closed: f => {f.pane.conn.closed = true;},
  ended: f => {f.pane.conn.ended = true;},
  disposed: f => {f.pane.actionDisposed = true;},
  hidden: f => {f.pane.termEl.hidden = true;},
  'workspace tab visibility': f => {f.state.visible = false;},
  suspended: f => {f.state.effects = false;},
  unbound: f => {f.state.bound = false;},
};
for (const [name, change] of Object.entries(changes)) test(`a pending clipboard read is discarded after ${name} changes`, async () => {
  const f = fixture(), pending = f.begin();
  change(f); f.finish(); await pending;
  assert.deepEqual(f.state.pasted, []);
});

test('an unverified attachment does not request clipboard contents', async () => {
  const f = fixture(false), pending = f.begin();
  f.finish(); await pending;
  assert.equal(f.state.reads, 0);
  assert.deepEqual(f.state.pasted, []);
  assert.deepEqual(f.state.messages, ['terminal.limitedInput']);
});

for (const phase of ['replaying', 'draining', 'replayPending']) {
  for (const readyFirst of [false, true]) test(`clipboard reserves FIFO before reading; ${phase}, read ${readyFirst ? 'before' : 'after'} replay ends`, async () => {
    const f = fixture(), pending = f.begin();
    f.pane.conn[phase] = true;
    // sendRaw is also the path used for a human key accepted during replay.
    f.pane.sendRaw(new TextEncoder().encode('later'));
    if (readyFirst) {f.finish(); await Promise.resolve();}
    else {f.pane.conn[phase] = false; f.pane.flushReplayInput(f.pane.conn);}
    assert.deepEqual(f.state.writes, [], 'neither the paste nor later keys may overtake the barrier');
    f.pane.conn[phase] = false;
    if (!readyFirst) f.finish();
    f.pane.flushReplayInput(f.pane.conn);
    await pending;
    assert.deepEqual(f.state.pasted, ['clipboard sample']);
    assert.deepEqual(f.state.writes, ['clipboard sample', 'later']);
    assert.equal(f.state.released, 1);
    assert.equal(f.pane.conn.activeHumanInput, null);
    assert.equal(f.pane.conn.queuedHumanInput.length, 0);
  });

  for (const bracketed of [false, true]) test(`clipboard uses normalized text and final bracketed-paste mode after ${phase} (${bracketed ? 'enabled' : 'disabled'})`, async () => {
    const f = fixture(), text = 'A\nB\r\nC\rD';
    const mode = (enabled: boolean) => new Promise<void>(done =>
      f.pane.term.write(`\x1b[?2004${enabled ? 'h' : 'l'}`, done));
    await mode(!bracketed);
    const pending = f.begin();
    f.pane.conn[phase] = true;
    f.pane.sendRaw(new TextEncoder().encode('later'));
    f.finish(0, text); await Promise.resolve();
    assert.deepEqual(f.state.writes, [], 'clipboard text must wait for output replay');
    // The mode at drain time controls framing, not the mode at the paste click.
    await mode(bracketed);
    assert.deepEqual(f.state.writes, []);
    f.pane.conn[phase] = false; f.pane.flushReplayInput(f.pane.conn);
    await pending;
    const normalized = 'A\rB\rC\rD';
    assert.deepEqual(f.state.pasted, [text], 'xterm receives the original clipboard text');
    assert.deepEqual(f.state.writes, [bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized, 'later'],
      'xterm normalizes and frames once, without adding Enter or overtaking the later key');
    f.pane.flushReplayInput(f.pane.conn);
    assert.equal(f.state.writes.length, 2, 'another drain cannot replay the paste');
    assert.equal(f.state.released, 1);
    assert.equal(f.pane.conn.activeHumanInput, null);
    assert.equal(f.pane.conn.queuedHumanInput.length, 0);
  });
}

for (const [name, change] of Object.entries(changes)) test(`queued clipboard refuses ${name} changes after the read resolves`, async () => {
  const f = fixture(), pending = f.begin();
  f.pane.conn.replaying = true;
  f.finish(); await Promise.resolve();
  const old = f.pane.conn;
  change(f);
  old.replaying = false; f.pane.flushReplayInput(old);
  await pending;
  assert.deepEqual(f.state.pasted, []);
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.state.released, 1);
});

for (const cancel of [false, true]) test(`${cancel ? 'cancelling' : 'denying'} clipboard read releases its queue barrier`, async () => {
  const f = fixture(), pending = f.begin();
  f.pane.sendRaw(new TextEncoder().encode('later'));
  assert.deepEqual(f.state.writes, []);
  if (cancel) {f.pane.conn.activeHumanInput.cancel(); f.finish();}
  else f.fail();
  await pending;
  assert.deepEqual(f.state.pasted, []);
  assert.deepEqual(f.state.writes, ['later']);
  assert.equal(f.state.released, 1);
  assert.equal(f.pane.conn.activeHumanInput, null);
  assert.equal(f.pane.conn.queuedHumanInput.length, 0);
  assert.deepEqual(f.state.messages, cancel ? [] : ['clipboard.pasteDenied']);
});

test('two clipboard permissions resolving in reverse order still paste in click order on the captured lease', async () => {
  const f = fixture(), first = f.begin(), second = f.begin();
  f.pane.sendRaw(new TextEncoder().encode('later'));
  const old = f.pane.inputLease;
  old.retire();
  f.pane.inputLease = createHumanInputLease({clientId: 'new', control() {},
    data() {throw Error('clipboard must retain its original transport');}});
  f.finish(1, 'second'); await Promise.resolve();
  assert.deepEqual(f.state.writes, []);
  f.finish(0, 'first'); await Promise.all([first, second]);
  assert.deepEqual(f.state.writes, ['first', 'second', 'later']);
  assert.equal(f.state.released, 2);
});
