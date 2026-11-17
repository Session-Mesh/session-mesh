// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone direct writing, ordering and ownership: a composed word belongs to the pane it was
// composed on, a key typed while the bar's Paste reads the clipboard is not overtaken by the
// paste, and Ctrl armed with a held composed letter sends nothing after the control key.
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {skip} from './terminal-browser-lib.ts';
import {direct, field, foreground, forget, frames, useMesh, waitForFlash} from './phone-direct-line-lib.ts';

declare function addPane(id: string): unknown;
declare function setActive(pane: unknown): void;
declare function refresh(): Promise<void>;
declare const panes: Array<{id: string; conn?: {terminal?: {isOpen(): boolean}}}>;

describe('phone direct writing: ordering and ownership', {skip}, () => {
  const {mesh, phone} = useMesh();

  test('a word composed on one pane does not start direct writing on another', async () => {
    const page = await phone('own-a', 'claude');
    foreground.set('own-b', 'claude');
    await mesh.newShell('own-b');
    await page.evaluate(() => refresh());
    await page.evaluate(() => addPane('own-b'));
    await page.waitForFunction(() => panes.length === 2 && panes.every(p => p.conn?.terminal?.isOpen()), null, {timeout: 10000});
    await page.evaluate(() => setActive(panes.find(p => p.id === 'own-a')));
    await page.locator('#line-text').focus();
    await forget(page);
    await page.evaluate(() => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      textarea.value = '/bc';
      setActive(panes.find(p => p.id === 'own-b'));   // the pane changes before the keyboard commits
      textarea.dispatchEvent(new CompositionEvent('compositionend', {data: '/bc', bubbles: true}));
    });
    await page.waitForTimeout(300);
    assert.deepEqual(await frames(page), [], 'nothing reaches either pane');
    assert.equal(await direct(page), false, 'the mode did not start');
    assert.equal(await field(page), '/bc', 'the word stays in the field');
  });

  test('a key typed while the bar\'s Paste reads the clipboard is not followed by the paste', async () => {
    const page = await phone('slow-paste', 'claude');
    await page.keyboard.type('/');
    await forget(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {configurable: true,
        value: {readText: () => new Promise(resolve => setTimeout(() => resolve('PASTED'), 400))}});
      document.querySelector<HTMLElement>('#keys [data-k="paste"]')!.click();
    });
    await page.locator('#line-text').focus();
    await page.keyboard.type('x');
    await waitForFlash(page, 'paste not sent');
    const sent = (await frames(page)).join('');
    assert.equal(sent, 'x', `only the key went, never the paste: ${JSON.stringify(sent)}`);
  });

  test('Ctrl armed with a composed letter held, then Tab: nothing follows the control key and the mode ends', async () => {
    const page = await phone('ctrl-tab', 'claude');
    await page.keyboard.type('/');
    await page.locator('#keys [data-k="ctrl"]').click();
    await forget(page);
    await page.evaluate(() => {
      const textarea = document.querySelector('#line-text') as HTMLTextAreaElement;
      textarea.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      textarea.value = 'c';
      textarea.dispatchEvent(new CompositionEvent('compositionend', {data: 'c', bubbles: true}));
      document.querySelector<HTMLElement>('#keys [data-k="tab"]')!.click();
    });
    await page.waitForTimeout(300);
    assert.deepEqual(await frames(page), ['\x03'], 'the control key, and no Tab after it');
    assert.equal(await direct(page), false, 'the control key ended the mode');
    assert.equal(await page.locator('#keys [data-k="ctrl"].on').count(), 0, 'Ctrl is disarmed');
  });
});
