// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A product's Board and Timeline (static/work-product-page.ts, static/work-product-board.ts) in headless Chromium
// against a throwaway server.py, native PTY host and the real work-read and work-write, on a fictional tracker: relay
// with its child products relay-core and relay-edge, projects in each (one with a hostile title), tasks in every
// status, some in no project, with owners, priorities, tags and dates; gateway holds more tasks than the reader
// lists (its document is truncated). At 1440 and 390 px:
//   - the product's view has three tabs (Overview, Board, Timeline) reached by the arrow keys; Board and Timeline show
//     the tasks of the product and of its child products, each card with its project; the open columns add up to the
//     product's count in the left rail;
//   - the filters (status, project, owner, tag, text) are reached and ticked with the keyboard, apply to both tabs,
//     and stay after leaving to the Sessions and after a reload, with the tab and the open task sheet;
//   - a card opens the task sheet (level 2); the browser's Back and Escape go up one level each, to the tab then to
//     the entry screen with the focus on the product's row;
//   - a truncated product says its view is partial, keeps the server's counters and shows more on demand; a filter
//     over a thousand tasks redraws within a frame budget;
//   - nothing overflows horizontally, no script runs from tracker text.
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
const KEY = 'mesh.workView';
const HOSTILE = '<img src=x onerror=window.__pwn=1> night shift';
const BULK = 1001;

type Event = Record<string, unknown>;
const project = (minute: number, id: string, title: string, product: string): Event =>
  ({ ts: `2026-11-07T08:${minute}:00Z`, task: id, type: 'project_created', title, product, category: 'platform' });
const set = (id: string, field: string, to: string, minute = 30): Event => ({ ts: `2026-11-07T11:${minute}:00Z`, task: id, type: 'set', field, to });

/** A task of `product`, created with `status`, in `projectId` (or none), with an owner, a tag and dates when given. */
function task(minute: number, id: string, title: string, product: string, status: string, projectId: string | null,
  extra: Readonly<{ owner?: string; tag?: string; due?: string; priority?: string }> = {}): Event[] {
  const events: Event[] = [{ ts: `2026-11-0${1 + (minute % 6)}T10:${String(minute).padStart(2, '0')}:00Z`, task: id, type: 'created', title, project: product,
    category: 'platform', priority: extra.priority ?? 'P2', status }];
  if (projectId) events.push(set(id, 'project', projectId));
  if (extra.owner) events.push(set(id, 'owner', extra.owner, 31));
  if (extra.due) events.push(set(id, 'due', extra.due, 32));
  if (extra.tag) events.push({ ts: '2026-11-07T11:33:00Z', task: id, type: 'add', field: 'tags', value: extra.tag });
  return events;
}

// relay (the fixture's P-5e6f "Delivery rollout" and three tasks of its children) gets a project of its own and one in
// each child, tasks in every status, two in no project.
const EVENTS: Event[] = [
  project(10, 'P-8a01', 'Harbour plan', 'relay-core'),
  project(11, 'P-8a02', 'Quay works', 'relay'),
  project(12, 'P-8a03', HOSTILE, 'relay-edge'),
  ...task(10, 'T-8b01', 'Survey the quay', 'relay', 'inbox', 'P-8a02', { owner: 'ana', tag: 'survey' }),
  ...task(11, 'T-8b02', 'Order the beams', 'relay', 'todo', 'P-8a02', { priority: 'P1', due: '2026-11-20' }),
  ...task(12, 'T-8b03', 'Lay the beams', 'relay', 'in_progress', 'P-8a02', { owner: 'ana' }),
  ...task(13, 'T-8b04', 'Wait for the crane', 'relay-core', 'waiting', 'P-8a01', { owner: 'ben', tag: 'crane' }),
  ...task(14, 'T-8b05', 'Fix the gate', 'relay-core', 'blocked', 'P-8a01'),
  ...task(15, 'T-8b06', 'Paint the posts', 'relay-core', 'done', 'P-8a01', { owner: 'ana' }),
  ...task(16, 'T-8b07', 'Drop the old plan', 'relay-edge', 'dropped', 'P-8a03'),
  ...task(17, 'T-8b08', 'Light the night shift', 'relay-edge', 'todo', 'P-8a03', { owner: 'ben', tag: 'survey' }),
  ...task(18, 'T-8b09', 'Sweep the yard', 'relay-core', 'todo', null, { owner: 'ana' }),
  ...task(19, 'T-8b0a', 'Count the bollards', 'relay-edge', 'in_progress', null),
  ...Array.from({ length: BULK }, (_, index) => task(index % 50, `T-${(0x90000 + index).toString(16)}`, `Bulk task ${index}`,
    'gateway', index % 3 === 0 ? 'done' : 'todo', null, { owner: index % 2 ? 'ana' : 'ben' })).flat(),
];

function tracker(scratch: string): string {
  const directory = path.join(scratch, 'tracker');
  fs.cpSync(FIXTURE, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'events', '2026-11.hostp.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pbt-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  await mesh.newShell('board-one');
});
after(async () => {
  await mesh?.stop();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

async function signIn(width: number): Promise<Page> {
  const phone = width < 600;
  const page = await mesh.signIn({ width, height: phone ? 844 : 900 }, undefined,
    watched => watched.on('pageerror', error => errors.push(String(error))), { phone });
  page.setDefaultTimeout(120_000);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noOverflow(page: Page, where: string): Promise<void> {
  const wide = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: [...document.querySelectorAll<HTMLElement>('#work-root *')].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.right > document.documentElement.clientWidth + 1;
    }).slice(0, 5).map(node => `${node.tagName}.${node.className}`),
  }));
  assert.equal(wide.page, 0, `the page does not scroll sideways (${where})`);
  assert.deepEqual(wide.main, [], `nothing goes past the screen (${where})`);
}

async function toProjects(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else await page.locator('#btn-projects').click();
  await page.waitForFunction(() => document.body.classList.contains('projecting'));
}

async function toSessions(page: Page, phone: boolean): Promise<void> {
  await page.locator(phone ? '#projects-return' : '#btn-sessions').click();
  await page.waitForFunction(() => !document.body.classList.contains('projecting'));
}

const view = (page: Page, id: string) => page.locator(`#work-root .work-product-view[data-product="${id}"]`);
const tab = (page: Page, key: string) => page.locator(`#work-root #work-tab-${key}`);
const panel = (page: Page, key: string) => page.locator(`#work-root #work-panel-${key}`);
const level = (page: Page) => page.evaluate(() => (history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0);
const focused = (page: Page) => page.evaluate(() => {
  const node = document.activeElement as HTMLElement | null;
  return node ? node.id || node.dataset.task || node.dataset.product || node.className : null;
});
const cardIds = (page: Page) => page.locator('#work-root #work-panel-board .work-card').evaluateAll(nodes =>
  nodes.map(node => (node as HTMLElement).dataset.task).sort());
const counters = (page: Page) => page.locator('#work-root #work-panel-board .work-column').evaluateAll(nodes =>
  Object.fromEntries(nodes.map(node => [[...node.classList].find(name => name.startsWith('work-column-'))!.slice(12),
    Number(node.querySelector('.work-count')?.textContent)])));
/** The open tasks of a product in the left rail, as its row shows them (the drawer may be closed). */
const railOpen = (page: Page, id: string) => page.evaluate(key =>
  Number(document.querySelector(`#work-rail [data-key="product:${key}"] > .work-tree-row .work-tree-tasks`)?.textContent), id);
const stored = (page: Page) => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? '{}') as
  { schema?: number; place?: { product?: string; tab?: string; task?: string; filters?: [string, Record<string, unknown>][] } }, KEY);

const RELAY_TASKS = ['T-2d3e', 'T-3c4d', 'T-6b7c', 'T-8b01', 'T-8b02', 'T-8b03', 'T-8b04', 'T-8b05', 'T-8b06', 'T-8b07', 'T-8b08', 'T-8b09', 'T-8b0a'];

/** The overview, then Board by the arrow key: every task of relay and of its children, the counters of the rail. */
async function boardOfRelay(page: Page, width: number): Promise<void> {
  await page.locator('#work-root .work-overview-product[data-product="relay"]').click();
  await view(page, 'relay').waitFor();
  assert.equal(await tab(page, 'overview').getAttribute('aria-selected'), 'true', 'the overview first');
  assert.equal(await panel(page, 'overview').locator('.work-entry-project').count(), 2, 'its own projects');
  assert.equal(await level(page), 1);
  await tab(page, 'overview').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), 'work-tab-board', 'the arrow key moves to Board');
  await panel(page, 'board').locator('.work-card').first().waitFor();
  assert.deepEqual(await cardIds(page), RELAY_TASKS, 'the tasks of relay, relay-core and relay-edge');
  const columns = await counters(page);
  const open = columns.todo! + columns.inProgress! + columns.blocked! + (columns.other ?? 0);
  assert.equal(open, await railOpen(page, 'relay'), 'the open columns add up to the rail\'s count of relay');
  assert.deepEqual(columns, { todo: 5, inProgress: 3, blocked: 3, done: 2 });
  const tag = panel(page, 'board').locator('.work-card[data-task="T-8b08"] .work-card-project');
  assert.equal(await tag.innerText(), HOSTILE, 'the project of a card, as text');
  assert.equal(await panel(page, 'board').locator('.work-card[data-task="T-8b09"] .work-card-project').innerText(), 'No project');
  assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn ?? 0), 0);
  assert.equal(await page.locator('#work-root .work-product-partial').count(), 0, 'relay is read whole');
  await noOverflow(page, 'board');
  await shot(page, `product-board-${width}`);
}

/** Status and owner by the keyboard, then a search: both tabs show the tasks that pass. */
async function filterByKeyboard(page: Page, width: number): Promise<void> {
  const status = page.locator('#work-root .work-filter[data-filter="statuses"]');
  await status.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await status.getAttribute('open'), '', 'Enter unfolds the list');
  await status.locator('input[value="todo"]').focus();
  await page.keyboard.press('Space');
  await status.locator('input[value="in_progress"]').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelectorAll('#work-panel-board .work-card').length === 8);
  assert.deepEqual(await cardIds(page), ['T-2d3e', 'T-3c4d', 'T-6b7c', 'T-8b02', 'T-8b03', 'T-8b08', 'T-8b09', 'T-8b0a']);
  assert.equal(await status.locator('summary').innerText(), 'Status (2)');
  await page.locator('#work-root .work-filter[data-filter="owners"] summary').click();
  await page.locator('#work-root .work-filter[data-filter="owners"] input[value="ana"]').check();
  await page.waitForFunction(() => document.querySelectorAll('#work-panel-board .work-card').length === 2);
  assert.deepEqual(await cardIds(page), ['T-8b03', 'T-8b09']);
  assert.match(await page.locator('#work-root .work-filter-count').innerText(), /^2 tasks shown out of 13$/);
  await page.locator('#work-root .work-filter-search').fill('sweep');
  await page.waitForFunction(() => document.querySelectorAll('#work-panel-board .work-card').length === 1);
  await tab(page, 'board').focus();
  await page.keyboard.press('ArrowRight');
  await panel(page, 'frise').locator('.work-pfrise-group').first().waitFor();
  assert.deepEqual(await panel(page, 'frise').locator('.work-frise-label').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.task)),
    ['T-8b09'], 'the Timeline shows the same tasks');
  assert.equal(await panel(page, 'frise').locator('.work-pfrise-group').getAttribute('data-project'), '', 'its group: no project');
  await page.locator('#work-root .work-filter-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#work-panel-frise .work-frise-label').length === 2);
  assert.deepEqual(await panel(page, 'frise').locator('.work-pfrise-group').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.project)),
    ['P-8a02', ''], 'grouped by project, no project last');
  await noOverflow(page, 'frise');
  await shot(page, `product-frise-${width}`);
}

/** A row opens the task sheet (level 2); the filters, the tab and the sheet stay after the Sessions and a reload. */
async function sheetAndKept(page: Page, phone: boolean, width: number): Promise<void> {
  await panel(page, 'frise').locator('.work-frise-label[data-task="T-8b03"]').click();
  await page.locator('#work-root .work-detail-heading').waitFor();
  assert.equal(await level(page), 2);
  assert.match(await page.locator('#work-root .work-detail-close').innerText(), /Timeline/, 'the way back names the tab');
  await noOverflow(page, 'sheet');
  await shot(page, `product-sheet-${width}`);
  const place = (await stored(page)).place;
  assert.deepEqual([place?.product, place?.tab, place?.task], ['relay', 'frise', 'T-8b03']);
  assert.deepEqual(place?.filters?.[0]?.[1], { projects: [], statuses: ['todo', 'in_progress'], priorities: [], owners: ['ana'], tags: [], text: '' });
  for (const away of ['sessions', 'reload'] as const) {
    if (away === 'sessions') await toSessions(page, phone); else await page.reload();
    await toProjects(page, phone);
    await page.locator('#work-root .work-detail-heading').waitFor();
    assert.equal(await tab(page, 'frise').getAttribute('aria-selected'), 'true', `the tab after ${away}`);
    assert.equal(await page.locator('#work-root .work-filter[data-filter="owners"] input[value="ana"]').isChecked(), true, `kept after ${away}`);
    assert.equal(await page.locator('#work-root .work-filter[data-filter="statuses"] input[value="todo"]').isChecked(), true);
    assert.equal(await panel(page, 'frise').locator('.work-frise-label').count(), 2, `the filtered rows after ${away}`);
    assert.equal(await level(page), 2, `the sheet's level after ${away}`);
  }
  await page.goBack();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#work-root .work-detail-pane')?.hidden === true);
  assert.equal(await level(page), 1, 'Back closes the sheet');
  assert.equal(await focused(page), 'T-8b03', 'the focus on the row that opened it');
  await page.keyboard.press('Escape');
  await page.locator('#work-root .work-entry .work-overview-product').first().waitFor();
  assert.equal(await level(page), 0);
  assert.equal(await focused(page), 'relay', 'Escape goes to the entry screen, on the product\'s row');
}

/** gateway holds more tasks than the reader lists: partial, the server's counters, "Show more", a fast filter. */
async function truncatedProduct(page: Page, width: number): Promise<void> {
  await page.locator('#work-root .work-overview-product[data-product="gateway"]').click();
  await tab(page, 'board').click();
  await page.locator('#work-root .work-product-partial').waitFor();
  assert.match(await page.locator('#work-root .work-product-partial').innerText(), /1000 tasks of 1005/);
  const todo = page.locator('#work-root #work-panel-board .work-column-todo');
  assert.equal(Number(await todo.locator('.work-count').innerText()), 668, 'the server\'s count of the column, the unread tasks included');
  const columns = await counters(page);
  assert.equal(await railOpen(page, 'gateway'), columns.todo! + columns.inProgress! + columns.blocked!, 'the rail\'s count of gateway');
  assert.equal(await todo.locator('.work-card').count(), 50, 'the first 50 cards');
  await todo.locator('.work-more').click();
  assert.equal(await todo.locator('.work-card').count(), 100, 'then 50 more');
  const ms = await page.evaluate(async () => {
    const box = document.querySelector<HTMLInputElement>('#work-root .work-filter[data-filter="owners"] input[value="ana"]')!;
    const start = performance.now();
    box.click();
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return performance.now() - start;
  });
  assert.ok(ms < 400, `a filter over 1000 tasks redraws in ${ms.toFixed(0)} ms`);
  console.log(`# filter redraw over 1000 tasks at ${width}px: ${ms.toFixed(1)} ms`);
  await noOverflow(page, 'truncated');
  await shot(page, `product-truncated-${width}`);
}

describe('the Board and Timeline of a product', { skip }, () => {
  for (const width of [1440, 390]) {
    test(`tabs, filters, sheet and way back at ${width} px`, { timeout: 900_000 }, async () => {
      const phone = width < 600;
      const page = await signIn(width);
      try {
        await toProjects(page, phone);
        await page.locator('#work-root .work-overview-product').first().waitFor();
        await boardOfRelay(page, width);
        await filterByKeyboard(page, width);
        await sheetAndKept(page, phone, width);
        await truncatedProduct(page, width);
        assert.equal((await stored(page)).schema, 3);
      } finally { await page.close(); }
    });
  }
});
