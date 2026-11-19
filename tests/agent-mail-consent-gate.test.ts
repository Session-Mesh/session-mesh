// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The agent-message approval prompt is shown in every viewer of the mesh. When another viewer
// answers it, the request leaves the pending list and the prompt still open here is withdrawn;
// an answer the server no longer accepts is reported, not retried.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {createAgentMailConsentGate} from '../static/pane-actions.ts';

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
    choose: (value) => new Promise<Choice>((resolve) => { shown.push(value.id); settle = resolve; }),
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

  test('a settled answer reports nothing', async () => {
    const h = harness('settled');
    const open = h.gate.consider([request('r1')]);
    h.answer('yes');
    await open;
    assert.equal(h.elsewhere(), 0);
    assert.deepEqual(h.withdrawn, []);
  });
});
