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
  const state = {refuse: false, uncertain: false, writeRefuse: false};
  const connection = {terminal: {isOpen: () => true}, queuedHumanInput: [{}]};
  const context = vm.createContext({line: {value: text}, lineRecovery: null, lineDirect: {session: 'A', pane: {conn: connection,
    term: {modes: {bracketedPasteMode: true}}, sendRaw(bytes: Uint8Array) {
      if (state.writeRefuse) return false;
      raw.push(new TextDecoder().decode(bytes)); return true;
    }}}, lineComposing: false, directInputCount: 0, directFieldAttempt: 0, ctrlArmed: false, enc: new TextEncoder(),
    MeshPaneActions: {directInput}, directLineAlive: () => true, fitLine() {}, renderLineStatus() {}, flash() {}, t: (key: string) => key,
    reportDirect() {}, sendDirectControl() {assert.fail('unexpected control');},
    paneTargets: {capture: () => ({}), release() {}},
    paneInput: {capture: () => ({}), deliver(_binding: unknown, value: string, _enter: boolean, complete: (result: {kind: string}) => void) {
      if (state.uncertain) {complete({kind: 'uncertain'}); return;}
      if (!state.refuse) pasted.push(value);
      complete({kind: state.refuse ? 'refused' : 'paste'});
    }}, endDirectLine() {context.lineDirect = null;}, sendLine() {assert.fail('unexpected ordinary line');}});
  vm.runInContext([
    section('function writeDirect(', '// Ctrl armed:'),
    section('function recoverDirectText(', '// The field changed'),
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

test('a held paste that is still refused enters recovery and never sends Enter', () => {
  const f = fixture();
  f.context.flushDirectField('insertFromPaste');
  f.connection.queuedHumanInput.length = 0; f.state.refuse = true;
  f.context.enterLine();
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
  assert.equal(f.context.line.value, ''); assert.equal(f.context.lineRecovery.text, 'draft');
  assert.equal(f.context.lineRecovery.target.displayName, 'A');
  f.context.enterLine(); assert.deepEqual(f.raw, []);
});

test('a held multiline paste without bracketed mode keeps its text and never sends Enter', () => {
  const f = fixture('first\nsecond');
  f.context.flushDirectField('insertFromPaste');
  f.connection.queuedHumanInput.length = 0;
  f.context.lineDirect.pane.term.modes.bracketedPasteMode = false;
  f.context.enterLine();
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
  assert.equal(f.context.line.value, ''); assert.equal(f.context.lineRecovery.text, 'first\nsecond');
  f.context.enterLine(); assert.deepEqual(f.raw, []);
});

test('emptying a held paste clears its provenance before new typed text', () => {
  const f = fixture();
  f.context.flushDirectField('insertFromPaste');
  f.context.line.value = ''; f.context.flushDirectField('deleteContentBackward');
  f.connection.queuedHumanInput.length = 0;
  f.context.line.value = 'typed'; f.context.enterLine();
  assert.deepEqual(f.raw, ['typed', '\r']); assert.deepEqual(f.pasted, []);
});

for (const [type, text] of [
  ['insertReplacementText', 'the'], ['insertFromPaste', 'bad\x01'],
]) test(`a fresh semantic refusal goes to explicit recovery (${type}, ${JSON.stringify(text)})`, () => {
  const f = fixture(text);
  f.connection.queuedHumanInput.length = 0;
  f.context.lineDirect.pane.term.modes.bracketedPasteMode = false;
  assert.equal(f.context.flushDirectField(type, true), false);
  assert.equal(f.context.line.value, '');
  assert.equal(f.context.lineDirect, null);
  assert.equal(f.context.lineRecovery.text, text);
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
});

test('a fresh refused multiline paste is recovered for its original session', () => {
  const f = fixture('first\nsecond');
  f.connection.queuedHumanInput.length = 0;
  f.context.lineDirect.pane.term.modes.bracketedPasteMode = false;
  assert.equal(f.context.flushDirectField('insertFromPaste', true), false);
  assert.equal(f.context.line.value, '');
  assert.equal(f.context.lineRecovery.text, 'first\nsecond');
  assert.equal(f.context.lineRecovery.target.displayName, 'A');
  assert.equal(f.context.lineDirect, null);
  f.context.enterLine(); assert.deepEqual(f.raw, []);
});

test('a refused acknowledged typed frame is recovered and cannot become a new session line', () => {
  const f = fixture('typed');
  f.connection.queuedHumanInput.length = 0;
  f.context.lineDirect.pane.inputAck = {};
  f.state.writeRefuse = true;
  assert.equal(f.context.flushDirectField('insertText'), false);
  assert.equal(f.context.line.value, '');
  assert.equal(f.context.lineRecovery.text, 'typed');
  assert.equal(f.context.lineRecovery.target.displayName, 'A');
  f.context.enterLine(); assert.deepEqual(f.raw, []);
});

test('an uncertain held-paste attempt is not left available for an implicit retry', () => {
  const f = fixture();
  f.context.flushDirectField('insertFromPaste');
  f.connection.queuedHumanInput.length = 0; f.state.uncertain = true;
  f.context.enterLine();
  assert.equal(f.context.line.value, ''); assert.equal(f.context.lineDirect, null);
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
});

for (const retained of [false, true]) test(`control characters enter explicit recovery (${retained ? 'previously held' : 'new'})`, () => {
  const f = fixture();
  if (retained) f.context.flushDirectField('insertFromPaste');
  f.context.line.value = 'bad\x01';
  assert.equal(f.context.flushDirectField('insertFromPaste'), false);
  assert.equal(f.context.line.value, '');
  assert.equal(f.context.lineDirect, null);
  assert.equal(f.context.lineRecovery.text, 'bad\x01');
  assert.deepEqual(f.raw, []); assert.deepEqual(f.pasted, []);
});
