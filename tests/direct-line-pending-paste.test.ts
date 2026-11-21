// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
import {directInput} from '../static/direct-line.ts';

const source = fs.readFileSync('static/app.js', 'utf8');
function section(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function fixture(text = 'draft') {
  const raw: string[] = [], pasted: string[] = [];
  const state = {refuse: false};
  const connection = {terminal: {isOpen: () => true}, queuedHumanInput: [{}]};
  const context = vm.createContext({line: {value: text}, lineDirect: {pane: {conn: connection,
    term: {modes: {bracketedPasteMode: true}}, sendRaw(bytes: Uint8Array) {
      raw.push(new TextDecoder().decode(bytes)); return true;
    }}}, lineComposing: false, directInputCount: 0, ctrlArmed: false, enc: new TextEncoder(),
    MeshPaneActions: {directInput}, directLineAlive: () => true, fitLine() {}, flash() {}, t: (key: string) => key,
    reportDirect() {}, sendDirectControl() {assert.fail('unexpected control');},
    paneTargets: {capture: () => ({}), release() {}},
    paneInput: {capture: () => ({}), deliver(_binding: unknown, value: string, _enter: boolean, complete: (result: {kind: string}) => void) {
      if (!state.refuse) pasted.push(value);
      complete({kind: state.refuse ? 'refused' : 'paste'});
    }}, endDirectLine() {context.lineDirect = null;}, sendLine() {assert.fail('unexpected ordinary line');}});
  vm.runInContext([
    section('function writeDirect(', '// Ctrl armed:'),
    section('function flushDirectField(', '// The field changed'),
    section('function deliverHeldDirectText()', '// The one way a key'),
    section('function submitDirectLine()', 'async function pasteClipboardDirect()'),
  ].join('\n'), context);
  return {context, connection, raw, pasted, state};
}

for (const type of ['insertFromPaste', 'insertFromDrop', 'insertTranscription', '']) {
  test(`held ${type || 'unknown'} text remains a paste when Enter follows queue completion`, () => {
    const f = fixture();
    assert.equal(f.context.flushDirectField(type), false);
    assert.equal(f.context.line.value, 'draft');
    f.connection.queuedHumanInput.length = 0;
    f.context.enterLine();
    assert.deepEqual(f.pasted, ['draft']);
    assert.deepEqual(f.raw, ['\r']);
    assert.equal(f.context.line.value, '');
  });
}

test('a held paste that is still refused keeps its text and never sends Enter', () => {
  const f = fixture();
  f.context.flushDirectField('insertFromPaste');
  f.connection.queuedHumanInput.length = 0; f.state.refuse = true;
  f.context.enterLine();
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
  assert.equal(f.context.line.value, 'draft');
});

test('a held multiline paste without bracketed mode keeps its text and never sends Enter', () => {
  const f = fixture('first\nsecond');
  f.context.flushDirectField('insertFromPaste');
  f.connection.queuedHumanInput.length = 0;
  f.context.lineDirect.pane.term.modes.bracketedPasteMode = false;
  f.context.enterLine();
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
  assert.equal(f.context.line.value, 'first\nsecond');
});

test('emptying a held paste clears its provenance before new typed text', () => {
  const f = fixture();
  f.context.flushDirectField('insertFromPaste');
  f.context.line.value = ''; f.context.flushDirectField('deleteContentBackward');
  f.connection.queuedHumanInput.length = 0;
  f.context.line.value = 'typed'; f.context.enterLine();
  assert.deepEqual(f.raw, ['typed', '\r']); assert.deepEqual(f.pasted, []);
});
