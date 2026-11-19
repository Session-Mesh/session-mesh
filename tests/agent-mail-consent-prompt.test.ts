// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The approval dialog behind the agent-message consent gate. A browser fires a dialog's `close`
// event in a later task, so a withdrawn prompt is settled at once and a late `close` event must
// never settle the prompt shown after it.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {createAgentMailConsentGate, createAgentMailConsentPrompt} from '../static/pane-actions.ts';
import {FakeDialog, drainMicrotasks, settle} from './helpers/fake-dialog.ts';

const request = (id: string) => ({
  id, message_id: `m-${id}`, state: 'pending' as const,
  source: {id: 'alpha', created: 1, agent: 'claude'},
  target: {id: 'beta', created: 2, agent: 'codex'},
});

function promptOn(blocked = false) {
  const dialog = new FakeDialog();
  let announced = 0;
  /** What the dialog's status line said each time a prompt opened, and whether it was open then. */
  const notices: string[] = [];
  const prompt = createAgentMailConsentPrompt(dialog as unknown as HTMLDialogElement, {
    blocked: () => blocked,
    describe: (value) => { dialog.shows = value.id; },
    notice: (notice) => { notices.push(`${dialog.shows}:${notice ?? 'none'}:${dialog.open ? 'open' : 'closed'}`); },
    withdrawn: () => { announced += 1; },
  });
  return {dialog, prompt, notices, announced: () => announced};
}

/** The real prompt behind the gate, over one fake dialog. */
function gateOn(now = () => 0) {
  const on = promptOn();
  const decided: string[] = [];
  let elsewhere = 0;
  const gate = createAgentMailConsentGate({
    choose: on.prompt.choose, withdraw: on.prompt.withdraw, now, deferMs: 1000,
    decide: async (id, decision) => { decided.push(`${id}:${decision}`); return 'settled'; },
    answeredElsewhere: () => { elsewhere += 1; },
  });
  return {...on, gate, decided, elsewhere: () => elsewhere};
}

describe('agent-mail consent prompt', () => {
  test('an answer settles the prompt when the dialog closes', async () => {
    const {dialog, prompt} = promptOn();
    const choice = prompt.choose(request('r1'));
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r1']);
    dialog.click('always');
    assert.equal(await choice, 'always');
  });

  test('Escape closes the prompt as "Later"', async () => {
    const {dialog, prompt} = promptOn();
    const choice = prompt.choose(request('r1'));
    dialog.escape();
    assert.equal(dialog.open, false);
    assert.equal(await choice, 'later');
  });

  test('Escape on a prompt that follows an "Always" answer defers, it does not grant again', async () => {
    // Browsers keep a dialog's returnValue across showModal; Escape closes without a value.
    const {dialog, prompt} = promptOn();
    const first = prompt.choose(request('r1'));
    dialog.click('always');
    await settle();
    assert.equal(await first, 'always');
    const second = prompt.choose(request('r2'));
    dialog.escape();
    await settle();
    assert.equal(await second, 'later');
  });

  test('an answer value the prompt does not know is "Later", never a refusal', async () => {
    const {dialog, prompt} = promptOn();
    const choice = prompt.choose(request('r1'));
    dialog.click('unexpected');
    assert.equal(await choice, 'later');
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

  test('an answer whose request is withdrawn before the dialog finished closing is reported as overtaken', async () => {
    const {dialog, prompt, announced} = promptOn();
    const choice = prompt.choose(request('r1'));
    dialog.click('no');
    await prompt.withdraw('r1');
    assert.equal(await choice, 'overtaken');
    await settle();
    assert.equal(announced(), 0, 'the dialog was already closed: no withdrawal notice');
  });

  test('a "Later" overtaken by a withdraw is a plain withdrawal', async () => {
    const {dialog, prompt} = promptOn();
    const choice = prompt.choose(request('r1'));
    dialog.escape();
    await prompt.withdraw('r1');
    assert.equal(await choice, 'withdrawn');
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

  test('the notice given to choose reaches the status line once the dialog is open', async () => {
    const {dialog, prompt, notices} = promptOn();
    void prompt.choose(request('r1'), 'withdrawn');
    dialog.click('later');
    await settle();
    void prompt.choose(request('r2'));
    assert.deepEqual(notices, ['r1:withdrawn:open', 'r2:none:open']);
  });

  test('the fake dialog follows the spec for showModal and Escape', () => {
    const dialog = new FakeDialog();
    let cancelled = 0;
    dialog.addEventListener('cancel', () => { cancelled += 1; });
    dialog.returnValue = 'later';
    dialog.showModal();
    dialog.showModal();
    assert.equal(dialog.open, true, 'showModal on an open modal dialog returns without effect');
    dialog.escape();
    assert.deepEqual([dialog.open, dialog.returnValue, cancelled], [false, 'later', 1]);
    dialog.show();
    assert.throws(() => dialog.showModal(), /InvalidStateError/);
  });
});

describe('agent-mail consent gate over the real prompt', () => {
  test('r1 decided elsewhere: r2 opens only after the close event of r1, and its refusal reaches the server', async () => {
    const {dialog, gate, decided, notices, announced} = gateOn();
    const run = gate.consider([request('r1'), request('r2')]);
    assert.equal(dialog.shows, 'r1');
    await gate.consider([request('r2')]);
    await drainMicrotasks();
    assert.equal(dialog.open, false, 'r2 waits for the close event of r1');
    await settle();
    assert.deepEqual([dialog.open, dialog.shows, announced()], [true, 'r2', 1]);
    assert.deepEqual(notices, ['r1:none:open', 'r2:withdrawn:open'], 'r2 says that r1 was decided elsewhere');
    dialog.click('no');
    await run;
    assert.deepEqual(decided, ['r2:no']);
  });

  test('two refreshes in one turn withdraw r1 once, and r2 still waits for its close event', async () => {
    const {dialog, gate, decided} = gateOn();
    const run = gate.consider([request('r1'), request('r2')]);
    void gate.consider([request('r2')]);
    void gate.consider([request('r2')]);
    await drainMicrotasks();
    assert.equal(dialog.open, false, 'r2 waits for the close event of r1');
    await settle();
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r2']);
    dialog.click('yes');
    await run;
    assert.deepEqual(decided, ['r2:yes']);
  });

  test('a stale list that lists r1 again before it finished closing does not reopen it in the same run', async () => {
    const {dialog, gate} = gateOn();
    const run = gate.consider([request('r1'), request('r2')]);
    await gate.consider([request('r2')]);
    await gate.consider([request('r1'), request('r2')]);
    await settle();
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r2'], 'the next request is asked, not r1 again');
    dialog.click('later');
    await run;
  });

  test('an answer overtaken by a refresh says it changed nothing, also on the next prompt', async () => {
    const {dialog, gate, decided, notices, elsewhere} = gateOn();
    const run = gate.consider([request('r1'), request('r2')]);
    dialog.click('no');
    await gate.consider([request('r2')]);
    await settle();
    assert.deepEqual([decided, elsewhere()], [[], 1]);
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r2']);
    assert.deepEqual(notices, ['r1:none:open', 'r2:answeredElsewhere:open']);
    dialog.click('later');
    await run;
  });

  test('Escape on the prompt defers the request: nothing is decided and it is asked again later', async () => {
    let clock = 0;
    const {dialog, gate, decided} = gateOn(() => clock);
    const run = gate.consider([request('r1')]);
    dialog.escape();
    await run;
    assert.deepEqual([dialog.open, decided], [false, []]);
    await gate.consider([request('r1')]);
    assert.equal(dialog.open, false, 'not asked again before the deferral ends');
    clock = 1000;
    const again = gate.consider([request('r1')]);
    assert.deepEqual([dialog.open, dialog.shows], [true, 'r1']);
    dialog.click('yes');
    await again;
    assert.deepEqual(decided, ['r1:yes']);
  });
});
