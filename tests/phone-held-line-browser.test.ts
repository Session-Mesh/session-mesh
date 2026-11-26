// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The phone's line, Enter pressed before the session list has named the pane's session (sendLine in
// static/app.js, static/held-line.ts). The line waits for a listing, read-only. While it waits:
// - switching the pane to another session sends nothing anywhere and keeps the text;
// - Cancel (the status's, or the reload hold's) ends the wait at once and keeps the text;
// - a listing slower than the bound sends nothing and keeps the text.
// The status says that nothing has been sent yet. Each case delays /api/sessions by 10 s and reloads.
// And after a web server restart, whose first answers are a skeleton that names no pane, a line sent
// at once waits through them and reaches its own terminal.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, test} from 'node:test';
import type {Page} from 'playwright-core';
import {REPO, TerminalMesh, rows, skip} from './terminal-browser-lib.ts';

const VIEW = {width: 1280, height: 800};
const HOLD_BOUND = 10_000;
const en = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
let mesh: TerminalMesh;
before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  // A few more sessions make the server's first description round after a restart take a while.
  for (const name of ['alpha', 'beta', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']) await mesh.newShell(name);
});
after(async () => { await mesh?.stop(); });

declare const active: {id: string; provisional?: boolean; conn: {ws: WebSocket | null} | null} | null;
declare let linePending: unknown;
declare const line: HTMLTextAreaElement;
declare function enterLine(): void;
declare const Progress: typeof import('../static/known-sessions.ts');
declare const store: {get(key: string, fallback: null): unknown};
declare const KNOWN_KEY: string;

type Held = {pending: boolean; readOnly: boolean; status: string};
const held = (page: Page): Promise<Held> => page.evaluate(() => ({pending: !!linePending, readOnly: line.readOnly,
  status: document.querySelector('#line + section')?.textContent ?? ''}));

/** Reload with every listing delayed, then Enter on a line while the pane is still unnamed. */
async function holdLine(marker: string): Promise<{page: Page; release: () => void}> {
  const page = await mesh.openPage('alpha', VIEW);
  // A reload can attach before the next listing only with a cached ACK identity.
  await page.waitForFunction(() => {
    const known = Progress.readKnown(store.get(KNOWN_KEY, null));
    return ['alpha', 'beta'].every(name => known?.rows.some(row =>
      row.name === name && row.created !== null && row.created > 0 && row.pty_capabilities?.length));
  });
  let release!: () => void;
  const listing = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sessions*', async route => {
    try {
      await listing;
      await route.continue();
    } catch { /* the page closed meanwhile */ }
  });
  page.once('close', release);
  try {
    await page.reload();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1 && active.id === 'alpha',
      undefined, {timeout: 30_000});
    assert.equal(await page.evaluate(() => !!active?.provisional), true, 'the pane is not named yet');
    await page.evaluate((text) => { line.value = text; enterLine(); }, marker);
    const state = await held(page);
    assert.equal(state.pending, true);
    assert.equal(state.readOnly, true);
    assert.ok(state.status.includes(en['line.waitingList']), state.status);
    assert.ok(!state.status.includes(en['line.pending']), 'nothing was sent: the status must not say so');
    return {page, release};
  } catch (error) {
    release();
    await page.context().close();
    throw error;
  }
}

/** Shows `name` once the listings answer again, and tells whether its terminal holds `marker`. */
async function sessionHas(page: Page, name: string, marker: string): Promise<boolean> {
  await page.unrouteAll({behavior: 'ignoreErrors'});
  await page.waitForFunction(() => !active?.provisional, undefined, {timeout: 60_000});
  await page.evaluate((id) => (document.querySelector(`#list .item[data-id="${id}"]`) as HTMLElement).click(), name);
  await page.waitForFunction((id) => active?.id === id && active?.conn?.ws?.readyState === 1, name, {timeout: 20_000});
  await page.waitForTimeout(1500);
  return (await rows(page)).join('\n').includes(marker);
}

const flashText = (page: Page) => page.evaluate(() => document.querySelector('#flash')?.textContent ?? '');

test('the pane switched to another session during the wait: sent nowhere, text kept', {skip}, async () => {
  const marker = 'echo HELD_LINE_MOVED_4127';
  const {page, release} = await holdLine(marker);
  await page.evaluate(() => (document.querySelector('#list .item[data-id="beta"]') as HTMLElement).click());
  await page.waitForFunction(() => active?.id === 'beta', undefined, {timeout: 9000});
  await page.waitForFunction(() => !linePending, undefined, {timeout: 30_000});
  assert.equal(await page.evaluate(() => line.value), marker);
  assert.equal(await page.evaluate(() => line.readOnly), false);
  assert.equal(await flashText(page), en['line.heldMoved']);
  release();
  assert.equal(await sessionHas(page, 'beta', 'HELD_LINE_MOVED_4127'), false, 'the line ran in beta');
  assert.equal(await sessionHas(page, 'alpha', 'HELD_LINE_MOVED_4127'), false, 'the line ran in alpha after all');
  await page.context().close();
});

for (const where of ['status', 'reload hold'] as const) {
  test(`Cancel (${where}) during the wait: the line is dropped at once, text kept`, {skip}, async () => {
    const marker = `echo HELD_LINE_CANCEL_${where === 'status' ? 'A' : 'B'}_5531`;
    const {page, release} = await holdLine(marker);
    const button = where === 'status' ? page.locator('#line + section button')
      : page.locator('#reload-status button', {hasText: en['reload.action.cancelEnter']});
    if (where === 'reload hold') await page.locator('#reload-status summary').click();
    await button.click();
    const state = await held(page);
    assert.equal(state.pending, false);
    assert.equal(state.readOnly, false);
    assert.equal(await page.evaluate(() => line.value), marker);
    release();
    assert.equal(await sessionHas(page, 'alpha', marker.slice(5)), false, 'a cancelled line was sent');
    await page.context().close();
  });
}

test('a listing slower than the bound: nothing sent, text kept, a message says why', {skip}, async () => {
  const marker = 'echo HELD_LINE_LATE_8810';
  const {page, release} = await holdLine(marker);
  const started = Date.now();
  await page.waitForFunction(() => !linePending, undefined, {timeout: HOLD_BOUND});
  assert.ok(Date.now() - started < HOLD_BOUND - 1000, 'the wait is bounded even while inventory is held');
  assert.equal(await page.evaluate(() => line.value), marker);
  assert.equal(await flashText(page), en['line.heldLate']);
  release();
  assert.equal(await sessionHas(page, 'alpha', 'HELD_LINE_LATE_8810'), false, 'a late line was sent');
  await page.context().close();
});

test('right after a server restart, a line waits through the skeleton and reaches its terminal', {skip}, async () => {
  const page = await mesh.openPage('alpha', VIEW);
  for (const round of [0, 1]) {
    await mesh.restartServer(0);
    await page.reload();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1 && active.id === 'alpha', undefined, {timeout: 20_000});
    const marker = `HELD_LINE_RESTART_${round}_6204`;
    await page.evaluate((text) => { line.value = text; enterLine(); }, `echo ${marker}`);
    await page.waitForFunction(() => !linePending, undefined, {timeout: 30_000});
    assert.equal(await flashText(page), '', `round ${round}: no refusal`);
    assert.equal(await page.evaluate(() => line.value), '', `round ${round}: the line was sent`);
    await page.waitForFunction((wanted) => {
      const buffer = (active as unknown as {term: {buffer: {active: {length: number; getLine(y: number): {translateToString(trim: boolean): string} | undefined}}}})
        .term.buffer.active;
      for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)?.translateToString(true).includes(wanted)) return true;
      return false;
    }, marker, {timeout: 20_000});
    assert.equal(await page.evaluate(() => active?.id), 'alpha');
  }
  await page.context().close();
});
