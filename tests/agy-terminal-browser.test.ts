// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How agy behaves in the page when it runs in its full-screen mode, with a witness program (named agy, so that
// discovery sees the agent) instead of the agent: it is on the alternate screen and asks for mouse reports and
// bracketed paste. What was observed of the real agy 1.5.9 (no model, no login): its login screen is on the alternate
// screen without mouse reporting; its signed-in screen was not observed, and its setting "altScreenMode" lets the
// owner choose. So this test shows that IF agy asks for the alternate screen and the mouse, the wheel and a swipe
// reach it, the phone input line pastes "/status" as one bracketed block followed by Enter, and the explicit
// recovery restores the wheel after a replay cut at 2 MiB. It does not show that agy asks for them.
// A real PTY host, server.py and Chromium (MESH_CHROMIUM; skipped without it).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {REPO, settle, skip, TerminalMesh, typeLine} from './terminal-browser-lib.ts';

type Line = {translateToString(trim: boolean): string};
type Pane = {term: {buffer: {active: {type: string; length: number; getLine(y: number): Line | undefined}};
  modes: {mouseTrackingMode: string}}; conn: {ws: {readyState: number}} | null};
declare const active: Pane;

const WITNESS = path.join(REPO, 'tests', 'fixtures', 'alt-screen-witness.mjs');
const DESKTOP = {width: 1100, height: 700};
const PHONE = {width: 390, height: 780};
let mesh: TerminalMesh;

before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('witness');
});
after(async () => { await mesh?.stop(); });

/** The witness's status row ("offset=N pasted=[…] submitted=N"), '' while it is not drawn. */
const statusRow = (page: Page): Promise<string> => page.evaluate(() => {
  const buffer = active.term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const text = buffer.getLine(y)!.translateToString(true);
    if (text.startsWith('offset=')) return text;
  }
  return '';
});
const offsetOf = async (page: Page): Promise<number> => Number(/^offset=(\d+)/.exec(await statusRow(page))?.[1]);
const bufferKind = (page: Page): Promise<[string, string]> =>
  page.evaluate(() => [active.term.buffer.active.type, active.term.modes.mouseTrackingMode]);

async function startWitness(page: Page): Promise<void> {
  await typeLine(page, `exec node ${WITNESS}`);
  await page.waitForFunction(() => {
    const buffer = active.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).startsWith('offset=')) return true;
    return false;
  }, undefined, {timeout: 15000});
  await settle(page);
}

async function swipe(page: Page, distance: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
  const x = box.x + box.width / 2, y0 = box.y + box.height * 0.3;
  const touch = (type: string, y: number) => cdp.send('Input.dispatchTouchEvent',
    {type, touchPoints: type === 'touchEnd' ? [] : [{x, y}]} as never);
  await touch('touchStart', y0);
  for (let step = 1; step <= 12; step += 1) { await touch('touchMove', y0 + (distance * step) / 12); await page.waitForTimeout(16); }
  await touch('touchEnd', y0 + distance);
  await page.waitForTimeout(900);
}

declare function find(id: string): {created: number; agent?: {type?: string; foreground?: boolean} | null} | undefined;
declare function restorePiFullscreenScroll(id: string, created: number): void;

describe('full-screen agent TUI in the page', {skip}, () => {
  test('desktop: alternate screen with mouse reporting; the wheel scrolls the program view', async () => {
    const page = await mesh.openPage('witness', DESKTOP);
    await startWitness(page);
    const [type, mouse] = await bufferKind(page);
    assert.equal(type, 'alternate');
    assert.notEqual(mouse, 'none');
    const bottom = await offsetOf(page);
    assert.ok(bottom > 100, `the view starts at the bottom of the 200 items (offset ${bottom})`);
    const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    const scrolled = await offsetOf(page);
    assert.ok(scrolled < bottom, `the wheel moved the program view up (${bottom} -> ${scrolled})`);
    for (let notch = 0; notch < 8; notch += 1) { await page.mouse.wheel(0, 120); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    assert.ok(await offsetOf(page) > scrolled, 'and back down');
    await page.context().close();
  });

  test('after a replay cut at 2 MiB the modes are lost; the explicit Antigravity recovery restores the wheel', async () => {
    await mesh.newShell('recovery');
    const named = path.join(mesh.scratch, 'agy');   // a program the kernel names agy, as discovery sees Antigravity
    fs.copyFileSync(process.execPath, named);
    fs.chmodSync(named, 0o755);
    // A node linked to a shared libnode (Homebrew's) finds it relative to its own path, so its copy cannot
    // start: it then runs with argv[0] agy instead, which discovery reads when the process name is node.
    const program = spawnSync(named, ['-e', '0']).status === 0 ? named
      : `perl -e 'exec {$ARGV[0]} "agy", @ARGV[1..$#ARGV]' ${process.execPath}`;
    const first = await mesh.openPage('recovery', DESKTOP);
    await typeLine(first, `exec ${program} ${WITNESS} churn`);
    await first.waitForFunction(() => find('recovery')?.agent?.type === 'agy' && find('recovery')?.agent?.foreground === true,
      undefined, {timeout: 20000});
    await first.waitForTimeout(4000);   // the churn is over
    await first.context().close();
    const page = await mesh.openPage('recovery', DESKTOP);
    await page.waitForFunction(() => find('recovery')?.agent?.type === 'agy', undefined, {timeout: 20000});
    const [type, mouse] = await bufferKind(page);
    assert.deepEqual([type, mouse], ['normal', 'none'], 'the replay no longer carries the program modes');
    const box = (await page.locator('.pane.active .xterm-screen').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await offsetOf(page);
    for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    assert.equal(await offsetOf(page), before, 'without the recovery the wheel does not reach the program');
    await page.evaluate(() => restorePiFullscreenScroll('recovery', find('recovery')!.created));
    await page.waitForTimeout(300);
    for (let notch = 0; notch < 4; notch += 1) { await page.mouse.wheel(0, -120); await page.waitForTimeout(80); }
    await page.waitForTimeout(500);
    assert.ok(await offsetOf(page) < before, 'after the recovery it does');
    await page.context().close();
  });

  test('phone: a swipe reaches the program as wheel reports; the input line pastes a slash command', async () => {
    const page = await mesh.signIn(PHONE, undefined, undefined, {phone: true});
    await page.evaluate(() => (document.querySelector('#list .item[data-id="witness"]') as HTMLElement).click());
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 10000});
    await settle(page);
    await page.waitForFunction(() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).startsWith('offset=')) return true;
      return false;
    }, undefined, {timeout: 15000});
    const before = await offsetOf(page);
    await swipe(page, 300);
    const after = await offsetOf(page);
    assert.ok(after < before, `a downward swipe scrolls the program view up (${before} -> ${after})`);
    await page.locator('#line-text').fill('/status');
    await page.locator('#line-text').press('Enter');
    await page.waitForFunction(() => {
      const buffer = active.term.buffer.active;
      for (let y = 0; y < buffer.length; y++) {
        const text = buffer.getLine(y)!.translateToString(true);
        if (text.includes('pasted=[/status]') && text.includes('submitted=1')) return true;
      }
      return false;
    }, undefined, {timeout: 10000});
  });
});
