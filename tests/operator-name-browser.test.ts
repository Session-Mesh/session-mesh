// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The operator's display name, end to end in headless Chromium against the real server, work-read and work-write on a
// fictional tracker: the owner types a name in the Configuration dialog (Appearance), unlocks with the master token
// when the server asks for it, and the Projects view says "En attente de la réponse de Camille"; a cleared name gives
// the wording without a name, at once in a Projects view already open, and in a new page. At 1440 and 390 px.
// Nothing here uses the default port or a real data directory: free MESH_PORT, temporary home and MESH_CONF_DIR,
// WL_HOME in a temporary directory.
// Needs MESH_CHROMIUM, MESH_PYTHON, MESH_PTYHOST_CMD is not needed; MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD default
// to the dune build outputs. Skipped without a Chromium (MESH_REQUIRE_BROWSER=1 makes that a failure) or without the
// programs (MESH_REQUIRE_WORK_READ=1 makes that a failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from './mesh-server-lib.ts';
import { chromiumLaunchOptions } from './helpers/browser-launch.ts';
import { showSection } from './helpers/config-sections.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = (!CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ
    ? 'built work-read and work-write are required' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const NAMED = 'En attente de la réponse de \u2068Camille\u2069';
const UNNAMED = "En attente de la réponse de l'opérateur";
const EVENTS = [{ ts: '2026-11-09T09:00:00Z', task: 'N-0000d0d1', type: 'question', id: 'N-0000d0d1', text: 'Which port?',
  agent: 'claude', session: 'asking-session' }];

let browser: Browser;
let mesh: Mesh;
let tracker = '';
const contexts: BrowserContext[] = [];

function temporaryTracker(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-name-tracker-'));
  const root = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'events', '2026-11.hostc.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return directory;
}

before(async () => {
  if (skip) return;
  tracker = temporaryTracker();
  mesh = await startMesh('opname-', { WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', WL_HOME: path.join(tracker, 'tracker'),
    MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  await browser?.close();
  await mesh?.stop();
  if (tracker) fs.rmSync(tracker, { recursive: true, force: true });
});

async function signedIn(width: number): Promise<{ page: Page; problems: string[]; otherRequests: string[] }> {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const problems: string[] = [], otherRequests: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  // Every request outside the configuration API, whatever its method (a GET can carry the name in its query too).
  page.on('request', request => {
    if (!new URL(request.url()).pathname.startsWith('/api/config')) {
      otherRequests.push(`${request.method()} ${decodeURIComponent(request.url())} ${request.postData() ?? ''}`);
    }
  });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  return { page, problems, otherRequests };
}

/** Whether the server still holds an elevation for this page. */
async function elevated(page: Page): Promise<boolean> {
  return await page.evaluate(async () => (await (await fetch('/api/config', { cache: 'no-store' })).json()).elevation?.active === true);
}

async function tap(page: Page, id: string, width: number): Promise<void> {
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator(`[data-mobile-action="${id}"]`).click();
  } else await page.locator(`#${id}`).click();
}

async function openProjects(page: Page, width: number): Promise<void> {
  await tap(page, 'btn-projects', width);
  await openSheet(page);
}

/** The question (about no task) has no answer form on the entry screen: unfold the pending questions and open its sheet. */
async function openSheet(page: Page): Promise<void> {
  const toggle = page.locator('.work-qsection-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.work-entry-questions .work-qrow-open').first().click();
  await page.locator('.work-qsheet .work-question-waiting').waitFor();
}

/** Type `name` in the Appearance card and save, unlocking with the master token when the server asks for it. */
async function saveName(page: Page, width: number, name: string, expected: string): Promise<void> {
  await tap(page, 'btn-config', width);
  await page.locator('#dlg-config[open] .config-shell').waitFor();
  await showSection(page, 'appearance');
  const card = page.locator('#dlg-config .config-operator');
  await card.locator('.config-operator-name').fill(name);
  await card.locator('.config-operator-save').click();
  const token = card.locator('.config-operator-token');
  await Promise.race([token.waitFor(), card.locator('.config-operator-status.config-ok').waitFor()]);
  const unlocked = await token.isVisible();
  if (unlocked) {
    await token.locator('input[type=password]').fill(mesh.token());
    await token.locator('button[type=submit]').click();
  }
  await card.locator('.config-operator-status.config-ok').waitFor();
  assert.equal(await card.locator('.config-operator-name').inputValue(), expected);
  assert.equal(await token.locator('input[type=password]').inputValue(), '', 'the token is not kept in the field');
  if (unlocked) {
    // The elevation was asked for this one save; the launch editor of the dialog, built before it, would show no clock
    // and no Lock button for it, so the card gives it back once the save is done.
    const until = Date.now() + 10_000;
    while (await elevated(page) && Date.now() < until) await page.waitForTimeout(100);
    assert.equal(await elevated(page), false, 'no elevation left running unseen');
  }
  await fits(page);
  await shot(page, `config-${width}-${expected || 'empty'}`);
  await page.locator('#dlg-config [data-close-dialog]').click();
}

const waiting = (page: Page) => page.locator('.work-qsheet .work-question-waiting').first();

async function fits(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const wide = [...document.querySelectorAll<HTMLElement>('.work-question-waiting, .config-operator, .config-operator *')]
      .filter(node => node.offsetParent !== null && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).display !== 'inline')
      .map(node => node.className || node.tagName);
    return { document: document.documentElement.scrollWidth <= innerWidth, wide };
  });
  assert.deepEqual(result, { document: true, wide: [] });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `operator-${name}.png`) });
}

describe('the operator name', { skip }, () => {
  for (const width of [1440, 390]) {
    test(`set in the Configuration dialog, it names the operator in Projects, and a cleared one falls back (${width} px)`, async () => {
      fs.rmSync(path.join(mesh.confDir, 'settings.json'), { force: true });
      const { page, problems, otherRequests } = await signedIn(width);
      await openProjects(page, width);
      assert.equal(await waiting(page).textContent(), UNNAMED, 'no name yet: the wording without one');

      await saveName(page, width, '  Camille  ', 'Camille');
      await page.waitForFunction(text => document.querySelector('.work-qsheet .work-question-waiting')?.textContent === text, NAMED);
      await fits(page);
      await shot(page, `projects-${width}-named`);

      const fresh = await signedIn(width);
      await openProjects(fresh.page, width);
      // Shared by the runner: another browser sees it once its own read of the configuration arrives.
      await fresh.page.waitForFunction(text => document.querySelector('.work-qsheet .work-question-waiting')?.textContent === text, NAMED);

      await saveName(page, width, '', '');
      await page.waitForFunction(text => document.querySelector('.work-qsheet .work-question-waiting')?.textContent === text, UNNAMED);
      await fresh.page.reload();
      await fresh.page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
      if (!(await fresh.page.locator('#projects').isVisible())) await tap(fresh.page, 'btn-projects', width);
      // The view comes back on the sheet left (static/work-view-state.ts); the entry screen would need it opened again.
      await fresh.page.locator('.work-qsheet .work-question-waiting, .work-qsection-toggle').first().waitFor();
      if (!(await fresh.page.locator('.work-qsheet').isVisible())) await openSheet(fresh.page);
      await fresh.page.waitForFunction(text => document.querySelector('.work-qsheet .work-question-waiting')?.textContent === text, UNNAMED);
      await shot(page, `projects-${width}-unnamed`);

      assert.deepEqual([...problems, ...fresh.problems], []);
      assert.ok(otherRequests.some(request => request.startsWith('GET ')), 'the GET requests are watched too');
      for (const request of [...otherRequests, ...fresh.otherRequests]) {
        assert.ok(!request.includes('Camille'), `the name is never sent elsewhere: ${request}`);
      }
    });
  }

  test('a hostile name is refused before sending and shown as text when stored by hand', async () => {
    const { page, problems } = await signedIn(1440);
    await tap(page, 'btn-config', 1440);
    await showSection(page, 'appearance');
    const card = page.locator('#dlg-config .config-operator');
    await card.locator('.config-operator-name').fill('Ca\u202emille');
    await card.locator('.config-operator-save').click();
    await card.locator('.config-operator-status.config-error').waitFor();
    assert.match(await card.locator('.config-operator-status').textContent() ?? '', /caractère interdit/);
    await page.locator('#dlg-config [data-close-dialog]').click();
    fs.writeFileSync(path.join(mesh.confDir, 'settings.json'), JSON.stringify({ v: 1, operator_name: '<img src=x onerror=window.__pwn=1>' }));
    await openProjects(page, 1440);
    await page.waitForFunction(() => document.querySelector('.work-qsheet .work-question-waiting')?.textContent?.includes('<img'));
    assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);
    assert.equal(await page.locator('.work-question-waiting img').count(), 0);
    fs.rmSync(path.join(mesh.confDir, 'settings.json'), { force: true });
    assert.deepEqual(problems, []);
  });
});
