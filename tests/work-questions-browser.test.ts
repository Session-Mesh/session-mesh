// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Questions surfaces of the Projects view in headless Chromium against the real server, the real work-read and
// the real work-write on a fictional tracker: the pending questions of the entry screen (one folded line above the
// products, unfolded into a list classified by zone, product, project and task, with no answer form), the ways in
// from a row (the task sheet at the question, the project's Questions tab, the sheet of a question about nothing,
// the sheet of a task in no project), the Questions tab of a project, and the open questions badge of the Projects
// button. More than one page of questions runs in tests/work-questions-pages-browser.test.ts; the harness (server,
// tracker, page, checks) is tests/helpers/work-questions-harness.ts.
// Needs MESH_CHROMIUM, MESH_PYTHON, MESH_WORK_READ_CMD and MESH_WORK_WRITE_CMD (default: the dune build outputs);
// skipped without a Chromium (MESH_REQUIRE_BROWSER=1 makes that a failure) or without the programs
// (MESH_REQUIRE_WORK_READ=1 makes that a failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import type { Mesh } from './mesh-server-lib.ts';
import {
  announced, answer, badge, card, closeContexts, countsAgree, entry, focusedQuestion, launch, noOverflow, openCount, openProjects,
  row, shot, signedIn, skip, smallTargets, start, stopAll, temporaryTracker, toggle, unfold, uniqueIds,
} from './helpers/work-questions-harness.ts';

const TASK = 'T-8e8e';          // product gateway, project P-5e6f, zone Platform
const HARBOUR = 'T-3c4d';       // product relay-edge, project P-5e6f, zone Platform
const LONE = 'T-9c0d';          // product supplies, no project, zone Office
const PROJECT = 'P-5e6f';       // product relay
const HOSTILE = '<img src=x onerror=window.__pwn=9> which port?';
const LONG = `Which harbour slot? ${'The tide tables and the crane bookings both matter here. '.repeat(8)}End.`;

// Each test answers its own questions, so the tests share one tracker without depending on their order.
type Asked = Readonly<{ id: string; about: string | null; text: string; at: string; session?: string }>;
const ASKED: readonly Asked[] = [
  { id: 'N-0000c0c1', about: TASK, text: HOSTILE, at: '2026-11-08T09:00:00Z' },
  { id: 'N-0000c0c2', about: TASK, text: 'Keep the old endpoint?', at: '2026-11-08T09:01:00Z' },
  { id: 'N-0000c0c3', about: PROJECT, text: 'Rename the project?', at: '2026-11-08T09:02:00Z' },
  { id: 'N-0000c0c4', about: null, text: 'A question about nothing in particular?', at: '2026-11-09T09:00:00Z' },
  { id: 'N-0000c0c5', about: null, text: 'Another free question?', at: '2026-11-09T08:00:00Z', session: 'other-session' },
  { id: 'N-0000c0c6', about: TASK, text: 'Phone width question?', at: '2026-11-08T09:03:00Z' },
  { id: 'N-0000c0c7', about: null, text: 'Hostile extras?', at: '2026-11-09T09:02:00Z' },
  { id: 'N-0000c0c8', about: TASK, text: 'Answered from the sheet over the board?', at: '2026-11-08T09:04:00Z' },
  { id: 'N-0000c0c9', about: PROJECT, text: 'Draft kept in the tab?', at: '2026-11-08T09:05:00Z' },
  { id: 'N-0000c0ca', about: LONE, text: 'Archive them all?', at: '2026-11-07T10:00:00Z' },
  { id: 'N-0000c0cb', about: HARBOUR, text: LONG, at: '2026-11-07T09:00:00Z' },
  { id: 'N-0000c0cc', about: null, text: 'Answered from its own sheet?', at: '2026-11-09T09:03:00Z' },
  { id: 'N-0000c0cd', about: TASK, text: 'Answered in the sheet opened from the list?', at: '2026-11-08T09:06:00Z' },
];
const HOSTILE_ASSUMPTION = '<img src=x onerror=window.__pwn=7>';
const HOSTILE_OPTIONS = ['<b>keep</b>', '<a href="javascript:window.__pwn=8">drop</a>'];
const EXTRAS: Readonly<Record<string, object>> = {
  'N-0000c0c2': { assumption: 'keep it for now', options: ['keep', 'drop'] },
  'N-0000c0c7': { assumption: HOSTILE_ASSUMPTION, options: HOSTILE_OPTIONS },
};
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: TASK, type: 'created', title: 'Questions task', project: 'gateway', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'set', field: 'project', to: PROJECT },
  ...ASKED.map(q => ({ ts: q.at, task: q.about ?? q.id, type: 'question', id: q.id, text: q.text, agent: 'claude',
    session: q.session ?? 'asking-session', ...(EXTRAS[q.id] ?? {}) })),
];

let asking: Mesh, quiet: Mesh;

before(async () => {
  if (skip) return;
  await launch();
  asking = await start('workq-', temporaryTracker(EVENTS));
  quiet = await start('workq-none-', temporaryTracker([]));
});
afterEach(closeContexts);
after(stopAll);

// app.js script-scope binding, read inside page functions.
declare const sessionMarker: { openQuestions: () => number | null } | null;

/** After a failed read of the view the badge shows no number the view did not read: nothing, or (once the session
 *  marker, told of the failure, has read the tracker again) the count the marker read. */
async function onlyReadCount(page: Page): Promise<void> {
  const [shown, read] = await page.evaluate(() => [
    (document.querySelector('#btn-projects .projects-question-badge') as HTMLElement).hidden
      ? null : document.querySelector('#btn-projects .projects-question-badge')!.textContent,
    sessionMarker?.openQuestions() ?? null]);
  assert.ok(shown === null || shown === String(read), `badge ${shown}, marker ${read}`);
}

describe('pending questions in the Projects view', { skip }, () => {
  test('the entry screen leads with the products; the questions are one folded line with their count, without forms', { timeout: 900_000 }, async () => {
    const { page, problems, reads } = await entry(asking, 1440);
    assert.equal(reads.filter(op => op === 'open-questions').length, 1, 'one read of the open questions, with the entry screen');
    assert.equal(reads.filter(op => op === 'resume').length, 0, 'not the resume of the agents, which keeps only the newest');
    const total = await openCount(page);
    assert.equal(await badge(page), String(total), 'the badge shows the count read with the entry screen');
    assert.equal(await page.locator('#projects-questions-description').textContent(), `${total} open question${total === 1 ? '' : 's'}`);
    assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false', 'folded by default');
    assert.equal(await toggle(page).textContent(), `Pending questions${total}`);
    assert.equal(await page.locator('#work-entry-questions-body').isHidden(), true);
    const section = await page.locator('.work-entry-questions').boundingBox();
    const product = await page.locator('.work-entry-toggle').first().boundingBox();
    assert.ok(section && section.height < 100, `the folded section is one line (${section?.height} px)`);
    assert.ok(product && product.y < 300, `the products are on the first screen (${product?.y} px)`);
    const forms = '.work-entry-questions textarea, .work-entry-questions .work-answer-form, .work-entry-questions .work-answer-area';
    assert.equal(await page.locator(forms).count(), 0, 'no answer form on the entry screen');
    await shot(page, 'questions-entry-folded-1440');
    await unfold(page);
    assert.equal(await page.locator(forms).count(), 0, 'none unfolded either');
    assert.equal(await page.locator('.work-qmore').count(), 0, 'fewer than a page: no "Show more questions"');
    assert.deepEqual(problems, []);
  });

  test('unfolded, the questions are classified by zone, product, project and task; a project once, under its product', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await toggle(page).focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'unfolded from the keyboard');
    const zones = await page.locator('.work-qzone').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.zone));
    assert.deepEqual(zones, ['platform', 'office', 'unattached'], 'the taxonomy order, then the questions without context');
    assert.ok((await page.locator('[data-zone="platform"] > .work-qzone-title').textContent())!.startsWith('Platform'));
    // The tasks of Delivery rollout were moved to gateway and relay-edge; the project stays under its own product.
    const products = await page.locator('[data-zone="platform"] > .work-qproduct').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
    assert.deepEqual(products, ['relay']);
    assert.equal(await page.locator(`.work-qproject[data-group="${PROJECT}"]`).count(), 1, 'the project is shown once');
    const relay = page.locator('[data-zone="platform"] > .work-qproduct[data-group="relay"]');
    const tasks = await relay.locator('.work-qtask').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
    assert.equal(tasks[0], HARBOUR, 'the task of the oldest question first');
    const ids = await relay.locator(`.work-qtask[data-group="${TASK}"] .work-qrow`).evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.questionId));
    assert.deepEqual(ids, [...ids].sort(), 'the oldest first inside a task (the fixture ids follow the dates)');
    const hostile = row(page, 'N-0000c0c1');
    if (await hostile.count() > 0) {   // another test may have answered it
      assert.equal(await hostile.locator('.work-qrow-context').textContent(), `Product relay › Project Delivery rollout › ${TASK} Questions task`);
    }
    assert.deepEqual(problems, []);
  });

  test('a row gives its text as text, kind, age, asker, where it stands and one way in; long texts fold', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    const hostile = row(page, 'N-0000c0c1');
    if (await hostile.count() > 0) {   // another test may have answered it
      assert.equal(await hostile.locator('.work-question-text').textContent(), HOSTILE, 'shown as written, as text');
      assert.match((await hostile.locator('.work-qcard-meta').textContent())!, /^Open question · (\d+ days ago|yesterday) · asked by asking-session \(claude\)$/);
      assert.equal(await hostile.locator('.work-qrow-open').textContent(), `Open in task ${TASK}`);
    }
    const choice = row(page, 'N-0000c0c2');
    if (await choice.count() > 0) {
      assert.equal(await choice.locator('.work-qkind').textContent(), 'Decision', 'options offered: a decision');
      assert.equal(await choice.locator('.work-qcard-extra').first().textContent(), 'Options offered: keep · drop');
      assert.equal(await choice.locator('details.work-qrow-assumption').getAttribute('open'), null, 'the assumption is folded');
      await choice.locator('details.work-qrow-assumption summary').click();
      assert.equal(await choice.locator('details.work-qrow-assumption p').textContent(), 'keep it for now');
    }
    const long = row(page, 'N-0000c0cb');
    const more = long.getByRole('button', { name: 'Show more' });
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await more.click();
    assert.equal(await long.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded'), 'true');
    assert.equal(await long.locator('.work-question-text').textContent(), LONG, 'the whole text, not cut at 300 characters');
    assert.deepEqual(problems, []);
  });

  test('the questions without context are grouped by session; hostile extras stay text; the open state is kept', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    const lone = page.locator('[data-zone="unattached"]');
    assert.match((await lone.locator('.work-qzone-hint').textContent())!, /attached to no task or project the tracker knows/);
    const sessions = await lone.locator('.work-qproduct').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
    assert.deepEqual(sessions, ['other-session', 'asking-session'], 'the session of the oldest question first');
    assert.equal(await row(page, 'N-0000c0c4').locator('.work-qrow-open').textContent(), 'Open the question');
    const extras = await row(page, 'N-0000c0c7').locator('.work-qcard-extra').allTextContents();
    assert.deepEqual(extras, [`Options offered: ${HOSTILE_OPTIONS.join(' · ')}`, HOSTILE_ASSUMPTION]);
    assert.equal(await page.locator('#work-root img, #work-root script, #work-root b, #work-root a[href^="javascript"]').count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn), undefined);
    await uniqueIds(page);
    await shot(page, 'questions-entry-open-1440');
    // The open state is kept for this tab of the browser: a reload shows the list unfolded again.
    await page.reload();
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    if (!(await page.locator('#work-root').isVisible())) await openProjects(page, 1440);
    await toggle(page).waitFor();
    assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'kept open in sessionStorage');
    await toggle(page).click();
    // Kept with the rest of the view's place (static/work-view-state.ts), under its one key.
    await page.waitForFunction(() => !(sessionStorage.getItem('mesh.workView') ?? '').includes('"questionsOpen":true'));
    assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('mesh.work'))), ['mesh.workView']);
    assert.deepEqual(problems, []);
  });

  test('"Open in task" opens the task sheet at the question, the answer is given there, Back returns to the list', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    const before = await openCount(page);
    await row(page, 'N-0000c0cd').locator('.work-qrow-open').click();
    const pane = page.locator('.work-detail-pane');
    await pane.locator('.work-detail-heading', { hasText: 'Questions task' }).waitFor();
    assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-question-id') === 'N-0000c0cd'
      && document.activeElement.closest('.work-detail-pane') !== null, undefined, { timeout: 30_000 });
    await answer(card(pane, 'N-0000c0cd'), 'answered in the sheet opened from the list');
    await card(pane, 'N-0000c0cd').locator('.work-answer-verified').waitFor();
    await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected,
      String(before - 1), { timeout: 30_000 });
    await page.goBack();
    await page.waitForFunction(() => (document.querySelector('.work-detail-pane') as HTMLElement | null)?.hidden !== false);
    await page.goBack();
    await toggle(page).waitFor();
    assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'back to the list, still unfolded');
    await countsAgree(page);
    assert.equal(await row(page, 'N-0000c0cd').count(), 0, 'the answered question left the list');
    assert.deepEqual(problems, []);
  });

  test('a question without context opens its own sheet, is answered there, and leaves the list', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    const before = await openCount(page);
    await row(page, 'N-0000c0cc').locator('.work-qrow-open').click();
    const sheet = page.locator('.work-qsheet');
    assert.equal(await sheet.locator('.work-detail-heading').textContent(), 'Question without context');
    assert.match((await sheet.locator('.work-qzone-hint').textContent())!, /attached to no task or project/);
    assert.match((await card(sheet, 'N-0000c0cc').locator('.work-qcard-meta').textContent())!, /asked by asking-session \(claude\)/);
    await answer(card(sheet, 'N-0000c0cc'), 'answered from its own sheet');
    await announced(page, 'Answer recorded.');
    await sheet.locator('.work-answer-recorded').waitFor();
    assert.equal(await badge(page), String(before - 1));
    await sheet.locator('.work-back').click();
    await toggle(page).waitFor();
    await countsAgree(page);
    assert.equal(await row(page, 'N-0000c0cc').count(), 0);
    assert.deepEqual(problems, []);
  });

  test('a question about a task in no project opens that task\'s sheet alone, at the question; Escape returns', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    assert.equal(await row(page, 'N-0000c0ca').locator('.work-qrow-context').textContent(), `Product supplies › ${LONE} Archive old labels`);
    await row(page, 'N-0000c0ca').locator('.work-qrow-open').click();
    const sheet = page.locator('.work-qsheet');
    await sheet.locator('.work-detail-heading', { hasText: 'Archive old labels' }).waitFor();
    assert.equal(await focusedQuestion(page), 'N-0000c0ca', 'at the question');
    await answer(card(sheet, 'N-0000c0ca'), 'archive them');
    await card(sheet, 'N-0000c0ca').locator('.work-answer-verified').waitFor();
    await page.keyboard.press('Escape');   // focus is on the answered question, not in a field holding text
    await toggle(page).waitFor();
    await countsAgree(page);
    assert.equal(await row(page, 'N-0000c0ca').count(), 0);
    assert.deepEqual(problems, []);
  });

  test('the Questions tab groups by task, answers inline, and the sheet and the badge follow', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    const before = await openCount(page);
    await row(page, 'N-0000c0c3').getByRole('button', { name: 'Open project Delivery rollout' }).click();
    const tab = page.locator('#work-panel-questions');
    await tab.locator('.work-qcard').first().waitFor();
    assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true', 'opened on the Questions tab');
    const groups = await tab.locator('.work-qgroup').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
    assert.deepEqual(groups.slice(-1), ['no-task'], '"without a task" last');
    assert.ok(groups.includes(TASK));
    await tab.locator(`.work-qgroup-task[data-task="${TASK}"]`).click();
    const pane = page.locator('.work-detail-pane');
    await card(pane, 'N-0000c0c2').waitFor();
    await uniqueIds(page);
    await answer(card(tab, 'N-0000c0c2'), 'drop it');
    await card(tab, 'N-0000c0c2').locator('.work-answer-verified').waitFor();
    await card(pane, 'N-0000c0c2').locator('.work-answer-verified').waitFor();
    assert.equal(await focusedQuestion(page), 'N-0000c0c2', 'focus on the answered question in the tab');
    await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected,
      String(before - 1), { timeout: 30_000 });
    await answer(card(pane, 'N-0000c0c1'), 'port 8443');
    await card(pane, 'N-0000c0c1').locator('.work-answer-verified').waitFor();
    await card(tab, 'N-0000c0c1').locator('.work-answer-verified').waitFor();
    await page.waitForFunction(expected => document.querySelector('#btn-projects .projects-question-badge')?.textContent === expected,
      String(before - 2), { timeout: 30_000 });
    await uniqueIds(page);
    await shot(page, 'questions-tab-1440');
    assert.deepEqual(problems, []);
  });

  test('at phone width the section and the list fit, with 44 px targets, the phone menu shows the badge, and an answer works', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 390);
    await noOverflow(page);
    const menuBadge = page.locator('[data-mobile-action="btn-projects"] .projects-question-badge');
    assert.equal(await menuBadge.evaluate((node: HTMLElement) => node.hidden), false, 'the phone menu item carries the badge');
    await shot(page, 'questions-entry-folded-390');
    await unfold(page);
    await noOverflow(page);
    assert.deepEqual(await smallTargets(page, '.work-entry-questions'), [], 'touch targets of the list are at least 44 px');
    await shot(page, 'questions-entry-open-390');
    await row(page, 'N-0000c0c6').locator('.work-qrow-open').click();
    const pane = page.locator('.work-detail-pane');
    await card(pane, 'N-0000c0c6').waitFor();
    await noOverflow(page);
    await answer(card(pane, 'N-0000c0c6'), 'answered at phone width');
    await card(pane, 'N-0000c0c6').locator('.work-answer-verified').waitFor();
    await noOverflow(page);
    await shot(page, 'questions-sheet-390');
    assert.deepEqual(problems, []);
  });

  test('the questions speak French, with the same words as the English', { timeout: 900_000 }, async () => {
    const { page } = await entry(asking, 390, 'fr-FR');
    assert.ok((await toggle(page).textContent())!.startsWith('Questions en attente'));
    await unfold(page);
    assert.ok((await page.locator('[data-zone="unattached"] > .work-qzone-title').textContent())!.startsWith('Sans contexte'));
    const hint = (await page.locator('[data-zone="unattached"] .work-qzone-hint').textContent())!;
    assert.match(hint, /connus du suivi : elles s’affichent sans contexte/, 'as in English: shown without context');
    assert.doesNotMatch(hint, /opérateur|propriétaire/, 'nobody named in the third person');
    const long = row(page, 'N-0000c0cb');
    await long.getByRole('button', { name: 'Voir plus', exact: true }).click();
    assert.equal(await long.getByRole('button', { name: 'Voir moins', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.equal(await row(page, 'N-0000c0c3').locator('.work-qrow-open').textContent(), 'Ouvrir le projet Delivery rollout');
    assert.match((await row(page, 'N-0000c0c3').locator('.work-qcard-meta').textContent())!, /^Question ouverte · (il y a \d+ jours|hier) · posée par asking-session \(claude\)$/);
    assert.match((await page.locator('#projects-questions-description').textContent())!, /^\d+ questions? ouvertes?$/);
  });

  test('a failed read of the questions keeps the products, shows the error with a retry, and hides the badge', { timeout: 900_000 }, async () => {
    let fail = true;
    const { page } = await entry(asking, 1440, 'en-US', p => p.route('**/api/work/v1', async route => {
      if (fail && route.request().postData()?.includes('"op":"open-questions"')) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"busy","message":"busy"}}' });
      }
      return route.continue();
    }));
    const error = page.locator('.work-entry-questions .work-error[data-kind="busy"]');
    await error.waitFor();
    assert.ok(await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).count() > 0, 'the products are shown');
    await onlyReadCount(page);
    await page.waitForFunction(() => !(document.querySelector('#btn-projects .projects-question-badge') as HTMLElement).hidden,
      undefined, { timeout: 15_000 });
    await onlyReadCount(page);
    fail = false;
    await error.getByRole('button', { name: 'Try again' }).click();
    await toggle(page).waitFor();
    assert.equal(await badge(page), String(await openCount(page)));
  });

  test('without questions: one line saying so, an empty tab, and no badge', { timeout: 900_000 }, async () => {
    const { page } = await entry(quiet, 1440);
    assert.equal(await page.locator('.work-questions-none').textContent(), 'No open question.');
    assert.equal(await toggle(page).count(), 0, 'nothing to unfold');
    assert.equal(await badge(page), null);
    assert.equal(await page.locator('#btn-projects').getAttribute('aria-describedby'), null);
    await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).click();
    await page.locator('#work-tab-questions').click();
    assert.equal(await page.locator('#work-panel-questions .work-empty').textContent(), 'No question about this project or its tasks.');
  });

  test('a draft in the Questions tab survives an answer sent from the sheet while another tab is shown', { timeout: 900_000 }, async () => {
    const { page, problems } = await entry(asking, 1440);
    await unfold(page);
    await row(page, 'N-0000c0c9').getByRole('button', { name: 'Open project Delivery rollout' }).click();
    const tab = page.locator('#work-panel-questions');
    await card(tab, 'N-0000c0c9').getByLabel('Your answer').fill('draft while on the board');
    await page.locator('#work-tab-board').click();
    await page.locator(`#work-panel-board [data-task="${TASK}"]`).first().click();
    const pane = page.locator('.work-detail-pane');
    await answer(card(pane, 'N-0000c0c8'), 'answered from the sheet over the board');
    await announced(page, 'Answer recorded.');
    await page.locator('#work-tab-questions').click();
    assert.equal(await card(tab, 'N-0000c0c9').getByLabel('Your answer').inputValue(), 'draft while on the board');
    await card(tab, 'N-0000c0c8').locator('.work-answer-verified').waitFor({ timeout: 10_000 });
    assert.deepEqual(problems, []);
  });

  test('two pages opening Projects at once both show the entry screen and its questions', { timeout: 900_000 }, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pages = await Promise.all([signedIn(asking, 1440), signedIn(asking, 1440)]);
      await Promise.all(pages.map(({ page }) => openProjects(page, 1440)));
      for (const { page } of pages) {
        assert.equal(await page.locator('.work-content > .work-error').count(), 0, `attempt ${attempt}: the entry screen is shown`);
        assert.equal(await page.locator('.work-entry-questions .work-error').count(), 0, `attempt ${attempt}: the questions are shown`);
      }
      await closeContexts();
    }
  });

  test('a question about a project missing from the list still opens it, by its id', { timeout: 900_000 }, async () => {
    const { page } = await entry(asking, 1440, 'en-US', p => p.route('**/api/work/v1', async route => {
      if (!route.request().postData()?.includes('"op":"projects"')) return route.continue();
      const response = await route.fetch();
      const body = await response.json() as { projects: { id: string }[] };
      return route.fulfill({ response, json: { ...body, projects: body.projects.filter(project => project.id !== PROJECT) } });
    }));
    await unfold(page);
    const open = row(page, 'N-0000c0c3').locator('.work-qrow-open');
    assert.equal(await open.getAttribute('data-project'), PROJECT);
    await open.click();
    await page.locator('.work-crumb-title', { hasText: 'Delivery rollout' }).waitFor();
    assert.equal(await page.locator('#work-tab-questions').getAttribute('aria-selected'), 'true');
  });
});
