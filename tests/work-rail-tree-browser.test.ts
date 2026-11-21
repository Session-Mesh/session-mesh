// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tree of zones, products and projects in the left rail of the Projects view (static/work-tree-view.ts), in
// headless Chromium against a throwaway server.py, native PTY host and real work-read and work-write, on a fictional
// tracker of two zones, several products and projects, and open questions:
//   - the tree is in the sidebar (on a phone, in its drawer), zones in taxonomy order, with the counters of the entry
//     screen; the Sessions list is back as it was when the Sessions view is shown again;
//   - choosing an item shows its place in the main area (the overview, a product, a project) and selects it; on a
//     phone the drawer closes; the browser's Back and Escape go up as from the main area;
//   - the arrow keys, Home and End move the focus, Right and Left unfold and fold, Enter chooses;
//   - the unfolded items survive leaving to the Sessions and coming back, and a reload of the tab;
//   - nothing overflows horizontally at 1440 and 390 px.
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
const HOSTILE = '<img src=x onerror=window.__pwn=1> plan';

// The fixture's taxonomy: Platform (gateway, relay with relay-core and relay-edge) then Office (supplies); its project
// P-5e6f "Delivery rollout" is in relay. Added: a project in relay-core, one in supplies, one with a hostile title in
// gateway, and three open questions.
const project = (minute: number, id: string, title: string, product: string, category: string): object =>
  ({ ts: `2026-11-07T09:${minute}:00Z`, task: id, type: 'project_created', title, product, category });
const task = (minute: number, id: string, title: string, product: string, category: string, projectId: string): object[] => [
  { ts: `2026-11-07T10:${minute}:00Z`, task: id, type: 'created', title, project: product, category, priority: 'P2', status: 'todo' },
  { ts: `2026-11-07T10:${minute}:30Z`, task: id, type: 'set', field: 'project', to: projectId },
];
const question = (minute: number, about: string, id: string): object =>
  ({ ts: `2026-11-08T09:${minute}:00Z`, task: about, type: 'question', id, text: `Fictional question ${id}?`, agent: 'claude', session: 'far' });
const EVENTS = [
  project(10, 'P-7f01', 'Harbour plan', 'relay-core', 'platform'),
  project(11, 'P-7f02', 'Paper order', 'supplies', 'office'),
  project(12, 'P-7f03', HOSTILE, 'gateway', 'platform'),
  ...task(10, 'T-7f11', 'Draw the quay', 'relay-core', 'platform', 'P-7f01'),
  ...task(11, 'T-7f12', 'Count the reams', 'supplies', 'office', 'P-7f02'),
  ...task(12, 'T-7f13', 'Pick a vendor', 'supplies', 'office', 'P-7f02'),
  question(10, 'T-7f11', 'N-0000f001'),
  question(11, 'T-7f12', 'N-0000f002'),
  question(12, 'T-7f13', 'N-0000f003'),
];

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
const errors: string[] = [];

before(async () => {
  if (skip) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-'));
  mesh = new TerminalMesh({ WL_HOME: tracker(scratch), WL_NOW: '2026-11-10T00:00:00Z', MESH_WORK_READ_CMD: READER,
    MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  await mesh.start();
  await mesh.newShell('rail-one');
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
  await page.waitForTimeout(300);   // the drawer's slide (0.18 s) has ended
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noOverflow(page: Page): Promise<void> {
  const wide = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rail: [...document.querySelectorAll<HTMLElement>('#work-rail *')].filter(node => {
      const box = node.getBoundingClientRect(), side = document.querySelector('#side')!.getBoundingClientRect();
      return box.width > 0 && box.right > side.right + 1;
    }).slice(0, 5).map(node => `${node.tagName}.${node.className}`),
  }));
  assert.equal(wide.page, 0, 'the page does not scroll sideways');
  assert.deepEqual(wide.rail, [], 'nothing of the tree goes past the sidebar');
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

/** On a phone the rail is in the drawer: open it. */
async function showRail(page: Page, phone: boolean): Promise<void> {
  if (phone && !(await page.evaluate(() => document.body.classList.contains('drawer')))) await page.locator('#btn-menu').click();
  await page.locator('#work-rail [role=tree]').waitFor();
  await page.locator('#work-rail [data-key="zone:platform"]').waitFor();
}

const item = (page: Page, key: string) => page.locator(`#work-rail [data-key="${key}"]`);
const row = (page: Page, key: string) => page.locator(`#work-rail [data-key="${key}"] > .work-tree-row`);
const focusedKey = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null);
const level = (page: Page) => page.evaluate(() => (history.state as { meshWorkLevel?: number } | null)?.meshWorkLevel ?? 0);
const atEntry = (page: Page) => page.locator('#work-root .work-entry .work-overview-product').first().waitFor();

describe('the tree of products and projects in the left rail', { skip }, () => {
  for (const width of [1440, 390] as const) {
    test(`at ${width} px: tree, counters, selection, drawer, way back and overflow`, { timeout: 600_000 }, async () => {
      const phone = width < 600;
      const page = await signIn(width);
      await page.evaluate(key => sessionStorage.removeItem(key), KEY);
      assert.equal(await page.locator('#work-rail').isHidden(), true, 'no tree in the Sessions view');
      await toProjects(page, phone);
      await atEntry(page);
      await page.locator('.work-entry-questions h2 .work-count').waitFor();
      await showRail(page, phone);

      // Zones in taxonomy order, products folded, the entry item first; the counters of the entry screen.
      const top = await page.locator('#work-rail [role=tree] > [role=treeitem]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.key));
      assert.deepEqual(top, ['entry', 'zone:platform', 'zone:office']);
      assert.equal(await item(page, 'entry').getAttribute('aria-selected'), 'true', 'the entry screen is the place shown');
      assert.equal(await item(page, 'zone:platform').getAttribute('aria-expanded'), 'true');
      assert.equal(await item(page, 'product:relay').getAttribute('aria-expanded'), 'false');
      await page.waitForFunction(() => document.querySelector('#work-rail [data-key="product:supplies"] .work-tree-questions')?.textContent === '? 2');
      assert.equal(await row(page, 'product:relay').locator('.work-tree-tasks').innerText(), '4', 'the open tasks of the product tree');
      assert.match(await item(page, 'product:supplies').getAttribute('aria-label') ?? '', /supplies, 2 open tasks, 2 open questions/);
      assert.equal(await item(page, 'zone:platform').locator('> .work-tree-row .work-tree-questions').innerText(), '? 1');
      await noOverflow(page);
      await shot(page, `rail-entry-${width}`);

      // A product chosen in the rail: its view in the main area, the item selected; on a phone the drawer closes.
      await row(page, 'product:supplies').click();
      await page.locator('#work-root .work-product-view[data-product="supplies"]').waitFor();
      if (phone) assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), false, 'the drawer closed');
      await showRail(page, phone);
      assert.equal(await item(page, 'product:supplies').getAttribute('aria-selected'), 'true');
      assert.equal(await item(page, 'entry').getAttribute('aria-selected'), 'false');
      assert.equal(await level(page), 1);

      // A project chosen in the rail (its product unfolded by the chevron): the project view, the item selected.
      await row(page, 'product:relay').locator('.work-tree-chev').click();
      assert.equal(await item(page, 'product:relay').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#work-root .work-product-view[data-product="supplies"]').count(), 1, 'unfolding is not a choice');
      await row(page, 'project:P-5e6f').click();
      await page.locator('#work-root .work-tab[aria-selected="true"]').waitFor();
      assert.ok((await page.locator('#work-root').innerText()).includes('Delivery rollout'));
      await showRail(page, phone);
      assert.equal(await item(page, 'project:P-5e6f').getAttribute('aria-selected'), 'true');
      assert.equal(await item(page, 'product:supplies').getAttribute('aria-selected'), 'false');
      await noOverflow(page);
      await shot(page, `rail-project-${width}`);

      // The browser's Back goes up as from the main area: the entry screen (a project is one level above it).
      if (phone) await page.locator('#btn-menu').click();   // the drawer closed
      await page.goBack();
      await atEntry(page);
      assert.equal(await level(page), 0);
      await showRail(page, phone);
      assert.equal(await item(page, 'entry').getAttribute('aria-selected'), 'true');

      // A hostile project title is text.
      await row(page, 'product:gateway').locator('.work-tree-chev').click();
      assert.equal(await row(page, 'project:P-7f03').locator('.work-tree-name').innerText(), HOSTILE);
      assert.equal(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn ?? 0), 0);

      // Unfolded and folded items survive the Sessions and back, and a reload.
      await row(page, 'zone:office').click();   // a zone folds
      assert.equal(await item(page, 'zone:office').getAttribute('aria-expanded'), 'false');
      if (phone) await page.locator('#btn-menu').click();
      await toSessions(page, phone);
      assert.equal(await page.locator('#work-rail').isHidden(), true, 'the tree leaves with Projects');
      if (!phone) assert.equal(await page.locator('#list').isVisible(), true, 'the Sessions list is back');
      await toProjects(page, phone);
      await showRail(page, phone);
      for (const [key, open] of [['product:relay', 'true'], ['product:gateway', 'true'], ['zone:office', 'false']] as const) {
        assert.equal(await item(page, key).getAttribute('aria-expanded'), open, `${key} after the Sessions`);
      }
      await page.reload();
      await toProjects(page, phone);
      await showRail(page, phone);
      for (const [key, open] of [['product:relay', 'true'], ['product:gateway', 'true'], ['zone:office', 'false']] as const) {
        assert.equal(await item(page, key).getAttribute('aria-expanded'), open, `${key} after a reload`);
      }
      assert.match(await page.evaluate(key => sessionStorage.getItem(key) ?? '', KEY), /"rail":\[/);
      await noOverflow(page);
      await shot(page, `rail-kept-${width}`);
      await page.context().close();
    });
  }

  test('the keyboard: arrows, Home and End move the focus, Right and Left unfold and fold, Enter chooses', { timeout: 600_000 }, async () => {
    const page = await signIn(1440);
    await page.evaluate(key => sessionStorage.removeItem(key), KEY);
    await toProjects(page, false);
    await atEntry(page);
    await showRail(page, false);
    await item(page, 'entry').focus();
    assert.equal(await item(page, 'entry').getAttribute('tabindex'), '0', 'one item takes the focus');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focusedKey(page), 'zone:platform');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focusedKey(page), 'product:gateway');
    await page.keyboard.press('ArrowDown');
    assert.equal(await focusedKey(page), 'product:relay');
    await page.keyboard.press('ArrowRight');
    assert.equal(await item(page, 'product:relay').getAttribute('aria-expanded'), 'true', 'Right unfolds');
    assert.equal(await focusedKey(page), 'product:relay');
    await page.keyboard.press('ArrowRight');
    assert.equal(await focusedKey(page), 'project:P-5e6f', 'Right again goes to the first child');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focusedKey(page), 'product:relay', 'Left goes to the parent');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await item(page, 'product:relay').getAttribute('aria-expanded'), 'false', 'Left folds');
    await page.keyboard.press('End');
    assert.equal(await focusedKey(page), 'product:supplies');
    await page.keyboard.press('Home');
    assert.equal(await focusedKey(page), 'entry');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focusedKey(page), 'entry', 'the first item stays');
    // Enter on a product: its view; the focus stays in the rail; Escape from the page goes back to the entry screen.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.locator('#work-root .work-product-view[data-product="supplies"]').waitFor();
    assert.equal(await focusedKey(page), 'product:supplies', 'the focus stays on the item chosen');
    assert.equal(await item(page, 'product:supplies').getAttribute('tabindex'), '0');
    // A product's view is a place: the Sessions and back show it again, its item selected, one level above the entry.
    await toSessions(page, false);
    await toProjects(page, false);
    await page.locator('#work-root .work-product-view[data-product="supplies"]').waitFor();
    await showRail(page, false);
    assert.equal(await item(page, 'product:supplies').getAttribute('aria-selected'), 'true');
    assert.equal(await level(page), 1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await atEntry(page);
    assert.equal(await level(page), 0);
    // A project of the product view, chosen in the main area, selects its item in the rail.
    await page.locator('#work-root .work-overview-product[data-product="supplies"]').click();
    await page.locator('#work-root .work-entry-project[data-project="P-7f02"]').click();
    await page.locator('#work-root .work-tab[aria-selected="true"]').waitFor();
    assert.equal(await item(page, 'project:P-7f02').getAttribute('aria-selected'), 'true', 'the rail follows the main area');
    await page.context().close();
  });
});
