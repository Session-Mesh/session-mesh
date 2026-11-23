// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Projects view comes back as the owner left it, in headless Chromium against a throwaway server.py, native PTY
// host, real work-read and work-write, on a fictional tracker (static/work-view-state.ts, static/work-view-memory.ts):
//   - leaving Projects for the sessions and coming back puts back the project, its tab, the open task sheet, the
//     scroll and the unsent answer draft; the sheet has its history level again (Escape: the tab, then the entry
//     screen);
//   - drafts are kept per question for every sheet and the entry screen, and survive a reload of the tab;
//   - a sent answer drops its draft; signing out drops them all; no draft is ever in a request but the answer sent,
//     and none is ever in localStorage.
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
// These polling scenarios are local-only: they add 90 seconds and use extra questions, changing this shared fixture.
const ENTRY_REFRESH_TEST = process.env.MESH_ENTRY_REFRESH_TEST === '1';
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const PROJECT = 'P-7a7a';
/** Each width answers its own questions (an answer given at one width would close the other's). */
type Set = Readonly<{ first: string; second: string; qFirst: string; qSecond: string; titles: readonly [string, string] }>;
const SETS: Readonly<Record<1440 | 390, Set>> = {
  1440: { first: 'T-7b7b', second: 'T-7d7d', qFirst: 'N-0000d001', qSecond: 'N-0000d004', titles: ['Alpha one', 'Alpha two'] },
  390: { first: 'T-7b8b', second: 'T-7d8d', qFirst: 'N-0000d011', qSecond: 'N-0000d014', titles: ['Bravo one', 'Bravo two'] },
};
const REFRESH: Readonly<Record<1440 | 390, { first: string; qFirst: string; title: string }>> = {
  1440: { first: 'T-7f01', qFirst: 'N-0000d031', title: 'Refresh desktop' },
  390: { first: 'T-7f02', qFirst: 'N-0000d032', title: 'Refresh phone' },
};
const EDIT_TASK = 'T-7f03', EDIT_QUESTION = 'N-0000d033';
const PRODUCT_REFRESH = {
  1440: { first: 'T-7f04', title: 'Refresh product desktop' },
  390: { first: 'T-7f05', title: 'Refresh product phone' },
} as const;
const PRODUCT_EDIT_TASK = 'T-7f06', PRODUCT_EDIT_QUESTION = 'N-0000d034';
const SHEET_REFRESH = {
  1440: { task: 'T-7f10', question: 'N-0000d041', title: 'Sheet desktop' },
  390: { task: 'T-7f11', question: 'N-0000d042', title: 'Sheet phone' },
} as const;
const SHEET_FOCUS_TASK = 'T-7f12';
const SHEET_SEND_TASK = 'T-7f13', SHEET_SEND_QUESTION = 'N-0000d043';
const ENTRY_REFRESH = {
  1440: { task: 'T-7f14', question: 'N-0000d044', title: 'Entry sheet desktop' },
  390: { task: 'T-7f15', question: 'N-0000d045', title: 'Entry sheet phone' },
} as const;
const ISOLATED = { 1440: 'N-0000d046', 390: 'N-0000d047' } as const;
/** The question of the last test, about a task of its own. */
const GONE_TASK = 'T-7e7e', Q_GONE = 'N-0000d021';
const KEY = 'mesh.workView';
// The drafts: fictional, and distinct enough to be found in any request or storage.
const DRAFT_FIRST = 'fictional draft one zq81', DRAFT_ENTRY = 'fictional entry draft zq82', DRAFT_SECOND = 'fictional draft two zq83';
const FILLERS = Array.from({ length: 16 }, (_, index) => `T-7c${String(index + 1).padStart(2, '0')}`);
const task = (id: string, title: string, minute: number, priority: string): object[] => [
  { ts: `2026-11-07T09:${String(minute).padStart(2, '0')}:00Z`, task: id, type: 'created', title, project: 'relay', category: 'platform', priority, status: 'todo' },
  { ts: `2026-11-07T09:${String(minute).padStart(2, '0')}:30Z`, task: id, type: 'set', field: 'project', to: PROJECT },
];
const question = (ts: string, about: string, id: string): object =>
  ({ ts, task: about, type: 'question', id, text: `Fictional question ${id}?`, agent: 'claude', session: 'far-away' });
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: PROJECT, type: 'project_created', title: 'Second rollout', product: 'relay', category: 'platform' },
  // The fillers come first on the Board and make it taller than the screen: there is a scroll to put back.
  ...FILLERS.flatMap((id, index) => task(id, `Filler task ${index + 1}`, 10 + index, 'P1')),
  ...Object.values(SETS).flatMap((set, index) => [
    ...task(set.first, set.titles[0], 40 + 2 * index, 'P3'),
    ...task(set.second, set.titles[1], 41 + 2 * index, 'P3'),
    question(`2026-11-08T09:0${2 * index}:00Z`, set.first, set.qFirst),
    question(`2026-11-08T09:0${2 * index + 1}:00Z`, set.second, set.qSecond),
  ]),
  ...task(GONE_TASK, 'Charlie one', 50, 'P3'),
  question('2026-11-08T09:30:00Z', GONE_TASK, Q_GONE),
  ...Object.values(REFRESH).flatMap((item, index) => [
    ...task(item.first, item.title, 53 + index, 'P3'),
    question(`2026-11-08T09:4${index}:00Z`, item.first, item.qFirst),
  ]),
  ...task(EDIT_TASK, 'Refresh while editing', 55, 'P3'),
  question('2026-11-08T09:42:00Z', EDIT_TASK, EDIT_QUESTION),
  ...task(PRODUCT_REFRESH[1440].first, PRODUCT_REFRESH[1440].title, 56, 'P3'),
  ...task(PRODUCT_REFRESH[390].first, PRODUCT_REFRESH[390].title, 57, 'P3'),
  ...task(PRODUCT_EDIT_TASK, 'Product answer', 58, 'P3'),
  question('2026-11-08T09:43:00Z', PRODUCT_EDIT_TASK, PRODUCT_EDIT_QUESTION),
  ...Object.values(SHEET_REFRESH).flatMap((item, index) => [
    ...task(item.task, item.title, 59, 'P3'),
    question(`2026-11-08T09:5${index}:00Z`, item.task, item.question),
  ]),
  ...task(SHEET_FOCUS_TASK, 'Focused sheet', 59, 'P3'),
  ...task(SHEET_SEND_TASK, 'Answer in flight', 59, 'P3'),
  question('2026-11-08T09:52:00Z', SHEET_SEND_TASK, SHEET_SEND_QUESTION),
  ...(ENTRY_REFRESH_TEST ? Object.values(ENTRY_REFRESH).flatMap((item, index) => [
    { ts: `2026-11-07T09:5${index}:00Z`, task: item.task, type: 'created', title: item.title, project: 'relay', category: 'platform', priority: 'P3', status: 'todo' },
    question(`2026-11-07T10:0${index}:00Z`, item.task, item.question),
  ]) : []),
  ...(ENTRY_REFRESH_TEST ? Object.values(ISOLATED).map((id, index) => ({ ts: `2026-11-07T10:1${index}:00Z`, task: id,
    type: 'question', id, text: `Isolated ${id}?`, agent: 'claude', session: 'far-away' })) : []),
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pvs-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  await mesh.newShell('qa-one');
});
after(async () => {
  await mesh?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

/** Every request of the page: its URL and body, to look for drafts. */
type Sent = { url: string; body: string };

async function signIn(width: number, sent: Sent[], realPoll = false): Promise<Page> {
  const phone = width < 600;
  const page = await mesh.signIn({ width, height: phone ? 844 : 900 }, undefined, watched => {
    watched.on('pageerror', error => errors.push(String(error)));
    watched.on('request', request => sent.push({ url: request.url(), body: request.postData() ?? '' }));
  }, { phone, routes: realPoll ? undefined : async page => {
    await page.route('**/static/work-view.js*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = /(function \w+\(\w+,\w+=)15e3(\)\{let \w+=!1,\w+,\w+=\(\)=>\{\w+\|\|\(\w+=setTimeout)/g;
      assert.equal([...source.matchAll(marker)].length, 1, 'exactly one project poll interval');
      await route.fulfill({ response, body: source.replace(marker, (_match, before: string, after: string) => `${before}200${after}`) });
    });
  } });
  page.setDefaultTimeout(120_000);
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: 'wait' });
  await page.context().close();
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

async function noOverflow(page: Page): Promise<void> {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0,
    'nothing overflows horizontally');
}

async function toProjects(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
}

/** Leave Projects for the sessions (the Sessions button, or on a phone the header's way back). */
async function toSessions(page: Page, phone: boolean): Promise<void> {
  await page.locator(phone ? '#projects-return' : '#btn-sessions').click();
  await page.waitForFunction(() => !document.body.classList.contains('projecting'));
}

const level = (page: Page) => page.evaluate(() => (history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0);
const atLevel = (page: Page, expected: number) => page.waitForFunction(
  wanted => ((history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0) === wanted, expected);
const sheetField = (page: Page, questionId: string) =>
  page.locator(`.work-detail-pane [data-work-answer-slot="${questionId}"] .work-answer-input`);
const tabField = (page: Page, questionId: string) =>
  page.locator(`#work-panel-questions [data-work-answer-slot="${questionId}"] .work-answer-input`);

/** Unfold the pending questions of the entry screen (when folded) and open the row of `question`. */
async function openRow(page: Page, question: string): Promise<void> {
  const toggle = page.locator('.work-qsection-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator(`.work-qrow[data-question-id="${question}"] .work-qrow-open`).click();
}
const scrollTop = (page: Page) => page.locator('#projects').evaluate(node => node.scrollTop);
const stored = (page: Page) => page.evaluate(key => sessionStorage.getItem(key) ?? '', KEY);
const card = (page: Page, id: string) => page.locator(`#work-panel-board [data-task="${id}"]`);

/** The sheet of `title` shown, read in full (its answer form drawn). */
async function sheetShown(page: Page, title: string): Promise<void> {
  await page.locator('.work-detail-pane .work-detail-heading', { hasText: title }).waitFor();
}

/** Escape from the page itself (not from a field holding text, which keeps its text and its level). */
async function escape(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
}

describe('the Projects view comes back as it was left', { skip }, () => {
  for (const width of [1440, 390] as const) test(`refresh restores the open product sheet scroll at ${width}px`, { timeout: 120_000 }, async () => {
    const page = await signIn(width, []);
    await page.addStyleTag({ content: '.work-detail-pane { height: 100px !important; max-height: 100px !important; overflow: auto !important; }' });
    await toProjects(page, width < 600);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator('#work-tab-board').click();
    await card(page, SHEET_REFRESH[1440].task).click();
    await sheetShown(page, SHEET_REFRESH[1440].title);
    const pane = page.locator('.work-detail-pane');
    const original = await pane.evaluate(node => { node.scrollTop = 70; return node.scrollTop; });
    assert.ok(original > 0);
    await page.waitForFunction(([key, expected]) => {
      const saved = sessionStorage.getItem(key);
      return saved !== null && JSON.parse(saved).place?.sheetScroll === expected;
    }, [KEY, original] as const);
    await page.locator('.work-refresh').click();
    await sheetShown(page, SHEET_REFRESH[1440].title);
    await page.waitForFunction(expected => Math.abs((document.querySelector('.work-detail-pane') as HTMLElement).scrollTop - expected) <= 1, original);
    await closePage(page);
  });
  test('an older rail read cannot restore a count after an answer', { timeout: 120_000 }, async () => {
    const id = 'N-0000d0f3';
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify(question('2026-11-09T23:58:00Z', GONE_TASK, id)) + '\n');
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-questions').click();
    const field = tabField(page, id);
    await field.fill('Answer while an old read waits');
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { observed = resolve; });
    let held = false;
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op !== 'open-questions' || held) return route.continue();
      held = true;
      const response = await route.fetch();
      observed();
      await gate;
      await route.fulfill({ response });
    });
    await field.blur();
    await waiting;
    const card = page.locator(`#work-panel-questions [data-question-id="${id}"]`);
    await card.getByRole('button', { name: 'Send answer' }).click();
    await card.locator('.work-answer-verified').waitFor();
    await page.waitForTimeout(6000);
    const before = await page.locator('#btn-projects').textContent();
    release();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#btn-projects').textContent(), before);
    await closePage(page);
  });
  for (const width of [1440, 390] as const) test(`entry list observes a changed question when the count stays the same at ${width}px`, { timeout: 120_000 }, async () => {
    const events = path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl');
    const first = width === 1440 ? 'N-0000d0f1' : 'N-0000d0f4', second = width === 1440 ? 'N-0000d0f2' : 'N-0000d0f5';
    fs.appendFileSync(events, JSON.stringify({ ts: '2026-11-07T10:10:00Z', task: first, type: 'question', id: first,
      text: 'First entry question?', agent: 'claude', session: 'far-away' }) + '\n');
    const page = await signIn(width, []);
    await toProjects(page, width < 600);
    const toggle = page.locator('.work-qsection-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator(`.work-qrow[data-question-id="${first}"]`).waitFor();
    await toggle.blur();
    fs.appendFileSync(events, [
      { ts: '2026-11-09T09:00:00Z', task: first, type: 'answer', question: first, text: 'Done', by: 'owner', via: 'owner-web' },
      { ts: '2026-11-07T10:11:00Z', task: second, type: 'question', id: second, text: 'Second entry question?', agent: 'claude', session: 'far-away' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    await page.locator(`.work-qrow[data-question-id="${second}"]`).waitFor({ timeout: 35_000 });
    assert.equal(await page.locator(`.work-qrow[data-question-id="${first}"]`).count(), 0);
    await closePage(page);
  });
  for (const width of [1440, 390] as const) {
    if (ENTRY_REFRESH_TEST) test(`isolated question disappearance preserves draft at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []), id = ISOLATED[width];
      await toProjects(page, width < 600);
      await openRow(page, id);
      const frame = page.locator('.work-qsheet');
      const field = frame.locator(`[data-work-answer-slot="${id}"] .work-answer-input`);
      await field.fill('Isolated draft retained');
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:51:00Z', task: id, type: 'answer', question: id,
          text: 'Answered elsewhere', by: 'owner', via: 'owner-web' }) + '\n');
      await frame.locator('.work-sheet-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
      assert.equal(await field.inputValue(), 'Isolated draft retained');
      assert.equal(await field.evaluate(node => node === document.activeElement), true);
      await noOverflow(page);
      await closePage(page);
    });
    if (ENTRY_REFRESH_TEST) test(`entry task refresh preserves draft at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []), item = ENTRY_REFRESH[width];
      await toProjects(page, width < 600);
      await openRow(page, item.question);
      const frame = page.locator('.work-qsheet');
      await frame.locator('.work-detail-heading', { hasText: item.title }).waitFor();
      const field = frame.locator(`[data-work-answer-slot="${item.question}"] .work-answer-input`);
      await field.fill('Entry draft preserved');
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:51:00Z', task: item.task, type: 'set', field: 'title', to: `${item.title} updated` }) + '\n');
      await frame.locator('.work-sheet-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
      assert.equal(await field.inputValue(), 'Entry draft preserved');
      assert.equal(await field.evaluate(node => node === document.activeElement), true);
      await field.fill('');
      await field.blur();
      await page.locator('.work-qsheet .work-detail-heading', { hasText: `${item.title} updated` }).waitFor({ timeout: 35_000 });
      await noOverflow(page);
      await closePage(page);
    });
    test(`open task refresh keeps an answer draft at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []);
      const item = SHEET_REFRESH[width];
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
      await page.locator('#work-tab-board').click();
      await card(page, item.task).click();
      await sheetShown(page, item.title);
      const field = sheetField(page, item.question);
      await field.fill('Draft preserved while task changes');
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:51:00Z', task: item.task, type: 'set', field: 'title', to: `${item.title} updated` }) + '\n');
      await page.locator('.work-sheet-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
      assert.equal(await field.inputValue(), 'Draft preserved while task changes');
      assert.equal(await field.evaluate(node => node === document.activeElement), true);
      await field.fill('');
      await field.blur();
      await sheetShown(page, `${item.title} updated`);
      assert.equal(await sheetField(page, item.question).inputValue(), '');
      await closePage(page);
    });
    test(`project rail refreshes counts without stealing focus at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []);
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      const item = page.locator('#work-rail [data-key="product:relay"]');
      const before = Number(await item.locator('.work-tree-tasks').textContent());
      if (width === 1440) await item.focus();
      const id = width === 1440 ? 'T-a801' : 'T-a802';
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        task(id, `Rail update ${width}`, 59, 'P3').map(event => JSON.stringify(event)).join('\n') + '\n');
      if (width === 1440) {
        await page.waitForTimeout(7_000);
        assert.equal(await item.evaluate(node => node === document.activeElement), true);
        assert.equal(Number(await item.locator('.work-tree-tasks').textContent()), before);
        await item.blur();
        await page.locator('#work-rail').evaluate(node => { node.style.maxHeight = '30px'; node.scrollTop = 20; });
      }
      await page.waitForFunction(([old]) => {
        const item = document.querySelector('#work-rail [data-key="product:relay"] .work-tree-tasks');
        return Number(item?.textContent) === old + 1;
      }, [before], { timeout: 35_000 });
      if (width === 1440) assert.equal(await page.locator('#work-rail').evaluate(node => node.scrollTop), 20);
      await closePage(page);
    });
    for (const tab of ['board', 'frise'] as const) {
      test(`product ${tab} refresh preserves filter and focus at ${width}px`, { timeout: 300_000 }, async () => {
        const page = await signIn(width, []);
        const { first, title } = PRODUCT_REFRESH[width];
        await toProjects(page, width < 600);
        await page.locator('.work-overview-product[data-product="relay"]').click();
        await page.locator(`#work-tab-${tab}`).click();
        const search = page.locator('.work-filter-search');
        await search.fill('Refresh');
        await page.waitForTimeout(300);
        const updatedTitle = `${title} product ${tab}`;
        fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
          JSON.stringify({ ts: `2026-11-09T09:${tab === 'board' ? '20' : '21'}:00Z`, task: first, type: 'set', field: 'title', to: updatedTitle }) + '\n');
        if (width === 1440 && tab === 'board') {
          await page.waitForTimeout(7_000);
          assert.equal(await search.inputValue(), 'Refresh');
          assert.equal(await search.evaluate(node => node === document.activeElement), true);
          assert.equal(await page.locator(`#work-panel-${tab} [data-task="${first}"]`).getByText(updatedTitle).count(), 0);
        }
        await search.blur();
        await page.locator(`#work-panel-${tab} [data-task="${first}"]`).getByText(updatedTitle).waitFor({ timeout: 35_000 });
        assert.equal(await page.locator('.work-filter-search').inputValue(), 'Refresh');
        await closePage(page);
      });
    }
    test(`at ${width} px: place, sheet, scroll and drafts, across the sessions, a reload, an answer and a sign-out`,
      { timeout: 600_000 }, async () => {
        const phone = width < 600, sent: Sent[] = [];
        const { first: FIRST, second: SECOND, qFirst: Q_FIRST, qSecond: Q_SECOND, titles: [TITLE_FIRST, TITLE_SECOND] } = SETS[width];
        const page = await signIn(width, sent);
        await toProjects(page, phone);
        await page.locator('.work-entry-questions h2 .work-count').waitFor();

        // A draft in the project's Questions tab, under the second question; then the first task's sheet from the Board.
        await page.locator('.work-overview-product[data-product="relay"]').click();   // the product's view lists its projects
        await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
        await page.locator('#work-tab-questions').click();
        await tabField(page, Q_SECOND).fill(DRAFT_ENTRY);
        await page.locator('#work-tab-board').click();
        await card(page, FIRST).scrollIntoViewIfNeeded();
        const tabScroll = await scrollTop(page);
        assert.ok(tabScroll > 0, `the board scrolls (scrollTop ${tabScroll})`);
        await card(page, FIRST).click();
        await sheetShown(page, TITLE_FIRST);
        await sheetField(page, Q_FIRST).fill(DRAFT_FIRST);
        await sheetField(page, Q_FIRST).scrollIntoViewIfNeeded();
        const sheetScroll = await scrollTop(page);

        // To the sessions and back: the same tab, sheet, scroll, draft, and the sheet's level of the history.
        await toSessions(page, phone);
        await toProjects(page, phone);
        await sheetShown(page, TITLE_FIRST);
        await page.waitForFunction(text => (document.querySelector('.work-detail-pane .work-answer-input') as HTMLTextAreaElement | null)
          ?.value === text, DRAFT_FIRST);
        assert.equal(await page.locator('#work-tab-board').getAttribute('aria-selected'), 'true');
        await atLevel(page, 2);
        assert.ok(Math.abs((await scrollTop(page)) - sheetScroll) <= 1, `scrolled back to ${sheetScroll}, at ${await scrollTop(page)}`);
        await noOverflow(page);
        await shot(page, `state-back-${width}`);

        // Escape from the sheet put back: its tab (on a phone, scrolled where it was), then the entry screen. The
        // project opened again: the draft of its Questions tab is still there.
        await escape(page);
        await atLevel(page, 1);
        assert.equal(await page.locator('.work-detail-pane').isHidden(), true);
        if (phone) assert.equal(await scrollTop(page), tabScroll, 'the tab is scrolled where it was');
        await escape(page);
        await page.locator('.work-entry-questions h2 .work-count').waitFor();
        await atLevel(page, 0);
        await page.locator('.work-overview-product[data-product="relay"]').click();   // the product's view lists its projects
        await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
        await page.locator('#work-tab-questions').click();
        assert.equal(await tabField(page, Q_SECOND).inputValue(), DRAFT_ENTRY);

        // The second sheet: the draft typed in the Questions tab is there; it is changed. The first one's stays.
        await page.locator('#work-tab-board').click();
        await card(page, SECOND).click();
        await sheetShown(page, TITLE_SECOND);
        assert.equal(await sheetField(page, Q_SECOND).inputValue(), DRAFT_ENTRY);
        await sheetField(page, Q_SECOND).fill(DRAFT_SECOND);

        // A reload of the tab: the second sheet and its draft; then the first sheet and its own.
        await page.reload();
        await sheetShown(page, TITLE_SECOND);
        await page.waitForFunction(([id, text]) => (document.querySelector(`.work-detail-pane [data-work-answer-slot="${id}"] .work-answer-input`) as
          HTMLTextAreaElement | null)?.value === text, [Q_SECOND, DRAFT_SECOND] as const);
        await atLevel(page, 2);
        if (phone) { await escape(page); await atLevel(page, 1); }
        await card(page, FIRST).click();
        await sheetShown(page, TITLE_FIRST);
        assert.equal(await sheetField(page, Q_FIRST).inputValue(), DRAFT_FIRST);
        assert.ok((await stored(page)).includes(DRAFT_FIRST) && (await stored(page)).includes(DRAFT_SECOND));

        // The answer sent: its draft is gone from the storage; the other one stays.
        const asked = page.locator(`.work-detail-pane [data-question-id="${Q_FIRST}"]`);
        await asked.getByRole('button', { name: 'Send answer' }).click();
        await asked.locator('.work-answer-verified').waitFor({ timeout: 60_000 });
        await page.waitForFunction(([key, text]) => !(sessionStorage.getItem(key) ?? '').includes(text), [KEY, DRAFT_FIRST] as const);
        assert.ok((await stored(page)).includes(DRAFT_SECOND), 'the other draft stays');
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('zq8')), false, 'no draft in localStorage');

        // An emptied field drops its draft.
        await toSessions(page, phone);
        await toProjects(page, phone);
        await sheetShown(page, TITLE_FIRST);
        if (phone) { await escape(page); await atLevel(page, 1); }
        await card(page, SECOND).click();
        await sheetShown(page, TITLE_SECOND);
        assert.equal(await sheetField(page, Q_SECOND).inputValue(), DRAFT_SECOND);
        await sheetField(page, Q_SECOND).fill('');
        await page.waitForFunction(([key, text]) => !(sessionStorage.getItem(key) ?? '').includes(text), [KEY, DRAFT_SECOND] as const);
        await sheetField(page, Q_SECOND).fill(DRAFT_SECOND);
        await page.waitForFunction(([key, text]) => (sessionStorage.getItem(key) ?? '').includes(text), [KEY, DRAFT_SECOND] as const);

        // No draft ever left the page, but the answer it sent (once).
        const carrying = (text: string) => sent.filter(request => request.url.includes(text) || request.body.includes(text));
        assert.deepEqual(carrying(DRAFT_SECOND), [], 'the second draft was never sent');
        assert.deepEqual(carrying(DRAFT_ENTRY), [], 'the entry draft was never sent');
        const answers = carrying(DRAFT_FIRST);
        assert.equal(answers.length, 1, 'the first draft was sent once, as the answer');
        assert.match(answers[0]?.body ?? '', /"op":"answer"/);

        // Signing out of this device: the sign-in page, and nothing of the view kept in this tab.
        await page.evaluate(() => document.getElementById('btn-logout')?.click());
        await page.waitForURL(/\/login/);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), KEY), null);
        await closePage(page);
      });
  }

  test('background refresh leaves an open answer untouched', { timeout: 300_000 }, async () => {
    const sent: Sent[] = [];
    const page = await signIn(1440, sent, true);
    const first = EDIT_TASK, qFirst = EDIT_QUESTION;
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-board').click();
    await card(page, first).click();
    await sheetField(page, qFirst).fill('draft while data changes');
    const taskReads = (): number => sent.filter(request => request.url.endsWith('/api/work/v1')
      && JSON.parse(request.body || '{}').op === 'task').length;
    const before = taskReads();
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:02:00Z', task: first, type: 'set', field: 'title', to: 'Changed while editing' }) + '\n');
    const pending = page.locator('.work-detail-pane .work-sheet-refresh-status');
    await pending.waitFor({ state: 'visible', timeout: 35_000 });
    assert.match(await pending.textContent() ?? '', /Updates available/);
    assert.ok(taskReads() > before, 'the real 15-second poll read the task after its data changed');
    assert.equal(await sheetField(page, qFirst).inputValue(), 'draft while data changes');
    assert.equal(await sheetField(page, qFirst).evaluate(node => node === document.activeElement), true);
    await closePage(page);
  });

  test('rail refresh reports a failed read and clears it after recovery', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op === 'projects')
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.locator('.work-rail-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.work-rail-refresh-status').waitFor({ state: 'hidden', timeout: 35_000 });
    await closePage(page);
  });

  test('open task reports a failed refresh and clears it after recovery', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-board').click();
    await card(page, SHEET_REFRESH[1440].task).click();
    await page.locator('.work-detail-heading').waitFor();
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op === 'task')
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.locator('.work-sheet-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.work-sheet-refresh-status').waitFor({ state: 'detached', timeout: 35_000 });
    await closePage(page);
  });

  test('open task refresh retains heading focus', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-board').click();
    await card(page, SHEET_FOCUS_TASK).click();
    await sheetShown(page, 'Focused sheet');
    const heading = page.locator('.work-detail-pane .work-detail-heading');
    assert.equal(await heading.evaluate(node => node === document.activeElement), true);
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:52:00Z', task: SHEET_FOCUS_TASK, type: 'set', field: 'title', to: 'Focused sheet updated' }) + '\n');
    await sheetShown(page, 'Focused sheet updated');
    assert.equal(await heading.evaluate(node => node === document.activeElement), true);
    await closePage(page);
  });

  test('background task read does not interrupt an answer being submitted', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-board').click();
    await card(page, SHEET_SEND_TASK).click();
    await sheetField(page, SHEET_SEND_QUESTION).fill('Answer submitted once');
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { observed = resolve; });
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op !== 'answer') return route.continue();
      const response = await route.fetch();
      observed();
      await gate;
      return route.fulfill({ response });
    });
    const question = page.locator(`.work-detail-pane [data-question-id="${SHEET_SEND_QUESTION}"]`);
    await question.getByRole('button', { name: 'Send answer' }).click();
    await pending;
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:53:00Z', task: SHEET_SEND_TASK, type: 'set', field: 'title', to: 'Answer in flight updated' }) + '\n');
    await page.locator('.work-sheet-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
    assert.equal(await sheetField(page, SHEET_SEND_QUESTION).inputValue(), 'Answer submitted once');
    assert.equal(await sheetField(page, SHEET_SEND_QUESTION).evaluate(node => (node as HTMLTextAreaElement).readOnly), true);
    release();
    await question.locator('.work-answer-verified').waitFor({ timeout: 35_000 });
    await sheetShown(page, 'Answer in flight updated');
    await page.unrouteAll({ behavior: 'wait' });
    await closePage(page);
  });

  test('manual refresh retries an unavailable rail immediately', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op === 'projects')
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.locator('.work-rail-refresh-status').waitFor({ state: 'visible', timeout: 35_000 });
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.work-refresh').click();
    await page.locator('.work-rail-refresh-status').waitFor({ state: 'hidden', timeout: 5000 });
    await closePage(page);
  });

  test('a slow rail read cannot discard a newly shown question page', { timeout: 300_000 }, async () => {
    const extra = Array.from({ length: 25 }, (_, index) => question('2026-11-08T10:00:00Z', EDIT_TASK,
      `N-${(0x1000 + index).toString(16).padStart(8, '0')}`));
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      extra.map(event => JSON.stringify(event)).join('\n') + '\n');
    const page = await signIn(1440, []);
    await toProjects(page, false);
    const toggle = page.locator('.work-qsection-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('.work-qmore-button').waitFor();
    let release!: () => void, observed!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { observed = resolve; });
    await page.route('**/api/work/v1', async route => {
      if (!held && JSON.parse(route.request().postData() ?? '{}').op === 'open-questions') {
        held = true;
        const response = await route.fetch();
        observed();
        await gate;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    await pending;
    await page.locator('.work-qmore-button').click();
    await page.waitForFunction(() => document.querySelectorAll('.work-qrow').length > 20);
    const badge = page.locator('#work-rail [data-key="product:relay"] .work-tree-questions');
    const afterMore = await badge.textContent();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(6000);
    release();
    await page.waitForTimeout(1000);
    assert.equal(await badge.textContent(), afterMore);
    await page.unrouteAll({ behavior: 'wait' });
    await closePage(page);
  });

  test('a background refresh does not cancel a slow requested question page', { timeout: 120_000 }, async () => {
    const extra = Array.from({ length: 25 }, (_, index) => question('2026-11-08T11:00:00Z', EDIT_TASK,
      `N-${(0x2000 + index).toString(16).padStart(8, '0')}`));
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      extra.map(event => JSON.stringify(event)).join('\n') + '\n');
    const page = await signIn(1440, []);
    await toProjects(page, false);
    const toggle = page.locator('.work-qsection-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('.work-qmore-button').waitFor();
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { observed = resolve; });
    await page.route('**/api/work/v1', async route => {
      const request = JSON.parse(route.request().postData() ?? '{}');
      if (request.op !== 'open-questions' || !request.args?.after) return route.continue();
      const response = await route.fetch();
      observed();
      await gate;
      await route.fulfill({ response });
    });
    await page.locator('.work-qmore-button').click();
    await pending;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(7_000);
    release();
    await page.waitForFunction(() => document.querySelectorAll('.work-qrow').length > 20, null, { timeout: 10_000 });
    await closePage(page);
  });

  test('product board refresh preserves expanded pages', { timeout: 300_000 }, async () => {
    const bulk = Array.from({ length: 70 }, (_, index) => ({ id: `T-8${index.toString(16).padStart(3, '0')}`, title: `Bulk ${index}` }));
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      bulk.flatMap(item => task(item.id, item.title, 58, 'P3')).map(event => JSON.stringify(event)).join('\n') + '\n');
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator('#work-tab-board').click();
    await page.locator('.work-filter-search').fill('Bulk');
    await page.waitForTimeout(300);
    await page.locator('#work-panel-board .work-more').click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal(await page.locator('#work-panel-board .work-card').count(), 70);
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:30:00Z', task: bulk[0]!.id, type: 'set', field: 'title', to: 'Bulk updated' }) + '\n');
    await page.locator(`#work-panel-board [data-task="${bulk[0]!.id}"]`).getByText('Bulk updated').waitFor({ timeout: 35_000 });
    assert.equal(await page.locator('#work-panel-board .work-card').count(), 70);
    await closePage(page);
  });

  test('product refresh updates its progress counts', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator('#work-tab-board').click();
    await page.locator('#work-tab-board').blur();
    const progress = page.locator('.work-product-head .work-progress-text');
    const before = await progress.textContent();
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:50:00Z', task: PRODUCT_REFRESH[1440].first, type: 'set', field: 'status', to: 'done' }) + '\n');
    await page.waitForFunction(previous => document.querySelector('.work-product-head .work-progress-text')?.textContent !== previous,
      before, { timeout: 35_000 });
    await closePage(page);
  });

  test('product refresh does not interrupt an answer', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator('#work-tab-board').click();
    await card(page, PRODUCT_EDIT_TASK).click();
    await sheetField(page, PRODUCT_EDIT_QUESTION).fill('Unsent product answer');
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:30:00Z', task: PRODUCT_EDIT_TASK, type: 'set', field: 'title', to: 'Product answer changed' }) + '\n');
    await page.waitForTimeout(7_000);
    assert.equal(await sheetField(page, PRODUCT_EDIT_QUESTION).inputValue(), 'Unsent product answer');
    assert.equal(await sheetField(page, PRODUCT_EDIT_QUESTION).evaluate(node => node === document.activeElement), true);
    await closePage(page);
  });

  test('product timeline refresh preserves expanded rows and folded groups', { timeout: 300_000 }, async () => {
    const bulk = Array.from({ length: 70 }, (_, index) => ({ id: `T-9${index.toString(16).padStart(3, '0')}`, title: `Timeline bulk ${index}` }));
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      bulk.flatMap(item => task(item.id, item.title, 58, 'P3')).map(event => JSON.stringify(event)).join('\n') + '\n');
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator('#work-tab-frise').click();
    await page.locator('.work-filter-search').fill('Timeline bulk');
    await page.waitForTimeout(300);
    await page.locator('#work-panel-frise .work-more').click();
    const group = page.locator(`#work-panel-frise .work-pfrise-group[data-project="${PROJECT}"]`);
    await group.locator('.work-pfrise-toggle').click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal(await group.locator('.work-frise-label').count(), 70);
    await page.locator('#work-tab-board').click();
    await page.locator('#work-tab-board').blur();
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify({ ts: '2026-11-09T09:31:00Z', task: bulk[0]!.id, type: 'set', field: 'title', to: 'Timeline bulk updated' }) + '\n');
    await page.waitForTimeout(7_000);
    await page.locator('#work-tab-frise').click();
    await group.locator('.work-frise-label').getByText('Timeline bulk updated').waitFor({ state: 'attached', timeout: 35_000 });
    assert.equal(await group.locator('.work-frise-label').count(), 70);
    assert.equal(await group.locator('.work-pfrise-toggle').getAttribute('aria-expanded'), 'false');
    await closePage(page);
  });

  test('product refresh reports an unavailable source and recovers', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator('#work-tab-frise').click();
    await page.locator('#work-tab-frise').blur();
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op === 'product')
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.locator('.work-auto-refresh-status').waitFor({ timeout: 35_000 });
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.work-auto-refresh-status').waitFor({ state: 'detached', timeout: 35_000 });
    await closePage(page);
  });

  for (const width of [1440, 390] as const) test(`unchanged entry overview keeps its DOM at ${width}px`, { timeout: 120_000 }, async () => {
    const page = await signIn(width, []);
    let observed!: () => void, reads = 0;
    const nextPoll = new Promise<void>(resolve => { observed = resolve; });
    try {
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product').first().waitFor();
      await page.evaluate(() => { (window as unknown as { entryNode: Element | null }).entryNode = document.querySelector('.work-entry'); });
      await page.route('**/api/work/v1', async route => {
        const op = JSON.parse(route.request().postData() ?? '{}').op;
        if (op === 'products' && ++reads === 2) observed();
        if (op !== 'projects') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        if (body.projects.length) body.projects[0].title += ' (updated)';
        await route.fulfill({ response, json: body });
      });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await nextPoll;
      assert.equal(await page.evaluate(() => (window as unknown as { entryNode: Element | null }).entryNode === document.querySelector('.work-entry')), true);
    } finally { await closePage(page); }
  });

  for (const width of [1440, 390] as const) test(`entry overview refreshes only after focus leaves at ${width}px`, { timeout: 120_000 }, async () => {
    const page = await signIn(width, []);
    try {
      await toProjects(page, width < 600);
      const original = page.locator('.work-overview-product[data-product="relay"]');
      await original.focus();
      await page.route('**/api/work/v1', async route => {
        if (JSON.parse(route.request().postData() ?? '{}').op !== 'products') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        const category = body.categories.find((item: { products: { id: string }[] }) => item.products.some(product => product.id === 'relay'));
        const product = category.products.find((item: { id: string }) => item.id === 'relay');
        category.products.push({ ...product, id: `new-${width}` });
        await route.fulfill({ response, json: body });
      });
      await page.waitForTimeout(7000);
      assert.equal(await original.evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator(`.work-overview-product[data-product="new-${width}"]`).count(), 0);
      await original.blur();
      await page.locator(`.work-overview-product[data-product="new-${width}"]`).waitFor({ timeout: 35_000 });
    } finally { await closePage(page); }
  });

  for (const width of [1440, 390] as const) test(`a pending project answer survives background refresh at ${width}px`, { timeout: 120_000 }, async () => {
    const page = await signIn(width, []);
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { observed = resolve; });
    try {
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
      await page.locator('#work-tab-questions').click();
      const id = REFRESH[width].qFirst;
      const field = tabField(page, id);
      await field.fill('Keep this answer on failure');
      await page.route('**/api/work/v1', async route => {
        if (JSON.parse(route.request().postData() ?? '{}').op !== 'answer') return route.continue();
        observed();
        await gate;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      });
      const form = field.locator('xpath=ancestor::form');
      await form.getByRole('button', { name: 'Send answer' }).click();
      await pending;
      await page.locator('#work-tab-board').click();
      await page.locator('#work-tab-board').blur();
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:59:00Z', task: REFRESH[width].first, type: 'set', field: 'title', to: `Pending ${width}` }) + '\n');
      await page.waitForTimeout(7000);
      await page.locator('#work-tab-questions').click();
      assert.equal(await form.getAttribute('aria-busy'), 'true');
      assert.equal(await field.inputValue(), 'Keep this answer on failure');
      release();
      await form.locator('.work-answer-status[data-state="error"]').waitFor();
      assert.equal(await field.inputValue(), 'Keep this answer on failure');
      await page.locator('#work-tab-board').click();
      await page.locator('#work-tab-board').blur();
      await card(page, REFRESH[width].first).getByText(`Pending ${width}`).waitFor({ timeout: 35_000 });
    } finally {
      release();
      await closePage(page);
    }
  });

  for (const width of [1440, 390] as const) test(`a stale project read cannot undo an answer at ${width}px`, { timeout: 120_000 }, async () => {
    const taskId = width === 1440 ? 'T-9a01' : 'T-9a02';
    const questionId = width === 1440 ? 'N-00009a01' : 'N-00009a02';
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      [...task(taskId, `Stale answer ${width}`, 59, 'P3'), question('2026-11-08T09:59:00Z', taskId, questionId)]
        .map(event => JSON.stringify(event)).join('\n') + '\n');
    const page = await signIn(width, []);
    let release!: () => void, releaseLater!: () => void, observed!: () => void, observedNext!: () => void, held = false, oldReleased = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const later = new Promise<void>(resolve => { releaseLater = resolve; });
    const pending = new Promise<void>(resolve => { observed = resolve; });
    const nextPoll = new Promise<void>(resolve => { observedNext = resolve; });
    try {
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
      await page.locator('#work-tab-board').click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.route('**/api/work/v1', async route => {
        if (JSON.parse(route.request().postData() ?? '{}').op !== 'project') return route.continue();
        if (oldReleased) { observedNext(); await later; return route.continue(); }
        if (held) return route.continue();
        held = true;
        const response = await route.fetch();
        observed();
        await gate;
        await route.fulfill({ response });
      });
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T10:00:00Z', task: taskId, type: 'set', field: 'title', to: `Changed before answer ${width}` }) + '\n');
      await pending;
      await page.locator('#work-tab-questions').click();
      const field = tabField(page, questionId);
      await field.fill('Answer survives');
      await field.locator('xpath=ancestor::form').getByRole('button', { name: 'Send answer' }).click();
      await page.locator(`.work-question-answered[data-question-id="${questionId}"]`).waitFor();
      await page.locator('#work-tab-board').click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.waitForTimeout(6000);
      oldReleased = true;
      release();
      // The poll is serialized: the next project request proves the old response was processed.
      await nextPoll;
      await page.locator('#work-tab-questions').click();
      assert.equal(await page.locator(`.work-question-answered[data-question-id="${questionId}"]`).count(), 1);
    } finally { release(); releaseLater(); await closePage(page); }
  });

  test('a failed background read is visible and clears after recovery', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-frise').click();
    await page.locator('#work-tab-frise').blur();
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op === 'project')
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.locator('.work-auto-refresh-status').waitFor({ timeout: 35_000 });
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.work-auto-refresh-status').waitFor({ state: 'detached', timeout: 35_000 });
    await closePage(page);
  });

  test('background refresh shows and clears project truncation', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-board').click();
    await page.locator('#work-tab-board').blur();
    let truncated = true;
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op !== 'project') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: { ...body, truncated } });
    });
    const notice = page.locator('.work-project > .work-omitted');
    await notice.waitFor({ state: 'visible', timeout: 35_000 });
    truncated = false;
    await notice.waitFor({ state: 'detached', timeout: 35_000 });
    await closePage(page);
  });

  test('a project gone since the owner left falls back to the entry screen, and corrupt state is ignored', { timeout: 300_000 }, async () => {
    const sent: Sent[] = [];
    const page = await signIn(1440, sent);
    await page.evaluate(([key, questionId]) => sessionStorage.setItem(key, JSON.stringify({ schema: 1,
      place: { project: 'P-0000dead', tab: 'board', task: 'T-0000dead', scroll: 300, sheetScroll: 0, tabScroll: null, expanded: null },
      drafts: { [questionId]: { text: 'fictional orphan draft', picked: [], edit: false, at: 1 } } })), [KEY, Q_GONE] as const);
    await toProjects(page, false);
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    await atLevel(page, 0);
    // The entry screen has no answer form: the question's sheet, opened from its row, has the draft.
    await openRow(page, Q_GONE);
    await sheetShown(page, 'Charlie one');
    assert.equal(await sheetField(page, Q_GONE).inputValue(), 'fictional orphan draft', 'the drafts of questions still open come back');
    // A corrupt value (written after the view's own last writes, as the page goes: pagehide, then the page hidden):
    // the next page starts as new.
    await page.evaluate(key => {
      const corrupt = (): void => sessionStorage.setItem(key, '{"schema":1,"place":');
      window.addEventListener('pagehide', corrupt);
      document.addEventListener('visibilitychange', corrupt);
    }, KEY);
    await page.reload();
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    assert.equal(await level(page), 0);
    await openRow(page, Q_GONE);
    await sheetShown(page, 'Charlie one');
    assert.equal(await sheetField(page, Q_GONE).inputValue(), '');
    await closePage(page);
  });

  test('the scroll of a tab left is not put on another tab chosen while the sheet is read again', { timeout: 300_000 }, async () => {
    const page = await signIn(1440, []);
    const { first: FIRST, titles: [TITLE_FIRST] } = SETS[1440];
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();   // the product's view lists its projects
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-board').click();
    await card(page, FIRST).scrollIntoViewIfNeeded();
    const boardScroll = await scrollTop(page);
    assert.ok(boardScroll > 0, `the board scrolls (scrollTop ${boardScroll})`);
    await card(page, FIRST).click();
    await sheetShown(page, TITLE_FIRST);
    await toSessions(page, false);
    // Coming back, the read of the sheet's task waits while the owner picks the Timeline tab, scrolled to its top.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/work/v1', async route => {
      if (JSON.parse(route.request().postData() ?? '{}').op !== 'task') return route.continue();
      await gate;
      return route.continue();
    });
    await toProjects(page, false);
    await page.locator('#work-tab-board[aria-selected="true"]').waitFor();
    await page.locator('#work-tab-frise').click();
    await page.locator('#projects').evaluate(node => { node.scrollTop = 0; });
    assert.ok(await page.locator('#projects').evaluate(node => node.scrollHeight > node.clientHeight), 'the Timeline scrolls');
    release();
    await sheetShown(page, TITLE_FIRST);
    assert.equal(await scrollTop(page), 0, 'the Timeline stays at its top');
    await page.unrouteAll({ behavior: 'wait' });
    await closePage(page);
  });

  for (const width of [1440, 390] as const) {
    test(`refresh keeps the selected task and draft at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []);
      const { first, qFirst, title } = REFRESH[width];
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
      await page.locator('#work-tab-board').click();
      await card(page, first).click();
      await sheetShown(page, title);
      await sheetField(page, qFirst).fill('refresh keeps this draft');
      const updatedTitle = `${title} updated`;
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:00:00Z', task: first, type: 'set', field: 'title', to: updatedTitle }) + '\n');
      await page.locator('.work-refresh').click();
      await sheetShown(page, updatedTitle);
      assert.equal(await sheetField(page, qFirst).inputValue(), 'refresh keeps this draft');
      await closePage(page);
    });
    test(`project board observes a changed task at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []);
      const { first, title } = REFRESH[width];
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
      await page.locator('#work-tab-board').click();
      const updatedTitle = `${title} automatic`;
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:10:00Z', task: first, type: 'set', field: 'title', to: updatedTitle }) + '\n');
      await page.locator('#work-tab-board').blur();
      await card(page, first).getByText(updatedTitle).waitFor({ timeout: 35_000 });
      await closePage(page);
    });
    test(`project timeline observes a changed task at ${width}px`, { timeout: 300_000 }, async () => {
      const page = await signIn(width, []);
      const { first, title } = REFRESH[width];
      await toProjects(page, width < 600);
      await page.locator('.work-overview-product[data-product="relay"]').click();
      await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
      await page.locator('#work-tab-frise').click();
      const updatedTitle = `${title} timeline`;
      fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
        JSON.stringify({ ts: '2026-11-09T09:11:00Z', task: first, type: 'set', field: 'title', to: updatedTitle }) + '\n');
      await page.locator('#work-tab-frise').blur();
      await page.locator(`#work-panel-frise [data-task="${first}"]`).getByText(updatedTitle).waitFor({ timeout: 35_000 });
      await closePage(page);
    });
  }

  test('a refused read of the history signs out: the drafts of the view go too', { timeout: 300_000 }, async () => {
    const questionId = 'N-0000d099';
    fs.appendFileSync(path.join(scratch, 'tracker', 'events', '2026-11.hostq.jsonl'),
      JSON.stringify(question('2026-11-09T23:59:00Z', GONE_TASK, questionId)) + '\n');
    const page = await signIn(1440, []);
    await toProjects(page, false);
    await page.locator('.work-overview-product[data-product="relay"]').click();   // the product's view lists its projects
    await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
    await page.locator('#work-tab-questions').click();
    await tabField(page, questionId).fill('fictional refused draft');
    await page.waitForFunction(([key, text]) => (sessionStorage.getItem(key) ?? '').includes(text), [KEY, 'fictional refused draft'] as const);
    await toSessions(page, false);
    // The credential is refused when the history is read; the sign-in page is a stub here, so that only the page
    // left (not static/login.js) can have removed the drafts.
    await page.route('**/api/history**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
    await page.route('**/login', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
    await page.locator('#tab-hist').click();
    await page.waitForURL(/\/login/);
    assert.equal(await stored(page), '', 'no draft kept after the refusal');
    await closePage(page);
  });
});
