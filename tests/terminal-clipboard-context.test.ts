// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import {createHumanInputLease, createPasteDelivery, createTerminalInputOrigin} from '../static/pane-actions.ts';

const source = fs.readFileSync('static/app.js', 'utf8');
const start = source.indexOf('  async pasteClipboard() {');
const end = source.indexOf('  filesIn(files)', start);
assert.ok(start >= 0 && end > start);

function fixture(bound = true) {
  const state = {bound, effects: true, visible: true, reads: 0, pasted: [] as string[],
    writes: [] as string[], messages: [] as string[], released: 0};
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
  observePaneActions() {}, MeshPaneActions: {createPasteDelivery, createTerminalInputOrigin},
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
    wireReplayInput() {}, filterFocusReport: () => false});
  pane.inputLease = createHumanInputLease({clientId: 'clipboard', control() {},
    data(bytes) {state.writes.push(new TextDecoder().decode(bytes));}});
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
