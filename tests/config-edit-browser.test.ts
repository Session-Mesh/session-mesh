// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The editable part of the Configuration dialog, in headless Chromium on a throwaway server:
// locked by default, unlocked with the master token, agents as check boxes, folders as a list,
// per-field default buttons, Save with readable errors, and the stale-revision message.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure). MESH_SHOT_DIR=<dir> also saves screenshots (prefix "edit-"), taken of the
// dialog alone, on a throwaway home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

let mesh: ConfigMesh;
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  // A skipped describe does not skip this file-level hook: start nothing without a Chromium.
  if (skip) return;
  mesh = await ConfigMesh.start('cfeb-', home => ({v: 1, workspace_roots: [path.join(home, 'work')], enabled_agents: ['claude', 'codex']}));
  browser = await chromium.launch({executablePath: CHROMIUM, args: ['--no-sandbox', '--mute-audio']});
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  await mesh?.stop();
});

async function restore(): Promise<void> {
  mesh.elevation = '';
  assert.equal((await mesh.elevate()).status, 200);
  const response = await mesh.save(['claude', 'codex'], [path.join(mesh.home, 'work')]);
  assert.equal(response.status, 200, await response.clone().text());
}

async function opened(locale: string, width: number): Promise<{page: Page; problems: string[]}> {
  const context = await browser.newContext({locale, viewport: {width, height: 900}});
  contexts.push(context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) problems.push(message.text()); });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForSelector('#btn-config', {state: 'attached'});
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-config"]').click();
  } else {
    await page.locator('#btn-config').click();
  }
  await page.locator('#dlg-config[open] .config-launch').waitFor();
  return {page, problems};
}

async function fits(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const box = document.querySelector('#dlg-config') as HTMLElement;
    const rect = box.getBoundingClientRect();
    const wide = [...box.querySelectorAll<HTMLElement>('.config-value, .config-row, dt, dd, .config-launch *')]
      .filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).display !== 'inline').map(node => node.className || node.tagName);
    return {document: document.documentElement.scrollWidth <= innerWidth, dialog: box.scrollWidth <= box.clientWidth,
      inside: rect.left >= 0 && rect.right <= innerWidth, wide};
  });
  assert.deepEqual(result, {document: true, dialog: true, inside: true, wide: []});
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, {recursive: true});
  const width = page.viewportSize()!.width;
  await page.setViewportSize({width, height: width > 600 ? 1700 : 3200});
  await page.locator('#dlg-config').screenshot({path: path.join(SHOTS, `edit-${name}.png`)});
  await page.setViewportSize({width, height: 900});
}

async function unlock(page: Page, token: string): Promise<void> {
  await page.locator('.config-edit').click();
  await page.locator('.config-token input').fill(token);
  await page.locator('.config-token button[type=submit]').click();
}

describe('editing the launch settings in the Configuration dialog', {skip}, () => {
  for (const width of [1440, 390]) {
    test(`locked by default, unlocked by the master token, saved, at ${width}px (English)`, async () => {
      await restore();
      mesh.elevation = '';
      const {page, problems} = await opened('en-US', width);
      const launch = page.locator('.config-launch');
      assert.equal(await launch.locator('input[type=checkbox]').count(), 0, 'read-only: no check box');
      assert.ok((await launch.innerText()).includes('Read-only'));
      assert.deepEqual((await launch.locator('.config-value').allInnerTexts()).map(t => t.split(',').length), [2, 1]);
      await shot(page, `locked-${width}-en`);

      await unlock(page, 'not-the-token');
      await launch.locator('[role=alert]').waitFor();
      assert.ok((await launch.innerText()).includes('Wrong token'));
      assert.equal(await page.locator('.config-token input').inputValue(), '', 'the token is cleared at once');

      await page.locator('.config-token input').fill(mesh.token());
      await page.locator('.config-token button[type=submit]').click();
      await launch.locator('input[type=checkbox]').first().waitFor();
      assert.match(await launch.locator('.config-clock').innerText(), /Editing unlocked: \d+:\d\d left/);
      assert.equal(await launch.locator('input[type=password]').count(), 0);
      assert.ok(!(await page.content()).includes(mesh.token()), 'the token is not in the page');
      assert.equal(await launch.locator('input[data-agent=claude]').isChecked(), true);
      assert.equal(await launch.locator('input[data-agent=pi]').isChecked(), false);

      await launch.locator('input[data-agent=pi]').check();
      await launch.locator('.config-new-root').fill(path.join(mesh.home, 'work2'));
      await launch.locator('.config-add-root').click();
      assert.equal(await launch.locator('.config-roots li').count(), 2);
      await shot(page, `editing-${width}-en`);
      await fits(page);

      await launch.locator('.config-save').click();
      await launch.locator('[role=status].config-ok').waitFor();
      assert.ok((await launch.innerText()).includes('running sessions are unchanged'));
      assert.deepEqual(mesh.file().enabled_agents, ['claude', 'codex', 'pi']);
      assert.deepEqual(mesh.file().workspace_roots, [path.join(mesh.home, 'work'), path.join(mesh.home, 'work2')].map(p => fs.realpathSync(p)));
      assert.equal(await launch.locator('input[data-agent=pi]').isChecked(), true, 'the saved values are shown after the reload');
      await shot(page, `saved-${width}-en`);
      assert.deepEqual(problems, []);
    });
  }

  test('readable errors, the default buttons, and the lock, at 390px in French', async () => {
    await restore();
    const {page, problems} = await opened('fr-FR', 390);
    const launch = page.locator('.config-launch');
    assert.ok((await launch.innerText()).includes('Lecture seule'));
    await launch.locator('.config-edit').click();
    await launch.locator('.config-token input').fill(mesh.token());
    await launch.locator('.config-token button[type=submit]').click();
    await launch.locator('input[type=checkbox]').first().waitFor();
    assert.match(await launch.locator('.config-clock').innerText(), /Modification déverrouillée : \d+:\d\d restantes/);

    const add = launch.locator('.config-new-root');
    for (const [typed, expected] of [['relatif/dossier', 'chemin absolu'], [path.join(mesh.home, 'work'), 'déjà dans la liste'], ['', 'Saisissez']] as const) {
      await add.fill(typed);
      await launch.locator('.config-add-root').click();
      assert.ok((await launch.locator('[role=alert]').innerText()).includes(expected), expected);
    }
    await add.fill(path.join(mesh.home, 'missing'));
    await launch.locator('.config-add-root').click();
    await launch.locator('.config-save').click();
    await launch.locator('[role=alert]:has-text("Non enregistré")').waitFor();
    assert.ok((await launch.locator('[role=alert]').innerText()).includes('missing'), 'the message names the folder');
    assert.deepEqual(mesh.file().workspace_roots, [path.join(mesh.home, 'work')], 'nothing was written');
    await shot(page, 'error-390-fr');
    await fits(page);

    for (const agent of ['claude', 'codex']) await launch.locator(`input[data-agent=${agent}]`).uncheck();
    await launch.locator('.config-save').click();
    assert.ok((await launch.locator('[role=alert]').innerText()).includes('au moins un agent'));

    await launch.locator('.config-default-agents').click();
    assert.equal(await launch.locator('input[type=checkbox]:checked').count(), await launch.locator('input[type=checkbox]').count());
    await launch.locator('.config-default-roots').click();
    assert.deepEqual(await launch.locator('.config-roots li').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.root)),
      [fs.realpathSync(mesh.home)]);
    await shot(page, 'defaults-390-fr');
    await fits(page);

    await launch.locator('button:has-text("Verrouiller")').click();
    await launch.locator('.config-edit').waitFor();
    assert.equal(await launch.locator('input[type=checkbox]').count(), 0);
    assert.deepEqual(problems, []);
  });

  test('a save from a stale page is refused with a message, and the current values are shown', async () => {
    await restore();
    const {page, problems} = await opened('en-US', 1440);
    const launch = page.locator('.config-launch');
    await unlock(page, mesh.token());
    await launch.locator('input[type=checkbox]').first().waitFor();
    const other = await mesh.save(['claude'], [path.join(mesh.home, 'work3')]);   // another tab saves first
    assert.equal(other.status, 200);
    await launch.locator('input[data-agent=gemini]').check();
    await launch.locator('.config-save').click();
    await launch.locator('[role=alert]:has-text("changed elsewhere")').waitFor();
    assert.deepEqual(mesh.file().enabled_agents, ['claude'], 'the other tab\'s edit stands');
    assert.equal(await launch.locator('input[data-agent=gemini]').isChecked(), false, 'the form shows the current values');
    assert.deepEqual(await launch.locator('.config-roots li').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.root)),
      [fs.realpathSync(path.join(mesh.home, 'work3'))]);
    await shot(page, 'stale-1440-en');
    assert.deepEqual(problems, []);
  });

  test('a "Lock" the server did not confirm is shown and the page stays unlocked', async () => {
    await restore();
    const {page, problems} = await opened('en-US', 1440);
    const launch = page.locator('.config-launch');
    await unlock(page, mesh.token());
    await launch.locator('input[type=checkbox]').first().waitFor();
    await page.route('**/api/config/elevate/revoke', route => route.fulfill({status: 500, body: 'no'}));
    await launch.locator('button:has-text("Lock")').click();
    await launch.locator('[role=alert]:has-text("Could not lock")').waitFor();
    assert.ok(await launch.locator('.config-clock').isVisible(), 'still unlocked, the countdown runs');
    assert.equal((await mesh.config()).elevation.active, true, 'and the server agrees: the elevation is live');
    await page.unroute('**/api/config/elevate/revoke');
    await launch.locator('button:has-text("Lock")').click();
    await launch.locator('.config-edit').waitFor();
    assert.equal(await launch.locator('input[type=checkbox]').count(), 0, 'locked once the server confirmed');
    assert.deepEqual(problems.filter(item => !/500/.test(item)), []);
  });

  test('every read-only value says where it is stored and how it changes; no control restarts anything', async () => {
    await restore();
    mesh.elevation = '';
    const {page} = await opened('en-US', 390);
    const rows = page.locator('#dlg-config .config-section:not(.config-launch) .config-row');
    const without = await rows.evaluateAll(items => items.filter(item => !item.querySelector('.config-hint')).map(item => item.querySelector('dt')?.textContent));
    assert.deepEqual(without, ['Version', 'Advertised capabilities'], 'only these two rows carry no hint (a detected fact)');
    const text = await page.locator('#dlg-config').innerText();
    for (const phrase of ['MESH_PORT', 'MESH_HOST', 'MESH_TRUST_PROXY', 'systemctl --user edit session-mesh', 'never restarted from this page']) {
      assert.ok(text.includes(phrase), phrase);
    }
    assert.equal(await page.locator('#dlg-config button:has-text("Restart")').count(), 0, 'the page offers no restart');
  });
});
