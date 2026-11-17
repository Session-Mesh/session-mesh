// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pure rules of phone direct writing (static/direct-line.ts): when it starts, and how text that
// reached the field is handed to the terminal. No line break or control character is ever
// classified as typed bytes.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {directInput, directLineStarts, directLineTrigger, foregroundAgent} from '../static/direct-line.ts';

describe('direct writing: trigger', () => {
  test('/ starts it in every agent, $ only in Codex, nothing without an agent', () => {
    for (const agent of ['claude', 'codex', 'pi'] as const) assert.equal(directLineTrigger(agent, '/'), true);
    assert.equal(directLineTrigger('codex', '$'), true);
    assert.equal(directLineTrigger('claude', '$'), false);
    assert.equal(directLineTrigger('pi', '$'), false);
    assert.equal(directLineTrigger(null, '/'), false);
    assert.equal(directLineTrigger('claude', 'a'), false);
  });

  test('only an agent in the foreground of a mesh session counts', () => {
    assert.equal(foregroundAgent({kind: 'mesh', agent: {type: 'claude', foreground: true}}), 'claude');
    assert.equal(foregroundAgent({kind: 'mesh', agent: {type: 'claude', foreground: false}}), null);
    assert.equal(foregroundAgent({kind: 'mesh', agent: {type: 'claude'}}), null);
    assert.equal(foregroundAgent({kind: 'external', agent: {type: 'claude', foreground: true}}), null);
    assert.equal(foregroundAgent({kind: 'mesh', agent: {type: 'vim', foreground: true}}), null);
    assert.equal(foregroundAgent({kind: 'mesh', agent: null}), null);
    assert.equal(foregroundAgent(undefined), null);
  });
});

describe('direct writing: how text reaches the terminal', () => {
  test('typed text without control characters is sent as typed', () => {
    // insertFromComposition is what Safari reports for a composition that was committed
    for (const type of ['insertText', 'insertCompositionText', 'insertFromComposition']) {
      assert.equal(directInput('help', type), 'typed');
      assert.equal(directLineStarts('claude', '/help', type), true);
    }
  });

  test('an autocorrection replaces nothing the field holds, so it is never sent', () => {
    assert.equal(directInput('the', 'insertReplacementText'), 'replacement');
    assert.equal(directLineStarts('claude', '/the', 'insertReplacementText'), false);
    assert.equal(directInput('a\x1bb', 'insertReplacementText'), 'refused');
    assert.equal(directInput('a\nb', 'insertReplacementText'), 'multiline');
  });

  test('a paste, a drop or a dictation is a paste even on one line', () => {
    for (const type of ['insertFromPaste', 'insertFromDrop', 'insertFromYank', 'insertTranscription', '']) {
      assert.equal(directInput('help', type), 'paste');
    }
  });

  test('a line break or a tab is never typed bytes, whatever the source', () => {
    for (const type of ['insertText', 'insertCompositionText', 'insertReplacementText', 'insertFromPaste', 'insertFromDrop']) {
      for (const text of ['a\nb', 'a\rb', 'a\r\nb', '\n', 'a\tb']) assert.equal(directInput(text, type), 'multiline', `${type} ${JSON.stringify(text)}`);
    }
  });

  test('any other control character is refused, even inside a paste', () => {
    for (const text of ['a\x1bb', '\x1b[201~', 'a\x03', 'a\x7f', 'a\x00', 'a\x85b', 'a\nb\x1b']) {
      for (const type of ['insertText', 'insertFromPaste']) assert.equal(directInput(text, type), 'refused', JSON.stringify(text));
    }
  });

  test('non-ASCII text is typed text', () => {
    assert.equal(directInput('é世🙂', 'insertText'), 'typed');
  });
});

describe('direct writing: what starts it', () => {
  test('typed text beginning with the agent trigger', () => {
    assert.equal(directLineStarts('claude', '/', 'insertText'), true);
    assert.equal(directLineStarts('claude', '/help', 'insertText'), true);
    assert.equal(directLineStarts('codex', '$sk', 'insertCompositionText'), true);
  });

  test('never a paste, a drop, a multi-line insertion or a control character', () => {
    assert.equal(directLineStarts('claude', '/x', 'insertFromPaste'), false);
    assert.equal(directLineStarts('claude', '/x', 'insertFromDrop'), false);
    assert.equal(directLineStarts('claude', '/a\nb', 'insertText'), false);
    assert.equal(directLineStarts('claude', '/a\x1b', 'insertText'), false);
    assert.equal(directLineStarts('claude', '/a\tb', 'insertText'), false);
  });

  test('not for another first character, an empty value, or a session without an agent', () => {
    assert.equal(directLineStarts('claude', 'a/', 'insertText'), false);
    assert.equal(directLineStarts('claude', '', 'insertText'), false);
    assert.equal(directLineStarts('claude', '$', 'insertText'), false);
    assert.equal(directLineStarts(null, '/', 'insertText'), false);
  });
});
