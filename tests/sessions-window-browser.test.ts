// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The windowed session list (static/list-window.ts, keyed-render.ts wired by app.js) keeps what the
// owner holds, on a throwaway server.py and native PTY host with 300 synthetic rows:
//   - the keyed morph never moves a focused node: reordered or pruned siblings go around it, and two
//     held nodes whose order changes both stay;
//   - a focused row stays focused while the list scrolls far from it, rendered alone between spacers;
//   - Tab walks every row past the edge of the window;
//   - an inline rename keeps its input while the list scrolls;
//   - a drag that auto-scrolls the list keeps the dragged row in the document;
//   - signing out removes the sessions this browser kept (mesh.knownSessions).
// Needs MESH_CHROMIUM and MESH_PTYHOST_CMD (skipped without the browser).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {TerminalMesh, skip, withoutSince} from './terminal-browser-lib.ts';

const VIEW = {width: 1280, height: 800};
const ROWS = 300;
const FOLDER = 'zz-filed';
let mesh: TerminalMesh;
let page: Page;
const errors: string[] = [];

before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('alpha');
});
after(async () => { await mesh?.stop(); });
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

/** A page whose listing carries 300 synthetic rows and no outside terminal (the machine's own vary).
 * With `filed`, the first `filed` rows are in the folder FOLDER and the others are loose. */
async function syntheticPage(filed = 0): Promise<Page> {
  const opened = await mesh.signIn(VIEW, undefined, target => target.on('pageerror', error => errors.push(String(error))), {
    routes: async target => {
      await target.route('**/api/sessions*', async route => {
        try {
          // Full answers only: the synthetic rows are added to every answer, so a delta (an answer to
          // `since`) would report them all as changed rows.
          const response = await route.fetch({url: withoutSince(route.request().url())});
          const listing = await response.json() as {mesh: Record<string, unknown>[]; external: unknown[]; folders?: string[]};
          const now = Date.now() / 1000;
          listing.external = [];
          if (filed) listing.folders = [FOLDER];
          for (let i = 0; i < ROWS; i++) {
            listing.mesh.push({kind: 'mesh', id: `synthetic-${i}`, name: `synthetic-${i}`, created: now - i, activity: now - i * 7,
              attached: 0, cwd: `/tmp/project-${i % 17}`, agent: null, known_agent: null, folder: i < filed ? FOLDER : null,
              rank: null, notice: null});
          }
          await route.fulfill({response, json: listing});
        } catch { /* the page closed meanwhile */ }
      });
    }});
  await opened.locator('#list .item[data-id="synthetic-0"]').waitFor({timeout: 30_000});
  return opened;
}

const frames = (target: Page) => target.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const focusedId = (target: Page) => target.evaluate(() =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#list .item')?.dataset.id
    ?? `${document.activeElement?.tagName}.${document.activeElement?.className}`);
const rowsInDom = (target: Page) => target.evaluate(() => document.querySelectorAll('#list .item').length);
const scrollList = async (target: Page, top: number) => {
  await target.evaluate(y => { document.querySelector('#list')!.scrollTop = y; }, top);
  await frames(target);
  await frames(target);
};

describe('windowed session list', {skip}, () => {
  before(async () => { if (!skip) page = await syntheticPage(); });
  after(async () => { await page?.context().close(); });

  test('the keyed morph never moves the focused node', async () => {
    const result = await page.evaluate(() => {
      const morph = (globalThis as unknown as {MeshSessionsProgress: {morphChildren: (t: Element, s: Element, c: object) => number}})
        .MeshSessionsProgress.morphChildren;
      const config = {keyAttributes: ['data-k'], isLeaf: (el: Element) => el.tagName === 'BUTTON'};
      const box = document.createElement('div');
      document.body.append(box);
      box.innerHTML = '<button data-k="x">x</button><button data-k="a">a</button><button data-k="b">b</button><button data-k="c">c</button>';
      const focused = box.querySelector<HTMLButtonElement>('[data-k="b"]')!;
      focused.focus();
      let blurred = 0;
      focused.addEventListener('blur', () => blurred++);
      const source = document.createElement('div');
      source.innerHTML = '<button data-k="c">c</button><button data-k="b">b</button><button data-k="a">a</button>';
      morph(box, source, config);
      const order = [...box.children].map(child => child.getAttribute('data-k')).join('');
      const kept = {order, same: document.activeElement === focused, blurred};
      box.remove();
      return kept;
    });
    assert.deepEqual(result, {order: 'cba', same: true, blurred: 0});
  });

  test('two held nodes whose order changes: neither is moved, the focused one keeps the focus', async () => {
    const result = await page.evaluate(() => {
      const morph = (globalThis as unknown as {MeshSessionsProgress: {morphChildren: (t: Element, s: Element, c: object) => number}})
        .MeshSessionsProgress.morphChildren;
      // `a` is held by the caller (a dragged row), `b` holds the focus; the new order swaps them.
      const config = {keyAttributes: ['data-k'], isLeaf: (el: Element) => el.tagName === 'BUTTON',
        keep: (el: Element) => el.getAttribute('data-k') === 'a'};
      const box = document.createElement('div');
      document.body.append(box);
      box.innerHTML = '<button data-k="x">x</button><button data-k="b">b</button><button data-k="a">a</button>';
      const focused = box.querySelector<HTMLButtonElement>('[data-k="b"]')!;
      const held = box.querySelector('[data-k="a"]')!;
      focused.focus();
      let blurred = 0;
      focused.addEventListener('blur', () => blurred++);
      const source = document.createElement('div');
      source.innerHTML = '<button data-k="a">a</button><button data-k="b">b</button><button data-k="x">x</button>';
      morph(box, source, config);
      const kept = {same: document.activeElement === focused, blurred, held: held.isConnected,
        last: box.lastElementChild?.getAttribute('data-k')};
      box.remove();
      return kept;
    });
    assert.deepEqual(result, {same: true, blurred: 0, held: true, last: 'x'});
  });

  test('a focused row stays focused while the list scrolls away from it, and the DOM stays bounded', async () => {
    await page.locator('#list .item[data-id="synthetic-5"]').focus();
    for (const top of [600, 1500, 3000, 6000, 12_000]) {
      await scrollList(page, top);
      assert.equal(await focusedId(page), 'synthetic-5', `focus kept at scrollTop ${top}`);
      const rows = await rowsInDom(page);
      assert.ok(rows < 80, `the focused row is rendered alone, not a window widened to it (${rows} rows at ${top})`);
    }
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await scrollList(page, 0);
  });

  test('Tab reaches every row past the edge of the window', async () => {
    await page.locator('#list .item[data-id="synthetic-0"]').focus();
    const visited: string[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      await frames(page);
      visited.push(await focusedId(page));
    }
    const expected = Array.from({length: 60}, (_, i) => `synthetic-${i + 1}`);
    assert.deepEqual(visited, expected);
    assert.ok(await rowsInDom(page) < 150, 'bounded DOM after the walk');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await scrollList(page, 0);
  });

  test('an inline rename keeps its input while the list scrolls', async () => {
    await page.locator('#list .item[data-id="synthetic-3"] .name').dblclick();
    const input = page.locator('#list .item[data-id="synthetic-3"] input.rename');
    await input.waitFor();
    await page.keyboard.type('-draft');
    const handle = await input.elementHandle();
    for (const top of [2000, 7000]) {
      await scrollList(page, top);
      assert.equal(await handle!.evaluate(el => el.isConnected && document.activeElement === el), true, `input kept at ${top}`);
    }
    assert.match(await handle!.evaluate(el => (el as HTMLInputElement).value), /-draft$/);
    await page.keyboard.press('Escape');
    await scrollList(page, 0);
  });

  test('a drag that auto-scrolls the list keeps the dragged row', async () => {
    await scrollList(page, 0);
    const row = page.locator('#list .item[data-id="synthetic-2"]');
    const handle = await row.elementHandle();
    // A node moved by the morph is removed and inserted again: count every removal of the dragged row.
    await handle!.evaluate(el => {
      const record = globalThis as unknown as {draggedMoves: number};
      record.draggedMoves = 0;
      new MutationObserver(records => {
        for (const change of records) for (const node of change.removedNodes) if (node === el || node.contains(el)) record.draggedMoves++;
      }).observe(document.querySelector('#list')!, {childList: true, subtree: true});
    });
    const from = (await row.boundingBox())!;
    const list = (await page.locator('#list').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 20, {steps: 4});
    await page.mouse.move(list.x + list.width / 2, list.y + list.height - 10, {steps: 8});
    await page.waitForTimeout(1500);
    const during = await page.evaluate(() => document.querySelector('#list')!.scrollTop);
    const kept = await handle!.evaluate(el => el.isConnected);
    const moves = await page.evaluate(() => (globalThis as unknown as {draggedMoves: number}).draggedMoves);
    await page.mouse.move(VIEW.width - 20, 20, {steps: 4});
    await page.mouse.up();
    assert.ok(during > 600, `the list auto-scrolled (${during} px)`);
    assert.equal(kept, true, 'the dragged row stayed in the document while the window moved');
    assert.equal(moves, 0, 'the dragged row was never taken out of the document, even for a move');
  });
});

describe('windowed session list with a folder', {skip}, () => {
  // 250 rows filed in a folder, 50 loose: two runs, each windowed.
  before(async () => { if (!skip) page = await syntheticPage(250); });
  after(async () => { await page?.context().close(); });

  test('a folder rename keeps its editor while the list scrolls', async () => {
    await scrollList(page, 0);
    await page.locator(`#list [data-folder-rename="${FOLDER}"]`).click();
    const input = page.locator('#list .folder-toolbar input.folder-rename-input');
    await input.waitFor();
    await page.keyboard.type('-draft');
    const handle = await input.elementHandle();
    for (const top of [2000, 7000]) {
      await scrollList(page, top);
      assert.equal(await handle!.evaluate(el => el.isConnected && document.activeElement === el), true, `editor kept at ${top}`);
    }
    assert.match(await handle!.evaluate(el => (el as HTMLInputElement).value), /-draft$/);
    await page.keyboard.press('Escape');
    await scrollList(page, 0);
  });

  test('folding the first run redraws the next one where it now starts', async () => {
    await scrollList(page, 0);
    // From the keyboard: a click would also move the focus, and a focus change redraws the window anyway.
    await page.locator(`#list [data-folder-head="${FOLDER}"]`).focus();
    await frames(page);
    await page.keyboard.press('Enter');
    await frames(page);
    await frames(page);
    await frames(page);
    const shown = await page.evaluate(() => {
      const box = document.querySelector('#list')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('#list .item')].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom && Number(row.dataset.id?.slice(10)) >= 250;
      }).length;
    });
    assert.ok(shown >= 5, `loose rows drawn in the viewport after the fold (${shown})`);
    await page.locator(`#list [data-folder-head="${FOLDER}"]`).click();
  });
});

describe('sign-out', {skip}, () => {
  test('signing out removes the sessions this browser kept', async () => {
    const own = await mesh.openPage('alpha', VIEW, undefined, target => target.on('pageerror', error => errors.push(String(error))));
    await own.waitForFunction(() => localStorage.getItem('mesh.knownSessions') !== null, undefined, {timeout: 15_000});
    await own.evaluate(() => (document.getElementById('btn-logout') as HTMLButtonElement).click());
    await own.waitForURL(/\/login/, {timeout: 15_000});
    assert.equal(await own.evaluate(() => localStorage.getItem('mesh.knownSessions')), null);
    await own.context().close();
  });
});
