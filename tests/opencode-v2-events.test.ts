// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The translation of OpenCode 2 plugin events into Mesh hook events (opencode-mesh-plugin-v2/events.ts).
// The event shapes are those observed on OpenCode 2.3.0 (a real run with a scripted provider, see
// tests/opencode-v2-real.test.ts), including the question form whose session is in data.form.sessionID.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {EventTranslatorV2} from '../opencode-mesh-plugin-v2/events.ts';

const ROOT = 'ses_e1e5d94aaffeXJrdx9TB6IG1Bs';
const CHILD = 'ses_e1e5d94bbffeCHILD0000000001';
const event = (type: string, data: object) => ({type, data});
const started = (sessionID: string) => event('session.execution.started', {sessionID});
const ended = (type: string, sessionID: string) => event(`session.execution.${type}`, {sessionID});
const form = (id: string, sessionID: string, kind = 'question') =>
  event('form.created', {form: {id, sessionID, title: 'Questions', metadata: {kind}}});

/** The types reported for a sequence of events, with the conversation each one names. */
function run(events: {type: string; data: object}[]): [string, string | undefined][] {
  const translator = new EventTranslatorV2(0);
  const reported: [string, string | undefined][] = [];
  for (const item of events) {
    const out = translator.translate(item);
    if (out) reported.push([out.type, out.detail.session]);
  }
  return reported;
}

describe('the state of a turn', () => {
  test('working while an execution runs, done when it succeeds or is interrupted, error when it fails', () => {
    assert.deepEqual(run([started(ROOT), ended('succeeded', ROOT), started(ROOT), ended('interrupted', ROOT)]),
      [['working', ROOT], ['done', ROOT], ['working', ROOT], ['done', ROOT]]);
    assert.deepEqual(run([started(ROOT), ended('failed', ROOT)]), [['working', ROOT], ['error', ROOT]]);
  });

  test('events that say nothing about the state are ignored', () => {
    assert.deepEqual(run([event('session.text.delta', {sessionID: ROOT}), event('provider.updated', {}),
      event('session.step.started', {sessionID: ROOT}), {type: 'x'}, {data: {}}, event('session.execution.started', {})]), []);
  });

  test('a repeated state is not reported again', () => {
    assert.deepEqual(run([started(ROOT), started(ROOT), ended('succeeded', ROOT), ended('succeeded', ROOT)]),
      [['working', ROOT], ['done', ROOT]]);
  });

  test('the sequence numbers rise, so the server can drop an event that arrives late', () => {
    const translator = new EventTranslatorV2(1000);
    const first = translator.translate(started(ROOT))!;
    const second = translator.translate(ended('succeeded', ROOT))!;
    assert.ok(second.detail.seq > first.detail.seq && first.detail.seq > 1000);
  });
});

describe('permission requests and questions', () => {
  test('a permission request is waiting, its answer is working again', () => {
    assert.deepEqual(run([started(ROOT), event('permission.asked', {id: 'per_1', sessionID: ROOT, action: 'bash'}),
      event('permission.replied', {sessionID: ROOT, requestID: 'per_1', reply: 'once'})]),
    [['working', ROOT], ['waiting_permission', ROOT], ['working', ROOT]]);
  });

  test('a question form (session in data.form.sessionID) is waiting_question, cancelled or answered it is working again', () => {
    for (const closing of ['form.cancelled', 'form.replied']) {
      assert.deepEqual(run([started(ROOT), form('frm_1', ROOT), event(closing, {id: 'frm_1', sessionID: ROOT})]),
        [['working', ROOT], ['waiting_question', ROOT], ['working', ROOT]], closing);
    }
  });

  test('a form that is not a question does not make OpenCode wait', () => {
    assert.deepEqual(run([started(ROOT), form('frm_1', ROOT, 'auth'), form('frm_2', ROOT, 'other')]), [['working', ROOT]]);
  });

  test('nothing is typed into a turn that ends with a request open: the end of the turn clears it, then done', () => {
    assert.deepEqual(run([started(ROOT), event('permission.asked', {id: 'per_1', sessionID: ROOT}), ended('interrupted', ROOT)]),
      [['working', ROOT], ['waiting_permission', ROOT], ['done', ROOT]]);
  });

  test('while a request is open, the end of another execution does not report done', () => {
    assert.deepEqual(run([started(ROOT), form('frm_1', ROOT), started(CHILD), ended('succeeded', CHILD)]),
      [['working', ROOT], ['waiting_question', ROOT]]);
  });

  test('an answer to an unknown request changes nothing', () => {
    assert.deepEqual(run([started(ROOT), event('permission.replied', {requestID: 'nope', sessionID: ROOT}),
      event('form.cancelled', {id: 'nope', sessionID: ROOT})]), [['working', ROOT]]);
  });
});

describe('sub-agents', () => {
  test('a sub-agent finishing inside the turn does not report done: only the last execution does', () => {
    assert.deepEqual(run([started(ROOT), started(CHILD), ended('succeeded', CHILD), ended('succeeded', ROOT)]),
      [['working', ROOT], ['done', ROOT]]);
  });

  test('a sub-agent starting inside a turn never names the conversation to resume', () => {
    const translator = new EventTranslatorV2(0);
    translator.translate(started(ROOT));
    translator.translate(started(CHILD));
    translator.translate(ended('succeeded', CHILD));
    // The next report is about the root conversation, whatever event carries it.
    const out = translator.translate(event('permission.asked', {id: 'per_1', sessionID: CHILD}))!;
    assert.equal(out.detail.session, ROOT);
  });

  test('a new conversation opened later is the one named once its turn starts', () => {
    const other = 'ses_e1e5d94ccffeOTHER000000002';
    assert.deepEqual(run([started(ROOT), ended('succeeded', ROOT), started(other)]),
      [['working', ROOT], ['done', ROOT], ['working', other]]);
  });

  test('a session id that is not an OpenCode one is never reported as the conversation', () => {
    assert.deepEqual(run([started('not-a-session')]), [['working', undefined]]);
  });
});
