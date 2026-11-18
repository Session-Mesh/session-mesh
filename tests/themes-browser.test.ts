// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Colour themes in a real page: the footer selector repaints the page and the open terminal
// without a reload, the choice is applied before the body is parsed on the next load (no flash
// of the default theme), and the custom palette dialog is validated, applied
// to the terminal and reset. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {DESKTOP, PHONE} from './phone-direct-line-lib.ts';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';

declare const active: {term: {options: {theme: Record<string, string>}}} | null;
declare global {
  // eslint-disable-next-line no-var
  var __themeAtBody: string | undefined;
}

// Records the theme the page carries when <body> first appears, before any of it is painted.
const RECORD_THEME_AT_BODY = (): void => {
  new MutationObserver((_, observer) => {
    if (!document.body) return;
    window.__themeAtBody = document.documentElement.dataset['theme'] ?? 'none';
    observer.disconnect();
  }).observe(document, {childList: true, subtree: true});
};

const terminalBackground = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => active?.term.options.theme['background']);
const bodyBackground = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

describe('colour themes', {skip}, () => {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  let counter = 0;
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  async function open(phone = false): Promise<Page> {
    const name = `themes-${counter += 1}`;
    await mesh.newShell(name);
    const page = await mesh.openPage(name, phone ? PHONE : DESKTOP, RECORD_THEME_AT_BODY, undefined, {phone});
    pages.push(page);
    return page;
  }

  test('the selector repaints the page and the open terminal, and the choice survives a reload', async () => {
    const page = await open();
    assert.equal(await page.evaluate(() => document.documentElement.dataset['theme']), 'default');
    assert.equal(await terminalBackground(page), '#0d1117');
    const offered = await page.locator('#theme-select option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value));
    assert.deepEqual(offered, ['default', 'light', 'solarized-dark', 'solarized-light', 'gruvbox-dark', 'nord', 'palette']);

    await page.locator('#theme-select').selectOption('solarized-dark');
    assert.equal(await bodyBackground(page), 'rgb(0, 43, 54)');
    assert.equal(await terminalBackground(page), '#002b36');
    assert.equal(await page.evaluate(() => localStorage.getItem('mesh.theme')), '"solarized-dark"');

    await page.reload();
    await page.waitForFunction(() => active?.term != null, undefined, {timeout: 30000});
    assert.equal(await page.evaluate(() => window.__themeAtBody), 'solarized-dark', 'applied before the body is parsed');
    assert.equal(await page.locator('#theme-select').inputValue(), 'solarized-dark');
    assert.equal(await terminalBackground(page), '#002b36', 'a terminal created after the load starts in the theme');
  });

  test('the custom palette is validated, reaches the terminal and resets', async () => {
    const page = await open();
    await page.locator('#theme-select').selectOption('palette');
    await page.locator('#dlg-palette[open]').waitFor();
    assert.equal(await page.locator('#theme-select').inputValue(), 'default', 'the entry only opens the editor');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'palette-text');

    await page.locator('#palette-text').fill('{"--term": "#101010", "--bogus": "#000", "--fg": "url(x)"}');
    await page.locator('#palette-apply').click();
    assert.match(await page.locator('#palette-status').textContent() ?? '', /--bogus.*--fg/);
    assert.equal(await page.locator('#palette-status.bad').count(), 1);
    assert.equal(await terminalBackground(page), '#0d1117', 'nothing applied');

    await page.locator('#palette-text').fill('{"--term": "#101010", "--ansi-red": "#FF0000"}');
    await page.locator('#palette-apply').click();
    assert.equal(await terminalBackground(page), '#101010');
    assert.equal(await page.evaluate(() => active?.term.options.theme['red']), '#ff0000');
    assert.equal(await page.evaluate(() => localStorage.getItem('mesh.palette')), '{"--term":"#101010","--ansi-red":"#ff0000"}');
    assert.match(await page.locator('#theme-select option[value="default"]').textContent() ?? '', /\+/);

    await page.locator('#palette-reset').click();
    assert.equal(await terminalBackground(page), '#0d1117');
    assert.equal(await page.evaluate(() => localStorage.getItem('mesh.palette')), null);
    assert.equal(await page.locator('#palette-text').inputValue(), '{}');
  });

  test('on a phone the selector sits in the sidebar footer without widening the page', async () => {
    const page = await open(true);
    await page.locator('#btn-menu').click();
    const select = page.locator('#theme-select');
    await select.waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#side')!.getBoundingClientRect().left >= 0);
    const box = await select.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= PHONE.width, JSON.stringify(box));
    await select.selectOption('light');
    assert.equal(await bodyBackground(page), 'rgb(238, 241, 245)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  });
});
