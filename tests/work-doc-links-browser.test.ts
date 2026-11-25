// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Links in the Projects view (static/work-linkify.ts) and its document panel (static/work-doc-panel.ts) in headless
// Chromium against the real server, the real work-read and work-write, on a fictional tracker and fictional documents:
// a question, a log entry, a blocker, the notes and the links of a task name documents and web pages; a document opens
// beside the view (1440 px) or over it (390 px), an HTML page with an inline SVG diagram is drawn and its script never
// runs, Markdown is rendered, a document outside the view roots is "not available", Escape closes the panel and gives
// focus back to the link, and hostile text (javascript:, data:, markup) never becomes a link.
// Nothing here uses the default port or a real data directory: free MESH_PORT, temporary home and MESH_CONF_DIR,
// WL_HOME in a temporary directory. Needs MESH_CHROMIUM, MESH_PYTHON, MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD (default:
// the dune build outputs); skipped like tests/work-questions-browser.test.ts. MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from './mesh-server-lib.ts';
import { chromiumLaunchOptions } from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = (!CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ
    ? 'built work-read and work-write are required' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const TASK = 'T-8e8e';
const PROJECT = 'P-5e6f';
const DIR = '~/notes/2026-11-20-fictional';
const QUESTION = `Which layout? The details and the diagram are in ${DIR}/plan.html, see also https://example.test/spec.`;
const HOSTILE = 'javascript:window.__pwn=1 data:text/html,<b>x</b> <img src=x onerror=window.__pwn=2> file:///etc/passwd';
const OUTSIDE = `${DIR}/outside.md`;
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: TASK, type: 'created', title: 'Layout task', project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'set', field: 'project', to: PROJECT },
  { ts: '2026-11-07T09:02:00Z', task: TASK, type: 'add', field: 'links', value: `${DIR}/diagram.svg` },
  { ts: '2026-11-07T09:03:00Z', task: TASK, type: 'add', field: 'links', value: 'https://example.test/board' },
  { ts: '2026-11-07T09:04:00Z', task: TASK, type: 'progress', text: `review written: ${DIR}/review.md` },
  { ts: '2026-11-07T09:05:00Z', task: TASK, type: 'note', text: HOSTILE },
  { ts: '2026-11-07T09:06:00Z', task: TASK, type: 'blocker', id: 'B-0d0c01', kind: 'review', text: `waiting on ${OUTSIDE}` },
  { ts: '2026-11-08T09:00:00Z', task: TASK, type: 'question', id: 'N-0000d0c1', text: QUESTION, agent: 'claude', session: 'asking-session' },
];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Plan</title>
<style>body{font:16px sans-serif;margin:16px} h1{color:#246}</style></head><body><h1>Fictional plan</h1>
<svg id="diagram" width="220" height="90" role="img" aria-label="diagram"><rect x="5" y="5" width="90" height="40" fill="#cde"/>
<text x="12" y="30">client</text><line x1="95" y1="25" x2="135" y2="25" stroke="black"/><rect x="135" y="5" width="80" height="40" fill="#edc"/>
<text x="142" y="30">server</text></svg>
<p id="flag">script did not run</p>
<script>document.getElementById("flag").textContent = "script ran"; parent.postMessage("doc-script-ran", "*");</script>
<img src="x" onerror="parent.postMessage('doc-handler-ran', '*')"></body></html>`;

let browser: Browser;
let mesh: Mesh;
const contexts: BrowserContext[] = [];
const scratch: string[] = [];

function temporaryTracker(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-doc-tracker-'));
  scratch.push(directory);
  const tracker = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, tracker, { recursive: true });
  fs.writeFileSync(path.join(tracker, 'events', '2026-11.hostd.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', tracker, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return tracker;
}

function writeDocuments(home: string): void {
  const notes = path.join(home, 'notes', '2026-11-20-fictional');
  fs.mkdirSync(notes, { recursive: true });
  fs.symlinkSync('/etc/hosts', path.join(notes, 'outside.md'));
  fs.writeFileSync(path.join(notes, 'plan.html'), PAGE);
  fs.writeFileSync(path.join(notes, 'diagram.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#9c9"/><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(notes, 'review.md'), '# Fictional review\n\n| step | state |\n| --- | --- |\n| draft | done |\n');
}

before(async () => {
  if (skip) return;
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  mesh = await startMesh('work-doc-', { WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', WL_HOME: temporaryTracker(),
    MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  writeDocuments(mesh.home);
});
afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  await browser?.close();
  await mesh?.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

type Session = Readonly<{ page: Page; problems: string[]; messages: () => Promise<string[]> }>;

async function signedIn(width: number, locale = 'en-US'): Promise<Session> {
  const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __docMessages: string[] }).__docMessages = seen;
    window.addEventListener('message', event => { if (typeof event.data === 'string') seen.push(event.data); });
  });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  const messages = () => page.evaluate(() => (window as unknown as { __docMessages: string[] }).__docMessages);
  return { page, problems, messages };
}

async function openProjects(page: Page, width: number): Promise<void> {
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  // The pending questions are one folded line: unfold them (the state is kept for the tab of the browser).
  const toggle = page.locator('.work-qsection-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.work-entry-questions .work-qcard').first().waitFor();
}

async function openTaskSheet(page: Page): Promise<void> {
  await page.locator(`.work-entry-questions .work-qrow-open[data-task="${TASK}"]`).first().click();
  await page.locator('.work-detail-pane .work-detail-heading', { hasText: 'Layout task' }).waitFor();
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

async function noOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>('#work-root *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 5).map(node => `${node.tagName}.${node.className}`),
  }));
  assert.equal(result.page, 0, 'nothing overflows horizontally');
  assert.deepEqual(result.wide, [], 'nothing extends past the viewport');
}

const panel = (page: Page) => page.locator('.work-doc-panel');

describe('links and documents in the Projects view', { skip }, () => {
  test('1440 px: a question opens its HTML document beside the view; the diagram is drawn, the script never runs', { timeout: 900_000 }, async () => {
    const { page, problems, messages } = await signedIn(1440);
    await openProjects(page, 1440);
    const card = page.locator('.work-entry-questions .work-qcard[data-question-id="N-0000d0c1"]');
    const text = card.locator('.work-question-text');
    assert.equal(await text.textContent(), `Which layout? The details and the diagram are in 📄plan.html, see also https://example.test/spec.`);
    const web = text.locator('a.work-link');
    assert.equal(await web.getAttribute('href'), 'https://example.test/spec');
    assert.equal(await web.getAttribute('target'), '_blank');
    assert.equal(await web.getAttribute('rel'), 'noopener noreferrer');
    const link = text.getByRole('button', { name: `Open the document plan.html (${DIR}/plan.html) beside the view` });
    assert.equal(await link.getAttribute('title'), `${DIR}/plan.html`);
    await link.focus();
    await page.keyboard.press('Enter');
    await panel(page).waitFor();
    assert.equal(await panel(page).getAttribute('aria-label'), 'Document plan.html');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'work-doc-title');
    const frame = panel(page).locator('iframe.work-doc-frame');
    assert.equal(await frame.getAttribute('sandbox'), '', 'an empty sandbox: no script, opaque origin');
    assert.match((await frame.getAttribute('src'))!, /\/view\/v2\.[fd]\.\d+\.[0-9a-f]{32}\/.*\/plan\.html\?static=1$/);
    const content = page.frameLocator('.work-doc-panel iframe');
    await content.locator('#diagram rect').first().waitFor();
    const box = await content.locator('#diagram').boundingBox();
    assert.ok(box && box.width > 200 && box.height > 80, 'the inline SVG diagram is drawn');
    assert.equal(await content.locator('#flag').textContent(), 'script did not run');
    await page.waitForTimeout(500);
    assert.deepEqual(await messages(), [], 'neither the script nor the handler of the document ran');
    // Beside the view: the panel and the task text side by side, nothing over the page width.
    const panelBox = await panel(page).boundingBox(), cardBox = await card.boundingBox();
    assert.ok(panelBox && cardBox && panelBox.x >= cardBox.x + cardBox.width - 1, 'the panel is to the right of the view');
    const newTab = panel(page).getByRole('link', { name: 'Open plan.html in a new tab' });
    assert.match((await newTab.getAttribute('href'))!, /\?static=1$/);
    assert.equal(await newTab.getAttribute('rel'), 'noopener noreferrer');
    await noOverflow(page);
    await shot(page, 'doc-panel-1440');
    await page.keyboard.press('Escape');
    await panel(page).waitFor({ state: 'hidden' });
    assert.equal(await panel(page).locator('iframe').count(), 0, 'closing removes the frame');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.docPath), `${DIR}/plan.html`);
    assert.equal(await page.locator('#projects').isVisible(), true, 'Escape closed the panel, not the Projects view');
    assert.deepEqual(problems, []);
  });

  test('the task sheet: log, links, blocker and notes; Markdown renders, SVG is a static picture, outside is not available', { timeout: 900_000 }, async () => {
    const { page, problems } = await signedIn(1440);
    await openProjects(page, 1440);
    await openTaskSheet(page);
    const sheet = page.locator('.work-detail-pane');
    const links = sheet.locator('.work-detail-link');
    assert.deepEqual((await links.allTextContents()).sort(), ['https://example.test/board', '📄diagram.svg']);
    await links.getByRole('button').click();
    await panel(page).locator('iframe').waitFor();
    assert.equal(await panel(page).locator('iframe').getAttribute('sandbox'), '');
    assert.match((await panel(page).locator('iframe').getAttribute('src'))!, /diagram\.svg\?static=1$/);
    await panel(page).locator('.work-doc-close').click();
    await panel(page).waitFor({ state: 'hidden' });
    // A log entry names the review in Markdown: the renderer runs, by nonce only.
    await sheet.locator('.work-event-text').getByRole('button', { name: /review\.md/ }).click();
    const md = panel(page).locator('iframe');
    await md.waitFor();
    assert.equal(await md.getAttribute('sandbox'), 'allow-scripts');
    await page.frameLocator('.work-doc-panel iframe').locator('table td', { hasText: 'draft' }).waitFor();
    // The blocker names a file outside the view roots: the reference is a button, the panel says it is not available.
    const denied = page.waitForResponse(response => response.url().endsWith('/api/view') &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.target === `${DIR}/outside.md`);
    await sheet.locator('.work-detail-item').getByRole('button', { name: /outside\.md/ }).click();
    assert.equal((await denied).status(), 403, 'outside-root symlink is refused by the server');
    await panel(page).locator('.work-doc-unavailable').waitFor();
    assert.equal(await panel(page).locator('iframe').count(), 0);
    assert.equal(await panel(page).locator('.work-doc-newtab').isHidden(), true);
    // Hostile text stays text: no link, no handler.
    const hostile = sheet.locator('.work-event-text', { hasText: 'javascript:' });
    assert.equal(await hostile.textContent(), HOSTILE);
    assert.equal(await hostile.locator('a, button, img').count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);
    assert.equal(await page.locator('#work-root a[href^="javascript:"], #work-root a[href^="data:"], #work-root a[href^="file:"]').count(), 0);
    await noOverflow(page);
    await shot(page, 'doc-sheet-1440');
    assert.deepEqual(problems, []);
  });

  test('390 px: the panel covers the view with its close button; 44 px targets; no horizontal overflow; French labels', { timeout: 900_000 }, async () => {
    const { page, problems, messages } = await signedIn(390, 'fr-FR');
    await openProjects(page, 390);
    const link = page.locator('.work-entry-questions .work-qcard[data-question-id="N-0000d0c1"] .work-doc-link');
    assert.equal(await link.getAttribute('aria-label'), `Ouvrir le document plan.html (${DIR}/plan.html) à côté de la vue`);
    const linkBox = await link.boundingBox();
    assert.ok(linkBox && linkBox.height >= 44, `the link is a 44 px target (${linkBox?.height})`);
    await noOverflow(page);
    await link.click();
    await panel(page).locator('iframe').waitFor();
    const box = await panel(page).boundingBox();
    assert.deepEqual(box && [box.x, box.y, box.width, box.height], [0, 0, 390, 900], 'full screen');
    const close = panel(page).getByRole('button', { name: 'Fermer le document' });
    const closeBox = await close.boundingBox();
    assert.ok(closeBox && closeBox.height >= 44 && closeBox.width >= 44, 'the close button is a 44 px target');
    await page.frameLocator('.work-doc-panel iframe').locator('#diagram').waitFor();
    await noOverflow(page);
    await shot(page, 'doc-panel-390');
    await close.click();
    await panel(page).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className), 'work-doc-link');
    await openTaskSheet(page);
    const denied = page.waitForResponse(response => response.url().endsWith('/api/view') &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.target === `${DIR}/outside.md`);
    await page.locator('.work-detail-pane .work-detail-item').getByRole('button', { name: /outside\.md/ }).click();
    assert.equal((await denied).status(), 403, 'outside-root symlink is refused by the server');
    await panel(page).locator('.work-doc-unavailable').waitFor();
    assert.equal(await panel(page).locator('iframe').count(), 0);
    assert.equal(await panel(page).locator('.work-doc-newtab').isHidden(), true);
    await noOverflow(page);
    assert.deepEqual(await messages(), []);
    assert.deepEqual(problems, []);
  });
});
