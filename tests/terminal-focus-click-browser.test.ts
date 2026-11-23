// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Clicks into a fullscreen program that asked for focus reports (?1004) and SGR mouse reports.
// Claude Code drops a click that arrives less than 400 ms after a focus-in (ESC [ I), and xterm
// focuses its textarea on mousedown just before it reports the press. On a phone every tap used
// to blur and refocus that textarea (the input line takes the focus back after each tap).
// The program here is a shell turning the modes on and reading its input away; the test reads
// what the page sends to each session's socket, with the time it was sent.
// Needs MESH_CHROMIUM and MESH_PTYHOST_CMD (skipped without the browser).
import assert from 'node:assert/strict';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {type PaneView, TerminalMesh, skip} from './terminal-browser-lib.ts';

declare global {
  // eslint-disable-next-line no-var
  var __frames: {t: number; url: string; d: string}[];
}
declare const active: PaneView;
declare const panes: Array<PaneView & {conn?: {terminal?: {isOpen(): boolean}}}>;
declare function addPane(id: string): unknown;
declare function refresh(): Promise<void>;

const PHONE = {width: 390, height: 800};
const DESKTOP = {width: 1280, height: 800};
const FOCUS_IN = '\x1b[I', FOCUS_OUT = '\x1b[O';
const PRESS = /\x1b\[<0;\d+;\d+M/;
const RELEASE = /\x1b\[<0;\d+;\d+m/;
// A full-screen program asking for what Claude Code asks for, then reading its input away.
const PROGRAM = "stty raw -echo; printf '\\033[?1049h\\033[?1004h\\033[?1003h\\033[?1006h\\033[2J'; exec cat >/dev/null";

/** Record, in the page, every input frame (raw bytes to a terminal socket) with its time and socket. */
function recordFrames(): void {
  window.__frames = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const ack = new URL(this.url).searchParams.get('input_ack');
    if (data instanceof Uint8Array) window.__frames.push({t: performance.now(), url: this.url,
      d: new TextDecoder().decode(ack === '1' || ack === '2' ? data.subarray(4) : data)});
    return send.call(this, data);
  };
}

type Frame = {t: number; url: string; d: string};
const framesOf = async (page: Page, session: string): Promise<Frame[]> =>
  (await page.evaluate(() => window.__frames.slice())).filter(f => f.url.includes(`/ws/${session}?`));
const forget = (page: Page): Promise<void> => page.evaluate(() => { window.__frames.length = 0; });

async function runProgram(page: Page): Promise<void> {
  await page.evaluate(command => active.send(`${command}\r`), PROGRAM);
  await page.waitForFunction(() => {
    const modes = (active as unknown as {term: {modes: {sendFocusMode: boolean; mouseTrackingMode: string}}}).term.modes;
    return modes.sendFocusMode && modes.mouseTrackingMode === 'any';
  }, undefined, {timeout: 20000});
  await page.waitForTimeout(300);
}

/** The middle of a pane's terminal screen. */
async function screenCenter(page: Page, session: string): Promise<{x: number; y: number}> {
  return page.evaluate(id => {
    const pane = panes.find(p => p.id === id) as unknown as {termEl: HTMLElement};
    const box = pane.termEl.querySelector('.xterm-screen')!.getBoundingClientRect();
    return {x: box.left + box.width / 2, y: box.top + box.height / 2};
  }, session);
}

/** Every press is delivered with no focus-in less than 400 ms before it; the number of presses. */
function assertClicksKept(frames: Frame[]): number {
  let presses = 0;
  frames.forEach((frame, index) => {
    if (!PRESS.test(frame.d)) return;
    presses += 1;
    const early = frames.slice(0, index).filter(f => f.d.includes(FOCUS_IN) && frame.t - f.t < 400);
    assert.deepEqual(early, [], `a focus-in precedes the press at ${frame.t} by less than 400 ms: ${JSON.stringify(frames)}`);
  });
  return presses;
}

describe('clicks into a program that reports focus', {skip}, () => {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  async function open(name: string, phone: boolean): Promise<Page> {
    await mesh.newShell(name);
    const page = await mesh.openPage(name, phone ? PHONE : DESKTOP, recordFrames, undefined, {phone});
    pages.push(page);
    await runProgram(page);
    return page;
  }

  test('two taps on a phone are two clicks, neither just after a focus-in', async () => {
    const page = await open('taps', true);
    await page.waitForFunction(() => document.activeElement === document.querySelector('#line-text'));
    await forget(page);
    const at = await screenCenter(page, 'taps');
    for (let tap = 0; tap < 2; tap += 1) {
      await page.touchscreen.tap(at.x, at.y);
      await page.waitForTimeout(600);
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#line-text')), true,
        'the input line has the focus back after the tap');
    }
    const frames = await framesOf(page, 'taps');
    assert.equal(assertClicksKept(frames), 2, JSON.stringify(frames));
    assert.equal(frames.filter(f => f.d.includes(FOCUS_OUT)).length, 0,
      `the pane kept the focus while it moved to the input line: ${JSON.stringify(frames)}`);
  });

  test('the first click into an unfocused pane on a desktop reaches the program, the focus-in after it', async () => {
    const page = await open('first-click', false);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(100);
    assert.ok((await framesOf(page, 'first-click')).some(f => f.d.includes(FOCUS_OUT)), 'leaving the pane is reported');
    await forget(page);
    const at = await screenCenter(page, 'first-click');
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    const frames = await framesOf(page, 'first-click');
    assert.equal(assertClicksKept(frames), 1, JSON.stringify(frames));
    const press = frames.findIndex(f => PRESS.test(f.d));
    const release = frames.findIndex(f => RELEASE.test(f.d));
    const focusIn = frames.findIndex(f => f.d.includes(FOCUS_IN));
    assert.ok(press >= 0 && release > press && focusIn > release,
      `the focus-in is still reported, after the release: ${JSON.stringify(frames)}`);
    assert.equal(frames.filter(f => f.d.includes(FOCUS_IN)).length, 1, JSON.stringify(frames));
  });

  test('switching panes still reports focus out to the one left and focus in to the one chosen', async () => {
    const page = await open('pane-a', false);
    await mesh.newShell('pane-b');
    await page.evaluate(() => refresh());
    await page.evaluate(() => addPane('pane-b'));
    await page.waitForFunction(() => panes.length === 2 && panes.every(p => p.conn?.terminal?.isOpen()), null, {timeout: 10000});
    await page.waitForFunction(() => active.id === 'pane-b' && active.conn?.replaying === false, null, {timeout: 10000});
    await runProgram(page);
    const a = await screenCenter(page, 'pane-a'), b = await screenCenter(page, 'pane-b');
    await page.mouse.click(a.x, a.y);
    await page.waitForTimeout(300);
    await forget(page);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(300);
    const left = await framesOf(page, 'pane-a'), chosen = await framesOf(page, 'pane-b');
    assert.deepEqual(left.filter(f => f.d === FOCUS_IN || f.d === FOCUS_OUT).map(f => f.d), [FOCUS_OUT], JSON.stringify(left));
    assert.deepEqual(chosen.filter(f => f.d === FOCUS_IN || f.d === FOCUS_OUT).map(f => f.d), [FOCUS_IN], JSON.stringify(chosen));
    assert.equal(assertClicksKept(chosen), 1, JSON.stringify(chosen));
    await forget(page);
    await page.evaluate(() => panes.find(p => p.id === 'pane-a')!.term.focus());   // the keyboard, not a press
    await page.waitForTimeout(100);
    assert.deepEqual((await framesOf(page, 'pane-a')).map(f => f.d), [FOCUS_IN]);
    assert.deepEqual((await framesOf(page, 'pane-b')).map(f => f.d), [FOCUS_OUT]);
  });

  test('on a phone, the window and a pane switch through the session list report the focus the input line held', async () => {
    const page = await open('phone-b', true);
    await mesh.newShell('phone-a');
    await page.evaluate(() => refresh());
    await page.evaluate(() => addPane('phone-a'));
    await page.waitForFunction(() => panes.length === 2 && panes.every(p => p.conn?.terminal?.isOpen()), null, {timeout: 10000});
    await page.waitForFunction(() => active.id === 'phone-a' && active.conn?.replaying === false, null, {timeout: 10000});
    await runProgram(page);
    const at = await screenCenter(page, 'phone-a');
    await forget(page);   // xterm answers the program turning focus reports on
    await page.touchscreen.tap(at.x, at.y);   // the pane takes the focus, then gives it to the input line
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#line-text')), true);
    const focusOf = async (session: string): Promise<string[]> =>
      (await framesOf(page, session)).filter(f => f.d === FOCUS_IN || f.d === FOCUS_OUT).map(f => f.d);
    assert.deepEqual(await focusOf('phone-a'), [FOCUS_IN]);
    await forget(page);
    // Playwright pages keep the window focus: the window's events are dispatched
    await page.evaluate(() => { window.dispatchEvent(new FocusEvent('blur')); window.dispatchEvent(new FocusEvent('focus')); });
    await page.waitForTimeout(100);
    assert.deepEqual(await focusOf('phone-a'), [FOCUS_OUT, FOCUS_IN], 'the window left and regained');
    await forget(page);
    await page.locator('#btn-menu').click();
    await page.locator('#list .item[data-id="phone-b"]').click();
    await page.waitForFunction(() => active.id === 'phone-b');
    await page.waitForTimeout(100);
    assert.deepEqual(await focusOf('phone-a'), [FOCUS_OUT], 'the pane left through the session list');
  });

  test('on a phone, a session switch inside one pane reports the focus-out to the session left and starts the next unreported', async () => {
    const page = await open('swap-b', true);   // swap-b's program already asks for focus reports
    await mesh.newShell('swap-a');
    await page.evaluate(() => refresh());
    const focusOf = async (session: string): Promise<string[]> =>
      (await framesOf(page, session)).filter(f => f.d === FOCUS_IN || f.d === FOCUS_OUT).map(f => f.d);
    const switchTo = async (session: string): Promise<void> => {
      await page.locator('#btn-menu').click();
      await page.locator(`#list .item[data-id="${session}"]`).click();
      await page.waitForFunction(id => panes.length === 1 && active.id === id && active.conn?.terminal?.isOpen()
        && active.conn?.replaying === false, session, {timeout: 10000});
      await page.waitForTimeout(300);
    };
    await switchTo('swap-a');
    await runProgram(page);
    const at = await screenCenter(page, 'swap-a');
    await forget(page);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(600);
    assert.deepEqual(await focusOf('swap-a'), [FOCUS_IN]);
    await forget(page);
    await switchTo('swap-b');
    assert.deepEqual(await focusOf('swap-a'), [FOCUS_OUT], 'the session left is told it lost the focus');
    assert.deepEqual(await focusOf('swap-b'), [], 'the session attached is reported nothing yet');
    await forget(page);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(600);
    const frames = await framesOf(page, 'swap-b');
    assert.equal(assertClicksKept(frames), 1, JSON.stringify(frames));
    assert.deepEqual(await focusOf('swap-b'), [FOCUS_IN], `the first tap reports the focus-in: ${JSON.stringify(frames)}`);
  });
});
