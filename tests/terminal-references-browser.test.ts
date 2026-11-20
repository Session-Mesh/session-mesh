// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tracker references of the terminal (static/terminal-references.ts, static/work-references.ts wired by app.js) in
// headless Chromium against a throwaway server.py, native PTY host and real work-read, on a fictional tracker:
//   - a shell prints a known task, project and question id, an unknown id and "T-12": only the known ids are links;
//   - hovering a known id shows its title; clicking it opens the Projects view on the task's sheet (Board tab), on the
//     project, or where the question is, at 1440 px and at 390 px (a tap), also when the program tracks the mouse;
//   - looking at and hovering ids for 30 seconds sends no burst of requests (one read of the ids a minute at most);
//   - without a tracker nothing is a link and the page shows no error.
// Needs MESH_CHROMIUM, MESH_PTYHOST_CMD, MESH_PYTHON and a built work-read (MESH_WORK_READ_CMD, default the dune build
// output); skipped without them (MESH_REQUIRE_BROWSER=1 and MESH_REQUIRE_WORK_READ=1, or CI, make that a failure).
// MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import { REPO, TerminalMesh, skip as noBrowser, typeLine, waitForRow } from './terminal-browser-lib.ts';

const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const skip = noBrowser || (!process.env.MESH_PTYHOST_CMD && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_PTYHOST_CMD is required' : false)
  || (!fs.existsSync(READER) && !process.env.MESH_REQUIRE_WORK_READ && !process.env.CI ? 'a built work-read is required' : false);
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const PROJECT = 'P-7a7a', TASK = 'T-7b7b', QUESTION = 'N-0000d001';
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: PROJECT, type: 'project_created', title: 'Second rollout', product: 'relay', category: 'platform' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'created', title: 'Reference task', project: 'relay', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:02:00Z', task: TASK, type: 'set', field: 'project', to: PROJECT },
  { ts: '2026-11-08T09:00:00Z', task: TASK, type: 'question', id: QUESTION, text: 'Fictional question about the reference task?', agent: 'claude', session: 'far-away' },
];
// The shell prints the ids; the command line itself does not hold them ("T%s7b7b"), so only the output row has them.
const PRINT = String.raw`printf 'known T%s7b7b unknown T%s9f9f short T%s12 project P%s7a7a question N%s0000d001\n' - - - - -`;
const OUTPUT = `known ${TASK} unknown T-9f9f short T-12 project ${PROJECT} question ${QUESTION}`;

function tracker(scratch: string): string {
  const directory = path.join(scratch, 'tracker');
  fs.cpSync(FIXTURE, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'events', '2026-11.hostr.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']]) {
    assert.equal(spawnSync('git', ['-C', directory, ...args], { stdio: 'ignore' }).status, 0, `git ${args.join(' ')}`);
  }
  return directory;
}

let scratch = '';
let mesh: TerminalMesh;
let untracked: TerminalMesh;
const errors: string[] = [];

/** A page that records its errors and the ops it sends to /api/work/v1, with the time of each. */
const watch = (into: { op: string; at: number }[]) => (page: Page): void => {
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (request.url().endsWith('/api/work/v1')) into.push({ op: String(JSON.parse(request.postData() ?? '{}').op), at: Date.now() });
  });
};

before(async () => {
  if (skip) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  await mesh.newShell('qa-refs');
  untracked = new TerminalMesh({ WL_HOME: path.join(scratch, 'no-tracker-here'), MESH_WORK_READ_CMD: READER });
  await untracked.start();
  await untracked.newShell('qa-refs');
});
after(async () => {
  await mesh?.stop();
  await untracked?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

type Link = { text: string; kind: string; start: [number, number]; end: [number, number] };
type Buffer = { length: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined };
// app.js script-scope bindings, read inside page functions.
declare const active: { term: { cols: number; rows: number; buffer: { active: Buffer & { viewportY: number } }; element: HTMLElement }; termEl: HTMLElement } | null;
declare const references: { lookup(id: string): unknown } | null;
declare const projecting: boolean;
declare function terminalLinksOnRow(buffer: unknown, y: number, cols: number): Link[];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

/** Print the ids in the active shell and return the buffer row of the output. */
async function printIds(page: Page, command = PRINT, output = OUTPUT): Promise<number> {
  await typeLine(page, 'clear');
  await typeLine(page, command);
  await waitForRow(page, output);
  return page.evaluate(wanted => {
    const buffer = active!.term.buffer.active;
    for (let y = buffer.length - 1; y >= 0; y--) if (buffer.getLine(y)?.translateToString(true) === wanted) return y;
    return -1;
  }, output);
}

const linksOn = (page: Page, y: number): Promise<Link[]> =>
  page.evaluate(row => terminalLinksOnRow(active!.term.buffer.active, row, active!.term.cols), y);

/** The page point at the middle of a buffer cell of the active pane (the row must be on screen). */
async function cellPoint(page: Page, y: number, col: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ y, col }) => {
    const term = active!.term, rect = term.element.querySelector('.xterm-screen')!.getBoundingClientRect();
    const row = y - term.buffer.active.viewportY;
    return { x: rect.x + (col + 0.5) * rect.width / term.cols, y: rect.y + (row + 0.5) * rect.height / term.rows };
  }, { y, col });
}

const columnOf = (id: string): number => OUTPUT.indexOf(id);

async function backToSessions(page: Page): Promise<void> {
  await page.locator('#btn-sessions').click();
  await page.waitForFunction(() => !projecting);
}

describe('tracker references in the terminal', { skip }, () => {
  test('at 1440 px: only known ids are links, a hover shows the title, a click opens the place, no request storm',
    { timeout: 600_000 }, async () => {
      const sent: { op: string; at: number }[] = [];
      const page = await mesh.openPage('qa-refs', { width: 1440, height: 900 }, undefined, watch(sent));
      await page.waitForFunction(id => references?.lookup(id) != null, TASK, { timeout: 60_000 });
      const y = await printIds(page);
      const links = await linksOn(page, y);
      assert.deepEqual(links.map(link => [link.kind, link.text]), [['ref', TASK], ['ref', PROJECT], ['ref', QUESTION]],
        'the known ids only: not T-9f9f, not T-12');
      assert.deepEqual(links[0]!.start, [y, columnOf(TASK)]);

      // Hover: the title, as text.
      const task = await cellPoint(page, y, columnOf(TASK) + 2);
      await page.mouse.move(task.x, task.y);
      await page.waitForFunction(() => active!.termEl.title !== '');
      assert.equal(await page.evaluate(() => active!.termEl.title), `Task ${TASK}: Reference task`);
      const unknown = await cellPoint(page, y, columnOf('T-9f9f') + 2);
      await page.mouse.move(unknown.x, unknown.y);
      await page.waitForFunction(() => !active!.termEl.hasAttribute('title'));
      await shot(page, 'references-1440');

      // No storm: the ids are looked at and hovered for 30 s; one read a minute at most, nothing per hover.
      const before = sent.length, started = Date.now();
      while (Date.now() - started < 30_000) {
        for (const id of [TASK, 'T-9f9f', 'T-12', PROJECT, QUESTION]) {
          const point = await cellPoint(page, y, columnOf(id) + 1);
          await page.mouse.move(point.x, point.y);
          await page.waitForTimeout(100);
        }
      }
      const during = sent.slice(before).map(entry => entry.op);
      assert.ok(during.filter(op => op === 'ids').length <= 1, `ids reads in 30 s: ${JSON.stringify(during)}`);
      assert.ok(during.length <= 2, `work reads in 30 s: ${JSON.stringify(during)}`);

      // Click on the task: the Projects view, the Board tab of its project, its sheet.
      await page.mouse.click(task.x, task.y);
      await page.waitForFunction(() => projecting);
      await page.locator('#work-tab-board[aria-selected="true"]').waitFor({ timeout: 60_000 });
      await page.locator('.work-detail-pane .work-detail-heading', { hasText: 'Reference task' }).waitFor({ timeout: 60_000 });
      assert.match(await page.locator('.work-project-head').innerText(), /Second rollout/);
      await shot(page, 'references-task-1440');

      // The question: its task's sheet, Questions tab, with the question.
      await backToSessions(page);
      const question = await cellPoint(page, y, columnOf(QUESTION) + 3);
      await page.mouse.move(question.x, question.y);
      await page.mouse.click(question.x, question.y);
      await page.locator('#work-tab-questions[aria-selected="true"]').waitFor({ timeout: 60_000 });
      await page.locator(`.work-detail-pane [data-question-id="${QUESTION}"]`).waitFor({ timeout: 60_000 });

      // A program that tracks the mouse: the click on the project still opens it, not the program.
      await backToSessions(page);
      await typeLine(page, String.raw`printf '\033[?1000h'`);
      await page.waitForFunction(() => (active as unknown as { term: { modes: { mouseTrackingMode: string } } }).term.modes.mouseTrackingMode !== 'none');
      const project = await cellPoint(page, y, columnOf(PROJECT) + 2);
      await page.mouse.move(project.x, project.y);
      await page.mouse.click(project.x, project.y);
      await page.locator('#work-tab-reprise[aria-selected="true"]').waitFor({ timeout: 60_000 });
      assert.match(await page.locator('.work-project-head').innerText(), /Second rollout/);
      await backToSessions(page);
      await typeLine(page, String.raw`printf '\033[?1000l'`);
      await page.context().close();
    });

  test('at 390 px a tap on a known id opens its sheet, and nothing overflows', { timeout: 600_000 }, async () => {
    const page = await mesh.openPage('qa-refs', { width: 390, height: 844 }, undefined, watch([]), { phone: true });
    await page.waitForFunction(id => references?.lookup(id) != null, TASK, { timeout: 60_000 });
    await page.waitForFunction(() => !document.body.classList.contains('drawer'));
    await page.waitForTimeout(400);   // the drawer slides out
    // A short line: the phone's terminal is narrow.
    const y = await printIds(page, String.raw`printf 'see T%s7b7b or T%s12\n' - -`, `see ${TASK} or T-12`);
    const links = await linksOn(page, y);
    assert.deepEqual(links.map(link => [link.kind, link.text]), [['ref', TASK]], 'the known id only');
    const task = await cellPoint(page, y, 'see '.length + 2);
    await shot(page, 'references-390');
    await page.touchscreen.tap(task.x, task.y);
    await page.waitForFunction(() => projecting, undefined, { timeout: 30_000 });
    await page.locator('.work-detail-pane .work-detail-heading', { hasText: 'Reference task' }).waitFor({ timeout: 60_000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0,
      'nothing overflows horizontally');
    await shot(page, 'references-task-390');
    await page.context().close();
  });

  test('without a tracker: nothing is a link, no error, no burst of reads', { timeout: 600_000 }, async () => {
    const sent: { op: string; at: number }[] = [];
    const page = await untracked.openPage('qa-refs', { width: 1440, height: 900 }, undefined, watch(sent));
    await page.waitForFunction(() => references !== null, undefined, { timeout: 60_000 });
    const y = await printIds(page);
    await page.waitForTimeout(10_000);
    assert.deepEqual(await linksOn(page, y), []);
    const task = await cellPoint(page, y, columnOf(TASK) + 2);
    await page.mouse.move(task.x, task.y);
    await page.mouse.click(task.x, task.y);
    await page.waitForTimeout(1_000);
    assert.equal(await page.evaluate(() => projecting), false, 'a click on an unknown id opens nothing');
    assert.equal(sent.filter(entry => entry.op === 'ids').length, 1, 'one read, then none within the minute');
    await page.context().close();
  });
});
