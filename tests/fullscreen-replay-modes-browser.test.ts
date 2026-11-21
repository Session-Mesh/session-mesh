// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A full-screen agent such as pi opened on a phone, then on a desktop once it has written more than the
// 2 MiB a replay keeps: its startup sequences (alternate screen, mouse reporting) are no longer in the
// replay, and the PTY host sends the modes they left set before the cut window. The desktop page is then
// on the alternate screen with mouse reporting "any", and the wheel reaches the program without any
// explicit recovery. A witness program named pi stands for the agent.
// A real PTY host, server.py and Chromium (MESH_CHROMIUM; skipped without it).
import assert from 'node:assert/strict';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {REPO, settle, skip, TerminalMesh, typeLine} from './terminal-browser-lib.ts';

type Line = {translateToString(trim: boolean): string};
type Pane = {term: {buffer: {active: {type: string; length: number; getLine(y: number): Line | undefined}};
  modes: {mouseTrackingMode: string}}};
declare const active: Pane;

const WITNESS = path.join(REPO, 'tests', 'fixtures', 'alt-screen-witness.mjs');
const PHONE = {width: 390, height: 844};
const DESKTOP = {width: 1440, height: 900};
let mesh: TerminalMesh;

before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('pi-late');
});
after(async () => { await mesh?.stop(); });

const bufferKind = (page: Page): Promise<[string, string]> =>
  page.evaluate(() => [active.term.buffer.active.type, active.term.modes.mouseTrackingMode]);

/** The witness's "offset=N" from its status row, NaN while it is not drawn. */
const offsetOf = (page: Page): Promise<number> => page.evaluate(() => {
  const buffer = active.term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const match = /^offset=(\d+)/.exec(buffer.getLine(y)!.translateToString(true));
    if (match) return Number(match[1]);
  }
  return NaN;
});

async function wheelUp(page: Page): Promise<void> {
  const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
  await page.waitForTimeout(500);
}

describe('a full-screen agent attached late, after a replay cut', {skip}, () => {
  test('phone first, then a desktop: alternate screen, mouse reporting and the wheel', async () => {
    const phone = await mesh.openPage('pi-late', PHONE, undefined, undefined, {phone: true});
    await typeLine(phone, `exec -a pi node ${WITNESS} churn`);
    await phone.waitForFunction(() => active.term.buffer.active.type === 'alternate', undefined, {timeout: 20000});
    assert.deepEqual(await bufferKind(phone), ['alternate', 'any'], 'the phone got the modes live');
    await phone.waitForTimeout(5000);   // the churn (more than 2 MiB of redraws) is over
    const desk = await mesh.openPage('pi-late', DESKTOP);
    await desk.waitForFunction(() => /^offset=/m.test(Array.from({length: active.term.buffer.active.length},
      (_, y) => active.term.buffer.active.getLine(y)!.translateToString(true)).join('\n')), undefined, {timeout: 20000});
    assert.deepEqual(await bufferKind(desk), ['alternate', 'any'], 'the desktop is in the program modes');
    const before = await offsetOf(desk);
    await wheelUp(desk);
    const scrolled = await offsetOf(desk);
    assert.ok(scrolled < before, `the wheel reaches the program (${before} -> ${scrolled})`);
    await phone.context().close();
    await desk.context().close();
  });
});
