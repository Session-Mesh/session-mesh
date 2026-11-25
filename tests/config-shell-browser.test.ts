// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The layout of the "Configuration" dialog: a sidebar of sections and a grid of cards on a wide
// window, a list that opens one section at a time on a phone. Run in headless Chromium on a
// throwaway server.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure). MESH_SHOT_DIR=<dir> also saves screenshots of the dialog at each width.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {REPO, type Mesh} from './mesh-server-lib.ts';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
import {SECTIONS, showSection} from './helpers/config-sections.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const LOCALES = [['en-US', 'en'], ['fr-FR', 'fr']] as const;
const SIDEBAR_WIDTHS = [1440, 900];

let lab: AgentMesh;
let mesh: Mesh;
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  if (skip) return;
  lab = await AgentMesh.start('cfgshell-', ['alpha']);
  mesh = lab.mesh;
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  await lab?.stop();
});

async function signedIn(locale: string, width: number, height = 900): Promise<{page: Page; problems: string[]}> {
  const context = await browser.newContext({locale, viewport: {width, height}});
  contexts.push(context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) problems.push(message.text()); });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForSelector('#btn-config', {state: 'attached'});
  return {page, problems};
}

async function openConfig(page: Page, width: number): Promise<void> {
  if (width <= 760) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-config"]').click();
  } else {
    await page.locator('#btn-config').click();
  }
  await page.locator('#dlg-config[open] .config-shell').waitFor();
}

async function fits(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const box = document.querySelector('#dlg-config') as HTMLElement;
    const rect = box.getBoundingClientRect();
    const wide = [...box.querySelectorAll<HTMLElement>('.config-card, .config-cards, .config-nav, .config-value, .config-row')]
      .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className);
    return {document: document.documentElement.scrollWidth <= innerWidth, dialog: box.scrollWidth <= box.clientWidth,
      inside: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight + 1, wide};
  });
  assert.deepEqual(result, {document: true, dialog: true, inside: true, wide: []});
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, {recursive: true});
  // The dialog only: the page behind it lists this machine's real sessions.
  await page.locator('#dlg-config').screenshot({path: path.join(SHOTS, `${name}.png`)});
}

const visible = (page: Page, selector: string): Promise<boolean> => page.locator(selector).first().isVisible();
const focusedSection = (page: Page): Promise<string | null> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.sectionId ?? null);

describe('the Configuration dialog layout', {skip}, () => {
  for (const width of [900, 390]) test(`an early configuration click waits for translations at ${width}px`, async () => {
    const context = await browser.newContext({locale: 'en-US', viewport: {width, height: 844}});
    contexts.push(context);
    const page = await context.newPage();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const seen = new Promise<void>(resolve => { requested = resolve; });
    try {
      await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
      await page.route(/\/static\/i18n\/en\.json(?:\?|$)/, async route => { requested(); await gate; await route.continue(); });
      await page.goto(`${mesh.base}/`, {waitUntil: 'domcontentloaded'});
      await seen;
      if (width === 390) {
        await page.locator('#btn-mobile-actions').click();
        await page.locator('[data-mobile-action="btn-config"]').click();
      } else await page.locator('#btn-config').click();
      assert.equal(await page.locator('#dlg-config').evaluate((node: HTMLDialogElement) => node.open), false);
      release();
      await page.locator('#dlg-config[open] .config-shell').waitFor();
      const names = await page.locator('.config-nav-button').allInnerTexts();
      assert.equal(names.length, SECTIONS.length);
      assert.ok(names.every(name => name !== '' && !/config\.[a-z]/.test(name)), names.join('|'));
    } finally { release(); }
  });
  test('a stalled translation opens usable English settings and never reopens after closing', async () => {
    const context = await browser.newContext({locale: 'en-US', viewport: {width: 900, height: 900}});
    contexts.push(context);
    const page = await context.newPage();
    let release!: () => void, requested!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { requested = resolve; });
    try {
      await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
      await page.route(/\/static\/i18n\/en\.json(?:\?|$)/, async route => { requested(); await gate; await route.continue(); });
      await page.goto(`${mesh.base}/`, {waitUntil: 'domcontentloaded'});
      await seen;
      await page.locator('#btn-config').click();
      await page.locator('#flash[role=status]').filter({hasText: 'Opening configuration in English'}).waitFor({timeout: 6000});
      await page.locator('#dlg-config[open] .config-shell').waitFor();
      assert.equal((await page.locator('.config-nav-button').allInnerTexts())[0], 'Appearance');
      await page.locator('.config-nav-button').filter({hasText: 'System'}).click();
      assert.equal(await page.locator('.config-nav-button[aria-current]').innerText(), 'System');
      await page.locator('#dlg-config [data-close-dialog]').click();
      assert.equal(await page.locator('#dlg-config').evaluate((node: HTMLDialogElement) => node.open), false);
      release();
      await page.waitForFunction(() => (window as unknown as {MeshI18n: {loaded: boolean}}).MeshI18n.loaded);
      assert.equal(await page.locator('#dlg-config').evaluate((node: HTMLDialogElement) => node.open), false);
      await page.locator('#btn-config').click();
      await page.locator('#dlg-config[open] .config-shell').waitFor();
    } finally { release(); }
  });
  test('offline configuration strings match the English catalog', async () => {
    const source = fs.readFileSync(path.join(REPO, 'static/i18n/en.json'), 'utf8');
    const expected = Object.fromEntries(Object.entries(JSON.parse(source)).filter(([key]) => key.startsWith('config.') || key.startsWith('common.')));
    const {page} = await signedIn('en-US', 900);
    const actual = await page.evaluate(() => (window as unknown as {MeshConfigFallback: unknown}).MeshConfigFallback);
    assert.deepEqual(actual, expected);
  });
  for (const broken of ['404', 'invalid-json']) test(`configuration falls back when both English loads return ${broken}`, async () => {
    const context = await browser.newContext({locale: 'en-US', viewport: {width: 900, height: 900}});
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    let attempts = 0;
    await page.route(/\/static\/i18n\/en\.json(?:\?|$)/, async route => {
      attempts++;
      await route.fulfill(broken === '404' ? {status: 404, body: ''} : {status: 200, body: '{'});
    });
    await page.goto(`${mesh.base}/`);
    await page.waitForFunction(() => (window as unknown as {MeshI18n: {loaded: boolean}}).MeshI18n.loaded);
    assert.equal(attempts, 2);
    await page.locator('#btn-config').click();
    await page.locator('#dlg-config[open] .config-shell').waitFor();
    assert.equal((await page.locator('.config-nav-button').allInnerTexts())[0], 'Appearance');
    await page.locator('.config-nav-button').filter({hasText: 'System'}).click();
    const label = await page.locator('.config-copy').first().getAttribute('aria-label');
    assert.match(label ?? '', /^Copy: .+/);
    assert.ok(!label?.includes('{label}'));
  });
  for (const [locale, code] of LOCALES) {
    for (const width of [1440, 900, 390]) {
      test(`fits and lays out its sections at ${width}px, ${code}`, async () => {
        const {page, problems} = await signedIn(locale, width, width === 390 ? 844 : 900);
        await openConfig(page, width);
        const names = await page.locator('.config-nav-button').allInnerTexts();
        assert.equal(names.length, SECTIONS.length);
        assert.ok(names.every(name => name !== '' && !/config\.[a-z]/.test(name)), names.join('|'));
        assert.equal(names[0], code === 'fr' ? 'Apparence' : 'Appearance');
        await fits(page);
        if (width === 390) {
          assert.equal(await visible(page, '.config-nav'), true, 'the list of sections is the first screen');
          assert.equal(await visible(page, '.config-panel'), false, 'and nothing else is shown yet');
          const boxes = await page.locator('.config-nav-button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
          assert.equal(new Set(boxes.map(box => Math.round(box.left))).size, 1, 'a single column');
          assert.ok(boxes.every(box => box.height >= 44), 'touch-sized rows');
          await shot(page, `config-${width}-${code}-list`);
        } else {
          assert.equal(await visible(page, '.config-nav'), true, 'the sidebar is visible');
          assert.equal(await visible(page, '.config-panel'), true);
          const box = await page.locator('#dlg-config').boundingBox();
          assert.ok(box!.width > 600, `a wide dialog, not the old narrow column: ${box!.width}`);
        }
        for (const id of ['system', 'agents'] as const) {
          await showSection(page, id);
          await fits(page);
          await shot(page, `config-${width}-${code}-${id}`);
        }
        assert.deepEqual(problems, []);
      });
    }
  }

  test('lays the cards of a section out as a grid of at least two columns at 1440px', async () => {
    const {page} = await signedIn('en-US', 1440);
    await openConfig(page, 1440);
    await showSection(page, 'system');
    const columns = await page.locator('.config-cards').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.ok(columns >= 2, `columns: ${columns}`);
    const lefts = await page.locator('.config-card').evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left))).size);
    assert.ok(lefts >= 2, 'cards sit side by side');
  });

  test('exposes the navigation to assistive technology and names the dialog by its title', async () => {
    const {page} = await signedIn('en-US', 1440);
    await openConfig(page, 1440);
    const roles = await page.evaluate(() => {
      const dialog = document.querySelector('#dlg-config') as HTMLElement;
      const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent;
      const nav = dialog.querySelector('nav')!;
      const panel = dialog.querySelector('.config-panel')!;
      return {title, navLabel: nav.getAttribute('aria-label'), current: [...nav.querySelectorAll('[aria-current]')].map(node => node.textContent),
        panelName: document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent, tabStops: nav.querySelectorAll('button:not([tabindex="-1"])').length};
    });
    assert.deepEqual(roles, {title: 'Configuration', navLabel: 'Configuration sections', current: ['Appearance'], panelName: 'Appearance', tabStops: 1});
  });

  for (const width of SIDEBAR_WIDTHS) {
    test(`switches sections with the mouse and the keyboard at ${width}px`, async () => {
      const {page} = await signedIn('en-US', width);
      await openConfig(page, width);
      await page.locator('.config-nav-button', {hasText: 'Terminal'}).click();
      assert.equal(await page.locator('.config-panel-title').innerText(), 'Terminal');
      assert.equal(await page.locator('.config-nav-button[aria-current="true"]').innerText(), 'Terminal');
      await page.keyboard.press('ArrowDown');
      assert.equal(await focusedSection(page), 'notifications');
      await page.keyboard.press('End');
      assert.equal(await focusedSection(page), 'system');
      await page.keyboard.press('ArrowDown');
      assert.equal(await focusedSection(page), 'appearance', 'the list wraps');
      await page.keyboard.press('ArrowUp');
      assert.equal(await focusedSection(page), 'system');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.config-panel-title').innerText(), 'System');
      assert.ok((await page.locator('.config-cards').innerText()).includes('Configuration folder'));
      const outline = await page.locator('.config-nav-button[aria-current="true"]').evaluate(node => getComputedStyle(node).outlineStyle);
      assert.notEqual(outline, 'none', 'the focus is visible');
    });

    test(`returns the focus to the opener when closed, at ${width}px`, async () => {
      const {page} = await signedIn('en-US', width);
      await openConfig(page, width);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-config');
      await openConfig(page, width);
      await page.locator('#dlg-config [data-close-dialog]').click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-config');
    });
  }

  test('opens one section at a time on a phone, with a way back', async () => {
    const {page} = await signedIn('fr-FR', 390, 844);
    await openConfig(page, 390);
    await page.locator('.config-nav-button', {hasText: 'Système'}).click();
    assert.equal(await visible(page, '.config-nav'), false);
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'config-panel-title', 'the focus follows the section title');
    assert.ok((await page.locator('.config-cards').innerText()).includes('Dossier de configuration'));
    await fits(page);
    await page.locator('.config-back').click();
    assert.equal(await visible(page, '.config-panel'), false);
    assert.equal(await focusedSection(page), 'system', 'the focus returns to the entry that was open');
  });

  test('keeps the focus when the window becomes a phone layout, and when it stops being one', async () => {
    const {page} = await signedIn('en-US', 1440);
    await openConfig(page, 1440);
    await page.locator('.config-nav-button', {hasText: 'Terminal'}).click();
    await page.setViewportSize({width: 600, height: 900});
    await page.waitForFunction(() => document.activeElement?.className === 'config-panel-title', null, {timeout: 3000});
    await page.locator('.config-back').focus();
    await page.setViewportSize({width: 1440, height: 900});
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.sectionId === 'terminal', null, {timeout: 3000});
  });

  test('hides the back glyph from assistive technology and titles the section with a heading', async () => {
    const {page} = await signedIn('en-US', 390, 844);
    await openConfig(page, 390);
    await page.locator('.config-nav-button', {hasText: 'Terminal'}).click();
    assert.equal(await page.locator('.config-back [aria-hidden="true"]').innerText(), '‹');
    assert.equal(await page.locator('.config-panel-title').evaluate(node => node.tagName), 'H3');
  });

  test('uses the one-column drill-down on a phone held sideways (844x390)', async () => {
    const {page} = await signedIn('en-US', 844, 390);
    await page.locator('#btn-config').click();
    await page.locator('#dlg-config[open] .config-shell').waitFor();
    assert.equal(await visible(page, '.config-panel'), false, 'the list of sections is the first screen');
    await page.locator('.config-nav-button', {hasText: 'System'}).click();
    await fits(page);
    const cards = await page.locator('.config-card').first().boundingBox();
    assert.ok(cards!.width > 600, `the cards use the whole width: ${cards!.width}`);
    await shot(page, 'config-844x390-system');
  });

  test('puts the launch settings editor in Agents and launch', async () => {
    const {page} = await signedIn('en-US', 1440);
    await openConfig(page, 1440);
    await showSection(page, 'agents');
    assert.equal(await page.locator('.config-launch').count(), 1, 'the launch settings editor is in Agents and launch');
    assert.equal(await page.locator('.config-card:not(.config-launch) .config-row').count() > 0, true);
    assert.equal(await page.locator('.config-card.config-launch').count(), 1, 'the editor is a card, so it gets the card border and full width');
    const geometry = await page.evaluate(() => {
      const card = document.querySelector('.config-launch') as HTMLElement, grid = document.querySelector('.config-cards') as HTMLElement;
      return {border: getComputedStyle(card).borderTopWidth, full: Math.abs(card.getBoundingClientRect().width - (grid.clientWidth - 4)) < 4};
    });
    assert.deepEqual(geometry, {border: '1px', full: true});
  });
});
