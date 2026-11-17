// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A terminal socket that drops and reopens (web server restart, network) gets the host's
// replay again: the pane shows that history once, its reset written in the same write as the
// replay, and keeps the input modes the program set before the output the replay holds. A
// pane on the alternate screen keeps it: its replay is appended there, as before.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {countRows, type PaneView, rows, settle, skip, TerminalMesh, typeLine, waitForRow} from './terminal-browser-lib.ts';

type Modes = {applicationCursorKeysMode: boolean; applicationKeypadMode: boolean;
  mouseTrackingMode: string; sendFocusMode: boolean};
type Core = {coreMouseService: {activeEncoding: string}; coreService: {isCursorHidden: boolean}};
type Buffers = {active: {type: string}; normal: {length: number}};
type Term = {modes: Modes; _core: Core; buffer: Buffers; write(data: unknown, done?: () => void): void};
declare const active: PaneView & {term: Term};
type WriteLog = Window & {__writes: string[]};

async function reconnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ws = active.conn!.ws as WebSocket & {closedByTest?: boolean};
    ws.closedByTest = true;
    ws.close();
  });
  await page.waitForFunction(() => {
    const ws = active.conn?.ws as (WebSocket & {closedByTest?: boolean}) | null | undefined;
    return ws?.readyState === 1 && !ws.closedByTest;
  }, undefined, {timeout: 15000});
  await settle(page);
}

/** Record, as text, every write the active pane's xterm receives from now on. */
function recordWrites(page: Page): Promise<void> {
  return page.evaluate(() => {
    const log = window as unknown as WriteLog;
    log.__writes = [];
    const write = active.term.write.bind(active.term);
    active.term.write = (data, done) => {
      log.__writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array));
      write(data, done);
    };
  });
}

function inputModes(page: Page) {
  return page.evaluate(() => {
    const {modes, _core: core} = active.term;
    return {cursorKeys: modes.applicationCursorKeysMode, keypad: modes.applicationKeypadMode,
      mouse: modes.mouseTrackingMode, encoding: core.coreMouseService.activeEncoding,
      focus: modes.sendFocusMode};
  });
}

function screenState(page: Page) {
  return page.evaluate(() => ({buffer: active.term.buffer.active.type, normalRows: active.term.buffer.normal.length,
    cursorHidden: active.term._core.coreService.isCursorHidden, mouse: active.term.modes.mouseTrackingMode}));
}

describe('a reconnected terminal shows its history once', {skip}, () => {
  const mesh = new TerminalMesh();

  before(() => mesh.start());
  after(() => mesh.stop());

  test('a marker written once appears once after the socket reopens, reset and replay in one write', async () => {
    await mesh.newShell('rc');
    const page = await mesh.openPage('rc', {width: 1200, height: 700});
    // The typed command reads MARK''ER: only the program's output is the marker row.
    await typeLine(page, "printf 'MARK''ER-once\\n'");
    await waitForRow(page, 'MARKER-once');
    assert.equal(countRows(await rows(page), 'MARKER-once'), 1);

    await recordWrites(page);
    await reconnect(page);
    const after = await rows(page);
    assert.equal(countRows(after, 'MARKER-once'), 1, after.join('\n'));
    const writes = await page.evaluate(() => (window as unknown as WriteLog).__writes);
    const replay = writes.filter(write => write.includes('MARKER-once'));
    assert.equal(replay.length, 1, 'the replay is written once');
    assert.ok(replay[0].startsWith('\x1bc'),
      `the reset must start the write that holds the replay, not be written apart: ${JSON.stringify(replay[0].slice(0, 40))}`);

    // The terminal still works after the reconnection.
    await typeLine(page, "printf 'AFT''ER-reconnect\\n'");
    await waitForRow(page, 'AFTER-reconnect');
    await page.context().close();
  });

  test('input modes set before the output the replay holds survive the reconnection', async () => {
    await mesh.newShell('rm');
    const page = await mesh.openPage('rm', {width: 1200, height: 700});
    // Application cursor and keypad keys, button mouse tracking in SGR encoding, focus
    // reports; then 2.2 MB of output, more than the 2 MiB replay holds,
    // and the program keeps running (bash would change some modes back at its prompt).
    await typeLine(page, "printf '\\033[?1h\\033=\\033[?1000h\\033[?1006h\\033[?1004h'; "
      + "head -c 2200000 /dev/zero | tr '\\0' x | fold -w 100; echo; printf 'MO''DES-set\\n'; sleep 600");
    await waitForRow(page, 'MODES-set', 60000);
    await settle(page);
    const expected = {cursorKeys: true, keypad: true, mouse: 'vt200', encoding: 'SGR', focus: true};
    assert.deepEqual(await inputModes(page), expected);
    await reconnect(page);
    const after = await rows(page);
    assert.equal(countRows(after, 'MODES-set'), 1);
    assert.ok(!after.some(row => row.includes("printf '")), 'the replay no longer holds the command that set the modes');
    assert.deepEqual(await inputModes(page), expected);
    await page.context().close();
  });

  test('a program on the alternate screen since before the replay keeps it across the reconnection', async () => {
    await mesh.newShell('ra');
    const page = await mesh.openPage('ra', {width: 1200, height: 700});
    // Alternate screen, hidden cursor, mouse tracking; then 2.2 MB of output on that screen, so
    // the replay no longer holds the sequence that entered it.
    await typeLine(page, "printf '\\033[?1049h\\033[?25l\\033[?1000h'; "
      + "head -c 2200000 /dev/zero | tr '\\0' y | fold -w 100; echo; printf 'AL''T-ready\\n'; sleep 600");
    await waitForRow(page, 'ALT-ready', 60000);
    await settle(page);
    const before = await screenState(page);
    assert.deepEqual({...before, normalRows: 0}, {buffer: 'alternate', normalRows: 0, cursorHidden: true, mouse: 'vt200'});
    await reconnect(page);
    assert.deepEqual(await screenState(page), before,
      'the reconnection must leave the alternate screen, its cursor, its mouse mode and the normal history as they were');
    await waitForRow(page, 'ALT-ready');
    await page.context().close();
  });
});
