// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The agent-message approval prompt is shown in every viewer of the mesh. When another viewer
// answers it, the request leaves the pending list and the prompt still open here is withdrawn;
// an answer the server no longer accepts is reported, not retried.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {createAgentMailConsentGate} from '../static/pane-actions.ts';
import {FakeDialog, settle} from './helpers/fake-dialog.ts';

type Choice = 'no' | 'yes' | 'always' | 'later' | 'withdrawn' | null;

const request = (id: string, state = 'pending') => ({
  id, message_id: `m-${id}`, state,
  source: {id: 'alpha', created: 1, agent: 'claude'},
  target: {id: 'beta', created: 2, agent: 'codex'},
});

/** A prompt the test settles by hand, and a record of what the gate did. */
function harness(decideOutcome: 'settled' | 'stale' | 'retry' = 'settled') {
  const shown: string[] = [];
  const withdrawn: string[] = [];
  const decided: string[] = [];
  let elsewhere = 0;
  let settle: ((choice: Choice) => void) | null = null;
  const gate = createAgentMailConsentGate({
    choose: (value, notice) => new Promise<Choice>((resolve) => {
      shown.push(notice === null ? value.id : `${value.id} (${notice})`);
      settle = resolve;
    }),
    decide: async (id, decision) => { decided.push(`${id}:${decision}`); return decideOutcome; },
    withdraw: (id) => { withdrawn.push(id); settle?.('withdrawn'); },
    answeredElsewhere: () => { elsewhere += 1; },
  });
  return {
    gate, shown, withdrawn, decided,
    elsewhere: () => elsewhere,
    answer: (choice: Choice) => settle?.(choice),
  };
}

describe('agent-mail consent gate across viewers', () => {
  test('a prompt whose request left the pending list is withdrawn, not decided', async () => {
    const h = harness();
    const open = h.gate.consider([request('r1')]);
    assert.deepEqual(h.shown, ['r1']);
    await h.gate.consider([]);
    await open;
    assert.deepEqual(h.withdrawn, ['r1']);
    assert.deepEqual(h.decided, []);
  });

  test('a request that is no longer pending (granted elsewhere) also withdraws the prompt', async () => {
    const h = harness();
    const open = h.gate.consider([request('r1')]);
    await h.gate.consider([request('r1', 'granted')]);
    await open;
    assert.deepEqual(h.withdrawn, ['r1']);
  });

  test('a list that still holds the request leaves the prompt open', async () => {
    const h = harness();
    const open = h.gate.consider([request('r1')]);
    await h.gate.consider([request('r1')]);
    assert.deepEqual(h.withdrawn, []);
    h.answer('yes');
    await open;
    assert.deepEqual(h.decided, ['r1:yes']);
  });

  test('a list that could not be read does not withdraw the prompt', async () => {
    const h = harness();
    const open = h.gate.consider([request('r1')]);
    await h.gate.consider(undefined);
    assert.deepEqual(h.withdrawn, []);
    h.answer('later');
    await open;
  });

  test('a withdrawn request that is pending again is asked again', async () => {
    const h = harness();
    const open = h.gate.consider([request('r1')]);
    await h.gate.consider([]);
    await open;
    const again = h.gate.consider([request('r1')]);
    assert.deepEqual(h.shown, ['r1', 'r1']);
    h.answer('no');
    await again;
    assert.deepEqual(h.decided, ['r1:no']);
  });

  test('an answer the server refuses as stale is reported once and not retried', async () => {
    const h = harness('stale');
    const open = h.gate.consider([request('r1')]);
    h.answer('always');
    await open;
    assert.equal(h.elsewhere(), 1);
    await h.gate.consider([request('r1')]);
    assert.deepEqual(h.shown, ['r1']);
  });

  test('the next prompt of a run says what became of the one before it', async () => {
    const stale = harness('stale');
    const first = stale.gate.consider([request('r1'), request('r2')]);
    stale.answer('no');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(stale.shown, ['r1', 'r2 (answeredElsewhere)']);
    stale.answer('later');
    await first;

    const h = harness();
    const second = h.gate.consider([request('r1'), request('r2'), request('r3')]);
    await h.gate.consider([request('r2'), request('r3')]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(h.shown, ['r1', 'r2 (withdrawn)']);
    h.answer('yes');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(h.shown, ['r1', 'r2 (withdrawn)', 'r3'], 'a settled answer carries nothing');
    h.answer('later');
    await second;
  });

  test('a settled answer reports nothing', async () => {
    const h = harness('settled');
    const open = h.gate.consider([request('r1')]);
    h.answer('yes');
    await open;
    assert.equal(h.elsewhere(), 0);
    assert.deepEqual(h.withdrawn, []);
  });
});

/** The gate over one modal dialog whose `close` event fires in a later task, as in a browser.
 * The prompt settles only on that event, so these cases hold for the plainest dialog wiring. */
function dialogHarness() {
  const dialog = new FakeDialog();
  const shown: string[] = [];
  const decided: string[] = [];
  const answers = ['no', 'yes', 'always', 'later', 'withdrawn'];
  const gate = createAgentMailConsentGate({
    choose: (value) => new Promise<Choice>((resolve) => {
      if (dialog.open) { resolve(null); return; }
      shown.push(value.id);
      dialog.shows = value.id;
      dialog.addEventListener('close', () => resolve(
        (answers.includes(dialog.returnValue) ? dialog.returnValue : 'later') as Choice), {once: true});
      dialog.returnValue = 'later';
      dialog.showModal();
    }),
    decide: async (id, decision) => { decided.push(`${id}:${decision}`); return 'settled'; },
    withdraw: () => { if (dialog.open) dialog.close('withdrawn'); },
  });
  return {gate, dialog, shown, decided};
}

describe('agent-mail consent gate with two pending requests', () => {
  test('the prompt shown stays tracked across refreshes and is withdrawn when decided elsewhere', async () => {
    const h = dialogHarness();
    const run = h.gate.consider([request('r1')]);
    assert.equal(h.dialog.shows, 'r1');
    await h.gate.consider([request('r1'), request('r2')]);
    await h.gate.consider([request('r2')]);
    await settle();
    assert.deepEqual([h.dialog.open, h.dialog.shows], [true, 'r2'], 'r1 closed, r2 asked');
    h.dialog.click('no');
    await run;
    assert.deepEqual(h.decided, ['r2:no']);
  });

  test('an answer to the next prompt is not lost to the close event of the withdrawn one', async () => {
    const h = dialogHarness();
    const run = h.gate.consider([request('r1'), request('r2')]);
    assert.equal(h.dialog.shows, 'r1');
    await h.gate.consider([request('r2')]);
    await settle();
    assert.deepEqual([h.dialog.open, h.dialog.shows], [true, 'r2']);
    h.dialog.click('no');
    await run;
    assert.deepEqual(h.decided, ['r2:no'], 'the refusal reached the server');
  });

  test('a request that left the newest list is not opened after a withdraw', async () => {
    const h = dialogHarness();
    const run = h.gate.consider([request('r1'), request('r2')]);
    await h.gate.consider([]);
    await run;
    assert.deepEqual(h.shown, ['r1']);
    assert.equal(h.dialog.open, false);
    assert.deepEqual(h.decided, []);
  });

  test('a request added while a prompt is open is asked after it', async () => {
    const h = dialogHarness();
    const run = h.gate.consider([request('r1')]);
    await h.gate.consider([request('r1'), request('r2')]);
    h.dialog.click('yes');
    await settle();
    assert.deepEqual([h.dialog.open, h.dialog.shows], [true, 'r2']);
    h.dialog.click('later');
    await run;
    assert.deepEqual(h.decided, ['r1:yes']);
  });
});
