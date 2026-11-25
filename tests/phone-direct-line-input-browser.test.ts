// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone direct writing, what the field receives: every insertion goes to the terminal as it is
// made and the field is emptied; the terminal is the only thing shown. This file covers typing,
// composition, corrections, Backspace, pastes, multi-line text and the key bar's Esc, Tab, arrows
// and Paste while writing directly.
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {skip} from './terminal-browser-lib.ts';
import {
  BRACKET_END, BRACKET_START, direct, field, flashed, forget, frames, keyboardOpen, outsideBrackets, screenRows,
  useMesh, waitForFlash, waitForRow, waitForRowContaining, waitForShellLine,
} from './phone-direct-line-lib.ts';

describe('phone direct writing: what the field receives', {skip}, () => {
  const {phone, withoutBracketedPaste} = useMesh();

  test('a full acknowledged input budget preserves typed text without sending the next key', async () => {
    const page = await phone('ack-full-direct', 'claude');
    await page.waitForFunction(() => !!active.inputAck);
    await page.keyboard.type('/');
    await page.waitForFunction(() => document.querySelector('#line-direct') && !document.querySelector('#line-direct')!.hasAttribute('hidden'));
    await forget(page);
    const result = await page.evaluate(() => {
      const pane = active as any;
      pane.inputAcks.set('test-budget', {input: {pendingBytes: 1024 * 1024}});
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      textarea.value = 'kept text';
      const delivered = sendKeyToAgent('\r');
      pane.inputAcks.delete('test-budget');
      return {delivered, text: textarea.value, mode: !!lineDirect};
    });
    assert.deepEqual(result, {delivered: false, text: 'kept text', mode: false});
    assert.deepEqual(await frames(page), [], 'neither held text nor Enter was sent');
  });

  test('a paste into the field while writing directly is one paste at the terminal, and the field stays empty', async () => {
    const page = await phone('paste-direct', 'claude');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('xyz'));
    await page.keyboard.type('/a');
    await page.keyboard.press('Control+V');
    await waitForShellLine(page, '/axyz');
    assert.equal(await field(page), '');
    assert.equal(await direct(page), true);
  });

  test('backspace on the empty field erases at the terminal and keeps the mode', async () => {
    const page = await phone('erase', 'claude');
    await page.keyboard.type('/ab');
    await waitForShellLine(page, '/ab');
    await page.keyboard.press('Backspace');
    await waitForShellLine(page, '/a');
    assert.deepEqual(await frames(page), ['/', 'a', 'b', '\x7f']);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => window.__input.length === 6);
    assert.deepEqual((await frames(page)).slice(4), ['\x7f', '\x7f']);
    assert.equal(await direct(page), true, 'the field cannot know when the agent line is empty: the mode stays');
    assert.equal(await field(page), '');
    assert.equal(await keyboardOpen(page), true);
    await page.keyboard.type('z');
    await waitForShellLine(page, 'z');
    assert.equal((await frames(page)).at(-1), 'z', 'still direct');
  });

  test('backspace from a keyboard that sends only beforeinput erases at the terminal', async () => {
    const page = await phone('erase-beforeinput', 'claude');
    await page.keyboard.type('/ab');
    // Android keyboards send keydown with key "Unidentified": only beforeinput names the deletion.
    await page.evaluate(() => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      textarea.dispatchEvent(new InputEvent('beforeinput', {inputType: 'deleteContentBackward', cancelable: true, bubbles: true}));
    });
    await waitForShellLine(page, '/a');
    assert.deepEqual(await frames(page), ['/', 'a', 'b', '\x7f']);
  });

  test('Esc, Tab and the arrows of the key bar go to the agent and keep the mode', async () => {
    const page = await phone('keybar', 'claude');
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    await forget(page);
    for (const key of ['tab', 'up', 'down', 'esc']) await page.locator(`#keys [data-k="${key}"]`).click();
    await page.waitForFunction(() => window.__input.length >= 4);
    assert.deepEqual(await frames(page), ['\t', '\x1b[A', '\x1b[B', '\x1b']);
    assert.equal(await direct(page), true);
    assert.equal(await field(page), '');
  });

  test('a whole word at once reaches the terminal without doubling or loss, and the field stays empty', async () => {
    const page = await phone('predictive', 'claude');
    await page.keyboard.type('/');
    await page.keyboard.insertText('help'); // a suggestion committed as one piece
    await waitForShellLine(page, '/help');
    assert.deepEqual(await frames(page), ['/', 'help']);
    assert.equal(await field(page), '');
    await page.keyboard.insertText('s');
    await waitForShellLine(page, '/helps');
    assert.deepEqual(await frames(page), ['/', 'help', 's']);
  });

  test('composition by a predictive keyboard is sent once, when it ends', async () => {
    const page = await phone('compose', 'claude');
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.type('/');
    for (const step of ['h', 'he', 'hel', 'help']) await cdp.send('Input.imeSetComposition', {text: step, selectionStart: step.length, selectionEnd: step.length});
    await cdp.send('Input.imeSetComposition', {text: 'held', selectionStart: 4, selectionEnd: 4}); // corrected while composing
    assert.deepEqual(await frames(page), ['/'], 'nothing is sent while composing');
    await cdp.send('Input.insertText', {text: 'held'});
    await waitForShellLine(page, '/held');
    assert.deepEqual(await frames(page), ['/', 'held']);
    assert.equal(await field(page), '');
    const rows = await screenRows(page);
    assert.ok(!rows[0]!.includes('/h/h') && !rows[0]!.includes('helphel'), rows[0]);
  });

  test('a keyboard correction replaces text the field no longer holds: it is refused, never added to the word', async () => {
    const page = await phone('replacement', 'claude');
    await page.keyboard.type('/teh');
    await waitForShellLine(page, '/teh');
    await forget(page);
    const prevented = await page.evaluate(() => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      const event = new InputEvent('beforeinput', {inputType: 'insertReplacementText', data: 'the', bubbles: true, cancelable: true});
      textarea.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, true, 'the browser is told not to edit the field');
    await waitForFlash(page, 'correction not sent');
    assert.deepEqual(await frames(page), [], 'the correction is not added to the word the terminal has');
    assert.equal(await field(page), '');
    assert.equal(await direct(page), true);
    // A keyboard whose beforeinput cannot be cancelled still inserts: the input event is refused too.
    await page.evaluate(() => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      textarea.value = 'the';
      textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertReplacementText', data: 'the', bubbles: true}));
    });
    assert.deepEqual(await frames(page), []);
    assert.equal(await field(page), '', 'the field is emptied, nothing hidden stays in it');
  });

  // ---- what the review demonstrated: nothing the agent line holds may be hidden

  test('/us, Tab, Backspaces, then a line: the terminal shows the real line and nothing hidden runs', async () => {
    const page = await phone('hidden-state', 'claude');
    await page.keyboard.type('/us');
    await waitForShellLine(page, '/us');
    await page.locator('#keys [data-k="tab"]').click();
    await waitForShellLine(page, '/usr/');   // the shell completed the line behind the field's back
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    await waitForShellLine(page, '/u');
    assert.equal(await field(page), '', 'the field claims nothing');
    assert.equal((await screenRows(page))[0]!.endsWith('/u'), true, 'the user sees the real line');
    await forget(page);
    await page.keyboard.press('Enter');   // submits what the user sees
    assert.deepEqual(await frames(page), ['\r']);
    await waitForRowContaining(page, '/u: ');
    await page.keyboard.type('echo fine');
    await page.keyboard.press('Enter');
    await waitForRow(page, 'fine');
    const rows = await screenRows(page);
    assert.ok(!rows.some(row => row.includes('/uecho')), 'the next line does not stick to a hidden remainder');
    assert.ok(!rows.some(row => row.includes('/uls')));
  });

  test('a multi-line insertion while writing directly is one bracketed paste', async () => {
    const page = await phone('multiline-direct', 'claude');
    await page.keyboard.type('/');
    await waitForShellLine(page, '/');
    await forget(page);
    await page.keyboard.insertText('a\nb');
    await page.waitForFunction(() => window.__input.length > 0);
    const sent = await frames(page);
    assert.ok(sent.length > 0 && sent.join('').startsWith(BRACKET_START) && sent.join('').endsWith(BRACKET_END), JSON.stringify(sent));
    assert.equal(outsideBrackets(sent), '', 'no line break reaches the terminal as keys');
    assert.equal(await field(page), '');
    assert.equal(await direct(page), true);
  });

  test('a multi-line paste into the field while writing directly is one bracketed paste', async () => {
    const page = await phone('multiline-paste', 'claude');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('one\ntwo'));
    await page.keyboard.type('/');
    await forget(page);
    await page.keyboard.press('Control+V');
    await page.waitForFunction(() => window.__input.length > 0);
    const sent = await frames(page);
    assert.equal(outsideBrackets(sent), '', JSON.stringify(sent));
    assert.ok(sent.join('').includes('one'), JSON.stringify(sent));
    assert.equal(await field(page), '');
  });

  test('a multi-line insertion is refused, with a message, when the program has not asked for bracketed paste', async () => {
    const page = await phone('multiline-refused', 'claude');
    await withoutBracketedPaste(page);   // a program is running in the shell: it did not ask for bracketed paste
    await page.keyboard.type('/');
    await forget(page);
    await page.keyboard.insertText('a\nb');
    await waitForFlash(page, 'multi-line text refused');
    assert.deepEqual(await frames(page), [], 'nothing, not even the first line');
    assert.equal(await field(page), '');
    assert.equal(await direct(page), true, 'nothing was sent, so nothing is claimed');
  });

  test('a control character in an insertion is refused', async () => {
    const page = await phone('control-refused', 'claude');
    await page.keyboard.type('/');
    await forget(page);
    await page.keyboard.insertText('a\x1b[201~b\nrm');
    await waitForFlash(page, 'control characters');
    assert.deepEqual(await frames(page), []);
  });

  test('the key bar Paste with an empty clipboard says so instead of doing nothing', async () => {
    const page = await phone('paste-empty', 'claude');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    await forget(page);
    await page.locator('#keys [data-k="paste"]').click();
    await waitForFlash(page, 'clipboard is empty');
    assert.deepEqual(await frames(page), []);
    assert.equal(await direct(page), true);
  });

  test('the key bar Paste is delivered at the terminal while writing directly', async () => {
    const page = await phone('paste-keybar', 'claude');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('xyz'));
    await page.keyboard.type('/a');
    await forget(page);
    await page.locator('#keys [data-k="paste"]').click();
    await waitForShellLine(page, '/axyz');
    assert.ok((await frames(page)).join('').includes('xyz'), 'the clipboard text was delivered');
    assert.equal(await direct(page), true);
    assert.equal(await flashed(page).then(text => text.includes('not delivered')), false);
  });
});
