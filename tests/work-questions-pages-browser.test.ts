// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// More than one page of pending questions in the Projects view, in headless Chromium against the real server, the
// real work-read and the real work-write on a fictional tracker: the entry screen lists every open question, the
// oldest first, a page at a time ("Show more questions"), with the true total; a question is read in full; a
// question about a task the tracker does not know is answered on its own sheet; an answer whose task sheet cannot be
// read again says so, with "Try again". The harness is tests/helpers/work-questions-harness.ts.
// Needs MESH_CHROMIUM, MESH_PYTHON, MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD (default: the dune build outputs);
// skipped like tests/work-questions-browser.test.ts. MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import type { Mesh } from './mesh-server-lib.ts';
import {
  announced, answer, badge, card, closeContexts, entry, launch, noOverflow, row, shot, skip, start, stopAll, temporaryTracker,
  toggle, unfold,
} from './helpers/work-questions-harness.ts';

const TASK = 'T-8e8e';          // in project P-5e6f
const UNKNOWN = 'T-ffff';       // no such task in the tracker
const FREE = 24;                // questions about nothing, one a minute
const free = (n: number): string => `N-0000e${n.toString(16).padStart(3, '0')}`;
const LONG = `Which crane? ${'The harbour schedule, the tide and the berth all weigh on it. '.repeat(10)}End.`;
const PAGE = 20;

// Oldest first: the task question, the one about an unknown task, then the free ones. Each test answers its own.
const EVENTS = [
  { ts: '2026-11-01T07:00:00Z', task: TASK, type: 'created', title: 'Pages task', project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-01T07:01:00Z', task: TASK, type: 'set', field: 'project', to: 'P-5e6f' },
  { ts: '2026-11-01T08:00:00Z', task: TASK, type: 'question', id: 'N-0000e200', text: 'Read again after the answer?', agent: 'claude', session: 'asking-session' },
  { ts: '2026-11-01T09:00:00Z', task: UNKNOWN, type: 'question', id: 'N-0000e100', text: 'About a task nobody knows?', agent: 'claude', session: 'asking-session' },
  ...Array.from({ length: FREE }, (_, i) => ({ ts: `2026-11-01T10:${String(i).padStart(2, '0')}:00Z`, task: free(i + 1), type: 'question',
    id: free(i + 1), text: i === 0 ? LONG : `Free question ${i + 1}?`, agent: 'claude', session: 'asking-session' })),
];
const TOTAL = FREE + 2;

let mesh: Mesh;
let routes: { failTask: boolean };

before(async () => {
  if (skip) return;
  await launch();
  mesh = await start('workq-pages-', temporaryTracker(EVENTS));
});
afterEach(closeContexts);
after(stopAll);

const shownIds = (page: Page): Promise<string[]> =>
  page.locator('.work-entry-questions .work-qrow').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.questionId ?? ''));

describe('more than one page of pending questions', { skip }, () => {
  test('every open question can be shown, the oldest first, a page at a time, with the true total', { timeout: 900_000 }, async () => {
    const { page, problems, reads } = await entry(mesh, 1440);
    assert.equal(await badge(page), String(TOTAL), 'the badge counts every open question');
    assert.equal(await toggle(page).locator('.work-count').textContent(), String(TOTAL));
    await unfold(page);
    const first = await shownIds(page);
    assert.equal(first.length, PAGE, 'one page');
    assert.ok(first.includes(free(1)), 'the oldest question is shown (resume kept only the 20 newest)');
    assert.ok(!first.includes(free(FREE)), 'the newest waits for the next page');
    assert.match((await page.locator('.work-qmore .work-omitted').textContent())!, /^6 more open questions, more recent, are not shown yet\./);
    await shot(page, 'questions-pages-first-1440');
    await page.getByRole('button', { name: 'Show more questions' }).click();
    await page.locator('.work-entry-questions .work-qrow').nth(TOTAL - 1).waitFor();
    const all = await shownIds(page);
    assert.equal(new Set(all).size, TOTAL, 'every open question, once');
    assert.equal(await page.locator('.work-qmore').count(), 0, 'nothing more to show');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.work-qrow')?.getAttribute('data-question-id')), free(PAGE - 1),
      'focus on the first question added');
    assert.ok(reads.filter(op => op === 'open-questions').length >= 2);
    assert.equal(await badge(page), String(TOTAL));
    await shot(page, 'questions-pages-all-1440');
    assert.deepEqual(problems, []);
  });

  test('at phone width the next page fits too', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(mesh, 390);
    await unfold(page);
    await noOverflow(page);
    await shot(page, 'questions-pages-first-390');
    await page.getByRole('button', { name: 'Show more questions' }).click();
    await page.locator('.work-qmore').waitFor({ state: 'detached' });
    await noOverflow(page);
    await shot(page, 'questions-pages-all-390');
    assert.deepEqual(problems, []);
  });

  test('a question without context is read and answered in full on its own sheet', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(mesh, 1440);
    await unfold(page);
    await row(page, free(1)).locator('.work-qrow-open').click();
    const sheet = page.locator('.work-qsheet');
    assert.equal(await card(sheet, free(1)).locator('.work-question-text').textContent(), LONG, 'the whole text, under the form');
    await answer(card(sheet, free(1)), 'the north crane');
    await announced(page, 'Answer recorded.');
    assert.equal(await badge(page), String(TOTAL - 1));
    assert.deepEqual(problems, []);
  });

  test('a question about a task the tracker does not know opens its own sheet, with the form', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(mesh, 1440);
    await unfold(page);
    const lone = row(page, 'N-0000e100');
    assert.equal(await lone.locator('xpath=ancestor::section[@data-zone]').getAttribute('data-zone'), 'unattached');
    assert.equal(await lone.locator('.work-qrow-open').textContent(), 'Open the question');
    await lone.locator('.work-qrow-open').click();
    const sheet = page.locator('.work-qsheet');
    assert.equal(await sheet.locator('.work-error').count(), 0, 'no error screen');
    await answer(card(sheet, 'N-0000e100'), 'attach it next time');
    await announced(page, 'Answer recorded.');
    await sheet.locator('.work-answer-recorded').waitFor();
    assert.deepEqual(problems, []);
  });

  test('an answer whose task sheet cannot be read again says so, and "Try again" reads it', { timeout: 900_000 }, async () => {
    routes = { failTask: false };
    const { page, problems } = await entry(mesh, 1440, 'en-US', p => p.route('**/api/work/v1', async route => {
      if (routes.failTask && route.request().postData()?.includes('"op":"task"')) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"busy","message":"busy"}}' });
      }
      return route.continue();
    }));
    await unfold(page);
    await row(page, 'N-0000e200').locator('.work-qrow-open').click();
    const pane = page.locator('.work-detail-pane');
    await card(pane, 'N-0000e200').getByLabel('Your answer').waitFor();
    routes.failTask = true;
    await answer(card(pane, 'N-0000e200'), 'yes, read it again');
    await announced(page, 'The answer is recorded, but the task could not be read again.');
    assert.equal(await card(pane, 'N-0000e200').locator('.work-answer-recorded').textContent(), 'Answer recorded.');
    const retry = pane.locator('.work-qsheet-reread').getByRole('button', { name: 'Try again' });
    routes.failTask = false;
    await retry.click();
    await card(pane, 'N-0000e200').locator('.work-answer-verified').waitFor();
    assert.equal(await pane.locator('.work-qsheet-reread').count(), 0);
    assert.deepEqual(problems, []);
  });
});
