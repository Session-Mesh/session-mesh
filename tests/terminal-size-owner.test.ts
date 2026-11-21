// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The page's side of the size owner rule (static/terminal-size-owner.ts): which size a pane
// shows, when it shows the banner, and which resizes it sends.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {isPtySizeFrame, parsePtySize, sendsSize, sizePlan} from '../static/terminal-size-owner.ts';

const phone = {rows: 33, cols: 52};
const desk = {rows: 40, cols: 116};

describe('the size a pane shows', () => {
  test('a host without the rule: the pane fits its own size, no banner', () => {
    assert.deepEqual(sizePlan(null, phone), {follow: false, term: phone, banner: false, claim: false});
  });
  test('the owner fits its own size', () => {
    assert.deepEqual(sizePlan({...phone, owner: 'you'}, phone), {follow: false, term: phone, banner: false, claim: false});
  });
  test('another device owns it: the pane shows the PTY size, with the banner', () => {
    assert.deepEqual(sizePlan({...desk, owner: 'other'}, phone), {follow: true, term: desk, banner: true, claim: false});
  });
  test('another device owns the same size: no banner', () => {
    assert.deepEqual(sizePlan({...phone, owner: 'other'}, phone), {follow: true, term: phone, banner: false, claim: false});
  });
  test('nobody owns it: the pane fits and claims', () => {
    assert.deepEqual(sizePlan({...desk, owner: 'none'}, phone), {follow: false, term: phone, banner: false, claim: true});
  });
});

describe('the resizes a pane sends', () => {
  test('a follower sends no automatic size, only take-overs and redraws', () => {
    const pty = {...desk, owner: 'other' as const};
    assert.equal(sendsSize(pty, 'claim'), false);
    assert.equal(sendsSize(pty, 'take'), true);
    assert.equal(sendsSize(pty, 'keep'), true);
  });
  test('the owner, nobody, or a host without the rule: every size', () => {
    for (const pty of [{...phone, owner: 'you' as const}, {...phone, owner: 'none' as const}, null])
      assert.equal(sendsSize(pty, 'claim'), true);
  });
});

describe('the message server.py relays', () => {
  test('wire validity is independent of the browser render cap', () => {
    for (const dimension of ['rows', 'cols']) {
      for (const owner of ['you', 'other', 'none']) for (const value of [2, 1000, 1001, 65535])
        assert.equal(isPtySizeFrame({t: 's', rows: 40, cols: 116, [dimension]: value, owner}), true);
      for (const value of [0, 1, -1, 65536, 2.5, NaN, Infinity, '40', true, null, undefined])
        assert.equal(isPtySizeFrame({t: 's', rows: 40, cols: 116, [dimension]: value, owner: 'you'}), false);
    }
    for (const message of [null, [], 's', {t: 's'}, {t: 'g', rows: 40, cols: 116, owner: 'you'},
      {t: 's', rows: 40, cols: 116, owner: 'invalid'}]) assert.equal(isPtySizeFrame(message), false);
  });
  test('a valid one', () => {
    assert.deepEqual(parsePtySize('{"t":"s","rows":40,"cols":116,"owner":"other"}'), {rows: 40, cols: 116, owner: 'other'});
  });
  test('the render cap stays at 1000 in both dimensions', () => {
    for (const dimension of ['rows', 'cols']) {
      for (const value of [2, 1000]) {
        const size = {rows: 40, cols: 116, [dimension]: value, owner: 'other'};
        assert.deepEqual(parsePtySize(JSON.stringify({t: 's', ...size})), size);
      }
      for (const value of [1, 1001, 65535, 65536])
        assert.equal(parsePtySize(JSON.stringify({t: 's', rows: 40, cols: 116, [dimension]: value, owner: 'other'})), null);
    }
  });
  test('anything else is ignored', () => {
    for (const text of ['', 'null', '{"t":"g","rows":40,"cols":116}', '{"t":"s","rows":40,"cols":116,"owner":"me"}',
      '{"t":"s","rows":1,"cols":116,"owner":"you"}', '{"t":"s","rows":40.5,"cols":116,"owner":"you"}',
      '{"t":"s","rows":40,"cols":1001,"owner":"you"}', '{"t":"s","rows":"40","cols":116,"owner":"you"}'])
      assert.equal(parsePtySize(text), null, text);
  });
});
