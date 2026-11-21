// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The phone key bar never changes the soft keyboard's state by itself. A tap on a key of the bar
// leaves the focus where it was: on the input line (the keyboard stays as it is: open, or closed
// by the user while the line kept the focus), or anywhere else (no editable field takes it, so
// the keyboard does not come up). The key still reaches the terminal.
// A real soft keyboard cannot be emulated: these tests assert on the focus, which is what opens
// or keeps it. Taps are real touch taps (Input.dispatchTouchEvent), so the focus a tapped button
// would take is exercised as on a phone.
// Helpers: tests/phone-direct-line-lib.ts. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {skip} from './terminal-browser-lib.ts';
import {direct, forget, frames, keyboardOpen, useMesh, waitForShellLine} from './phone-direct-line-lib.ts';

const ARROWS = {up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C'} as const;
const OTHER_KEYS = {esc: '\x1b', tab: '\t'} as const;

/** Close the keyboard: the input line loses the focus, as when the user dismisses it on iOS. */
async function closeKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  assert.equal(await keyboardOpen(page), false);
}

/** Whether the focused element is one a soft keyboard opens for. xterm's helper textarea has
 * inputmode "none" on a touch device: it does not count. */
function editableFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    if (el.getAttribute('inputmode') === 'none') return false;
    return el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
  });
}

/** Count every time the input line loses the focus from now on (a blur, even a brief one, hides
 * the keyboard on a phone). */
async function watchLineBlur(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as {__lineBlurs: number};
    w.__lineBlurs = 0;
    document.querySelector('#line-text')!.addEventListener('blur', () => { w.__lineBlurs += 1; });
  });
  return () => page.evaluate(() => (window as unknown as {__lineBlurs: number}).__lineBlurs);
}

const viewportHeight = (page: Page): Promise<number> => page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
const tap = (page: Page, key: string): Promise<void> => page.locator(`#keys [data-k="${key}"]`).tap();
const ctrlArmed = async (page: Page): Promise<boolean> => (await page.locator('#keys [data-k="ctrl"].on').count()) === 1;

describe('phone key bar: a tap never changes the soft keyboard state', {skip}, () => {
  const {phone, desktop} = useMesh();

  test('keyboard closed: every arrow, Esc and Tab reach the program and no editable field takes the focus', async () => {
    const page = await phone('closed-keys', null);
    await closeKeyboard(page);
    const height = await viewportHeight(page);
    const keys = {...ARROWS, ...OTHER_KEYS};
    for (const [key, bytes] of Object.entries(keys)) {
      await forget(page);
      await tap(page, key);
      assert.deepEqual(await frames(page), [bytes], `${key} reached the terminal`);
      assert.equal(await editableFocused(page), false, `${key} left the keyboard closed`);
      assert.equal(await viewportHeight(page), height);
    }
  });

  test('keyboard open: every arrow keeps the input line focused, without even a brief blur', async () => {
    const page = await phone('open-keys', null);
    const blurs = await watchLineBlur(page);
    for (const [key, bytes] of Object.entries(ARROWS)) {
      await forget(page);
      await tap(page, key);
      assert.deepEqual(await frames(page), [bytes], `${key} reached the terminal`);
      assert.equal(await keyboardOpen(page), true, `${key} kept the line focused`);
    }
    assert.equal(await blurs(), 0, 'the line never lost the focus');
  });

  test('keyboard closed: ^C reaches the program and the keyboard stays closed', async () => {
    const page = await phone('closed-cc', null);
    await closeKeyboard(page);
    await forget(page);
    await tap(page, 'cc');
    assert.deepEqual(await frames(page), ['\x03']);
    assert.equal(await editableFocused(page), false);
  });

  test('Ctrl arms with the keyboard closed and stays armed until the user opens it and types', async () => {
    const page = await phone('closed-ctrl', null);
    await closeKeyboard(page);
    await tap(page, 'ctrl');
    assert.equal(await ctrlArmed(page), true);
    assert.equal(await editableFocused(page), false, 'arming Ctrl does not open the keyboard');
    await forget(page);
    await page.locator('#line-text').tap();   // the user opens the keyboard
    await page.keyboard.type('c');
    assert.deepEqual(await frames(page), ['\x03']);
    assert.equal(await ctrlArmed(page), false);
  });

  test('Ctrl arms with the keyboard open and the next letter is a control key', async () => {
    const page = await phone('open-ctrl', null);
    const blurs = await watchLineBlur(page);
    await tap(page, 'ctrl');
    assert.equal(await ctrlArmed(page), true);
    assert.equal(await keyboardOpen(page), true);
    await page.keyboard.type('c');
    assert.deepEqual(await frames(page), ['\x03']);
    assert.equal(await blurs(), 0);
  });

  test('direct writing goes on in both keyboard states', async () => {
    const page = await phone('direct-keys', 'claude');
    await page.keyboard.type('/a');
    await waitForShellLine(page, '/a');
    await forget(page);
    await tap(page, 'down');
    assert.equal(await keyboardOpen(page), true, 'open: the line keeps the focus');
    await closeKeyboard(page);
    await tap(page, 'up');
    assert.equal(await editableFocused(page), false, 'closed: the keyboard stays closed');
    assert.deepEqual(await frames(page), ['\x1b[B', '\x1b[A']);
    assert.equal(await direct(page), true);
  });

  test('keyboard open with a word still composing: the word goes first, then the key, and the line keeps the keyboard', async () => {
    const page = await phone('composing-key', 'claude');
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.type('/');
    await forget(page);
    await cdp.send('Input.imeSetComposition', {text: 'rev', selectionStart: 3, selectionEnd: 3});
    await tap(page, 'down');
    await page.waitForFunction(() => window.__input.length > 1);
    assert.deepEqual(await frames(page), ['rev', '\x1b[B']);
    assert.equal(await keyboardOpen(page), true);
  });

  test('✎ keeps the browser focus handling: the composer takes the focus and gives it back on close', async () => {
    const page = await phone('composer-focus', null);
    await closeKeyboard(page);
    await tap(page, 'compose');
    await page.waitForFunction(() => document.activeElement?.id === 'compose-text');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !(document.querySelector('#dlg-compose') as HTMLDialogElement).open);
    assert.equal(await editableFocused(page), false, 'the keyboard closed with the composer');
  });

  test('Paste with the keyboard closed reads the clipboard from the tap itself', async () => {
    const page = await phone('closed-paste', null);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('echo pasted'));
    await closeKeyboard(page);
    await forget(page);
    await tap(page, 'paste');
    await page.waitForFunction(() => window.__input.join('').includes('echo pasted'));
    assert.equal(await editableFocused(page), false);
  });

  test('desktop: no key bar and no input line, the terminal keeps the focus', async () => {
    const page = await desktop('desktop-keys', null);
    assert.equal(await page.locator('#keys').isHidden(), true);
    assert.equal(await page.locator('#line').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), true);
  });
});
