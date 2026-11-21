// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('static/app.js', 'utf8');
const start = source.indexOf('  async pasteClipboard() {');
const end = source.indexOf('  filesIn(files)', start);
assert.ok(start >= 0 && end > start);

function fixture(bound = true) {
  const state = {bound, effects: true, reads: 0, pasted: [] as string[], messages: [] as string[]};
  let resolve!: (text: string) => void;
  const terminal = {isOpen: () => true, isBound: () => state.bound};
  const context = vm.createContext({navigator: {clipboard: {readText() {
    state.reads++; return new Promise<string>(done => {resolve = done;});
  }}}, localMeshEffectsAllowed: () => state.effects, t: (key: string) => key,
  flash: (text: string) => state.messages.push(text)});
  const paste = vm.runInContext(`({${source.slice(start, end)}}).pasteClipboard`, context) as (this: any) => Promise<void>;
  const pane = {id: 'A', actionView: 1, actionDisposed: false, termEl: {hidden: false},
    term: {paste: (text: string) => state.pasted.push(text)},
    conn: {name: 'A', created: 1, ws: {}, terminal, closed: false, ended: false}};
  return {pane, state, begin: () => paste.call(pane), finish: () => resolve?.('clipboard sample')};
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
