// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The folder field of the "New session" dialog in the real interface, on a throwaway server whose launch
// settings allow one work folder (~/work): the list shows the allowed folder first, then its sub-folders
// (GET /api/dirs), never a folder outside it, walks down a typed path, is driven by the keyboard (arrows,
// Enter, Escape, and Tab which completes like a shell) with the combobox attributes kept current, opens on a
// click, a tap or a focus, renders folder names as text, shows the runner's recent folders on every browser,
// moves the recent folders an older version kept in a browser to the runner once, and has options large
// enough to tap and no horizontal overflow at 1440 and 390 px.
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
    for (const folder of ['work/alpha/inner', 'work/alpine', 'work/beta', `work/${HOSTILE}`, 'work/gamma', 'other/outside', 'dev/legacy']) {
      fs.mkdirSync(path.join(mesh.home, folder), {recursive: true});
    }
    // GET /api/dirs lists the sub-folders newest first: a fixed order
    ['alpha', 'alpine', 'beta', HOSTILE, 'gamma'].forEach((name, rank) => {
      const when = new Date(Date.UTC(2026, 0, 10 - rank));
      fs.utimesSync(path.join(work, name), when, when);
    });
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
    const page = await mesh.signIn(phone ? {width: 390, height: 844} : {width: 1440, height: 900}, undefined, undefined, {phone});
    pages.push(page);
    await page.evaluate(() => { void openNew(); });
    await page.locator('#dlg-new[open]').waitFor();
    await knownLoaded(page);
    return page;
  }

  /** The allowed folder (from GET /api/config) is in the list, shown or not: the dialog's requests have answered. */
  const knownLoaded = (page: Page) => page.waitForFunction(root => [...document.querySelectorAll('#new-folder-list [role="option"]')]
    .some(option => option.textContent === root), work, {polling: 100, timeout: 10000});

  function waitForOptions(page: Page, expected: string[]): Promise<unknown> {
    return page.waitForFunction(want => JSON.stringify([...document.querySelectorAll('#new-folder-list [role="option"]')]
      .map(option => option.textContent)) === want, JSON.stringify(expected), {polling: 100, timeout: 10000});
  }

  /** Replace the field's text by typing it, then wait until the list holds `expected`. */
  async function typeAndWait(page: Page, text: string, expected: string[]): Promise<void> {
    await field(page).fill('');
    await field(page).pressSequentially(text);
    await waitForOptions(page, expected);
  }

  const listed = [path.join(work, 'alpha'), path.join(work, 'alpine'), path.join(work, HOSTILE), path.join(work, 'gamma')];

  test('the allowed folder first, nothing outside it; arrows, Enter and Tab accept, Escape closes the list only', async () => {
    const page = await dialog();
    // Config roots can arrive before the directory scan and session recency.
    await waitForOptions(page, [work, path.join(work, 'beta'), ...listed]);
    await field(page).press('ArrowDown');
    assert.deepEqual(await options(page), [work, path.join(work, 'beta'), ...listed], 'roots, open sessions, then GET /api/dirs');
    assert.equal(await field(page).getAttribute('aria-expanded'), 'true');
    assert.equal(await field(page).getAttribute('aria-activedescendant'), 'new-folder-0');
    assert.equal(await page.locator('#new-folder-0').getAttribute('aria-selected'), 'true');

    await typeAndWait(page, '~/', ['~/work', path.join(work, 'beta'), ...listed]);   // ~/dev and ~/other are outside the allowed folder
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

  test('the folder a session started in comes back after the allowed folder (recorded by the runner)', async () => {
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

  test('a click opens the list, and so does reaching the field with Tab; the dialog opens with it closed', async () => {
    const page = await dialog();
    assert.equal(await listShown(page), false);
    await field(page).click();
    assert.equal(await listShown(page), true);
    assert.equal(await field(page).getAttribute('aria-expanded'), 'true');
    await field(page).press('Escape');
    assert.equal(await listShown(page), false);
    await page.locator('#form-new input[name="name"]').focus();   // the agent choices between them are labels, not stops
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'cwd');
    assert.equal(await listShown(page), true);
  });

  test('Tab completes the first suggestion that extends the text, like a shell, says so, and a second Tab moves on', async () => {
    const page = await dialog();
    const before = await field(page).inputValue();
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('name') ?? document.activeElement?.tagName);
    await field(page).click();
    await field(page).press('Tab');                     // nothing typed: the folder the dialog opened with is kept
    assert.equal(await field(page).inputValue(), before);
    assert.notEqual(await focused(), 'cwd');

    await typeAndWait(page, '~/work/alp', ['~/work/alpha', '~/work/alpine']);
    await field(page).press('Tab');
    assert.equal(await field(page).inputValue(), '~/work/alpha', 'the first suggestion');
    assert.equal(await focused(), 'cwd', 'the focus stays to go on typing');
    assert.equal(await listShown(page), false);
    assert.equal(await page.locator('#new-folder-status').textContent(), 'Folder completed: ~/work/alpha');
    assert.equal(await page.locator('#new-folder-status').getAttribute('aria-live'), 'polite');
    await field(page).press('Tab');                     // the list is closed: Tab moves on
    assert.notEqual(await focused(), 'cwd');
    assert.equal(await field(page).inputValue(), '~/work/alpha');

    // "~/work/api" matches alpine only by its letters in order: Tab moves on and keeps the text, whether the
    // listing of the new text has arrived or the list still shows the suggestions of "~/work/a" (debounce window)
    await field(page).fill('');
    await field(page).pressSequentially('~/work/a');
    await page.waitForFunction(() => [...document.querySelectorAll('#new-folder-list [role="option"]')].slice(0, 2)
      .map(option => option.textContent).join() === '~/work/alpha,~/work/alpine', undefined, {polling: 100, timeout: 10000});
    await field(page).pressSequentially('pi');
    await field(page).press('Tab');
    assert.equal(await field(page).inputValue(), '~/work/api', 'Tab never replaces the typed text with a fuzzy match');
    assert.notEqual(await focused(), 'cwd', 'it moves on');

    await typeAndWait(page, '~/work/alpine', ['~/work/alpine']);
    await field(page).press('Tab');                     // the field already holds the only suggestion: Tab moves on
    assert.notEqual(await focused(), 'cwd');

    await typeAndWait(page, '~/work/be', ['~/work/beta']);
    await field(page).press('Shift+Tab');               // Shift+Tab moves back, never completes
    assert.notEqual(await focused(), 'cwd');
    assert.equal(await field(page).inputValue(), '~/work/be');
  });

  test('the recent folders belong to the runner: a folder started from one browser is offered on another', async () => {
    const first = await dialog();
    await typeAndWait(first, '~/work/alpha/', ['~/work/alpha/inner']);
    await field(first).press('Tab');
    await first.locator('#form-new label', {has: first.locator('input[value="shell"]')}).click();
    await first.locator('#form-new button.primary').click();
    await first.locator('#dlg-new').waitFor({state: 'hidden'});
    assert.deepEqual(await first.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith('recentFolders'))), [],
      'nothing is kept in the browser');

    const phone = await dialog(true);
    await field(phone).tap();
    assert.deepEqual((await options(phone)).slice(0, 2), [work, path.join(work, 'alpha', 'inner')]);
  });

  test('the recent folders an older version kept in a browser move to the runner once; sign-in drops a copy', async () => {
    const page = await dialog();
    await page.evaluate(([gamma, home]) => localStorage.setItem('mesh.recentFolders', JSON.stringify([gamma, `${home}/missing`, 7])),
      [path.join(work, 'gamma'), mesh.home]);
    await page.reload();
    await page.waitForFunction(() => localStorage.getItem('mesh.recentFolders') === null, undefined, {timeout: 10000});
    const recent = await page.evaluate(async () =>
      ((await (await fetch('/api/config')).json()) as {runner_settings: {values: {recent_folders: string[]}}}).runner_settings.values.recent_folders);
    assert.equal(recent.at(-1), path.join(work, 'gamma'), JSON.stringify(recent));
    assert.ok(!recent.includes(path.join(mesh.home, 'missing')));

    await page.evaluate(() => localStorage.setItem('mesh.recentFolders', JSON.stringify(['/somewhere'])));
    await page.goto(`${mesh.base}/login`);
    assert.equal(await page.evaluate(() => localStorage.getItem('mesh.recentFolders')), null);
  });

  test('desktop: the open list leaves nothing overflowing', async () => {
    const page = await dialog();
    await field(page).click();
    assert.equal(await listShown(page), true);
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('#dlg-new')!;
      const box = document.querySelector('#new-folder-list')!.getBoundingClientRect();
      return {page: document.documentElement.scrollWidth - innerWidth, dialog: dialog.scrollWidth - dialog.clientWidth, right: box.right - innerWidth};
    });
    assert.ok(overflow.page <= 0 && overflow.dialog <= 0 && overflow.right <= 0, JSON.stringify(overflow));
  });
});
