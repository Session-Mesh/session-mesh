// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Panes restored before the first listing (bootMesh, settleProvisionalPanes in static/app.js), on a
// throwaway server.py and native PTY host:
//   - a pane the owner moved to a history card before the first listing keeps that card: only the
//     terminal restored provisionally is settled;
//   - a terminal restored before a document pane whose description is slow is still settled by a
//     listing that arrives during that wait (shown unavailable when the listing omits it);
//   - a saved layout holding only a session's board keeps that board on a device with no known sessions.
// Needs MESH_CHROMIUM and MESH_PTYHOST_CMD (skipped without the browser).
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import type {Page} from 'playwright-core';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';

const VIEW = {width: 1280, height: 800};
const HISTORY = 'h:claude:abcdefgh1234';
let mesh: TerminalMesh;
const errors: string[] = [];
before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('alpha');
});
after(async () => { await mesh?.stop(); });
after(() => { assert.deepEqual(errors, [], 'no error in the pages'); });

type PaneView = {id: string | null; provisional?: unknown; layoutTarget?: string | null; show(id: string): void};
declare const active: PaneView | null;
declare const panes: PaneView[];
declare const restoringWorkspace: boolean;
declare const inventoryLoaded: boolean;
declare const MeshWorkspaceSpec: {migrateV1(value: unknown): unknown};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const watch = (page: Page) => page.on('pageerror', error => errors.push(String(error)));
/** Every listing answered `ms` late (a request still waiting when the page closes is dropped). */
const slowListings = (page: Page, ms: number) => page.route('**/api/sessions*', async route => {
  try {
    const response = await route.fetch();
    await delay(ms);
    await route.fulfill({response});
  } catch { /* the page closed meanwhile */ }
});

/** Replaces this browser's saved layout by `columns` (v1 descriptors) and forgets its known sessions. */
async function saveLayout(page: Page, columns: {id: string; kind: string}[][]): Promise<void> {
  await page.evaluate((saved) => {
    const v1 = {active: saved[0]![0]!.id, columns: saved.map((tabs) => ({grow: 1, active: 0, tabs}))};
    const v2 = MeshWorkspaceSpec.migrateV1(v1);
    if (!v2) throw new Error('the layout does not migrate');
    localStorage.setItem('mesh.workspace.v1', JSON.stringify(v1));
    localStorage.setItem('mesh.workspace.v2', JSON.stringify(v2));
    localStorage.setItem('mesh.layout', JSON.stringify(saved.flat().map((tab) => ({id: tab.id, grow: 1}))));
    for (const key of ['mesh.knownSessions', 'mesh.workspace.hash']) localStorage.removeItem(key);
  }, columns);
}

test('a history card opened before the first listing is kept', {skip}, async () => {
  const page = await mesh.openPage('alpha', VIEW, undefined, watch);
  await slowListings(page, 4000);
  await page.reload();
  await page.waitForFunction(() => active?.id === 'alpha' && !!active.provisional, undefined, {timeout: 9000});
  await page.evaluate((id) => active!.show(id), HISTORY);
  await page.waitForFunction(() => inventoryLoaded && !restoringWorkspace && !active?.provisional, undefined, {timeout: 30_000});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => active?.id), HISTORY);
  await page.context().close();
});

test('a terminal restored before a slow document pane is settled by the listing', {skip}, async () => {
  const page = await mesh.openPage('alpha', VIEW, undefined, watch);
  await saveLayout(page, [[{id: 'gone', kind: 'terminal'}], [{id: 'web:/tmp/held-restore.md', kind: 'document'}]]);
  let described = 0;
  await page.route('**/api/view', async route => {
    await delay(4000);
    described += 1;
    await route.continue().catch(() => { /* the page closed meanwhile */ });
  });
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction(() => inventoryLoaded && !restoringWorkspace, undefined, {timeout: 30_000});
  assert.ok(described >= 1, 'the document pane was described after the listing arrived');
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => panes.map((pane) => ({id: pane.id, layoutTarget: pane.layoutTarget ?? null,
    provisional: !!pane.provisional})));
  assert.equal(state.some((pane) => pane.id === 'gone'), false, JSON.stringify(state));
  assert.equal(state.some((pane) => pane.layoutTarget === 'gone'), true, JSON.stringify(state));
  assert.equal(state.some((pane) => pane.provisional), false, JSON.stringify(state));
  await page.context().close();
});

test('a layout holding only a board keeps it on a device that knows no session', {skip}, async () => {
  const page = await mesh.openPage('alpha', VIEW, undefined, watch);
  await saveLayout(page, [[{id: 'board:alpha', kind: 'board'}]]);
  await slowListings(page, 4000);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction(() => !restoringWorkspace && panes.length > 0, undefined, {timeout: 9000});
  assert.deepEqual(await page.evaluate(() => panes.map((pane) => pane.id)), ['board:alpha'], 'before the listing');
  await page.waitForFunction(() => inventoryLoaded, undefined, {timeout: 30_000});
  assert.deepEqual(await page.evaluate(() => panes.map((pane) => pane.id)), ['board:alpha'], 'after the listing');
  await page.context().close();
});
