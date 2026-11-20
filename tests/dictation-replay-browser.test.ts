// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: actual-page replay tests, discovered by browser shards.
// Actual shipped frontend, fake sockets/media/API only; no running PTY host.
import assert from 'node:assert/strict';
import {test, harness, wire, select, closeCompose} from '../checks/dictation-browser-fixture.ts';
declare const active: any, dictation: any, inlineDictation: any;
declare function openCompose(): void;
declare function refresh(): Promise<unknown>;
declare const meshPageCache: any, dictationInventoryReady: boolean;
declare function addPane(name: string): any;
declare function closePane(pane: any): void;
declare const data: any;

test('closing a pane retires its queued xterm reset viewport callback before renderer disposal', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await page.evaluate(() => { (window as any).closingPane = addPane('B'); });
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen()
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    await page.evaluate(() => {
      const pane = (window as any).closingPane;
      // Attach/reset and the replay's RIS each schedule a viewport sync. Keep
      // both pending, then close in this same task before their next frame.
      pane.term.reset();
      pane.term.reset();
      closePane(pane);
    });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.evaluate(() => (window as any).closingPane.actionDisposed), true);
    assert.equal(await page.evaluate(() => active.id), 'A');
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type('a'); await page.keyboard.press('Enter'); await page.waitForTimeout(50);
    assert.deepEqual(wire(writes, 'A:0'), ['a', '\r']);
  });
});

test('physical keys during a reconnection replay queue once and revoke native authority immediately', async () => {
  await harness(async (page, _api, sockets, writes) => {
    await page.evaluate(() => {
      const w = window as any;
      w.nativeAttempt = active.inputLease.claim();
      w.beforeRevision = active.inputLease.revision;
      w.originalWrite = active.term.write;
      w.heldWrites = [];
      active.term.write = (data: unknown, done: unknown) => w.heldWrites.push([data, done]);
      active.conn.ws.close();
    });
    await page.waitForFunction(() => active.conn?.terminal?.isOpen() && active.conn.replaying);
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type('z');
    assert.equal(await page.evaluate(() => (window as any).nativeAttempt.valid()), false);
    assert.equal(await page.evaluate(() => active.inputLease.revision > (window as any).beforeRevision), true);
    assert.equal(await page.evaluate(() => active.inputLease.inputDirty), true);
    assert.equal(await page.evaluate(() => active.inputLease.claim()), null);
    const key = `A:${sockets.get('A')!.length - 1}`;
    assert.deepEqual(wire(writes, key), [], 'no human frame before replay parsing completes');
    await page.evaluate(() => {
      const w = window as any;
      active.term.write = w.originalWrite;
      for (const [data, done] of w.heldWrites) active.term.write(data, done);
    });
    await page.waitForFunction(() => !active.conn.replaying && !active.conn.draining);
    await page.waitForTimeout(100);
    assert.deepEqual(wire(writes, key), ['z']);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    assert.deepEqual(wire(writes, key), ['z', '\r']);
    assert.equal(await page.evaluate(() => active.inputLease.inputDirty), false);
    assert.equal(await page.evaluate(() => active.inputOrigin.supported), true);
  });
});

test('alternate-screen reconnect preserves the original bracketed mode without a reset prefix', async () => {
  await harness(async (page, _api, sockets) => {
    await page.evaluate(async () => {
      await new Promise<void>(resolve => active.term.write('\x1b[?2004h\x1b[?1049h', resolve));
      active.conn.ws.close();
    });
    await page.waitForFunction(() => active.conn?.terminal?.isOpen() && !active.conn.replayPending
      && !active.conn.replaying && !active.conn.draining);
    assert.equal(sockets.get('A')!.length, 2);
    assert.equal(await page.evaluate(() => active.term.buffer.active.type), 'alternate');
    assert.equal(await page.evaluate(() => active.conn.terminal.dictationMode.valid), true);
    assert.equal(await page.evaluate(() => active.conn.terminal.dictationMode.value), true);
  });
});
test('beforeinput text during replay is reserved before write and cancelled on a different incarnation/view', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await page.evaluate(() => {
      active.conn.replaying = true;
      (window as any).nativeAttempt = active.inputLease.claim();
      active.term.textarea.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: 'é', bubbles: true, cancelable: true,
      }));
    });
    assert.equal(await page.evaluate(() => (window as any).nativeAttempt.valid()), false);
    assert.deepEqual(wire(writes, 'A:0'), []);
    await page.evaluate(() => active.show('B'));
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen()
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.deepEqual(wire(writes, 'A:0'), []);
    assert.deepEqual(wire(writes, 'B:0'), []);
    assert.equal(await page.evaluate(() => active.inputLease.inputDirty), false);
  });
});
