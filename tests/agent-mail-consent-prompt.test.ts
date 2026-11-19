// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The approval dialog behind the agent-message consent gate. A browser fires a dialog's `close`
// event in a later task, so a withdrawn prompt is settled at once and a late `close` event must
// never settle the prompt shown after it.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {createAgentMailConsentGate, createAgentMailConsentPrompt} from '../static/pane-actions.ts';
import {FakeDialog, settle} from './helpers/fake-dialog.ts';

const request = (id: string) => ({
  id, message_id: `m-${id}`, state: 'pending' as const,
  source: {id: 'alpha', created: 1, agent: 'claude'},
  target: {id: 'beta', created: 2, agent: 'codex'},
});

function promptOn(blocked = false) {
  const dialog = new FakeDialog();
  let announced = 0;
  const prompt = createAgentMailConsentPrompt(dialog as unknown as HTMLDialogElement, {
    blocked: () => blocked,
    describe: (value) => { dialog.shows = value.id; },
    withdrawn: () => { announced += 1; },
  });
  return {dialog, prompt, announced: () => announced};
}

describe('agent-mail consent prompt', () => {
  test('an answer settles the prompt when the dialog closes', async () => {
    const {dialog, prompt} = promptOn();
    const choice = prompt.choose(request('r1'));
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r1']);
    dialog.click('always');
    assert.equal(await choice, 'always');
  });

  test('a withdraw settles the prompt at once and is announced once the dialog has closed', async () => {
    const {dialog, prompt, announced} = promptOn();
    let choice: string | null = 'pending';
    void prompt.choose(request('r1')).then((value) => { choice = value; });
    const closed = prompt.withdraw('r1');
    await Promise.resolve();
    assert.deepEqual([choice, dialog.open, announced()], ['withdrawn', false, 0]);
    await closed;
    assert.equal(announced(), 1);
  });

  test('the close event of a withdrawn prompt does not settle the prompt opened after it', async () => {
    const {dialog, prompt} = promptOn();
    void prompt.choose(request('r1'));
    void prompt.withdraw('r1');
    const next = prompt.choose(request('r2'));
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r2']);
    await settle();
    assert.equal(dialog.open, true);
    dialog.click('no');
    assert.equal(await next, 'no');
  });

  test('a withdraw for another request leaves the prompt open', async () => {
    const {dialog, prompt, announced} = promptOn();
    const choice = prompt.choose(request('r1'));
    await prompt.withdraw('r2');
    assert.equal(dialog.open, true);
    dialog.click('yes');
    assert.equal(await choice, 'yes');
    assert.equal(announced(), 0);
  });

  test('another open modal, or a prompt already shown, makes choose answer null', async () => {
    assert.equal(await promptOn(true).prompt.choose(request('r1')), null);
    const {prompt} = promptOn();
    void prompt.choose(request('r1'));
    assert.equal(await prompt.choose(request('r2')), null);
  });

  test('with the gate: r1 decided elsewhere, the refusal of r2 reaches the server', async () => {
    const {dialog, prompt, announced} = promptOn();
    const decided: string[] = [];
    const gate = createAgentMailConsentGate({
      choose: prompt.choose, withdraw: prompt.withdraw,
      decide: async (id, decision) => { decided.push(`${id}:${decision}`); return 'settled'; },
    });
    const run = gate.consider([request('r1'), request('r2')]);
    assert.equal(dialog.shows, 'r1');
    await gate.consider([request('r2')]);
    assert.equal(dialog.open, false, 'r2 is not opened in the turn of the withdraw');
    await settle();
    assert.deepEqual([dialog.open, dialog.shows, announced()], [true, 'r2', 1]);
    dialog.click('no');
    await run;
    assert.deepEqual(decided, ['r2:no']);
  });
});
