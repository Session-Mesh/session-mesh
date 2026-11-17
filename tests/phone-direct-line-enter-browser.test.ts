// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone direct writing, Enter and what sends: Enter submits the agent's line as the terminal
// shows it, after delivering, in order, any text the field still holds (a composition that ended
// but is not flushed yet); it is refused while a composition is in progress. The composer (✎)
// and the attachment menu (📎) also end the mode when they send.
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {skip} from './terminal-browser-lib.ts';
import {
  direct, field, flashed, forget, frames, keyboardOpen, useMesh, waitForFlash, waitForShellLine,
} from './phone-direct-line-lib.ts';

type EnterPath = 'keydown' | 'beforeinput' | 'send button' | 'key bar';
const ENTER_PATHS: readonly EnterPath[] = ['keydown', 'beforeinput', 'send button', 'key bar'];

/** Compose `word` in the field, then reach Enter by `path`, in the same task: the composition
 * ended (its flush waits for the next task) or, with `ended` false, is still in progress. */
async function composeThenEnter(page: Page, word: string, path: EnterPath, ended: boolean): Promise<void> {
  await page.evaluate(({word, path, ended}) => {
    const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    textarea.value = word;
    if (ended) textarea.dispatchEvent(new CompositionEvent('compositionend', {data: word, bubbles: true}));
    if (path === 'keydown') textarea.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    else if (path === 'beforeinput') textarea.dispatchEvent(new InputEvent('beforeinput', {inputType: 'insertLineBreak', bubbles: true, cancelable: true}));
    else if (path === 'send button') document.querySelector<HTMLElement>('#line button.primary')!.click();
    else document.querySelector<HTMLElement>('#keys [data-k="enter"]')!.click();
  }, {word, path, ended});
}

describe('phone direct writing: Enter', {skip}, () => {
  const {phone} = useMesh();

  test('Enter sends only Enter, and the next line is an ordinary line', async () => {
    const page = await phone('enter', 'claude');
    await page.keyboard.type('/he');
    await waitForShellLine(page, '/he');
    await forget(page);
    await page.keyboard.press('Enter');
    assert.deepEqual(await frames(page), ['\r'], 'no text is sent a second time');
    assert.equal(await direct(page), false);
    assert.equal(await field(page), '');
    await page.keyboard.type('x');
    assert.deepEqual(await frames(page), ['\r'], 'the next line is held again');
    assert.equal(await keyboardOpen(page), true);
  });

  test('the send button and the key bar Enter also submit and end it', async () => {
    const page = await phone('leave', 'claude');
    await page.keyboard.type('/a');
    await forget(page);
    await page.locator('#line button.primary').click();
    assert.deepEqual(await frames(page), ['\r']);
    assert.equal(await direct(page), false);
    await page.keyboard.type('/b');
    await forget(page);
    await page.locator('#keys [data-k="enter"]').click();
    assert.deepEqual(await frames(page), ['\r']);
    assert.equal(await direct(page), false);
  });

  for (const path of ENTER_PATHS) {
    test(`Enter by ${path} right after a composition ended delivers the word first, then Enter`, async () => {
      const page = await phone(`ended-${path.replace(' ', '-')}`, 'claude');
      await page.keyboard.type('/');
      await forget(page);
      await composeThenEnter(page, 'help', path, true);
      assert.deepEqual(await frames(page), ['help', '\r'], 'the word, in order, before the Enter');
      assert.equal(await field(page), '', 'nothing stays in the field');
      assert.equal(await direct(page), false);
      await page.waitForTimeout(200);   // the composition's own late flush finds nothing left
      assert.deepEqual(await frames(page), ['help', '\r']);
    });

    test(`Enter by ${path} while a composition is in progress is refused, and the word is sent once when it ends`, async () => {
      const page = await phone(`composing-${path.replace(' ', '-')}`, 'claude');
      await page.keyboard.type('/');
      await forget(page);
      await composeThenEnter(page, 'help', path, false);
      await waitForFlash(page, 'still being composed');
      assert.deepEqual(await frames(page), [], 'no Enter before the word');
      assert.equal(await field(page), 'help', 'the composition is left alone');
      assert.equal(await direct(page), true);
      await page.evaluate(() => {   // the keyboard commits the word
        document.querySelector('#line-text')!.dispatchEvent(new CompositionEvent('compositionend', {data: 'help', bubbles: true}));
      });
      await waitForShellLine(page, '/help');
      assert.deepEqual(await frames(page), ['help'], 'once');
      assert.equal(await field(page), '');
      await page.keyboard.press('Enter');
      assert.deepEqual(await frames(page), ['help', '\r']);
    });
  }

  test('a real keyboard composition committed and followed at once by Enter reaches the terminal in order', async () => {
    const page = await phone('ime-enter', 'claude');
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.type('/');
    await forget(page);
    await cdp.send('Input.imeSetComposition', {text: 'help', selectionStart: 4, selectionEnd: 4});
    await Promise.all([
      cdp.send('Input.insertText', {text: 'help'}),
      cdp.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13}),
      cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13}),
    ]);
    await page.waitForFunction(() => window.__input.join('').endsWith('\r'));
    assert.deepEqual(await frames(page), ['help', '\r']);
    assert.equal(await field(page), '');
  });

  test('a real keyboard composition, then a tap on the send button, never sends Enter before the word', async () => {
    const page = await phone('ime-button', 'claude');
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.type('/');
    await forget(page);
    await cdp.send('Input.imeSetComposition', {text: 'help', selectionStart: 4, selectionEnd: 4});
    await page.locator('#line button.primary').click();
    await page.waitForTimeout(300);
    const sent = (await frames(page)).join('');
    assert.ok(!sent.includes('\r') || sent.indexOf('help') >= 0 && sent.indexOf('help') < sent.indexOf('\r'), JSON.stringify(sent));
    if (!sent.includes('\r')) assert.ok((await flashed(page)).includes('composed') || (await field(page)) === 'help');
  });

  test('held text that cannot be delivered stops Enter: nothing is sent after it', async () => {
    const page = await phone('held-fails', 'claude');
    await page.keyboard.type('/');
    await forget(page);
    await page.evaluate(() => {   // the socket accepts nothing from now on
      (active.conn as unknown as {terminal: {queueInput: () => never}}).terminal.queueInput = () => { throw new Error('closed'); };
    });
    await composeThenEnter(page, 'help', 'keydown', true);
    await waitForFlash(page, 'keys not delivered');
    assert.deepEqual(await frames(page), [], 'no Enter after the word that did not go');
    assert.equal(await direct(page), false);
  });

  // ---- the composer and the attachment menu send into the terminal, not into the agent's line

  test('a send from the composer (✎) ends the mode', async () => {
    const page = await phone('composer', 'claude');
    await page.keyboard.type('/a');
    await forget(page);
    await page.locator('#keys [data-k="compose"]').click();
    await page.locator('#compose-text').fill('hello');
    await page.locator('#compose-send').click();
    await page.waitForFunction(() => window.__input.join('').endsWith('\r'), undefined, {timeout: 30000});
    assert.equal(await direct(page), false, 'the Enter it sent ended the mode');
    await page.waitForFunction(() => !(document.querySelector('#dlg-compose') as HTMLDialogElement).open);
    await forget(page);
    await page.locator('#line-text').focus();
    await page.keyboard.type('hi');
    assert.deepEqual(await frames(page), [], 'an ordinary line again: nothing is typed at the agent');
    assert.equal(await field(page), 'hi');
  });

  test('an insertion from the composer (✎ without Enter) ends the mode too', async () => {
    const page = await phone('composer-insert', 'claude');
    await page.keyboard.type('/a');
    await forget(page);
    await page.locator('#keys [data-k="compose"]').click();
    await page.locator('#compose-text').fill('hello');
    await page.locator('#compose-insert').click();
    await page.waitForFunction(() => window.__input.length > 0, undefined, {timeout: 30000});
    assert.equal(await direct(page), false);
  });

  test('files sent from the attachment menu (📎) end the mode', async () => {
    const page = await phone('attach', 'claude');
    await page.keyboard.type('/a');
    await forget(page);
    await page.locator('#keys [data-k="file"]').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#attach-menu [data-attach="file"]').click();
    await (await chooser).setFiles({name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('x')});
    await page.waitForFunction(() => window.__input.length > 0, undefined, {timeout: 30000});
    assert.equal(await direct(page), false);
    await forget(page);
    await page.locator('#line-text').focus();
    await page.keyboard.type('hi');
    assert.deepEqual(await frames(page), [], 'an ordinary line again');
  });
});
