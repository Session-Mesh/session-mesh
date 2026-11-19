// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The folder field of the "New session" dialog in the real interface, on a throwaway server whose launch
// settings allow one work folder (~/work): the list shows the allowed folder first, never a folder outside
// it, walks down a typed path, is driven by the keyboard (arrows, Enter, Tab, Escape) with the combobox
// attributes kept current, renders folder names as text, remembers the folder a session started in, and on
// a touch phone opens on a tap with options large enough to tap and no horizontal overflow.
// Needs MESH_CHROMIUM and MESH_PTYHOST_CMD (skipped without the browser).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';

declare function openNew(): Promise<void>;

const HOSTILE = '<img src=x onerror=window.__folderXss=1>';
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-fold-'));
const settingsFile = path.join(settingsDir, 'launch.json');

describe('folder field of the New session dialog', {skip}, () => {
  const mesh = new TerminalMesh({MESH_LAUNCH_SETTINGS: settingsFile});
  const work = path.join(mesh.home, 'work');
  const pages: Page[] = [];

  before(async () => {
    for (const folder of ['work/alpha/inner', 'work/alpine', 'work/beta', `work/${HOSTILE}`, 'other/outside', 'dev/legacy']) {
      fs.mkdirSync(path.join(mesh.home, folder), {recursive: true});
    }
    fs.writeFileSync(settingsFile, JSON.stringify({v: 1, workspace_roots: [work], enabled_agents: ['claude']}));
    await mesh.start();
    const response = await fetch(`${mesh.base}/api/new`, {method: 'POST',
      body: JSON.stringify({preset: 'shell', cwd: path.join(work, 'beta'), name: 'base'}),
      headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'}});
    assert.equal(response.status, 200, `${await response.text()}\n${mesh.output}`);
  });
  after(async () => { await mesh.stop(); fs.rmSync(settingsDir, {recursive: true, force: true}); });
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  const field = (page: Page) => page.locator('#form-new input[name="cwd"]');
  const options = (page: Page) => page.locator('#new-folder-list [role="option"]').allTextContents();
  const listShown = (page: Page) => page.locator('#new-folder-list').isVisible();

  async function dialog(phone = false): Promise<Page> {
    const page = await mesh.signIn(phone ? {width: 390, height: 844} : {width: 1280, height: 800}, undefined, undefined, {phone});
    pages.push(page);
    await page.evaluate(() => { void openNew(); });
    await page.locator('#dlg-new[open]').waitFor();
    await knownLoaded(page);
    return page;
  }

  /** The allowed folder (from GET /api/config) is in the list, shown or not: the dialog's requests have answered. */
  const knownLoaded = (page: Page) => page.waitForFunction(root => [...document.querySelectorAll('#new-folder-list [role="option"]')]
    .some(option => option.textContent === root), work, {polling: 100, timeout: 10000});

  /** Replace the field's text by typing it, then wait until the list holds `expected`. */
  async function typeAndWait(page: Page, text: string, expected: string[]): Promise<void> {
    await field(page).fill('');
    await field(page).pressSequentially(text);
    await page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('#new-folder-list [role="option"]')]
      .map(option => option.textContent)) === want, JSON.stringify(expected), {polling: 100, timeout: 10000});
  }

  test('the allowed folder first, nothing outside it; arrows, Enter and Tab accept, Escape closes the list only', async () => {
    const page = await dialog();
    await field(page).press('ArrowDown');
    assert.deepEqual(await options(page), [work, path.join(work, 'beta')]);
    assert.equal(await field(page).getAttribute('aria-expanded'), 'true');
    assert.equal(await field(page).getAttribute('aria-activedescendant'), 'new-folder-0');
    assert.equal(await page.locator('#new-folder-0').getAttribute('aria-selected'), 'true');

    await typeAndWait(page, '~/', ['~/work', path.join(work, 'beta')]);   // ~/dev and ~/other are outside the allowed folder
    await typeAndWait(page, '~/work/al', ['~/work/alpha', '~/work/alpine']);
    assert.equal(await field(page).getAttribute('aria-activedescendant'), null);
    await field(page).press('ArrowDown');
    await field(page).press('ArrowDown');
    await field(page).press('ArrowUp');
    await field(page).press('Enter');
    assert.equal(await field(page).inputValue(), '~/work/alpha');
    assert.equal(await listShown(page), false);
    assert.equal(await page.locator('#dlg-new').evaluate((d: HTMLDialogElement) => d.open), true);   // Enter chose, did not submit

    await typeAndWait(page, '~/work/alpha/', ['~/work/alpha/inner']);
    await field(page).press('ArrowDown');
    await field(page).press('Tab');
    assert.equal(await field(page).inputValue(), '~/work/alpha/inner');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'cwd');

    await typeAndWait(page, '~/work/be', ['~/work/beta']);
    await field(page).press('Escape');
    assert.equal(await listShown(page), false);
    assert.equal(await page.locator('#dlg-new').evaluate((d: HTMLDialogElement) => d.open), true);
    await field(page).press('Escape');
    assert.equal(await page.locator('#dlg-new').evaluate((d: HTMLDialogElement) => d.open), false);
  });

  test('a folder name is shown as text, never as markup', async () => {
    const page = await dialog();
    await typeAndWait(page, '~/work/<', [`~/work/${HOSTILE}`]);
    assert.equal(await page.locator('#new-folder-list img').count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as {__folderXss?: number}).__folderXss), undefined);
  });

  test('the folder a session started in comes back after the allowed folder', async () => {
    const page = await dialog();
    await typeAndWait(page, '~/work/alpi', ['~/work/alpine']);
    await field(page).press('ArrowDown');
    await field(page).press('Enter');
    await field(page).press('Enter');                                   // the list is closed: this submits
    await page.locator('#dlg-new').waitFor({state: 'hidden'});
    await page.evaluate(() => { void openNew(); });
    await knownLoaded(page);
    await field(page).press('ArrowDown');
    assert.deepEqual((await options(page)).slice(0, 2), [work, path.join(work, 'alpine')]);
  });

  test('phone: a tap opens the list, options are tall enough to tap, nothing overflows', async () => {
    const page = await dialog(true);
    await field(page).tap();
    assert.equal(await listShown(page), true);
    const shown = await options(page);   // the sessions of the earlier tests may add their folders
    assert.equal(shown[0], work);
    assert.ok(shown.includes(path.join(work, 'beta')), JSON.stringify(shown));
    const sizes = await page.evaluate(() => {
      const shownOptions = [...document.querySelectorAll('#new-folder-list [role="option"]')];
      const heights = shownOptions.map(o => o.getBoundingClientRect().height);
      const minHeights = shownOptions.map(o => getComputedStyle(o).minHeight);   // one-line paths too, not only wrapped ones
      const box = document.querySelector('#new-folder-list')!.getBoundingClientRect();
      const dialogBox = document.querySelector('#dlg-new')!;
      return {heights, minHeights, right: box.right, width: innerWidth, dialogScroll: dialogBox.scrollWidth - dialogBox.clientWidth,
        pageScroll: document.documentElement.scrollWidth - innerWidth};
    });
    assert.ok(sizes.heights.every(height => height >= 44), JSON.stringify(sizes));
    assert.ok(sizes.minHeights.every(height => height === '44px'), JSON.stringify(sizes));
    assert.ok(sizes.right <= sizes.width, JSON.stringify(sizes));
    assert.ok(sizes.dialogScroll <= 0 && sizes.pageScroll <= 0, JSON.stringify(sizes));
    await typeAndWait(page, '~/work/be', ['~/work/beta']);
    await page.locator('#new-folder-list [role="option"]', {hasText: '~/work/beta'}).tap();
    assert.equal(await field(page).inputValue(), '~/work/beta');
    assert.equal(await listShown(page), false);
  });
});
