// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';

declare const active: any, line: HTMLTextAreaElement;
declare const paneTargets: any, paneInput: any;
const phone = {hasTouch: true, isMobile: true, viewport: {width: 390, height: 800}};

test('limited touch input offers immediate terminal keys without submitting the saved phone draft', async () => {
  await harness(async page => {
    await page.locator('#line-text').fill('saved phone draft');
    await page.routeWebSocket('**/ws/A**', socket => {
      socket.onMessage(() => {}); socket.send(JSON.stringify({t: 'limited'})); socket.send(Buffer.alloc(0));
    });
    await page.evaluate(() => active.attach('A'));
    await page.waitForFunction(() => active.conn?.terminal?.limited && !active.conn.replayPending
      && !active.conn.replaying && !active.conn.draining);
    const button = page.locator('.pane.active .limited-keyboard');
    assert.equal(await button.count(), 1);
    assert.equal(await button.isVisible(), true);
    await button.click();
    assert.deepEqual(await page.evaluate(() => ({focused: document.activeElement === active.term.textarea,
      inputMode: active.term.textarea.getAttribute('inputmode'), draft: line.value,
      bound: active.conn.terminal.isBound('A', 1), retained: active.conn.terminal.retain()})),
    {focused: true, inputMode: 'text', draft: 'saved phone draft', bound: false, retained: null});
    await page.evaluate(() => {
      (window as any).liveKeys = [];
      const send = active.conn.ws.send.bind(active.conn.ws);
      active.conn.ws.send = (data: any) => {
        if (typeof data !== 'string') (window as any).liveKeys.push(new TextDecoder().decode(data));
        send(data);
      };
      const target = paneTargets.capture(active);
      (window as any).limitedCapture = target && paneInput.capture(active, target);
      if (target) paneTargets.release(target);
    });
    await page.keyboard.type('ok'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (window as any).liveKeys.join('')), 'ok\r');
    assert.equal(await page.evaluate(() => line.value), 'saved phone draft');
    assert.equal(await page.evaluate(() => (window as any).limitedCapture), null);
    await page.evaluate(() => active.show('B'));
    await page.waitForFunction(() => active.conn?.terminal?.isBound('B', 2));
    await page.evaluate(() => active.focus());
    assert.deepEqual(await page.evaluate(() => ({focus: document.activeElement?.id,
      inputMode: active.term.textarea.getAttribute('inputmode'), draft: line.value})),
    {focus: 'line-text', inputMode: 'none', draft: 'saved phone draft'});
  }, false, 'en', {rows: 24, cols: 80}, phone);
});

test('limited touch keyboard activation waits for the current replay instead of queueing input', async () => {
  await harness(async page => {
    let release!: () => void;
    await page.routeWebSocket('**/ws/A**', socket => {
      socket.onMessage(() => {}); socket.send(JSON.stringify({t: 'limited'}));
      release = () => socket.send(Buffer.alloc(0));
    });
    await page.evaluate(() => active.attach('A'));
    await page.waitForFunction(() => active.conn?.terminal?.limited && active.conn.replayPending);
    const button = page.locator('.pane.active .limited-keyboard');
    assert.equal(await button.count(), 1);
    await button.click();
    assert.equal(await page.evaluate(() => document.activeElement === active.term.textarea), false);
    assert.equal(await page.evaluate(() => active.term.textarea.getAttribute('inputmode')), 'none');
    release();
    await page.waitForFunction(() => !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    await button.click();
    assert.equal(await page.evaluate(() => document.activeElement === active.term.textarea), true);
  }, false, 'en', {rows: 24, cols: 80}, phone);
});

test('desktop limited terminals do not acquire a touch-only keyboard control', async () => {
  await harness(async page => {
    await page.routeWebSocket('**/ws/A**', socket => {
      socket.onMessage(() => {}); socket.send(JSON.stringify({t: 'limited'})); socket.send(Buffer.alloc(0));
    });
    await page.evaluate(() => active.attach('A'));
    await page.waitForFunction(() => active.conn?.terminal?.limited && !active.conn.replayPending
      && !active.conn.replaying && !active.conn.draining);
    assert.equal(await page.locator('.pane.active .limited-keyboard').isHidden(), true);
  }, false, 'en');
});
