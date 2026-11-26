// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone direct writing, the key bar: every key that writes into the agent's line (Esc, Tab, the
// arrows, ↵ line, Ctrl, Paste) follows the rule of Enter. Nothing goes before the text the field
// still holds, nothing goes after a text that was not delivered as typed, and the key is refused
// while a word is being composed. A key bar tap is a real tap in the first cases: the tap itself
// ends a keyboard composition, so the word and the key meet in the same task.
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {skip} from './terminal-browser-lib.ts';
import {
  direct, field, flashed, foreground, forget, frames, useMesh, waitForFlash, waitForShellLine,
} from './phone-direct-line-lib.ts';

// The bytes each key of the bar sends to a Claude Code session.
const KEY_BYTES = {tab: '\t', left: '\x1b[D', esc: '\x1b', nl: '\x1b\r'} as const;
type BarKey = keyof typeof KEY_BYTES;
const BAR_KEYS = Object.keys(KEY_BYTES) as BarKey[];

/** Compose `word` in the field, then press `key` of the bar in the same task: the composition
 * ended (its flush waits for the next task) or, with `ended` false, is still in progress. */
async function composeThenKey(page: Page, word: string, key: string, ended: boolean): Promise<void> {
  await page.evaluate(({word, key, ended}) => {
    const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    textarea.value = word;
    if (ended) textarea.dispatchEvent(new CompositionEvent('compositionend', {data: word, bubbles: true}));
    document.querySelector<HTMLElement>(`#keys [data-k="${key}"]`)!.click();
  }, {word, key, ended});
}

describe('phone direct writing: the key bar follows the rule of Enter', {skip}, () => {
  const {phone, withoutBracketedPaste} = useMesh();

  for (const key of BAR_KEYS) {
    test(`${key} right after a composition ended delivers the word first, then the key, and keeps the mode`, async () => {
      const page = await phone(`ended-${key}`, 'claude');
      await page.keyboard.type('/');
      await waitForShellLine(page, '/');
      await forget(page);
      await composeThenKey(page, 'help', key, true);
      await page.waitForFunction(() => window.__input.length >= 2);
      assert.deepEqual(await frames(page), ['help', KEY_BYTES[key]], 'the word, in order, before the key');
      assert.equal(await field(page), '');
      assert.equal(await direct(page), true);
      await page.waitForTimeout(200);   // the composition's own late flush finds nothing left
      assert.deepEqual(await frames(page), ['help', KEY_BYTES[key]]);
    });

    test(`${key} while a composition is in progress is refused, and the word is sent once when it ends`, async () => {
      const page = await phone(`composing-${key}`, 'claude');
      await page.keyboard.type('/');
      await waitForShellLine(page, '/');
      await forget(page);
      await composeThenKey(page, 'help', key, false);
      await waitForFlash(page, 'still being composed');
      assert.deepEqual(await frames(page), [], 'no key before the word');
      assert.equal(await field(page), 'help', 'the composition is left alone');
      assert.equal(await direct(page), true);
      await page.evaluate(() => {   // the keyboard commits the word
        document.querySelector('#line-text')!.dispatchEvent(new CompositionEvent('compositionend', {data: 'help', bubbles: true}));
      });
      await waitForShellLine(page, '/help');
      assert.deepEqual(await frames(page), ['help'], 'once');
    });

    test(`a real tap on ${key} after a real keyboard composition never overtakes the word`, async () => {
      const page = await phone(`tap-${key}`, 'claude');
      const cdp = await page.context().newCDPSession(page);
      await page.keyboard.type('/');
      await waitForShellLine(page, '/');
      await forget(page);
      await cdp.send('Input.imeSetComposition', {text: 'rev', selectionStart: 3, selectionEnd: 3});
      await page.locator(`#keys [data-k="${key}"]`).tap();
      await page.waitForFunction(() => window.__input.length >= 2);
      await page.waitForTimeout(300);
      assert.deepEqual(await frames(page), ['rev', KEY_BYTES[key]], 'the word first, then the key');
      assert.equal(await field(page), '');
    });
  }

  test('held text that is refused stops Enter and the keys: nothing is sent after it, and the message says so', async () => {
    for (const via of ['enter', 'tab', 'nl'] as const) {
      const page = await phone(`refused-${via}`, 'claude');
      await page.keyboard.type('/rev');
      await waitForShellLine(page, '/rev');
      await forget(page);
      await composeThenKey(page, 'iew\u0001', via, true);
      await waitForFlash(page, 'not delivered as typed');
      const message = await flashed(page);
      assert.ok(message.includes('control characters'), message);
      assert.deepEqual(await frames(page), [], `no ${via} after the refused text`);
      assert.equal(await page.locator('#line + section pre').textContent(), 'iew\u0001', 'the refused text remains available for review');
      assert.equal(await page.locator('#line-text').getAttribute('readonly'), '', 'recovery prevents accidental submission');
      assert.equal(await direct(page), false, 'direct mode ends while the refused text is reviewed');
    }
  });

  test('held multi-line text without bracketed paste is refused and stops Enter', async () => {
    const page = await phone('refused-multiline', 'claude');
    await withoutBracketedPaste(page);   // a program is running in the shell: it did not ask for bracketed paste
    await page.keyboard.type('/rev');
    await waitForShellLine(page, '/rev');
    await forget(page);
    await composeThenKey(page, 'iew\tx', 'enter', true);
    await waitForFlash(page, 'not delivered as typed');
    assert.ok((await flashed(page)).includes('bracketed paste'));
    assert.deepEqual(await frames(page), []);
    assert.equal(await page.locator('#line + section pre').textContent(), 'iew\tx', 'the refused text remains available for review');
    assert.equal(await page.locator('#line-text').getAttribute('readonly'), '', 'recovery prevents accidental submission');
    assert.equal(await direct(page), false);
  });

  test('held text that cannot be delivered stops the keys too', async () => {
    const page = await phone('held-fails', 'claude');
    await page.keyboard.type('/');
    await waitForShellLine(page, '/');
    await forget(page);
    await page.evaluate(() => {   // acknowledged input cannot retain the held text, so the key must not follow
      (active as unknown as {inputAck: {write: () => boolean}}).inputAck.write = () => false;
    });
    await composeThenKey(page, 'help', 'tab', true);
    await waitForFlash(page, 'not delivered as typed');
    assert.ok((await flashed(page)).includes('keys not delivered'));
    assert.deepEqual(await frames(page), [], 'no Tab after the word that did not go');
    assert.equal(await direct(page), false);
  });

  test('a key of the bar checks the foreground first: an agent that left gets nothing', async () => {
    for (const key of ['tab', 'nl'] as const) {
      const page = await phone(`left-${key}`, 'claude');
      await page.keyboard.type('/a');
      await waitForShellLine(page, '/a');
      await forget(page);
      // Starting the mode fired a refresh that is still in flight: answered while the agent was
      // there, it would restore the foreground the page is about to lose. A refresh of our own is
      // awaited: the poller answers it after the request in flight, so both are applied before it.
      await page.evaluate('refresh()');
      foreground.set(`left-${key}`, null);
      await page.evaluate(id => {   // the inventory the page holds says the agent is gone
        (find(id) as unknown as {agent: {foreground: boolean}}).agent.foreground = false;
      }, `left-${key}`);
      await page.locator(`#keys [data-k="${key}"]`).click();
      assert.deepEqual(await frames(page), [], `${key} is not sent`);
      assert.equal(await direct(page), false);
      assert.ok((await flashed(page)).includes('no longer in the foreground'));
    }
  });

  test('arming Ctrl delivers the held word first, so it is not taken for a control letter', async () => {
    const page = await phone('ctrl-held', 'claude');
    await page.keyboard.type('/');
    await waitForShellLine(page, '/');
    await forget(page);
    await composeThenKey(page, 'r', 'ctrl', true);
    await page.waitForFunction(() => window.__input.length >= 1);
    assert.deepEqual(await frames(page), ['r'], 'the letter went as typed, not as ^R');
    assert.equal(await page.locator('#keys [data-k="ctrl"].on').count(), 1, 'Ctrl is armed once the word went');
    assert.equal(await direct(page), true);
  });

  test('arming Ctrl while a word is being composed is refused', async () => {
    const page = await phone('ctrl-composing', 'claude');
    await page.keyboard.type('/');
    await waitForShellLine(page, '/');
    await forget(page);
    await composeThenKey(page, 'r', 'ctrl', false);
    await waitForFlash(page, 'still being composed');
    assert.equal(await page.locator('#keys [data-k="ctrl"].on').count(), 0, 'Ctrl is not armed');
    assert.deepEqual(await frames(page), []);
  });

  test('^C of the bar delivers the held word first, then ends the mode', async () => {
    const page = await phone('cc-held', 'claude');
    await page.keyboard.type('/');
    await waitForShellLine(page, '/');
    await forget(page);
    await composeThenKey(page, 'help', 'cc', true);
    await page.waitForFunction(() => window.__input.length >= 2);
    assert.deepEqual(await frames(page), ['help', '\x03']);
    assert.equal(await direct(page), false);
  });

  test('Paste delivers the held word first, then the clipboard, and is refused while a word is being composed', async () => {
    const page = await phone('paste-held', 'claude');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('xyz'));
    await page.keyboard.type('/');
    await waitForShellLine(page, '/');
    await forget(page);
    await composeThenKey(page, 'help', 'paste', false);
    await waitForFlash(page, 'still being composed');
    assert.deepEqual(await frames(page), [], 'nothing goes before the word being composed');
    await page.evaluate(() => {   // the keyboard commits, the word goes; the paste is tapped again
      document.querySelector('#line-text')!.dispatchEvent(new CompositionEvent('compositionend', {data: 'help', bubbles: true}));
    });
    await waitForShellLine(page, '/help');
    await composeThenKey(page, 'er', 'paste', true);
    await waitForShellLine(page, '/helperxyz');
    const sent = (await frames(page)).join('');
    assert.ok(sent.startsWith('helper') && sent.includes('xyz'), `the held word before the paste: ${JSON.stringify(sent)}`);
  });
});
