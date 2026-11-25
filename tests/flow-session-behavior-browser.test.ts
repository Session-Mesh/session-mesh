// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {chromium, type Browser} from 'playwright-core';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';
import {REPO} from './mesh-server-lib.ts';

declare const active: {adopt: (mode: string, button: HTMLButtonElement) => Promise<void>};

const chrome = process.env.MESH_CHROMIUM ?? '';
const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml', '_build', 'default', 'bin', 'mesh_history_main.exe');
const skip = !chrome && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

test('Flow keeps covered sessions unread and closes when a new session is created', {skip}, async () => {
  if (fs.existsSync(helper)) process.env.MESH_MESH_HISTORY_CMD = helper;
  const lab = await AgentMesh.start('flow-session-', ['alpha']);
  let browser: Browser | undefined;
  let unblockAdoption = () => {};
  try {
    browser = await chromium.launch(chromiumLaunchOptions(chrome, ['--no-sandbox']));
    const page = await browser.newPage({locale: 'en-US', viewport: {width: 1400, height: 900}});
    await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
    await page.goto(`${lab.mesh.base}/#alpha`);
    await page.waitForFunction(() => Boolean(JSON.parse(localStorage.getItem('mesh.seen') || '{}').alpha));
    await page.locator('#btn-flow').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('mesh.seen') || '{}').alpha as number);
    await page.waitForTimeout(1200);
    await page.evaluate(() => (window as unknown as {refresh: () => Promise<unknown>}).refresh());
    const during = await page.evaluate(() => JSON.parse(localStorage.getItem('mesh.seen') || '{}').alpha as number);
    assert.equal(during, before, 'inventory refresh while Flow covers the pane must not mark it read');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
      document.dispatchEvent(new Event('visibilitychange'));
      delete (document as unknown as {visibilityState?: string}).visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const afterVisibility = await page.evaluate(() => JSON.parse(localStorage.getItem('mesh.seen') || '{}').alpha as number);
    assert.equal(afterVisibility, before, 'hiding and returning to the page must not mark a Flow-covered pane read');
    await page.locator('#btn-sessions').click();
    await page.evaluate(() => (window as unknown as {refresh: () => Promise<unknown>}).refresh());
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mesh.seen') || '{}').alpha as number);
    assert.ok(after > during, 'the visible pane is marked read after returning to Sessions');

    await page.locator('#btn-flow').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    await page.locator('#btn-new').click();
    await page.locator('#form-new input[name="cwd"]').fill(lab.mesh.home);
    await page.locator('#form-new input[name="name"]').fill('flow-created');
    await page.locator('#form-new .presets label:has(input[value="shell"])').click();
    await page.locator('#form-new button[value="ok"]').click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#flow')?.hidden === true
      && document.querySelector('#panes .p-name')?.textContent?.includes('flow-created'), null, {timeout: 10000});
    assert.equal(await page.locator('#panes').isVisible(), true);
    assert.equal(await page.locator('#btn-flow').getAttribute('aria-pressed'), 'false');

    await page.locator('#btn-flow').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    await page.locator('#list .item[data-id="alpha"]').click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Open in a new column', exact: true}).click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#flow')?.hidden === true
      && document.querySelector('#panes .pane.active .p-name')?.textContent?.includes('alpha'), null, {timeout: 10000});
    assert.equal(await page.locator('#panes .pane').count(), 2);
    assert.equal(await page.locator('#panes').isVisible(), true);
    assert.equal(await page.locator('#btn-flow').getAttribute('aria-pressed'), 'false');

    await page.locator('#btn-flow').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    const documentPath = path.join(lab.mesh.home, 'flow-document.html');
    fs.writeFileSync(documentPath, '<!doctype html><title>Flow document</title>');
    await page.locator('#btn-web').click();
    await page.locator('#form-web input[name="target"]').fill(documentPath);
    await page.locator('#form-web').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.locator('#flow').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#panes').isVisible(), true, 'opening a page exposes its pane');

    let requestStarted = () => {};
    const requested = new Promise<void>(resolve => { requestStarted = resolve; });
    const release = new Promise<void>(resolve => { unblockAdoption = resolve; });
    await page.route('**/api/adopt', async route => {
      requestStarted();
      await release;
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({id: 'flow-created'})});
    });
    await page.evaluate(() => { void active.adopt('when-idle', document.createElement('button')); });
    await requested;
    await page.locator('#btn-flow').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    unblockAdoption();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#flow')?.hidden === true
      && document.querySelector('#panes .pane.active .p-name')?.textContent?.includes('flow-created'), null, {timeout: 10000});
    assert.equal(await page.locator('#panes').isVisible(), true, 'the adopted session is visible after Flow closes');
    assert.equal(await page.locator('#btn-flow').getAttribute('aria-pressed'), 'false');
  } finally { unblockAdoption(); try { await browser?.close(); } finally { await lab.stop(); } }
});


test('creating a session from Flow exposes its terminal on a phone', {skip}, async () => {
  if (fs.existsSync(helper)) process.env.MESH_MESH_HISTORY_CMD = helper;
  const lab = await AgentMesh.start('flow-phone-', ['alpha']);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch(chromiumLaunchOptions(chrome, ['--no-sandbox']));
    const page = await browser.newPage({locale: 'en-US', viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
    await page.goto(`${lab.mesh.base}/#alpha`);
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-flow"]').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    await page.locator('#btn-menu').click();
    await page.locator('#btn-new').click();
    await page.locator('#form-new input[name="cwd"]').fill(lab.mesh.home);
    await page.locator('#form-new input[name="name"]').fill('flow-phone');
    await page.locator('#form-new .presets label:has(input[value="shell"])').click();
    await page.locator('#form-new button[value="ok"]').click();
    await page.locator('#flow').waitFor({state: 'hidden'});
    await page.locator('#panes .p-name').getByText('flow-phone').waitFor();
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('drawer')), false);
    assert.equal(await page.locator('#panes').isVisible(), true);
  } finally { try { await browser?.close(); } finally { await lab.stop(); } }
});
