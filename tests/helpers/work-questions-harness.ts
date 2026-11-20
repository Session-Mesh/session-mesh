// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What the browser tests of the Projects view's questions share (tests/work-questions-browser.test.ts and
// tests/work-questions-pages-browser.test.ts): a fictional tracker in a temporary directory, a Mesh server with the
// real work-read and work-write, a signed-in headless Chromium page, and the checks the tests repeat. Nothing here
// uses the default port or a real data directory: free MESH_PORT, temporary home and MESH_CONF_DIR, WL_HOME in a
// temporary directory. Each test file is its own process, so the state below is per file.
// Needs MESH_CHROMIUM, MESH_PYTHON, MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD (default: the dune build outputs);
// `skip` says why a file is skipped (MESH_REQUIRE_BROWSER=1 and MESH_REQUIRE_WORK_READ=1 make that a failure).
// MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from '../mesh-server-lib.ts';
import { chromiumLaunchOptions } from './browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
export const skip = (!CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ && !process.env.CI
    ? 'built work-read and work-write are required' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');

let browser: Browser | undefined;
const contexts: BrowserContext[] = [];
const meshes: Mesh[] = [];
const scratch: string[] = [];

export async function launch(): Promise<void> {
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
}

export async function closeContexts(): Promise<void> {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
}

export async function stopAll(): Promise<void> {
  await browser?.close();
  for (const mesh of meshes) await mesh.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
}

/** A copy of the fixture tracker with `events` added, as a git repository. */
export function temporaryTracker(events: readonly object[]): string {
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

export async function start(prefix: string, tracker: string): Promise<Mesh> {
  const mesh = await startMesh(prefix, { WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', WL_HOME: tracker,
    MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  meshes.push(mesh);
  return mesh;
}

export type Session = Readonly<{ page: Page; problems: string[]; reads: string[] }>;

/** A signed-in page with Projects open on the entry screen, its open questions read (or their read failed). */
export async function entry(mesh: Mesh, width: number, locale = 'en-US', prepare?: (page: Page) => Promise<void>): Promise<Session> {
  const session = await signedIn(mesh, width, locale, prepare);
  await openProjects(session.page, width);
  return session;
}

export async function openProjects(page: Page, width: number): Promise<void> {
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  await page.locator('.work-entry-toggle, .work-content > .work-error').first().waitFor();
  await page.locator('.work-qsection-toggle, .work-questions-none, .work-entry-questions .work-error, .work-content > .work-error')
    .first().waitFor();
}

export async function signedIn(mesh: Mesh, width: number, locale = 'en-US', prepare?: (page: Page) => Promise<void>): Promise<Session> {
  assert.ok(browser, 'launch() first');
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
  return { page, problems, reads };
}

export const announced = (page: Page, text: string): Promise<unknown> =>
  page.waitForFunction(expected => document.querySelector('.work-announcer')?.textContent === expected, text, { timeout: 30_000 });
export const row = (scope: Locator | Page, id: string): Locator => scope.locator(`.work-entry-questions [data-question-id="${id}"]`);
export const card = (scope: Locator | Page, id: string): Locator => scope.locator(`[data-question-id="${id}"]`);
export const toggle = (page: Page): Locator => page.locator('.work-qsection-toggle');
export const badge = (page: Page): Promise<string | null> => page.locator('#btn-projects .projects-question-badge')
  .evaluate((node: HTMLElement) => (node.hidden ? null : node.textContent));

/** Unfold the pending questions (they are folded unless this tab of the browser left them open). */
export async function unfold(page: Page): Promise<void> {
  if (await toggle(page).getAttribute('aria-expanded') !== 'true') await toggle(page).click();
  await page.locator('#work-entry-questions-body').waitFor();
}

/** The open questions of the tracker now, as the reader counts them (other tests may have answered some). */
export async function openCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await (await fetch('/api/work/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'open-questions', args: { limit: 1 } }) })).json()).open_questions as number);
}

/** The count of the folded line, of the badge and of the reader agree. */
export async function countsAgree(page: Page): Promise<void> {
  const total = String(await openCount(page));
  await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected,
    total, { timeout: 30_000 });
  await page.waitForFunction(expected => document.querySelector('.work-qsection-toggle .work-count')?.textContent === expected,
    total, { timeout: 30_000 });
}

export async function answer(scope: Locator, text: string, label = 'Your answer', send = 'Send answer'): Promise<void> {
  await scope.getByLabel(label).fill(text);
  await scope.getByRole('button', { name: send }).click();
}

export async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); }
}

export async function noOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>('#work-root *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 5).map(node => `${node.tagName}.${node.className}`),
  }));
  assert.equal(result.page, 0, 'nothing overflows horizontally');
  assert.deepEqual(result.wide, [], 'nothing extends past the viewport');
}

export async function uniqueIds(page: Page): Promise<void> {
  const duplicates = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const node of document.querySelectorAll('[id]')) seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
  assert.deepEqual(duplicates, [], 'every element id is unique');
}

/** The controls of `scope` that are shown and smaller than 44 px. */
export async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(selector => [...document.querySelectorAll<HTMLElement>(`${selector} button, ${selector} summary`)]
    .filter(node => node.offsetParent !== null && node.getBoundingClientRect().height < 43.5).map(node => node.className || node.tagName), scope);
}

export const focusedQuestion = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-question-id') ?? null);
