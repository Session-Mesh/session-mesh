// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Input made while a terminal parses the replay its socket starts with (attach and
// reconnection) is dropped, as it always was: a paste or a mouse report made then is encoded
// with the terminal's modes before the replay sets them, so a multiline paste would leave
// without its brackets and run line by line. Nothing typed then reaches the PTY, on this
// session or on the session the pane opens next. A real PTY host, server.py and Chromium.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {rows, settle, skip, TerminalMesh, typeLine, waitForRow} from './terminal-browser-lib.ts';
import {READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

type MouseEvent = {col: number; row: number; x: number; y: number; button: number; action: number;
  ctrl: boolean; alt: boolean; shift: boolean};
type Pane = {
  id: string;
  term: {input(data: string, user: boolean): void; paste(text: string): void;
    write(data: unknown, done?: () => void): void; modes: {mouseTrackingMode: string};
    _core: {coreMouseService: {triggerMouseEvent(event: MouseEvent): boolean}}};
  conn: {ws: WebSocket & {closedByTest?: boolean}; replaying?: boolean} | null;
};
declare const active: Pane;
type Sent = {socket: number; text: string};
type TestWindow = Window & {__held: (() => void)[]; __holdArmed: boolean; __queued: number; __sends: Sent[];
  __writes: [unknown, (() => void) | undefined][]; __write: Pane['term']['write']};

const VIEWPORT = {width: 1200, height: 700};
const PASTE = 'echo PASTE-one\necho PASTE-two\n';

// Init script: a socket opened while __holdArmed keeps every binary frame it receives (the
// replay first) until its entry in __held runs, which delivers them in order, synchronously.
// Every binary frame the page sends is recorded with the number of its socket.
function holdReplays(): void {
  const w = window as unknown as TestWindow;
  w.__held = []; w.__holdArmed = false; w.__queued = 0; w.__sends = [];
  let sockets = 0;
  type Tagged = WebSocket & {__handler?: unknown; __id?: number};
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true,
    get(this: Tagged) { return this.__handler; },
    set(this: Tagged, handler: (event: MessageEvent) => void) {
      this.__handler = handler;
      this.__id = ++sockets;
      let queue: MessageEvent[] | null = w.__holdArmed ? [] : null;
      if (queue) {
        w.__holdArmed = false;
        w.__held.push(() => { const queued = queue!; queue = null; for (const event of queued) handler.call(this, event); });
      }
      descriptor.set!.call(this, (event: MessageEvent) => {
        if (typeof event.data !== 'string' && queue) { queue.push(event); w.__queued = queue.length; return; }
        handler.call(this, event);
      });
    },
  });
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: Tagged, data) {
    if (typeof data !== 'string') w.__sends.push({socket: this.__id ?? 0, text: new TextDecoder().decode(data as ArrayBuffer)});
    return send.call(this, data);
  };
}

async function waitHeld(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as unknown as TestWindow;
    return active?.conn?.ws?.readyState === 1 && !active.conn.ws.closedByTest && w.__held.length === 1 && w.__queued >= 1;
  }, undefined, {timeout: READY_TIMEOUT_MS});
}

/** Close the socket; the next one keeps its replay until __held[0]() runs. */
async function reconnectHeld(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__holdArmed = true; w.__held = []; w.__queued = 0;
    active.conn!.ws.closedByTest = true;
    active.conn!.ws.close();
  });
  await waitHeld(page);
}

function sent(page: Page): Promise<Sent[]> {
  return page.evaluate(() => (window as unknown as TestWindow).__sends);
}

/** Deliver the held replay, then paste and type while xterm has not parsed it yet. */
function inputDuringReplay(page: Page): Promise<boolean> {
  return page.evaluate(paste => {
    const w = window as unknown as TestWindow;
    w.__sends.length = 0;
    w.__held[0]();
    const replaying = active.conn!.replaying === true;
    active.term.paste(paste);
    active.term.input('Z', true);   // what xterm does for a key
    return replaying;
  }, PASTE);
}

describe('input made while a terminal parses its replay', {skip}, () => {
  const mesh = new TerminalMesh();
  before(() => mesh.start());
  after(() => mesh.stop());

  test('a multiline paste during the replay of an attach never reaches the PTY', async () => {
    await mesh.newShell('p-attach');
    const page = await mesh.signIn(VIEWPORT, holdReplays);
    await page.evaluate(() => { (window as unknown as TestWindow).__holdArmed = true; });
    await page.locator('#list .item[data-id="p-attach"]').click();
    await waitHeld(page);
    assert.equal(await inputDuringReplay(page), true, 'the paste must be made while the replay is parsed');
    await settle(page);
    assert.deepEqual(await sent(page), [], 'input made during the replay must be dropped, not sent');
    assert.ok(!(await rows(page)).some(row => row.includes('PASTE-one')), (await rows(page)).join('\n'));
    // The terminal still takes input once the replay is parsed.
    await typeLine(page, "printf 'AF''TER-attach\\n'");
    await waitForRow(page, 'AFTER-attach');
    await page.context().close();
  });

  test('no mouse report and no paste leave before a reconnection replay is parsed', async () => {
    await mesh.newShell('p-mouse');
    const page = await mesh.openPage('p-mouse', VIEWPORT, holdReplays);
    // Mouse tracking in xterm's default encoding (reports go through onBinary), kept by the
    // running program; the reconnection's replay starts from a reset that sets it again.
    await typeLine(page, "printf '\\033[?1000h'; printf 'MOU''SE-on\\n'; sleep 600");
    await waitForRow(page, 'MOUSE-on');
    await settle(page);
    assert.equal(await page.evaluate(() => active.term.modes.mouseTrackingMode), 'vt200');
    await reconnectHeld(page);
    const during = await page.evaluate(paste => {
      const w = window as unknown as TestWindow;
      w.__sends.length = 0;
      w.__held[0]();
      const press = {col: 3, row: 3, x: 0, y: 0, button: 0, action: 1, ctrl: false, alt: false, shift: false};
      const reported = active.term._core.coreMouseService.triggerMouseEvent(press);
      active.term.paste(paste);
      return {replaying: active.conn!.replaying === true, reported};
    }, PASTE);
    assert.deepEqual(during, {replaying: true, reported: true}, 'xterm must emit the report while the replay is parsed');
    await settle(page);
    assert.deepEqual(await sent(page), [], 'a mouse report or a paste made during the replay must not be sent');
    await page.context().close();
  });

  test('input made during a replay never reaches the session the pane opens next', async () => {
    await mesh.newShell('p-first');
    await mesh.newShell('p-next');
    const page = await mesh.openPage('p-first', VIEWPORT, holdReplays);
    await reconnectHeld(page);
    const replaying = await page.evaluate(paste => {
      const w = window as unknown as TestWindow;
      w.__sends.length = 0;
      // xterm parses nothing until the pane has opened the next session.
      w.__writes = []; w.__write = active.term.write;
      active.term.write = (data, done) => { w.__writes.push([data, done]); };
      w.__held[0]();
      active.term.paste(paste);
      active.term.input('Z', true);
      return active.conn!.replaying === true;
    }, PASTE);
    assert.equal(replaying, true);
    await page.locator('#list .item[data-id="p-next"]').click();
    await page.waitForFunction(() => active.id === 'p-next' && active.conn?.ws?.readyState === 1, undefined, {timeout: 15000});
    await page.evaluate(() => {
      const w = window as unknown as TestWindow;
      active.term.write = w.__write;
      for (const [data, done] of w.__writes) active.term.write(data, done);
    });
    await settle(page);
    const leaked = (await sent(page)).filter(item => item.text.includes('PASTE') || item.text.includes('Z'));
    assert.deepEqual(leaked, [], `input made during the replay of p-first was sent after the pane opened p-next: ${JSON.stringify(leaked)}`);
    await typeLine(page, "printf 'NE''XT-works\\n'");
    await waitForRow(page, 'NEXT-works');
    await page.context().close();
  });
});
