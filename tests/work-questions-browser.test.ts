// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Questions surfaces of the Projects view (static/work-questions-view.ts) in headless Chromium against the real
// server, the real work-read and the real work-write on a fictional tracker: the open questions of the entry screen
// (without a task, about a task), the Questions tab of a project, and the open questions badge of the Projects button.
// Nothing here uses the default port or a real data directory: free MESH_PORT, temporary home and MESH_CONF_DIR,
// WL_HOME in a temporary directory.
// Needs MESH_CHROMIUM, MESH_PYTHON, MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD (default: the dune build outputs);
// skipped without a Chromium (MESH_REQUIRE_BROWSER=1 makes that a failure) or without the programs
// (MESH_REQUIRE_WORK_READ=1 makes that a failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
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
const HOSTILE = '<img src=x onerror=window.__pwn=9> which port?';

// Each test answers its own questions, so the tests share one tracker without depending on their order.
type Asked = Readonly<{ id: string; about: string | null; text: string; at: string }>;
const ASKED: readonly Asked[] = [
  { id: 'N-0000c0c1', about: TASK, text: HOSTILE, at: '2026-11-08T09:00:00Z' },
  { id: 'N-0000c0c2', about: TASK, text: 'Keep the old endpoint?', at: '2026-11-08T09:01:00Z' },
  { id: 'N-0000c0c3', about: PROJECT, text: 'Rename the project?', at: '2026-11-08T09:02:00Z' },
  { id: 'N-0000c0c4', about: null, text: 'A question about nothing in particular?', at: '2026-11-09T09:00:00Z' },
  { id: 'N-0000c0c5', about: null, text: 'Another free question?', at: '2026-11-09T09:01:00Z' },
  { id: 'N-0000c0c6', about: TASK, text: 'Phone width question?', at: '2026-11-08T09:03:00Z' },
];
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: TASK, type: 'created', title: 'Questions task', project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'set', field: 'project', to: PROJECT },
  ...ASKED.map(q => ({ ts: q.at, task: q.about ?? q.id, type: 'question', id: q.id, text: q.text, agent: 'claude', session: 'asking-session',
    ...(q.id === 'N-0000c0c2' ? { assumption: 'keep it for now', options: ['keep', 'drop'] } : {}) })),
];

let browser: Browser;
const contexts: BrowserContext[] = [];
const meshes: Mesh[] = [];
const scratch: string[] = [];
let asking: Mesh, quiet: Mesh;

function temporaryTracker(events: readonly object[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-questions-tracker-'));
  scratch.push(directory);
  const tracker = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, tracker, { recursive: true });
  if (events.length > 0) fs.writeFileSync(path.join(tracker, 'events', '2026-11.hostc.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', tracker, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return tracker;
}

async function start(prefix: string, tracker: string): Promise<Mesh> {
  const mesh = await startMesh(prefix, { WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', WL_HOME: tracker,
    MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  meshes.push(mesh);
  return mesh;
}

before(async () => {
  if (skip) return;
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  asking = await start('workq-', temporaryTracker(EVENTS));
  quiet = await start('workq-none-', temporaryTracker([]));
});
afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  await browser?.close();
  for (const mesh of meshes) await mesh.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

type Session = Readonly<{ page: Page; problems: string[]; reads: string[] }>;

/** A signed-in page with Projects open on the entry screen. */
async function entry(mesh: Mesh, width: number, locale = 'en-US', prepare?: (page: Page) => Promise<void>): Promise<Session> {
  const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  const problems: string[] = [], reads: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('request', request => {
    if (request.url().endsWith('/api/work/v1')) reads.push(String(JSON.parse(request.postData() ?? '{}').op));
  });
  await prepare?.(page);
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  await page.locator('.work-entry-questions').waitFor();
  await page.locator('.work-entry-toggle').first().waitFor();
  return { page, problems, reads };
}

const card = (scope: Locator | Page, id: string): Locator => scope.locator(`[data-question-id="${id}"]`);
const badge = (page: Page): Promise<string | null> => page.locator('#btn-projects .projects-question-badge')
  .evaluate((node: HTMLElement) => (node.hidden ? null : node.textContent));

/** The open questions of the tracker now, as the reader counts them (other tests may have answered some). */
async function openCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await (await fetch('/api/work/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'resume', args: {} }) })).json()).open_questions as number);
}

async function answer(scope: Locator, text: string, label = 'Your answer', send = 'Send answer'): Promise<void> {
  await scope.getByLabel(label).fill(text);
  await scope.getByRole('button', { name: send }).click();
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); }
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

async function uniqueIds(page: Page): Promise<void> {
  const duplicates = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const node of document.querySelectorAll('[id]')) seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
  assert.deepEqual(duplicates, [], 'every element id is unique');
}

describe('open questions in the Projects view', { skip }, () => {
  test('the entry screen lists them without and with a task, as text, and the badge counts them', { timeout: 900_000 }, async () => {
    const { page, problems, reads } = await entry(asking, 1440);
    assert.equal(reads.filter(op => op === 'resume').length, 1, 'one read of the open questions, with the entry screen');
    const total = await openCount(page);
    assert.equal(await badge(page), String(total), 'the badge shows the count read with the entry screen');
    assert.equal(await page.locator('#btn-projects').getAttribute('aria-describedby'), 'projects-questions-description');
    assert.equal(await page.locator('#projects-questions-description').textContent(), `${total} open question${total === 1 ? '' : 's'}`);
    assert.equal(await page.locator('#btn-projects').getAttribute('aria-label'), 'Projects mode', 'the accessible name is unchanged');
    const noTask = page.locator('.work-entry-questions [data-group="no-task"]');
    const withTask = page.locator('.work-entry-questions [data-group="with-task"]');
    assert.equal(await noTask.locator('.work-section-title').first().textContent(), `Without a task${await noTask.locator('.work-qcard').count()}`);
    assert.equal(await card(noTask, 'N-0000c0c3').locator('.work-qcard-about').textContent(), 'Open project Delivery rollout');
    assert.equal(await card(withTask, 'N-0000c0c1').locator('.work-qcard-about').textContent(), `Open task ${TASK}`);
    const hostile = card(withTask, 'N-0000c0c1');
    assert.equal(await hostile.locator('.work-question-text').textContent(), HOSTILE, 'shown as written, as text');
    assert.match((await hostile.locator('.work-qcard-meta').textContent())!, /^Open · Open task T-8e8e · (\d+ days ago|yesterday) · asked by asking-session \(claude\)$/);
    assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);
    assert.equal(await page.locator('#work-root img, #work-root script').count(), 0);
    assert.match((await card(withTask, 'N-0000c0c2').textContent())!, /Options offered: keep · drop.*Assumption adopted meanwhile: keep it for now/);
    await uniqueIds(page);
    await shot(page, 'questions-entry-1440');
    assert.deepEqual(problems, []);
  });

  test('a question without a task is answered from the entry screen; it leaves the list and the badge goes down', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    const before = await openCount(page);
    await answer(card(page, 'N-0000c0c4'), 'answered from the entry list');
    await page.waitForFunction(() => document.querySelector('.work-announcer')?.textContent === 'Answer recorded.');
    assert.equal(await card(page, 'N-0000c0c4').count(), 0, 'an answered question is no longer open');
    assert.equal(await badge(page), String(before - 1));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'work-entry-questions-title', 'focus stays in the list');
    assert.deepEqual(problems, []);
  });

  test('the Questions tab groups by task, answers inline, and the sheet and the badge follow', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    const before = await openCount(page);
    await card(page, 'N-0000c0c3').getByRole('button', { name: 'Open project Delivery rollout' }).click();
    const tab = page.locator('#work-panel-questions');
    await tab.locator('.work-qcard').first().waitFor();
    assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true', 'opened on the Questions tab');
    const groups = await tab.locator('.work-qgroup').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
    assert.deepEqual(groups, [TASK, 'no-task'], 'the task first, "without a task" last');
    assert.equal(await tab.locator('[data-group="no-task"] .work-qgroup-title').textContent(), 'Without a task');
    // The sheet of the task shows the same questions: ids stay unique, and an answer in the tab updates the sheet.
    await tab.locator(`.work-qgroup-task[data-task="${TASK}"]`).click();
    const pane = page.locator('.work-detail-pane');
    await card(pane, 'N-0000c0c2').waitFor();
    await uniqueIds(page);
    await answer(card(tab, 'N-0000c0c2'), 'drop it');
    await card(tab, 'N-0000c0c2').locator('.work-answer-verified').waitFor();
    await card(pane, 'N-0000c0c2').locator('.work-answer-verified').waitFor();
    assert.equal(await card(tab, 'N-0000c0c2').locator('.work-qcard-state').textContent(), 'Answered');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-question-id')), 'N-0000c0c2', 'focus on the answered question in the tab');
    await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected, String(before - 1));
    // An answer from the sheet updates the tab in turn.
    await answer(card(pane, 'N-0000c0c1'), 'port 8443');
    await card(pane, 'N-0000c0c1').locator('.work-answer-verified').waitFor();
    await card(tab, 'N-0000c0c1').locator('.work-answer-verified').waitFor();
    await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected, String(before - 2));
    await uniqueIds(page);
    await shot(page, 'questions-tab-1440');
    assert.deepEqual(problems, []);
  });

  test('"Open task" from the entry screen opens its project on the Questions tab with the task sheet', { timeout: 900_000 }, async () => {
    const { page } = await entry(asking, 1440);
    await page.locator(`.work-entry-questions .work-qcard-about[data-task="${TASK}"]`).first().click();
    await page.locator('.work-detail-pane .work-detail-heading', { hasText: 'Questions task' }).waitFor();
    assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true');
    // Back to the entry screen: the list is read again.
    await page.locator('.work-back').click();
    await page.locator('.work-entry-questions').waitFor();
  });

  test('at phone width the list and the tab fit, the phone menu shows the badge, and an answer works', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 390);
    await noOverflow(page);
    const menuBadge = page.locator('[data-mobile-action="btn-projects"] .projects-question-badge');
    assert.equal(await menuBadge.evaluate((node: HTMLElement) => node.hidden), false, 'the phone menu item carries the badge');
    await shot(page, 'questions-entry-390');
    await card(page, 'N-0000c0c3').getByRole('button', { name: 'Open project Delivery rollout' }).click();
    const tab = page.locator('#work-panel-questions');
    await card(tab, 'N-0000c0c6').waitFor();
    await noOverflow(page);
    await answer(card(tab, 'N-0000c0c6'), 'answered at phone width');
    await card(tab, 'N-0000c0c6').locator('.work-answer-verified').waitFor();
    await noOverflow(page);
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#work-panel-questions button')]
      .filter(node => node.offsetParent !== null && node.getBoundingClientRect().height < 43.5).map(node => node.className));
    assert.deepEqual(small, [], 'touch targets are at least 44 px');
    await shot(page, 'questions-tab-390');
    assert.deepEqual(problems, []);
  });

  test('the questions speak French, ages included', { timeout: 900_000 }, async () => {
    const { page } = await entry(asking, 390, 'fr-FR');
    assert.equal((await page.locator('#work-entry-questions-title').textContent())!.startsWith('Questions ouvertes'), true);
    assert.ok((await page.locator('.work-entry-questions [data-group="no-task"] .work-section-title').textContent())!.startsWith('Sans tâche'));
    assert.match((await card(page, 'N-0000c0c3').locator('.work-qcard-meta').textContent())!, /^Ouverte · Ouvrir le projet Delivery rollout · (il y a \d+ jours|hier) · posée par asking-session \(claude\)$/);
    assert.equal(await card(page, 'N-0000c0c3').getByLabel('Votre réponse').count(), 1);
    assert.match((await page.locator('#projects-questions-description').textContent())!, /^\d+ questions? ouvertes?$/);
  });

  test('a failed read of the questions keeps the products, shows the error with a retry, and hides the badge', { timeout: 900_000 }, async () => {
    let fail = true;
    const { page } = await entry(asking, 1440, 'en-US', p => p.route('**/api/work/v1', async route => {
      if (fail && route.request().postData()?.includes('"op":"resume"')) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"busy","message":"busy"}}' });
      }
      return route.continue();
    }));
    const error = page.locator('.work-entry-questions .work-error[data-kind="busy"]');
    await error.waitFor();
    assert.ok(await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).count() > 0, 'the products are shown');
    assert.equal(await badge(page), null, 'no number that was not read');
    fail = false;
    await error.getByRole('button', { name: 'Try again' }).click();
    await page.locator('.work-entry-questions .work-qcard').first().waitFor();
    assert.equal(await badge(page), String(await openCount(page)));
  });

  test('without questions: an empty list, an empty tab, and no badge', { timeout: 900_000 }, async () => {
    const { page } = await entry(quiet, 1440);
    assert.equal(await page.locator('.work-questions-none').textContent(), 'No open question.');
    assert.equal(await badge(page), null);
    assert.equal(await page.locator('#btn-projects').getAttribute('aria-describedby'), null);
    await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).click();
    await page.locator('#work-tab-questions').click();
    assert.equal(await page.locator('#work-panel-questions .work-empty').textContent(), 'No question about this project or its tasks.');
    await page.keyboard.press('Shift');
    await page.locator('#work-tab-questions').focus();
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#work-tab-reprise').getAttribute('aria-selected'), 'true', 'the tab is in the keyboard ring');
  });
});
