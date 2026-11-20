// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Projects view (static/work-view.ts) in headless Chromium against the real server and the real work-read
// program on a fictional tracker (a copy of the worklog fixture plus a hostile task and a dependency). Nothing
// here uses the default port or a real data directory: free MESH_PORT, temporary home and MESH_CONF_DIR, WL_HOME
// in a temporary directory.
// Needs MESH_CHROMIUM=<chromium>, MESH_PYTHON, MESH_WORK_READ_CMD=<built work-read> and MESH_WORK_WRITE_CMD=<built
// work-write> (default: the dune build outputs) and MESH_PTYHOST_CMD=<ptyhost>; skipped without a Chromium
// (MESH_REQUIRE_BROWSER=1 makes that a failure) or without the programs (MESH_REQUIRE_WORK_READ=1 makes that a
// failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from './mesh-server-lib.ts';
import { chromiumLaunchOptions } from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD
  || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');   // never an empty value: the server reads that as "no program"
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
// MESH_REQUIRE_BROWSER=1 makes a missing Chromium a failure; MESH_REQUIRE_WORK_READ=1 does the same for the reader
// (public CI builds no work-read, so there the file skips instead of failing).
const skip = (!CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ
    ? 'built work-read and work-write are required (dune build work_read/bin/work_read_main.exe work_write/bin/work_write_main.exe)' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const LONG_WORD = 'W'.repeat(120);
const HOSTILE_TITLE = `<img src=x onerror=window.__pwn=1><script>window.__pwn=2</script> evil ${LONG_WORD}`;   // bidi controls cannot enter the data (the library refuses control characters); they are covered by the unit tests
const HOSTILE_ANSWER = '<img src=x onerror=window.__pwn=4> port 8443';
const WIDTHS = [390, 1440] as const;

const HOSTILE_EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: 'T-8e8e', type: 'created', title: HOSTILE_TITLE, project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:01:00Z', task: 'T-8e8e', type: 'set', field: 'project', to: 'P-5e6f' },
  { ts: '2026-11-07T09:02:00Z', task: 'T-8e8e', type: 'session_linked', agent: 'claude', session: '<b>hostile-session</b>', host: 'hostc', repo: null, branch: `feat/<i>x</i>-${LONG_WORD}` },
  { ts: '2026-11-07T09:03:00Z', task: 'T-8e8e', type: 'progress', text: '<script>window.__pwn=3</script> noted', prov: 'inferred' },
  { ts: '2026-11-08T08:00:00Z', task: 'T-3c4d', type: 'add', field: 'blocked_by', value: 'T-1a2b' },
  { ts: '2026-11-08T08:01:00Z', task: 'T-8e8e', type: 'add', field: 'blocked_by', value: 'T-3c4d' },
  // Two questions (work_ask), one answered (work_answer relaying the owner's words, with a hostile text).
  { ts: '2026-11-08T09:00:00Z', task: 'T-8e8e', type: 'question', id: 'N-0000a0a1', text: 'Keep the old endpoint?', agent: 'claude', session: 'asking-session' },
  { ts: '2026-11-08T09:01:00Z', task: 'T-8e8e', type: 'question', id: 'N-0000a0a2', text: 'Which port?', agent: 'claude', session: 'asking-session' },
  { ts: '2026-11-08T10:00:00Z', task: 'T-8e8e', type: 'answer', question: 'N-0000a0a2', text: HOSTILE_ANSWER, by: 'owner', agent: 'claude', session: 'asking-session' },
  // An answer whose free `by` label claims verification: the view must still show a relayed, unverified claim.
  { ts: '2026-11-08T09:02:00Z', task: 'T-8e8e', type: 'question', id: 'N-0000a0a3', text: 'Ship on Friday?', agent: 'claude', session: 'asking-session' },
  { ts: '2026-11-08T10:01:00Z', task: 'T-8e8e', type: 'answer', question: 'N-0000a0a3', text: 'yes', by: 'Owner (verified, in person)', agent: 'claude', session: 'other-session' },
];

let browser: Browser;
const contexts: BrowserContext[] = [];
const meshes: Mesh[] = [];
const scratch: string[] = [];
let tracked: Mesh, untracked: Mesh, noReader: Mesh;

function temporaryTracker(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-view-tracker-'));
  scratch.push(directory);
  const tracker = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, tracker, { recursive: true });
  fs.writeFileSync(path.join(tracker, 'events', '2026-11.hostc.jsonl'), HOSTILE_EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  return tracker;
}

const baseEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  ({ WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER,
    MESH_WORK_READ_TIMEOUT: '90', ...extra });

async function start(prefix: string, extra: NodeJS.ProcessEnv): Promise<Mesh> {
  const mesh = await startMesh(prefix, baseEnv(extra));
  meshes.push(mesh);
  return mesh;
}

before(async () => {
  if (skip) return;
  tracked = await start('workui-', { WL_HOME: temporaryTracker() });
  untracked = await start('workui-none-', { WL_HOME: path.join(os.tmpdir(), 'work-view-no-such-tracker') });
  noReader = await start('workui-503-', { WL_HOME: temporaryTracker(), MESH_WORK_READ_CMD: path.join(os.tmpdir(), 'work-view-no-such-program') });
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
// A page left open keeps loading the machine for the tests after it.
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  for (const mesh of meshes) await mesh.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

type Session = { page: Page; problems: string[]; requests: string[] };

async function signedIn(mesh: Mesh, locale: string, width: number): Promise<Session> {
  const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  const problems: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) problems.push(message.text()); });
  page.on('request', request => { const { pathname } = new URL(request.url()); if (pathname.startsWith('/api/work')) requests.push(pathname); });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, { timeout: 180_000 });
  await page.goto(`${mesh.base}/`, { timeout: 180_000 });
  await page.waitForSelector('#btn-projects', { state: 'attached' });
  // A click before the page knows its mesh is ignored by the app: wait for it.
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  return { page, problems, requests };
}

async function enterProjects(page: Page, width: number): Promise<void> {
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else {
    await page.locator('#btn-projects').click();
  }
  await page.locator('#projects').waitFor({ state: 'visible' });
}

/** Whether a root is switched on (not `hidden`): the old workspace root may be empty, which Playwright counts as invisible. */
const shown = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate(target => !(document.querySelector(target) as HTMLElement).hidden, selector);

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); }
}

async function noOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    root: (document.querySelector('#projects') as HTMLElement).scrollWidth - (document.querySelector('#projects') as HTMLElement).clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>('#work-root *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 5).map(node => `${node.tagName}.${node.className}`),
  }));
  assert.equal(result.page, 0, 'document scrollWidth equals clientWidth');
  assert.equal(result.root, 0, '#projects scrollWidth equals clientWidth');
  assert.deepEqual(result.wide, [], 'nothing extends past the viewport');
}

// The entry list, or an error that says what the page showed instead (a loaded machine makes timeouts ambiguous).
async function waitForEntry(page: Page): Promise<void> {
  try {
    await page.locator('.work-entry-toggle').first().waitFor();
  } catch (error) {
    const shown = await page.evaluate(() => JSON.stringify({
      root: document.querySelector('#work-root')?.textContent, status: document.querySelector('#projects-module-status')?.textContent,
      projecting: document.body.classList.contains('projecting'), stopped: (window as unknown as { meshStopped?: boolean }).meshStopped ?? null,
    }));
    throw new Error(`the entry list did not appear: ${shown}`, { cause: error });
  }
}

async function openRelayProject(page: Page): Promise<void> {
  await waitForEntry(page);
  await page.locator('.work-entry-toggle', { hasText: 'relay' }).first().waitFor();
  await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).waitFor();
  await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).click();
  await page.locator('.work-tab[aria-selected="true"]').waitFor();
}

for (const width of WIDTHS) {
  describe(`Projects view at ${width}px`, { skip }, () => {
    test('the entry list shows products with projects, progress, blockers and a "no project" line', { timeout: 900_000 }, async () => {
      const { page, problems, requests } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await waitForEntry(page);
      assert.deepEqual(requests.filter(request => request === '/api/work/v1').length >= 2, true, 'products and projects are read');
      assert.equal(await shown(page, '#work-root'), true);
      assert.equal(await shown(page, '#projects-root'), false, 'the old workspace is not shown by default');
      const relay = page.locator('.work-entry-toggle', { hasText: 'relay' }).first();
      assert.equal(await relay.getAttribute('aria-expanded'), 'true', 'a product with an active project starts expanded');
      assert.ok(await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).isVisible());
      const gateway = page.locator('.work-entry-toggle', { hasText: 'gateway' }).first();
      assert.equal(await gateway.getAttribute('aria-expanded'), 'false');
      await gateway.click();
      assert.equal(await gateway.getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator('.work-entry-noproject', { hasText: 'No project' }).first().isVisible());
      assert.ok(await page.locator('.work-bar[role=progressbar]').count() > 0);
      assert.ok(await page.locator('.work-blockers.has').count() > 0, 'a blocker count is shown');
      await noOverflow(page);
      await shot(page, `entry-${width}`);
      assert.deepEqual(problems, []);
    });

    test('a project opens on five tabs that switch by mouse and by keyboard', { timeout: 900_000 }, async () => {
      const { page, problems } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await openRelayProject(page);
      const tabs = page.locator('.work-tab');
      assert.deepEqual(await tabs.allTextContents(), ['Pick up', 'Board', 'Timeline', 'Dependencies', 'Questions']);
      assert.equal(await page.locator('#work-root [role=tablist] [role=tab]').count(), 5);
      assert.equal(await page.locator('#work-panel-reprise').isVisible(), true);
      await page.locator('#work-panel-reprise .work-card').first().waitFor();
      await shot(page, `reprise-${width}`);
      await tabs.nth(1).click();
      assert.equal(await page.locator('#work-tab-board').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#work-panel-board .work-column').count(), 4);
      assert.ok(await page.locator('#work-panel-board .work-card').count() >= 3);
      await noOverflow(page);
      await shot(page, `board-${width}`);
      await tabs.nth(2).click();
      assert.ok(await page.locator('#work-panel-frise .work-frise-row').count() >= 3);
      assert.ok(await page.locator('#work-panel-frise .work-bar-span').count() >= 3);
      assert.ok(await page.locator('#work-panel-frise .work-frise-facts', { hasText: 'created' }).count() >= 3);
      const overlaps = await page.evaluate(() => {
        const today = document.querySelector('.work-frise-today')!.getBoundingClientRect();
        return [...document.querySelectorAll('.work-frise-edge')].filter(edge => {
          const box = edge.getBoundingClientRect();
          return box.left < today.right && today.left < box.right && box.top < today.bottom && today.top < box.bottom;
        }).length;
      });
      assert.equal(overlaps, 0, 'the Today label does not cover an edge date');
      await noOverflow(page);
      await shot(page, `frise-${width}`);
      await tabs.nth(3).click();
      await page.locator('#work-panel-deps .work-dep-level').first().waitFor();
      assert.ok(await page.locator('#work-panel-deps', { hasText: 'Level 0' }).isVisible());
      assert.equal(await page.locator('#work-panel-deps', { hasText: 'Level 1: waits on level 0 or lower' }).count(), 1, 'the level heading names the level below');
      assert.ok(await page.locator('#work-panel-deps .work-dep-state').count() > 0, 'the state of each target is a word');
      await noOverflow(page);
      await shot(page, `deps-${width}`);
      // keyboard: arrows move and select, Home and End jump, only the selected tab is in the tab order
      await tabs.nth(0).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#work-tab-board').getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'work-tab-board');
      await page.keyboard.press('End');
      assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#work-tab-reprise').getAttribute('aria-selected'), 'true', 'wraps around');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await page.locator('#work-tab-reprise').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.work-tab[tabindex="0"]').count(), 1);
      assert.deepEqual(problems, []);
    });

    test('touch targets are at least 44 px and the focus ring is visible', { timeout: 900_000 }, async () => {
      const { page } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await openRelayProject(page);
      const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#work-root button')]
        .filter(node => node.offsetParent !== null && node.getBoundingClientRect().height < 43.5)
        .map(node => `${node.className}:${Math.round(node.getBoundingClientRect().height)}`));
      assert.deepEqual(small, []);
      await page.keyboard.press('Shift');   // keyboard modality: :focus-visible applies to the next focus()
      await page.locator('.work-tab').first().focus();
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
      assert.notEqual(outline, 'none');
    });

    test('a task opens its detail; hostile text stays inert; Escape closes the detail first', { timeout: 900_000 }, async () => {
      const { page, problems } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await openRelayProject(page);
      await page.locator('.work-tab').nth(1).click();
      await noOverflow(page);
      const hostile = page.locator('#work-panel-board .work-card', { hasText: '<script>window.__pwn=2</script>' });
      await hostile.waitFor();
      assert.ok((await hostile.textContent())!.includes('<img src=x onerror=window.__pwn=1>'), 'markup is shown as text');
      assert.equal(await page.locator('#work-root img, #work-root script, #work-root b, #work-root i').count(), 0, 'no element was created from data');
      assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);
      await hostile.click();
      const pane = page.locator('.work-detail-pane');
      await pane.locator('.work-detail-heading').waitFor();
      assert.ok((await pane.textContent())!.includes('hostile-session'), 'the session name is shown');
      assert.ok((await pane.textContent())!.includes('<b>hostile-session</b>'), 'as text, not as markup');
      assert.equal(await pane.locator('a, button:not(.work-detail-close):not(.work-answer-send)').count(), 0, 'sessions are plain text, not clickable');
      assert.ok(await pane.locator('.work-event-inferred').count() >= 1, 'an inferred event is marked');
      assert.ok(await pane.locator('.work-prov-inferred').count() >= 1, 'with a word as well as a style');
      assert.ok(await pane.locator('.work-dep-state').count() >= 1, 'blocked_by shows the state of its target');
      const answered = pane.locator('.work-question-answered[data-question-id="N-0000a0a2"]');
      assert.equal(await answered.locator('.work-answer-text').textContent(), HOSTILE_ANSWER, 'the answer is shown, as text');
      const meta = (await answered.locator('.work-answer-meta').textContent())!;
      assert.ok(meta.includes("owner's answer as relayed by asking-session, not verified"), `a relayed, unverified claim: ${meta}`);
      assert.ok(!meta.includes('answered by') && !meta.includes('stated answerer'), `no bare attribution, no label for owner: ${meta}`);
      assert.equal(await answered.locator('.work-answer-meta *').count(), 0, 'the provenance is text only');
      assert.equal(await answered.locator('.work-answer-hint').textContent(), 'This answer was relayed by an agent and is not verified. You can give your own answer here; it replaces the relayed one.',
        'a question answered only by a relay can still be answered by the owner');
      assert.equal(await answered.locator('[data-work-answer-slot] form.work-answer-form').count(), 1);
      const forged = (await pane.locator('[data-question-id="N-0000a0a3"] .work-answer-meta').textContent())!;
      assert.ok(forged.startsWith('answer as relayed by other-session, not verified'), `a claimed verification stays a relayed claim: ${forged}`);
      assert.ok(forged.includes('stated answerer: Owner (verified, in person)') && !forged.includes("owner's answer"), `the label is shown as stated, not as fact: ${forged}`);
      const open = pane.locator('.work-question-open[data-question-id="N-0000a0a1"]');
      assert.equal(await open.locator('.work-answer-hint').textContent(), 'Answer below, or in an agent session with mesh-work.', 'an open question says where to answer');
      const slot = open.locator('.work-answer-area[data-work-answer-for="N-0000a0a1"] [data-work-answer-slot="N-0000a0a1"]');
      assert.equal(await slot.count(), 1, 'the reply slot is there');
      assert.equal(await slot.getByLabel('Your answer').count(), 1, 'with a labelled field');
      assert.equal(await slot.getByRole('button', { name: 'Send answer' }).count(), 1, 'and a send button');
      assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined, 'the answer text stays inert');
      await noOverflow(page);
      await shot(page, `detail-${width}`);
      assert.equal(await page.locator('#work-panel-board').isVisible(), width > 760, 'a phone shows the detail in place of the board');
      await page.keyboard.press('Escape');
      assert.equal(await pane.isVisible(), false, 'Escape closes the detail');
      assert.equal(await page.evaluate(() => document.body.classList.contains('projecting')), true, 'and stays in Projects');
      await page.locator('#work-panel-board .work-card[data-task="T-3c4d"]').click();
      await pane.locator('.work-detail-heading').waitFor();
      assert.ok(await pane.locator('li', { hasText: 'waiting for slot confirmation' }).count() >= 1, 'an open blocker is listed');
      assert.deepEqual(problems, []);
    });

    test('the old view stays reachable through a persisted switch', { timeout: 900_000 }, async () => {
      const { page } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await waitForEntry(page);
      const toggle = page.locator('#projects-view-switch');
      assert.equal((await toggle.textContent())?.trim(), 'Old view');
      await toggle.click();
      assert.equal(await shown(page, '#work-root'), false);
      assert.equal(await shown(page, '#projects-root'), true);
      assert.equal((await toggle.textContent())?.trim(), 'New view');
      await page.reload();
      await page.locator('#projects').waitFor({ state: 'visible' });
      assert.equal(await shown(page, '#work-root'), false, 'the choice survives a reload');
      assert.equal(await shown(page, '#projects-root'), true);
      await toggle.click();
      await waitForEntry(page);
      assert.equal(await shown(page, '#work-root'), true);
    });

    test('no tracker: a plain empty state that offers the old view', { timeout: 900_000 }, async () => {
      const { page } = await signedIn(untracked, 'en-US', width);
      await enterProjects(page, width);
      const empty = page.locator('.work-error[data-kind="no-tracker"]');
      await empty.waitFor();
      assert.equal((await empty.locator('.work-error-title').textContent())?.trim(), 'No tracker found');
      const advice = (await empty.locator('.work-error-text').textContent()) ?? '';
      assert.match(advice, /mesh-work/, 'the empty state says which tools start the tracker');
      assert.match(advice, /work_add_product/, 'the advice names the tool that creates a product');
      assert.match(advice, /work_add_project/, 'the advice names the tool that creates a project');
      assert.match(advice, /WL_HOME/, 'the advice covers an existing tracker that WL_HOME must name');
      assert.match(advice, /“Try again”/, 'the advice names the retry button');
      assert.equal(await empty.getByRole('button', { name: 'Try again' }).count(), 1, 'the advice names a button that is there');
      await noOverflow(page);
      await shot(page, `empty-${width}`);
      await empty.getByRole('button', { name: 'Use the old view' }).click();
      assert.equal(await shown(page, '#projects-root'), true);
      assert.equal(await shown(page, '#work-root'), false);
    });

    test('program missing: the old view takes over once, the stored choice is kept, then the error offers both ways out', { timeout: 900_000 }, async () => {
      const { page, requests } = await signedIn(noReader, 'en-US', width);
      await enterProjects(page, width);
      await page.waitForFunction(() => !(document.querySelector('#projects-root') as HTMLElement).hidden);
      assert.equal(await shown(page, '#work-root'), false, 'the old workspace is shown');
      assert.equal(await page.locator('#projects-fallback-notice').isVisible(), true, 'with a one-line notice');
      const stored = (): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith('.projects.legacy')));
      assert.deepEqual(await stored(), [], 'the automatic fallback does not overwrite the stored preference');
      await noOverflow(page);
      await page.locator('#projects-view-switch').click();   // "New view": the fallback happens once per page load
      const unavailable = page.locator('.work-error[data-kind="not-available"]');
      await unavailable.waitFor();
      assert.equal((await unavailable.locator('.work-error-title').textContent())?.trim(), 'Reading failed');
      assert.equal(await page.locator('#projects-fallback-notice').isVisible(), false);
      assert.ok(await unavailable.getByRole('button', { name: 'Try again' }).isVisible());
      assert.ok(await unavailable.getByRole('button', { name: 'Use the old view' }).isVisible());
      const before = requests.length;
      await unavailable.getByRole('button', { name: 'Try again' }).click();
      await page.waitForFunction(() => document.querySelector('.work-error[data-kind="not-available"]') !== null);
      assert.ok(requests.length > before, 'retry asks again');
      assert.equal(await shown(page, '#work-root'), true, 'and does not fall back a second time');
      await noOverflow(page);
      await shot(page, `unavailable-${width}`);
      await unavailable.getByRole('button', { name: 'Use the old view' }).click();
      assert.equal(await shown(page, '#projects-root'), true);
      assert.equal((await stored()).length, 1, 'the owner own choice is stored');
    });

    test('a project opened from the list returns focus to its row after "Back to products"', { timeout: 900_000 }, async () => {
      const { page } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await openRelayProject(page);
      await page.locator('.work-back').click();
      await waitForEntry(page);
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-project') === true), true, 'focus is on the project row');
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
    });

    test('Escape with focus on the page body closes an open detail before leaving Projects', { timeout: 900_000 }, async () => {
      const { page } = await signedIn(tracked, 'en-US', width);
      await enterProjects(page, width);
      await openRelayProject(page);
      await page.locator('.work-tab').nth(1).click();
      await page.locator('#work-panel-board .work-card[data-task="T-3c4d"]').click();
      await page.locator('.work-detail-pane .work-detail-heading').waitFor();
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.work-detail-pane').isVisible(), false);
      assert.equal(await page.evaluate(() => document.body.classList.contains('projecting')), true);
    });
  });
}

describe('Projects view in French', { skip }, () => {
  test('tabs and empty state are in French', { timeout: 900_000 }, async () => {
    const { page } = await signedIn(tracked, 'fr-FR', 390);
    await enterProjects(page, 390);
    await openRelayProject(page);
    assert.deepEqual(await page.locator('.work-tab').allTextContents(), ['Reprise', 'Tableau', 'Frise', 'Dépendances', 'Questions']);
    await shot(page, 'french-390');
    const none = await signedIn(untracked, 'fr-FR', 390);
    await enterProjects(none.page, 390);
    await none.page.locator('.work-error[data-kind="no-tracker"]').waitFor();
    assert.equal((await none.page.locator('.work-error-title').textContent())?.trim(), 'Aucun suivi trouvé');
    const advice = (await none.page.locator('.work-error-text').textContent()) ?? '';
    assert.match(advice, /outils mesh-work/, 'the French advice says which tools start the tracker');
    assert.match(advice, /work_add_product/, 'the French advice names the tool that creates a product');
    assert.match(advice, /work_add_project/, 'the French advice names the tool that creates a project');
    assert.match(advice, /WL_HOME/, 'the French advice covers an existing tracker that WL_HOME must name');
    assert.match(advice, /« Réessayer »/, 'the French advice names the retry button');
    assert.equal(await none.page.getByRole('button', { name: 'Réessayer' }).count(), 1);
  });
});
