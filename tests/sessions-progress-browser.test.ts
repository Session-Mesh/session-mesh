// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session list's progressive loading in a real page (static/sessions-progress.ts wired by app.js),
// on a throwaway server.py and native PTY host:
//   - after a server restart the status line says so within seconds, then empties once listed;
//   - with a slow /api/sessions the restored terminal attaches and the known rows show before the
//     list arrives;
//   - a provisional row cannot be renamed before the list arrives;
//   - the retry button of a slow row hands the focus to its row once the row is ready;
//   - 300 rows render without a long task, with a bounded number of rows in the DOM.
// Needs MESH_CHROMIUM and MESH_PTYHOST_CMD (skipped without the browser).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {TerminalMesh, skip, withoutSince} from './terminal-browser-lib.ts';

const VIEW = {width: 1280, height: 800};
let mesh: TerminalMesh;

before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('alpha');
  await mesh.newShell('beta');
});
after(async () => { await mesh?.stop(); });

declare const active: {conn: {ws: WebSocket | null} | null} | null;
const errors: string[] = [];
const watchErrors = (page: Page): void => { page.on('pageerror', error => errors.push(String(error))); };
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });
const statusText = (page: Page) => page.locator('#sessions-status .sessions-status-text').innerText();

describe('progressive session list', {skip}, () => {
  test('a server restart shows in the status line within seconds, and clears once listed', async () => {
    const page = await mesh.openPage('alpha', VIEW, undefined, watchErrors);
    assert.equal(await statusText(page), '');
    const box = await page.locator('#sessions-status').boundingBox();
    const listTop = (await page.locator('#list').boundingBox())!.y;
    const restarted = Date.now();
    const restart = mesh.restartServer(1500);
    await page.waitForFunction(() => (document.querySelector('#sessions-status .sessions-status-text')?.textContent ?? '') !== '',
      undefined, {timeout: 5000});
    const shownAfter = Date.now() - restarted;
    const said = await statusText(page);
    assert.match(said, /^(Server unreachable\.|Server unreachable\. Trying again…|The server restarted: loading the session list…)$/, said);
    assert.doesNotMatch(said, /\d:\d/, 'no clock time in the announced message');
    assert.equal((await page.locator('#list').boundingBox())!.y, listTop, 'the line has reserved height: the list did not move');
    assert.equal((await page.locator('#sessions-status').boundingBox())!.height, box!.height);
    await restart;
    await page.waitForFunction(() => (document.querySelector('#sessions-status .sessions-status-text')?.textContent ?? '') === '',
      undefined, {timeout: 60_000});
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 30_000});
    console.log(`status line shown ${shownAfter} ms after the restart began`);
    await page.context().close();
  });

  test('with a slow listing, terminals attach and known rows show before the list arrives', async () => {
    const page = await mesh.openPage('alpha', VIEW, undefined, watchErrors);   // the layout and the known sessions are saved
    const delay = 8000;
    let answered = 0;
    await page.route('**/api/sessions*', async route => {
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, delay));
      answered = Date.now();
      await route.fulfill({response});
    });
    const reloaded = Date.now();
    await page.reload();
    await page.locator('#list .item[data-id="beta"]').waitFor({timeout: 10_000});
    const rowsAfter = Date.now() - reloaded;
    assert.equal(answered, 0, 'rows shown before any listing answered');
    assert.ok(await page.locator('#list .item[data-id="alpha"].row-loading').count() >= 1, 'marked as loading');
    assert.match(await statusText(page), /Loading the session list: 2 sessions known on this device/);
    // A row not listed yet is not renamed: no editor, no request to the server.
    const organized: string[] = [];
    page.on('request', request => { if (request.url().includes('/api/organize')) organized.push(request.url()); });
    const edited = await page.evaluate(() => {
      // A bare dblclick event: real clicks would also open the row's pane, whose terminal takes the focus.
      document.querySelector('#list .item[data-id="beta"] .name')!.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
      const input = document.querySelector<HTMLInputElement>('#list input.rename');
      if (!input) return false;
      input.value = 'renamed early';
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      return true;
    });
    await page.waitForTimeout(500);
    assert.equal(edited, false, 'no rename editor on a provisional row');
    assert.deepEqual(organized, []);
    assert.equal(answered, 0, 'checked before the listing answered');
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 6000});
    const attachedAfter = Date.now() - reloaded;
    assert.equal(answered, 0, `terminal attached (${attachedAfter} ms) before the listing answered`);
    await page.waitForFunction(() => document.querySelector('#list .item.row-loading') === null, undefined, {timeout: 60_000});
    console.log(`rows ${rowsAfter} ms, terminal ${attachedAfter} ms, list ${answered - reloaded} ms after reload`);
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.context().close();
  });

  test('the retry button of a slow row: once the row is ready, the focus is on the row, not the page', async () => {
    const page = await mesh.openPage('alpha', VIEW, undefined, watchErrors);
    let slow = true;
    await page.route('**/api/sessions*', async route => {
      // Full answers only: a delta (an answer to `since`) would not carry beta's row to mark.
      const response = await route.fetch({url: withoutSince(route.request().url())});
      const listing = await response.json() as {mesh: Record<string, unknown>[]};
      if (slow) for (const row of listing.mesh) if (row.id === 'beta') row.state = 'slow';
      await route.fulfill({response, json: listing});
    });
    const retry = page.locator('#list .row-retry[data-retry="beta"]');
    await retry.waitFor({timeout: 15_000});
    await retry.focus();
    slow = false;
    await page.keyboard.press('Enter');
    await retry.waitFor({state: 'detached', timeout: 15_000});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#list .item')?.dataset.id
      ?? document.activeElement?.tagName);
    assert.equal(focused, 'beta');
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.context().close();
  });

  test('300 rows render without a long task and keep the DOM bounded', async () => {
    const page = await mesh.signIn(VIEW, () => {
      const tasks: number[] = [];
      (globalThis as unknown as {longTasks: number[]}).longTasks = tasks;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration); })
        .observe({type: 'longtask', buffered: true});
    }, watchErrors, {routes: async target => {
      await target.route('**/api/sessions*', async route => {
        const response = await route.fetch();
        const listing = await response.json() as {mesh: Record<string, unknown>[]};
        const now = Date.now() / 1000;
        for (let i = 0; i < 300; i++) {
          listing.mesh.push({kind: 'mesh', id: `synthetic-${i}`, name: `synthetic-${i}`, created: now - i, activity: now - i * 7,
            attached: 0, cwd: `/tmp/project-${i % 17}`, agent: null, known_agent: null, folder: null, rank: null, notice: null});
        }
        await route.fulfill({response, json: listing});
      });
    }});
    await page.locator('#list .item[data-id="synthetic-0"]').waitFor({timeout: 30_000});
    await page.waitForTimeout(1000);
    const initial = await page.evaluate(() => (globalThis as unknown as {longTasks: number[]}).longTasks.splice(0));
    const firstRows = await page.locator('#list .item').count();
    // Several refreshes and a scroll to the end, measured on their own.
    const scrolled = await page.evaluate(async () => {
      const box = document.querySelector('#list')!;
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      let added = 0;
      const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) if ((node as Element).matches?.('.item')) added++;
      });
      observer.observe(box, {childList: true, subtree: true});
      for (let i = 0; i < 3; i++) { await (globalThis as unknown as {refresh: () => Promise<unknown>}).refresh(); await frame(); await frame(); }
      observer.disconnect();
      const rebuilt = added;
      // Scroll through the whole list: every synthetic row must be rendered at some position, and
      // the number of rows in the DOM must stay bounded at each one.
      const seen = new Set<string>();
      let most = 0;
      const rendered = () => [...box.querySelectorAll('.item')].map(row => (row as HTMLElement).dataset.id ?? '');
      for (let y = 0; y <= box.scrollHeight; y += 200) {
        box.scrollTop = y;
        await frame(); await frame();
        const ids = rendered();
        most = Math.max(most, ids.length);
        for (const id of ids) if (id.startsWith('synthetic-')) seen.add(id);
      }
      return {rows: most, seen: seen.size, rebuilt};
    });
    await page.waitForTimeout(500);
    const later = await page.evaluate(() => (globalThis as unknown as {longTasks: number[]}).longTasks.splice(0));
    console.log(`300 rows: ${firstRows} rows in the DOM at first, at most ${scrolled.rows} while scrolling, ${scrolled.rebuilt} replaced by 3 refreshes; long tasks at load ${JSON.stringify(initial.map(Math.round))}, after ${JSON.stringify(later.map(Math.round))}`);
    assert.ok(firstRows < 150, `bounded DOM (${firstRows} rows)`);
    assert.ok(scrolled.rows < 150, `bounded DOM while scrolling (${scrolled.rows} rows)`);
    assert.equal(scrolled.seen, 300, 'scrolling through the list reaches every row');
    assert.ok(scrolled.rebuilt < firstRows / 2, `three refreshes replaced ${scrolled.rebuilt} of ${firstRows} rows: keyed, not rebuilt`);
    assert.deepEqual(later, [], 'no long task while refreshing and scrolling');
    await page.unrouteAll({behavior: 'ignoreErrors'});
    await page.context().close();
  });
});
