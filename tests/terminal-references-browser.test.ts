// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tracker references of the terminal (static/terminal-references.ts, static/work-references.ts wired by app.js) in
// headless Chromium against a throwaway server.py, native PTY host and real work-read, on a fictional tracker:
//   - a shell prints a known task, project and question id, an unknown id and "T-12": only the known ids are links;
//   - hovering a known id shows its title, as text even when the title is markup; clicking it opens the Projects view
//     on the task's sheet (Board tab), on the project, or where the question is, at 1440 px and at 390 px (a tap),
//     also when the program tracks the mouse;
//   - a path that holds a known id stays a path link: a file name cut by a soft wrap, or by a hard wrap of the agent;
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
const PROJECT = 'P-7a7a', TASK = 'T-7b7b', QUESTION = 'N-0000d001', HOSTILE = 'T-7c7c';
// A title that would run script if it were ever rendered as markup.
const HOSTILE_TITLE = '<img src=x onerror="window.__refsPwned=1">';
const EVENTS = [
  { ts: '2026-11-07T09:00:00Z', task: PROJECT, type: 'project_created', title: 'Second rollout', product: 'relay', category: 'platform' },
  { ts: '2026-11-07T09:01:00Z', task: TASK, type: 'created', title: 'Reference task', project: 'relay', category: 'platform', priority: 'P1', status: 'todo' },
  { ts: '2026-11-07T09:02:00Z', task: TASK, type: 'set', field: 'project', to: PROJECT },
  { ts: '2026-11-07T09:03:00Z', task: HOSTILE, type: 'created', title: HOSTILE_TITLE, project: 'relay', category: 'platform', priority: 'P2', status: 'todo' },
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
declare const active: {
  term: { cols: number; rows: number; buffer: { active: Buffer & { viewportY: number } }; element: HTMLElement };
  termEl: HTMLElement;
} | null;
declare const references: { lookup(id: string): unknown } | null;
declare const projecting: boolean;
declare function terminalLinksOnRow(buffer: unknown, y: number, cols: number): Link[];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
}

/** A 1440 px page on the tracked mesh, once the known ids are read. */
async function openWide(onPage: (page: Page) => void): Promise<Page> {
  const page = await mesh.openPage('qa-refs', { width: 1440, height: 900 }, undefined, onPage);
  await page.waitForFunction(id => references?.lookup(id) != null, TASK, { timeout: 60_000 });
  return page;
}

/** Print the ids in the active shell and return the buffer row of the output. The tests share one session, so the
 * output of an earlier test is still on screen: wait until `clear` has removed it, or the row found below would be
 * that stale one, blanked and redrawn under the pointer while the test hovers and clicks it. */
async function printIds(page: Page, command = PRINT, output = OUTPUT): Promise<number> {
  await typeLine(page, 'clear');
  await page.waitForFunction(text => {
    const buffer = active!.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)?.translateToString(true) === text) return false;
    return true;
  }, output, { timeout: 20_000 });
  await typeLine(page, command);
  await waitForRow(page, output);
  const row = await rowOf(page, output);
  assert.ok(row >= 0, 'the printed output still exists when its cell coordinates are captured');
  return row;
}

/** The last buffer row whose text is `wanted`, or -1. */
const rowOf = (page: Page, wanted: string): Promise<number> => page.evaluate(text => {
  const buffer = active!.term.buffer.active;
  for (let y = buffer.length - 1; y >= 0; y--) if (buffer.getLine(y)?.translateToString(true) === text) return y;
  return -1;
}, wanted);

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

/** Hover the ids of the output row for 30 s and return the ops sent meanwhile. */
async function hoverAround(page: Page, y: number, sent: { op: string }[]): Promise<string[]> {
  const before = sent.length, started = Date.now();
  while (Date.now() - started < 30_000) {
    for (const id of [TASK, 'T-9f9f', 'T-12', PROJECT, QUESTION]) {
      const point = await cellPoint(page, y, columnOf(id) + 1);
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(100);
    }
  }
  return sent.slice(before).map(entry => entry.op);
}

describe('tracker references in the terminal', { skip }, () => {
  test('at 1440 px: only known ids are links, a hover shows the title, no request storm', { timeout: 600_000 }, async () => {
    const sent: { op: string; at: number }[] = [];
    const page = await openWide(watch(sent));
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
    const during = await hoverAround(page, y, sent);
    assert.ok(during.filter(op => op === 'ids').length <= 1, `ids reads in 30 s: ${JSON.stringify(during)}`);
    assert.ok(during.length <= 2, `work reads in 30 s: ${JSON.stringify(during)}`);
    await page.context().close();
  });

  test('at 1440 px: a click opens the task, the question, and the project also when the program tracks the mouse',
    { timeout: 600_000 }, async () => {
      const page = await openWide(watch([]));
      const y = await printIds(page);
      // The task: the Projects view, the Board tab of its project, its sheet.
      const task = await cellPoint(page, y, columnOf(TASK) + 2);
      await page.mouse.move(task.x, task.y);
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

  test('a path holding a known id stays a path link; a title that is markup is shown as text', { timeout: 600_000 }, async () => {
    const page = await openWide(watch([]));
    // A file name cut by a soft wrap right after its dot: the terminal's own wrap, so one word over two rows.
    const cols = await page.evaluate(() => active!.term.cols);
    const lead = 'w'.repeat(cols - ` ${TASK}.`.length);
    const y = await printIds(page, String.raw`printf '%s T%s7b7b.md soft\n' ${lead} -`, `${lead} ${TASK}.`);
    assert.ok(y >= 0, 'the first row of the wrapped file name');
    for (const row of [y, y + 1]) {
      assert.deepEqual((await linksOn(page, row)).map(link => [link.kind, link.text]), [['doc', `${TASK}.md`]], `row ${row}`);
    }

    // An agent's hard wrap (12 columns, indented rows): "docs/" "T-7b7b." "md" is one path, and the id on the middle
    // row is offered as a reference too: only the overlap check of the page keeps the path.
    const hard = await page.evaluate(id => {
      const rows = ['read  docs/', `  ${id}.`, '  md now'];
      const buffer = { getLine: (row: number) => rows[row] === undefined ? undefined : {
        length: 12, isWrapped: false,
        getCell: (x: number) => ({ getWidth: () => 1, getChars: () => rows[row]![x] ?? '' }),
      } };
      return [0, 1, 2].map(row => terminalLinksOnRow(buffer, row, 12).map(link => [link.kind, link.text]));
    }, TASK);
    assert.deepEqual(hard, [0, 1, 2].map(() => [['doc', `docs/${TASK}.md`]]), 'the path only, never the reference inside it');

    // A title made of markup: shown as text in the title attribute, never parsed.
    const row = await printIds(page, String.raw`printf 'hostile T%s7c7c\n' -`, `hostile ${HOSTILE}`);
    const point = await cellPoint(page, row, 'hostile '.length + 2);
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => active!.termEl.title !== '');
    assert.equal(await page.evaluate(() => active!.termEl.title), `Task ${HOSTILE}: ${HOSTILE_TITLE}`);
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('img[src="x"]').length,
      (window as unknown as { __refsPwned?: number }).__refsPwned ?? null]), [0, null], 'no element made from the title');
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

  test('a fresh print waits for clear instead of reusing an identical replay row', { timeout: 600_000 }, async () => {
    const page = await openWide(watch([]));
    const wait = page.waitForFunction.bind(page);
    try {
      await printIds(page);
      await page.evaluate(({command, output}) => {
        const pane = active as any, socket = pane.conn.ws, receive = socket.onmessage, send = pane.send;
        const held: MessageEvent[] = [];
        socket.onmessage = (event: MessageEvent) => held.push(event);
        pane.send = function(text: string, ...args: unknown[]) {
          if (text === command + '\r') {
            const buffer = pane.term.buffer.active;
            for (let y = 0; y < buffer.length; y++) {
              if (buffer.getLine(y)?.translateToString(true) === output)
                throw Error('the old replay row still satisfies the next print');
            }
          }
          return send.call(this, text, ...args);
        };
        (window as any).referencePrintGate = {
          held,
          release() {socket.onmessage = receive; for (const event of held.splice(0)) receive.call(socket, event);},
          dispose() {this.release(); pane.send = send;},
        };
      }, {command: PRINT, output: OUTPUT});
      // Deliver the real clear response when the helper first asks for readiness.
      // The old helper sends PRINT first and fails the stale-row guard above.
      page.waitForFunction = (async (...args: Parameters<Page['waitForFunction']>) => {
        page.waitForFunction = wait;
        await wait(() => (window as any).referencePrintGate.held.length > 0);
        await page.evaluate(() => (window as any).referencePrintGate.release());
        return wait(...args);
      }) as typeof page.waitForFunction;
      const y = await printIds(page);
      assert.equal((await linksOn(page, y))[0]?.text, TASK);
      const point = await cellPoint(page, y, columnOf(TASK) + 2);
      await page.mouse.move(point.x, point.y);
      await wait(() => active!.termEl.title === 'Task T-7b7b: Reference task');
      await page.mouse.click(point.x, point.y);
      await wait(() => projecting);
    } finally {
      page.waitForFunction = wait;
      try {await page.evaluate(() => (window as any).referencePrintGate?.dispose());}
      finally {await page.context().close();}
    }
  });
});
