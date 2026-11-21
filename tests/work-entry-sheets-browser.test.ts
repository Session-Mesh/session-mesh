// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sheets the entry screen's pending questions open without a project view (static/work-entry-sheets.ts): the sheet
// of a task in no project and the sheet of a question about nothing, in headless Chromium against a throwaway
// server.py, native PTY host, real work-read and work-write, on a fictional tracker:
//   - leaving Projects, or reloading the tab, comes back to the sheet left, with the draft typed there; the pending
//     questions stay unfolded; signing out leaves no key of the view in the tab;
//   - the way back to the entry screen keeps the focus on the question's way in once the list is read again;
//   - the sheet of a task in no project opened while a project was shown replaces it (Refresh shows the entry screen);
//   - two answers sent in one task sheet: the older read of the task never shows last;
//   - an answer recorded whose task cannot be read again: the form gives way to a note and a retry, drafts kept.
// Needs MESH_CHROMIUM, MESH_PTYHOST_CMD, MESH_PYTHON and built work-read and work-write (MESH_WORK_READ_CMD and
// MESH_WORK_WRITE_CMD, default the dune build outputs); skipped without them (MESH_REQUIRE_BROWSER=1 and
// MESH_REQUIRE_WORK_READ=1 make that a failure). MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page, Route } from 'playwright-core';
import { REPO, TerminalMesh, skip as noBrowser } from './terminal-browser-lib.ts';

const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = noBrowser || (!process.env.MESH_PTYHOST_CMD && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_PTYHOST_CMD is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ
    ? 'built work-read and work-write are required' : false);
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const KEY = 'mesh.workView';
const PROJECT = 'P-7a7a', TASK = 'T-7b7b';
/** A task of the fixture in no project, and its title. */
const LONE = 'T-9c0d', LONE_TITLE = 'Archive old labels';
// Each test answers (or types under) its own questions.
const Q_LONE = 'N-0000e001', Q_ORDER_A = 'N-0000e002', Q_ORDER_B = 'N-0000e003', Q_FAIL = 'N-0000e004', Q_OTHER = 'N-0000e005';
const Q_FREE = 'N-0000e011';
const DRAFT_LONE = 'fictional lone draft zq91', DRAFT_FREE = 'fictional free draft zq92', DRAFT_OTHER = 'fictional other draft zq93';
const asked = (ts: string, about: string, id: string): object =>
  ({ ts, task: about, type: 'question', id, text: `Fictional question ${id}?`, agent: 'claude', session: 'far-away' });
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: PROJECT, type: 'project_created', title: 'Second rollout', product: 'relay', category: 'platform' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'created', title: 'Alpha one', project: 'relay', category: 'platform', priority: 'P3', status: 'todo' },
  { ts: '2026-11-07T09:02:00Z', task: TASK, type: 'set', field: 'project', to: PROJECT },
  ...[Q_LONE, Q_ORDER_A, Q_ORDER_B, Q_FAIL, Q_OTHER].map((id, index) => asked(`2026-11-08T09:0${index}:00Z`, LONE, id)),
  asked('2026-11-08T10:00:00Z', Q_FREE, Q_FREE),
];

function tracker(scratch: string): string {
  const directory = path.join(scratch, 'tracker');
  fs.cpSync(FIXTURE, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'events', '2026-11.hosts.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  await mesh.newShell('qa-sheets');
});
after(async () => {
  await mesh?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

// app.js script-scope bindings, used as its session marker does (openSessionQuestions).
declare let pendingWorkTarget: unknown;
declare function setProjects(on: boolean): void;

async function signIn(): Promise<Page> {
  const page = await mesh.signIn({ width: 1440, height: 900 }, undefined, watched => {
    watched.on('pageerror', error => errors.push(String(error)));
  });
  page.setDefaultTimeout(120_000);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

/** Projects open on the entry screen, its pending questions read. */
async function toEntry(page: Page): Promise<void> {
  await page.locator('#btn-projects').click();
  await page.locator('.work-entry-questions h2 .work-count').waitFor();
}

async function toSessions(page: Page): Promise<void> {
  await page.locator('#btn-sessions').click();
  await page.waitForFunction(() => !document.body.classList.contains('projecting'));
}

/** Unfold the pending questions (when folded) and open the row of `question`. */
async function openRow(page: Page, question: string): Promise<void> {
  const toggle = page.locator('.work-qsection-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator(`.work-qrow[data-question-id="${question}"] .work-qrow-open`).click();
}

const atLevel = (page: Page, expected: number) => page.waitForFunction(
  wanted => ((history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0) === wanted, expected);
const field = (page: Page, question: string) => page.locator(`.work-qsheet [data-work-answer-slot="${question}"] .work-answer-input`);
const card = (page: Page, question: string) => page.locator(`.work-qsheet [data-question-id="${question}"]`);
const fieldHolds = (page: Page, question: string, text: string) => page.waitForFunction(([id, value]) =>
  (document.querySelector(`.work-qsheet [data-work-answer-slot="${id}"] .work-answer-input`) as HTMLTextAreaElement | null)?.value === value,
[question, text] as const);
const storedHolds = (page: Page, text: string) => page.waitForFunction(([key, value]) =>
  (sessionStorage.getItem(key) ?? '').includes(value), [KEY, text] as const);

async function loneShown(page: Page): Promise<void> {
  await page.locator('.work-qsheet .work-detail-heading', { hasText: LONE_TITLE }).waitFor();
}

async function send(page: Page, question: string, text: string): Promise<void> {
  await field(page, question).fill(text);
  await card(page, question).getByRole('button', { name: 'Send answer' }).click();
}

describe('the sheets opened from the entry screen', { skip }, () => {
  test('come back as left, with their drafts; the questions stay unfolded; signing out leaves no key', { timeout: 600_000 }, async () => {
    const page = await signIn();
    await toEntry(page);
    await openRow(page, Q_LONE);
    await page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key) ?? '{}').place?.questionsOpen === true, KEY);
    await loneShown(page);
    await atLevel(page, 1);
    await field(page, Q_LONE).fill(DRAFT_LONE);
    await storedHolds(page, DRAFT_LONE);

    // To the sessions and back: the same sheet, its level of the history, its draft.
    await toSessions(page);
    await page.locator('#btn-projects').click();
    await loneShown(page);
    await atLevel(page, 1);
    await fieldHolds(page, Q_LONE, DRAFT_LONE);
    await shot(page, 'entry-sheet-lone-back');

    // Back to the entry screen: the questions unfolded, and once they are read again the focus is still on the way in
    // of the question that opened the sheet.
    await page.evaluate(() => {
      const holder = window as unknown as { blocks: number };
      holder.blocks = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.work-entry-questions')) holder.blocks++;
        }
      }).observe(document.getElementById('work-root')!, { childList: true, subtree: true });
    });
    await page.locator('.work-qsheet .work-back').click();
    await page.waitForFunction(() => (window as unknown as { blocks: number }).blocks >= 2);
    assert.equal(await page.locator('.work-qsection-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(id => document.activeElement === document.querySelector(
      `.work-qrow[data-question-id="${id}"] .work-qrow-open`), Q_LONE), true, 'the focus stays on the way in after the re-read');

    // The sheet of a question about nothing, and a reload of the tab: the sheet and its draft.
    await openRow(page, Q_FREE);
    await page.locator('.work-qsheet .work-detail-heading', { hasText: 'Question without context' }).waitFor();
    await field(page, Q_FREE).fill(DRAFT_FREE);
    await storedHolds(page, DRAFT_FREE);
    await page.reload();
    await page.locator('.work-qsheet .work-detail-heading', { hasText: 'Question without context' }).waitFor();
    await atLevel(page, 1);
    await fieldHolds(page, Q_FREE, DRAFT_FREE);

    // Signing out: nothing of the view stays in this tab.
    await page.evaluate(() => document.getElementById('btn-logout')?.click());
    await page.waitForURL(/\/login/);
    assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('mesh.'))), []);
    await page.context().close();
  });

  test('a task in no project opened while a project is shown replaces it', { timeout: 300_000 }, async () => {
    const page = await signIn();
    await toEntry(page);
    await page.locator('.work-overview-product[data-product="relay"]').click();   // the product's view lists its projects
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('.work-project-head').waitFor();
    await toSessions(page);
    // As the session marker opens a task (app.js openSessionQuestions).
    await page.evaluate(id => { pendingWorkTarget = { kind: 'task', id }; setProjects(true); }, LONE);
    await loneShown(page);
    await page.locator('.work-refresh').click();
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    assert.equal(await page.locator('.work-project-head').count(), 0, 'Refresh shows the entry screen, not the project left');
    await page.context().close();
  });

  test('two answers in one task sheet: the older read of the task never shows last', { timeout: 300_000 }, async () => {
    const page = await signIn();
    await toEntry(page);
    await openRow(page, Q_ORDER_A);
    await loneShown(page);
    // The first read of the task after an answer is read at once but given to the page only after the second one.
    let release!: () => void, fetched!: () => void, given!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = new Promise<void>(resolve => { fetched = resolve; });
    const done = new Promise<void>(resolve => { given = resolve; });
    let reads = 0;
    await page.route('**/api/work/v1', async (route: Route) => {
      if (JSON.parse(route.request().postData() ?? '{}').op !== 'task' || reads++ > 0) return route.continue();
      const response = await route.fetch();
      fetched();
      await gate;
      await route.fulfill({ response });
      given();
    });
    await send(page, Q_ORDER_A, 'fictional answer A');
    await read;
    await send(page, Q_ORDER_B, 'fictional answer B');
    await card(page, Q_ORDER_B).locator('.work-answer-verified').waitFor({ timeout: 60_000 });
    release();
    await done;
    await page.waitForTimeout(500);   // the page has had the older read for a while: it is not drawn
    assert.equal(await card(page, Q_ORDER_B).locator('.work-answer-verified').count(), 1, 'the second answer still shown');
    assert.equal(await field(page, Q_ORDER_B).count(), 0, 'no answer form again under the second question');
    await page.unroute('**/api/work/v1');
    await page.context().close();
  });

  test('an answer recorded whose task cannot be read again: a note and a retry, the other drafts kept', { timeout: 300_000 }, async () => {
    const page = await signIn();
    await toEntry(page);
    await openRow(page, Q_FAIL);
    await loneShown(page);
    await field(page, Q_OTHER).fill(DRAFT_OTHER);
    await page.route('**/api/work/v1', async (route: Route) =>
      (JSON.parse(route.request().postData() ?? '{}').op === 'task' ? route.abort('failed') : route.continue()));
    await send(page, Q_FAIL, 'fictional answer recorded');
    await page.locator('.work-qsheet .work-qsheet-reread').waitFor({ timeout: 60_000 });
    assert.equal(await card(page, Q_FAIL).locator('.work-answer-recorded').count(), 1, 'the answer shows as recorded');
    assert.equal(await field(page, Q_FAIL).count(), 0, 'no form left disabled');
    assert.equal(await field(page, Q_OTHER).inputValue(), DRAFT_OTHER);
    assert.equal(await field(page, Q_OTHER).evaluate(node => (node as HTMLTextAreaElement).readOnly), false);
    await shot(page, 'entry-sheet-reread-failed');
    await page.unroute('**/api/work/v1');
    await page.locator('.work-qsheet-reread').getByRole('button', { name: 'Try again' }).click();
    await card(page, Q_FAIL).locator('.work-answer-verified').waitFor({ timeout: 60_000 });
    assert.equal(await page.locator('.work-qsheet-reread').count(), 0);
    assert.equal(await field(page, Q_OTHER).inputValue(), DRAFT_OTHER, 'the other draft survives the redraw');
    await page.context().close();
  });
});
