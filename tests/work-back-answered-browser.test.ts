// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The way back inside the Projects view and an answered question leaving every surface at once, in headless Chromium
// against a throwaway server.py, native PTY host, real work-read and work-write, on a fictional tracker:
//   - from a task sheet, its button (named after the tab it covers), Escape and the browser's Back return to that tab
//     (on a phone, scrolled where it was); from a project, Escape and Back return to the entry screen; the page is
//     never left, and leaving Projects takes back the history entries the view added;
//   - an answer given in the task sheet (1440 px) or in the Questions tab (390 px) at once leaves the "? n" marker of
//     the sessions, the header button and the Projects button count, the Questions tab and the entry screen, with no
//     reload and well before the marker's one-minute read; an answered question is never drawn in the pending colour.
// Needs MESH_CHROMIUM, MESH_PTYHOST_CMD, MESH_PYTHON and built work-read and work-write (MESH_WORK_READ_CMD and
// MESH_WORK_WRITE_CMD, default the dune build outputs); skipped without them (MESH_REQUIRE_BROWSER=1 and
// MESH_REQUIRE_WORK_READ=1 make that a failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import { REPO, TerminalMesh, skip as noBrowser } from './terminal-browser-lib.ts';

const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = noBrowser || (!process.env.MESH_PTYHOST_CMD && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_PTYHOST_CMD is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ
    ? 'built work-read and work-write are required' : false);
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const PROJECT = 'P-5e6f', OTHER_PROJECT = 'P-7a7a', TASK = 'T-7b7b';
const FILLERS = ['T-7c01', 'T-7c02', 'T-7c03', 'T-7c04', 'T-7c05', 'T-7c06', 'T-7c07', 'T-7c08'];
const question = (ts: string, about: string, id: string, session: string): object =>
  ({ ts, task: about, type: 'question', id, text: `Fictional question ${id}?`, agent: 'claude', session });
const task = (id: string, title: string, minute: number, priority: string): object[] => [
  { ts: `2026-11-07T09:${String(minute).padStart(2, '0')}:00Z`, task: id, type: 'created', title, project: 'relay', category: 'platform', priority, status: 'todo' },
  { ts: `2026-11-07T09:${String(minute).padStart(2, '0')}:30Z`, task: id, type: 'set', field: 'project', to: OTHER_PROJECT },
];
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: OTHER_PROJECT, type: 'project_created', title: 'Second rollout', product: 'relay', category: 'platform' },
  // The fillers come first on the Board and make it taller than a phone screen: the way back has a scroll to put back.
  ...FILLERS.flatMap((id, index) => task(id, `Filler task ${index + 1}`, 10 + index, 'P1')),
  ...task(TASK, 'Marker task', 30, 'P3'),
  { ts: '2026-11-07T09:31:00Z', task: TASK, type: 'session_linked', agent: 'shell', session: 'qa-linked', host: 'testhost', repo: null, branch: null },
  // qa-linked: one question about its task, asked elsewhere; qa-asker: two of its own in another project.
  question('2026-11-08T09:00:00Z', TASK, 'N-0000d001', 'far-away'),
  question('2026-11-08T09:01:00Z', PROJECT, 'N-0000d002', 'qa-asker'),
  question('2026-11-08T09:02:00Z', 'T-1a2b', 'N-0000d003', 'qa-asker'),
];

function tracker(scratch: string): string {
  const directory = path.join(scratch, 'tracker');
  fs.cpSync(FIXTURE, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'events', '2026-11.hostq.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', directory, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return directory;
}

let scratch = '';
let mesh: TerminalMesh;
const errors: string[] = [];

before(async () => {
  if (skip) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pba-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  for (const name of ['qa-linked', 'qa-asker']) await mesh.newShell(name);
});
after(async () => {
  await mesh?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

// app.js script-scope bindings, read inside page functions.
declare const active: { id: string } | null;
declare const sessionMarker: { marker: (name: string) => unknown } | null;

const row = (page: Page, name: string) => page.locator(`#list .item[data-id="${name}"]`);
const rowBadge = (page: Page, name: string) => row(page, name).locator('.question-badge');
const headerButton = (page: Page) => page.locator('.pane.active [data-act="questions"]');
const sheetBack = (page: Page) => page.locator('.work-detail-pane .work-detail-close');
const projectsBadge = (page: Page): Promise<string | null> => page.locator('#btn-projects .projects-question-badge')
  .evaluate((node: HTMLElement) => (node.hidden ? null : node.textContent));

async function signIn(width: number): Promise<Page> {
  const phone = width < 600;
  const page = await mesh.signIn({ width, height: phone ? 844 : 900 }, undefined, watched => {
    watched.on('pageerror', error => errors.push(String(error)));
  }, { phone });
  page.setDefaultTimeout(120_000);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

async function noOverflow(page: Page): Promise<void> {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0,
    'nothing overflows horizontally');
}

async function enterProjects(page: Page, width: number): Promise<void> {
  if (width < 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  await page.locator('.work-entry-questions h2 .work-count').waitFor();
}

/** Show the session in the active pane and wait for its header. */
async function openSession(page: Page, name: string, phone: boolean): Promise<void> {
  if (phone && !(await row(page, name).isVisible())) await page.locator('#btn-menu').click();
  await row(page, name).click();
  await page.waitForFunction(id => active?.id === id, name);
}

/** Where the view stands: Projects shown, the project and tab, the sheet, the page's URL and its history level. */
const where = (page: Page) => page.evaluate(() => ({
  projecting: document.body.classList.contains('projecting'),
  entry: document.querySelector('#work-root .work-entry-questions') !== null,
  tab: document.querySelector('#work-root .work-tab[aria-selected="true"]')?.id ?? null,
  sheet: (document.querySelector('#work-root .work-detail-pane') as HTMLElement | null)?.hidden === false,
  path: location.pathname,
  level: (history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0,
}));

/** The view's own moves through the history land a moment later (`history.go`): wait for the entry's level. */
const atLevel = (page: Page, level: number) => page.waitForFunction(
  expected => ((history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0) === expected, level);

/** No element of a question card is drawn in the pending colour (--wait), text or border. */
async function pendingColoured(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(scope => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--wait)';
    document.body.append(probe);
    const wait = getComputedStyle(probe).color;
    probe.remove();
    return [...document.querySelectorAll<HTMLElement>(`${scope}, ${scope} *`)].filter(node => {
      const style = getComputedStyle(node);
      return node.offsetParent !== null && (style.color === wait || (style.borderTopWidth !== '0px' && style.borderTopColor === wait)
        || style.backgroundColor === wait);
    }).map(node => node.className);
  }, selector);
}

describe('the way back inside a project', { skip }, () => {
  for (const width of [1440, 390] as const) {
    test(`at ${width} px: sheet, tab and entry screen by the button, Escape and the browser Back`, { timeout: 600_000 }, async () => {
      const page = await signIn(width);
      const phone = width < 600;
      await enterProjects(page, width);
      await page.locator(`.work-entry-project[data-project="${OTHER_PROJECT}"]`).click();
      await page.locator('#work-tab-board').click();
      const card = page.locator(`#work-panel-board [data-task="${TASK}"]`);
      await card.scrollIntoViewIfNeeded();
      const scrolled = await page.locator('#projects').evaluate(node => node.scrollTop);
      if (phone) assert.ok(scrolled > 0, `the board scrolls on a phone (scrollTop ${scrolled})`);
      await card.click();
      await page.locator('.work-detail-heading', { hasText: 'Marker task' }).waitFor();
      assert.deepEqual(await where(page), { projecting: true, entry: false, tab: 'work-tab-board', sheet: true, path: '/', level: 2 });

      // The sheet's button names the tab it returns to; a 44 px target.
      assert.equal(await sheetBack(page).innerText(), 'Back to the Board tab');
      assert.equal(await sheetBack(page).getAttribute('aria-label'), 'Back to the Board tab of Second rollout');
      const box = await sheetBack(page).boundingBox();
      assert.ok(box && box.height >= 44 && box.width >= 44, `a 44 px target, got ${JSON.stringify(box)}`);
      await noOverflow(page);
      await shot(page, `back-sheet-${width}`);

      // The browser's Back (a phone's back gesture): the sheet closes, the Board tab is there, scrolled where it was.
      await page.goBack();
      await page.waitForFunction(() => (document.querySelector('#work-root .work-detail-pane') as HTMLElement).hidden);
      assert.deepEqual(await where(page), { projecting: true, entry: false, tab: 'work-tab-board', sheet: false, path: '/', level: 1 });
      if (phone) assert.equal(await page.locator('#projects').evaluate(node => node.scrollTop), scrolled, 'the tab is scrolled where it was');
      assert.equal(await card.evaluate(node => document.activeElement === node), true, 'focus on the card that opened the sheet');

      // The button, then Escape, from the keyboard.
      await card.click();
      await sheetBack(page).waitFor();
      await sheetBack(page).focus();
      await page.keyboard.press('Enter');
      assert.equal((await where(page)).sheet, false);
      await atLevel(page, 1);
      await card.click();
      await page.locator('.work-detail-heading').waitFor();
      await page.keyboard.press('Escape');
      await atLevel(page, 1);
      assert.deepEqual(await where(page), { projecting: true, entry: false, tab: 'work-tab-board', sheet: false, path: '/', level: 1 });
      // Escape in a project goes to the entry screen (it used to leave Projects).
      await page.keyboard.press('Escape');
      await page.locator('.work-entry-questions h2 .work-count').waitFor();
      await atLevel(page, 0);
      assert.deepEqual(await where(page), { projecting: true, entry: true, tab: null, sheet: false, path: '/', level: 0 });
      await page.waitForFunction(id => document.activeElement?.getAttribute('data-project') === id, OTHER_PROJECT);

      // Back twice: sheet, tab, entry screen; the page is never left.
      await page.locator(`.work-entry-project[data-project="${OTHER_PROJECT}"]`).click();
      await page.locator(`#work-panel-reprise`).waitFor();
      await page.locator('#work-tab-board').click();
      await card.click();
      await page.locator('.work-detail-heading').waitFor();
      await page.goBack();
      await page.waitForFunction(() => (document.querySelector('#work-root .work-detail-pane') as HTMLElement).hidden);
      await page.goBack();
      await page.locator('.work-entry-questions h2 .work-count').waitFor();
      await atLevel(page, 0);
      assert.deepEqual(await where(page), { projecting: true, entry: true, tab: null, sheet: false, path: '/', level: 0 });

      // Leaving Projects from a sheet takes the view's history entries back: the next Back is not a dead one.
      await page.locator(`.work-entry-project[data-project="${OTHER_PROJECT}"]`).click();
      await page.locator('#work-tab-board').click();
      await card.click();
      await page.locator('.work-detail-heading').waitFor();
      await page.locator('#projects-return').click();
      await page.waitForFunction(() => !document.body.classList.contains('projecting'));
      await page.waitForFunction(() => ((history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0) === 0);
      // Projects opens again as it was left, on the project (its entry pushed once the move back has landed); Escape
      // goes to the entry screen, and there it leaves Projects as before.
      if (phone) {
        await page.locator('#btn-mobile-actions').click();
        await page.locator('[data-mobile-action="btn-projects"]').click();
      } else await page.locator('#btn-projects').click();
      await page.locator('#work-tab-board[aria-selected="true"]').waitFor();
      await page.waitForFunction(() => (history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel === 1);
      await page.locator('#work-tab-board').focus();
      await page.keyboard.press('Escape');
      await page.locator('.work-entry-questions h2 .work-count').waitFor();
      await atLevel(page, 0);
      assert.deepEqual(await where(page), { projecting: true, entry: true, tab: null, sheet: false, path: '/', level: 0 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('projecting'));
      if (!phone) {
        // A reload inside a project keeps the history entry; the new page reuses it rather than stacking a second
        // project entry, so Back from a project opened after the reload still reaches the entry screen.
        await enterProjects(page, width);
        await page.locator(`.work-entry-project[data-project="${OTHER_PROJECT}"]`).click();
        await atLevel(page, 1);
        await page.reload();
        await page.locator('.work-entry-questions h2 .work-count').waitFor();
        await atLevel(page, 0);
        await page.locator(`.work-entry-project[data-project="${OTHER_PROJECT}"]`).click();
        await atLevel(page, 1);
        await page.goBack();
        await page.locator('.work-entry-questions h2 .work-count').waitFor();
        assert.deepEqual(await where(page), { projecting: true, entry: true, tab: null, sheet: false, path: '/', level: 0 });
        // Escape while the project is still being read goes back to the entry screen too, not out of Projects.
        await page.route('**/api/work/v1', async route => {
          if (route.request().postData()?.includes('"op":"project"')) await new Promise(resolve => setTimeout(resolve, 3000));
          await route.continue().catch(() => undefined);
        });
        await page.locator(`.work-entry-project[data-project="${OTHER_PROJECT}"]`).click();
        await page.locator('#work-root .work-loading').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('.work-entry-questions h2 .work-count').waitFor();
        await atLevel(page, 0);
        assert.equal((await where(page)).projecting, true, 'still in Projects');
        await page.unroute('**/api/work/v1');
      }
      await page.context().close();
    });
  }
});

describe('an answered question leaves every surface at once', { skip }, () => {
  test('at 1440 px, answered in the task sheet opened by the session marker', { timeout: 600_000 }, async () => {
    const page = await signIn(1440);
    await rowBadge(page, 'qa-linked').waitFor({ timeout: 60_000 });
    assert.equal(await rowBadge(page, 'qa-linked').textContent(), '? 1');
    const before = Number(await projectsBadge(page));
    await openSession(page, 'qa-linked', false);
    await headerButton(page).click();
    const sheet = page.locator('.work-detail-pane');
    const asked = sheet.locator('[data-question-id="N-0000d001"]');
    await asked.getByLabel('Your answer').fill('fictional answer');
    await asked.getByRole('button', { name: 'Send answer' }).click();
    await asked.locator('.work-answer-verified').waitFor({ timeout: 60_000 });
    const answeredAt = Date.now();

    // Still in Projects, no reload: the marker already dropped the question, the Projects button counts one less.
    await page.waitForFunction(() => sessionMarker?.marker('qa-linked') === null, undefined, { timeout: 5000 });
    await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected,
      String(before - 1), { timeout: 10_000 });
    assert.deepEqual(await pendingColoured(page, '.work-detail-pane [data-question-id="N-0000d001"]'), [], 'answered: not in the pending colour');

    // Back (the browser's) from the sheet opened by the marker: its project's Questions tab, the question answered.
    await page.goBack();
    await page.waitForFunction(() => (document.querySelector('#work-root .work-detail-pane') as HTMLElement).hidden);
    assert.equal((await where(page)).tab, 'work-tab-questions');
    // The tab was read again after the answer (a moment after the sheet): it shows the question answered.
    const inTab = page.locator('#work-panel-questions [data-question-id="N-0000d001"]');
    await inTab.locator('.work-qcard-answered').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('#work-panel-questions .work-qcard-open').count(), 0);
    assert.deepEqual(await pendingColoured(page, '#work-panel-questions [data-question-id="N-0000d001"]'), []);
    await shot(page, 'answered-tab-1440');

    // Back again: the entry screen, which no longer lists it, and counts one less.
    await page.goBack();
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    assert.equal(await page.locator('.work-entry-questions h2 .work-count').innerText(), String(before - 1));
    assert.equal(await page.locator('.work-entry-questions [data-question-id="N-0000d001"]').count(), 0);

    // The sessions: no marker on the row, no header button, without waiting for the minute read.
    await page.locator('#btn-sessions').click();
    await rowBadge(page, 'qa-linked').waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await headerButton(page).isHidden(), true);
    assert.equal(await projectsBadge(page), String(before - 1));
    assert.equal(await rowBadge(page, 'qa-asker').textContent(), '? 2', 'the other session keeps its marker');
    assert.ok(Date.now() - answeredAt < 30_000, 'well within the minute');
    await page.context().close();
  });

  test('at 390 px, answered in the Questions tab', { timeout: 600_000 }, async () => {
    const page = await signIn(390);
    await page.locator('#btn-menu').click();
    await rowBadge(page, 'qa-asker').waitFor({ timeout: 60_000 });
    assert.equal(await rowBadge(page, 'qa-asker').textContent(), '? 2');
    const before = Number(await projectsBadge(page));
    await openSession(page, 'qa-asker', true);
    await page.waitForFunction(() => !document.body.classList.contains('drawer'));
    await headerButton(page).click();
    const tab = page.locator('#work-panel-questions');
    const asked = tab.locator('[data-question-id="N-0000d002"]');
    await asked.getByLabel('Your answer').fill('fictional answer at phone width');
    await asked.getByRole('button', { name: 'Send answer' }).click();
    await asked.locator('.work-answer-verified').waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => (sessionMarker?.marker('qa-asker') as { count: number } | null)?.count === 1, undefined, { timeout: 5000 });
    await page.waitForFunction(expected => document.querySelector('[data-mobile-action="btn-projects"] .projects-question-badge')?.textContent === expected,
      String(before - 1), { timeout: 10_000 });
    assert.equal(await asked.locator('.work-qcard-answered').count(), 1);
    assert.deepEqual(await pendingColoured(page, '#work-panel-questions [data-question-id="N-0000d002"]'), []);
    await noOverflow(page);
    await shot(page, 'answered-tab-390');

    await page.locator('.work-back').click();
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    assert.equal(await page.locator('.work-entry-questions h2 .work-count').innerText(), String(before - 1));
    assert.equal(await page.locator('.work-entry-questions [data-question-id="N-0000d002"]').count(), 0);

    await page.locator('#projects-return').click();
    await page.waitForFunction(() => !document.body.classList.contains('projecting'));
    await headerButton(page).waitFor();
    assert.match(await headerButton(page).innerText(), /^\?\s*1$/, 'the header button counts what is left');
    await page.locator('#btn-menu').click();
    await page.waitForFunction(() => document.querySelector('#list .item[data-id="qa-asker"] .question-badge')?.textContent === '? 1',
      undefined, { timeout: 5000 });
    await noOverflow(page);
    await page.context().close();
  });
});
