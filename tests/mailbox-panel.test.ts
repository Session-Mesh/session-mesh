// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pure parts of the pane mailbox: what is shown for an agent's text, which server answers are
// accepted, and which pending requests concern a session.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {hasMailbox, inertText, parseMailbox, requestsFor} from '../static/mailbox-panel.ts';

const mark = (codePoint: number): string => `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;

const alpha = {id: 'alpha', created: 1, agent: 'claude'};
const beta = {id: 'beta', created: 2, agent: 'codex'};
const message = {id: 'a'.repeat(32), conversation_id: 'b'.repeat(32), source: alpha, target: beta, kind: 'message',
  text: 'hi', created: 3, seq: 1};
const request = {id: 'c'.repeat(32), message_id: message.id, source: alpha, target: beta, created: 3, state: 'pending'};
const view = {identity: beta, received: [message], sent: [], truncated: false, requests: [request],
  always: [{id: 'd'.repeat(32), source: alpha, target: beta, created: 4}]};

describe('inertText', () => {
  test('keeps ordinary text, newlines and tabs, and normalises line ends', () => {
    assert.equal(inertText('a\tb\nc\r\nd\re'), 'a\tb\nc\nd\ne');
    assert.equal(inertText('<b>x</b> https://example.invalid'), '<b>x</b> https://example.invalid');
  });
  test('shows controls, line separators and bidirectional overrides as visible marks', () => {
    assert.equal(inertText('a‮b‬c'), 'a<U+202E>b<U+202C>c');
    assert.equal(inertText('\u0000\u001b[31m ⁦\u007f'), '<U+0000><U+001B>[31m<U+2028><U+2066><U+007F>');
  });
  test('marks each invisible family: Arabic letter mark, zero-width, soft hyphen, word joiner, BOM', () => {
    for (const codePoint of [0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad]) {
      assert.equal(inertText(`a${String.fromCodePoint(codePoint)}b`), `a${mark(codePoint)}b`, mark(codePoint));
    }
  });
  test('marks every tag character, the first and the last of the block included', () => {
    for (const codePoint of [0xe0000, 0xe0001, 0xe0020, 0xe0041, 0xe007f]) {
      assert.equal(inertText(`a${String.fromCodePoint(codePoint)}b`), `a${mark(codePoint)}b`, mark(codePoint));
    }
    assert.equal(inertText(String.fromCodePoint(0xe0068, 0xe0069)), '<U+E0068><U+E0069>', 'one mark per code point');
  });
  test('marks the other format characters (category Cf) and the variation selectors', () => {
    for (const codePoint of [0x0600, 0x180e, 0x2061, 0x2064, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x110bd, 0x1d173,
      0x180b, 0x180d, 0x180f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef]) {
      assert.equal(inertText(`a${String.fromCodePoint(codePoint)}b`), `a${mark(codePoint)}b`, mark(codePoint));
    }
    assert.equal(inertText('a\u0000\u001b\u007f\u0085  ‎‮⁩b'),
      'a<U+0000><U+001B><U+007F><U+0085><U+2028><U+2029><U+200E><U+202E><U+2069>b');
  });
  test('leaves visible text alone: accents, emoji, CJK, astral letters, spaces, tabs and newlines', () => {
    const visible = 'é ça 日本語 😀 𝒜 ü\tx\ny   　';
    assert.equal(inertText(visible), visible);
  });
});

describe('hasMailbox', () => {
  test('is true only for a session launched as a messaging agent', () => {
    for (const agent of ['claude', 'codex', 'pi']) assert.equal(hasMailbox({kind: 'mesh', known_agent: agent}), true, agent);
    for (const none of [{kind: 'mesh', known_agent: null}, {kind: 'mesh'}, {known_agent: 'bash'}, {known_agent: 1},
      {kind: 'mesh', agent: {type: 'claude'}}, null, undefined, 'claude', []]) {
      assert.equal(hasMailbox(none), false, JSON.stringify(none));
    }
  });
});

describe('parseMailbox', () => {
  test('accepts the exact shape', () => assert.deepEqual(parseMailbox(view)?.received[0]?.text, 'hi'));
  test('refuses a malformed answer whole', () => {
    for (const broken of [null, [], {}, {...view, truncated: 'no'}, {...view, received: [{...message, kind: 'other'}]},
      {...view, received: [{...message, text: 1}]}, {...view, requests: [{...request, state: 'granted'}]},
      {...view, identity: {...beta, created: 'x'}}, {...view, always: [{id: '', source: alpha, target: beta, created: 1}]}]) {
      assert.equal(parseMailbox(broken), null, JSON.stringify(broken).slice(0, 60));
    }
  });
});

describe('requestsFor', () => {
  test('keeps the requests whose source or target is exactly that incarnation', () => {
    const other = {...request, id: 'e'.repeat(32), source: {...alpha, id: 'x'}, target: {...beta, id: 'y'}};
    assert.deepEqual(requestsFor([request, other], 'beta', 2).map(item => item.id), [request.id]);
    assert.deepEqual(requestsFor([request], 'alpha', 1).length, 1);
    assert.deepEqual(requestsFor([request], 'beta', 3), [], 'another incarnation');
    assert.deepEqual(requestsFor('nope', 'beta', 2), []);
    assert.deepEqual(requestsFor([{...request, state: 'granted'}, 7, null], 'beta', 2), []);
  });
});
