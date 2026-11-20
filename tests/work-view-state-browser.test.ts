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
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const PROJECT = 'P-7a7a';
/** Each width answers its own questions (an answer given at one width would close the other's). */
type Set = Readonly<{ first: string; second: string; qFirst: string; qSecond: string; titles: readonly [string, string] }>;
const SETS: Readonly<Record<1440 | 390, Set>> = {
  1440: { first: 'T-7b7b', second: 'T-7d7d', qFirst: 'N-0000d001', qSecond: 'N-0000d004', titles: ['Alpha one', 'Alpha two'] },
  390: { first: 'T-7b8b', second: 'T-7d8d', qFirst: 'N-0000d011', qSecond: 'N-0000d014', titles: ['Bravo one', 'Bravo two'] },
};
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

async function signIn(width: number, sent: Sent[]): Promise<Page> {
  const phone = width < 600;
  const page = await mesh.signIn({ width, height: phone ? 844 : 900 }, undefined, watched => {
    watched.on('pageerror', error => errors.push(String(error)));
    watched.on('request', request => sent.push({ url: request.url(), body: request.postData() ?? '' }));
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
  for (const width of [1440, 390] as const) {
    test(`at ${width} px: place, sheet, scroll and drafts, across the sessions, a reload, an answer and a sign-out`,
      { timeout: 600_000 }, async () => {
        const phone = width < 600, sent: Sent[] = [];
        const { first: FIRST, second: SECOND, qFirst: Q_FIRST, qSecond: Q_SECOND, titles: [TITLE_FIRST, TITLE_SECOND] } = SETS[width];
        const page = await signIn(width, sent);
        await toProjects(page, phone);
        await page.locator('.work-entry-questions h2 .work-count').waitFor();

        // A draft on the entry screen, under the second question; then the first task's sheet from the Board.
        await page.locator(`.work-entry-questions [data-work-answer-slot="${Q_SECOND}"] .work-answer-input`).fill(DRAFT_ENTRY);
        await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
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

        // Escape from the sheet put back: its tab (on a phone, scrolled where it was), then the entry screen, whose
        // draft is still there.
        await escape(page);
        await atLevel(page, 1);
        assert.equal(await page.locator('.work-detail-pane').isHidden(), true);
        if (phone) assert.equal(await scrollTop(page), tabScroll, 'the tab is scrolled where it was');
        await escape(page);
        await page.locator('.work-entry-questions h2 .work-count').waitFor();
        await atLevel(page, 0);
        assert.equal(await page.locator(`.work-entry-questions [data-work-answer-slot="${Q_SECOND}"] .work-answer-input`).inputValue(), DRAFT_ENTRY);

        // The second sheet: the draft typed on the entry screen is there; it is changed. The first one's stays.
        await page.locator(`.work-entry-project[data-project="${PROJECT}"]`).click();
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
        await page.context().close();
      });
  }

  test('a project gone since the owner left falls back to the entry screen, and corrupt state is ignored', { timeout: 300_000 }, async () => {
    const sent: Sent[] = [];
    const page = await signIn(1440, sent);
    await page.evaluate(([key, questionId]) => sessionStorage.setItem(key, JSON.stringify({ schema: 1,
      place: { project: 'P-0000dead', tab: 'board', task: 'T-0000dead', scroll: 300, sheetScroll: 0, tabScroll: null, expanded: null },
      drafts: { [questionId]: { text: 'fictional orphan draft', picked: [], edit: false, at: 1 } } })), [KEY, Q_GONE] as const);
    await toProjects(page, false);
    await page.locator('.work-entry-questions h2 .work-count').waitFor();
    await atLevel(page, 0);
    assert.equal(await page.locator(`.work-entry-questions [data-work-answer-slot="${Q_GONE}"] .work-answer-input`).inputValue(),
      'fictional orphan draft', 'the drafts of questions still open come back');
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
    assert.equal(await page.locator(`.work-entry-questions [data-work-answer-slot="${Q_GONE}"] .work-answer-input`).inputValue(), '');
    await page.context().close();
  });
});
