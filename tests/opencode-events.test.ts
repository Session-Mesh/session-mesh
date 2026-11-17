// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The translation of OpenCode plugin events into Mesh hook events (opencode-mesh-events.ts).
// The event names are the ones OpenCode 1.18.35 delivered to a probe plugin in a real run
// (session.status busy/idle, session.idle) plus the permission and question events its plugin API names.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {EventTranslator} from '../opencode-mesh-events.ts';

const SESSION = 'ses_e1ec1ceb2ffeve47ULriArjJ5g';
const status = (type: string, sessionID = SESSION) => ({type: 'session.status', properties: {sessionID, status: {type}}});

describe('OpenCode events', () => {
  test('a turn is working, then done, and carries the conversation to resume', () => {
    const translator = new EventTranslator(1000);
    const working = translator.translate(status('busy'), 100);
    assert.deepEqual(working, {type: 'working', at: 100,
      detail: {source: 'opencode', hook: 'session.status', seq: 1001, session: SESSION}});
    assert.equal(translator.translate(status('busy'), 101), null, 'a repeated state is not sent again');
    const done = translator.translate(status('idle'), 102);
    assert.equal(done?.type, 'done');
    assert.equal(done?.detail.seq, 1002, 'each event carries a number the server orders them by');
    assert.equal(translator.translate({type: 'session.idle', properties: {sessionID: SESSION}}, 103), null);
  });

  test('the numbers start from the clock, so an OpenCode restart keeps them rising', () => {
    const first = new EventTranslator(5_000).translate(status('busy'));
    const restarted = new EventTranslator(9_000).translate(status('busy'));
    assert.ok(restarted!.detail.seq > first!.detail.seq);
  });

  test('a permission or a question closes the idle gate, and its answer reopens work', () => {
    const translator = new EventTranslator();
    translator.translate(status('busy'));
    assert.equal(translator.translate({type: 'permission.asked', properties: {sessionID: SESSION}})?.type,
      'waiting_permission');
    assert.equal(translator.translate({type: 'permission.replied', properties: {sessionID: SESSION}})?.type, 'working');
    assert.equal(translator.translate({type: 'question.asked', properties: {sessionID: SESSION}})?.type,
      'waiting_question');
    assert.equal(translator.translate({type: 'question.rejected', properties: {sessionID: SESSION}})?.type, 'working');
    assert.equal(translator.translate({type: 'session.error', properties: {sessionID: SESSION}})?.type, 'error');
  });

  test('a sub-agent session never speaks for the terminal', () => {
    const translator = new EventTranslator();
    const child = 'ses_childchildchild0000000001';
    translator.translate({type: 'session.created', properties: {sessionID: child, info: {id: child, parentID: SESSION}}});
    assert.equal(translator.translate(status('idle', child)), null);
    assert.equal(translator.translate(status('busy', child)), null);
    assert.equal(translator.translate(status('idle'))?.type, 'done');
  });

  test('a sub-agent permission request is the root conversation waiting, without naming the sub-agent', () => {
    const translator = new EventTranslator();
    const child = 'ses_childchildchild0000000001';
    translator.translate({type: 'session.created', properties: {sessionID: child, info: {id: child, parentID: SESSION}}});
    translator.translate(status('busy'));
    const asked = translator.translate({type: 'permission.asked', properties: {sessionID: child}});
    assert.equal(asked?.type, 'waiting_permission');
    assert.equal(asked?.detail.session, undefined);
    assert.equal(translator.translate({type: 'permission.replied', properties: {sessionID: child}})?.type, 'working');
    assert.equal(translator.translate({type: 'question.asked', properties: {sessionID: child}}), null,
      'only a permission request is reported for a sub-agent');
  });

  test('other events and malformed values are ignored', () => {
    const translator = new EventTranslator();
    for (const event of [{type: 'message.updated', properties: {sessionID: SESSION}}, {type: 7}, {}, {type: 'session.status'},
      {type: 'session.status', properties: {status: 'busy'}}, {type: 'session.status', properties: {status: {type: 'other'}}}]) {
      assert.equal(translator.translate(event as never), null, JSON.stringify(event));
    }
  });

  test('a conversation id that is not an OpenCode id is not forwarded', () => {
    const translator = new EventTranslator();
    const event = translator.translate(status('busy', '../../etc/passwd'));
    assert.equal(event?.type, 'working');
    assert.equal(event?.detail.session, undefined);
  });
});
