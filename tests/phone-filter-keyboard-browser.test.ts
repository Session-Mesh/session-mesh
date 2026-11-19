// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sessions filter on a phone. Tapping it opens the soft keyboard; with
// `interactive-widget=resizes-content` the keyboard shrinks the layout viewport and the window
// fires `resize`. The sidebar must stay open, with the filter focused, so the list it filters
// stays in sight. A change of width (a rotation, a window resized) still closes the sidebar.
// The keyboard is emulated by shrinking the viewport's height. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {PHONE} from './phone-direct-line-lib.ts';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';

const KEYBOARD_HEIGHT = 340;

describe('phone sessions filter with the soft keyboard', {skip}, () => {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  let counter = 0;
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  /** A phone page with a session open, then a second session in the list; the sidebar is closed. */
  async function open(): Promise<{page: Page; other: string}> {
    counter += 1;
    const name = `filter-open-${counter}`;
    const other = `filter-other-${counter}`;
    await mesh.newShell(name);
    await mesh.newShell(other);
    const page = await mesh.openPage(name, PHONE, undefined, undefined, {phone: true});
    pages.push(page);
    await page.waitForFunction(() => !document.body.classList.contains('drawer'), undefined, {timeout: 5000});
    await page.locator(`#list .item[data-id="${other}"]`).waitFor({state: 'attached', timeout: 10000});
    return {page, other};
  }

  const drawerOpen = (page: Page): Promise<boolean> =>
    page.evaluate(() => document.body.classList.contains('drawer'));
  const filterFocused = (page: Page): Promise<boolean> =>
    page.evaluate(() => document.activeElement === document.querySelector('#filter'));
  /** The sidebar's left edge is on screen (it slides out to the left when closed). */
  const sideOnScreen = (page: Page): Promise<boolean> =>
    page.evaluate(() => document.querySelector('#side')!.getBoundingClientRect().left >= 0);

  async function tapFilterWithKeyboard(page: Page): Promise<void> {
    await page.locator('#btn-menu').tap();
    await page.waitForFunction(() => document.body.classList.contains('drawer'), undefined, {timeout: 5000});
    await page.locator('#filter').tap();
    assert.equal(await filterFocused(page), true, 'the tap focuses the filter');
    await page.setViewportSize({width: PHONE.width, height: PHONE.height - KEYBOARD_HEIGHT});
    await page.waitForTimeout(400);
  }

  test('the keyboard opening keeps the sidebar and the filter in sight', async () => {
    const {page, other} = await open();
    await tapFilterWithKeyboard(page);
    assert.equal(await drawerOpen(page), true, 'the sidebar is still open');
    assert.equal(await filterFocused(page), true, 'the filter keeps the focus');
    await page.waitForFunction(() => document.querySelector('#side')!.getBoundingClientRect().left >= 0, undefined, {timeout: 2000});
    await page.keyboard.type(other);
    await page.waitForTimeout(300);
    const shown = await page.locator('#list .item[data-id]').evaluateAll(items => items.map(item => item.getAttribute('data-id')));
    assert.deepEqual(shown, [other], 'the filtered list is the one on screen');
    assert.equal(await sideOnScreen(page), true);
    // the keyboard closing (the height comes back) keeps it too
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(400);
    assert.equal(await drawerOpen(page), true, 'still open after the keyboard closes');
  });

  test('a change of width still closes the sidebar', async () => {
    const {page} = await open();
    await tapFilterWithKeyboard(page);
    assert.equal(await drawerOpen(page), true);
    await page.setViewportSize({width: PHONE.height - KEYBOARD_HEIGHT, height: PHONE.width});
    await page.waitForFunction(() => !document.body.classList.contains('drawer'), undefined, {timeout: 5000});
  });
});
