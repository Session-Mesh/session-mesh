// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Synthetic page-cache transitions exercise the shipped page with fake local sockets,
// not actual browser BFCache eligibility or a running PTY host.
import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';
declare const active: any;
declare function openLocalTerminal(...args: any[]): any;

for (const choice of ['unchanged', 'filter', 'filter-then-body']) test(`cached terminal focus respects ${choice}`, async () => {
  await harness(async page => {
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    await page.evaluate(() => {
      const w = window as any;
      w.heldOpen = []; w.originalOpen = openLocalTerminal;
      openLocalTerminal = (name: any, size: any, observer: any) => {
        const wrapped = {...observer};
        for (const key of ['opened', 'bytes', 'replayGeometry', 'ptySize'])
          wrapped[key] = (...args: any[]) => w.heldOpen.push(() => observer[key]?.(...args));
        return w.originalOpen(name, size, wrapped);
      };
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => (window as any).heldOpen.length >= 2);
    if (choice !== 'unchanged') {await page.locator('#filter').focus(); await page.keyboard.type('search');}
    if (choice === 'filter-then-body') await page.locator('#filter').blur();
    await page.evaluate(() => {
      const w = window as any;
      openLocalTerminal = w.originalOpen;
      for (const run of w.heldOpen.splice(0)) run();
    });
    await page.waitForFunction(() => !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.equal(await page.evaluate(() => document.activeElement === active.term.textarea), choice === 'unchanged');
    if (choice === 'filter') {
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'filter');
      await page.evaluate(() => {
        const w = window as any, ws = active.conn.ws, send = ws.send.bind(ws);
        w.sent = [];
        ws.send = (data: any) => {if (typeof data !== 'string') w.sent.push(new TextDecoder().decode(data)); send(data);};
      });
      await page.keyboard.type('z');
      assert.equal(await page.locator('#filter').inputValue(), 'searchz');
      assert.deepEqual(await page.evaluate(() => (window as any).sent), [], 'filter keys never reach the PTY');
    }
  }, false, 'en');
});

test('cache focus intent starts before the resume inventory settles', async () => {
  await harness(async (page, api) => {
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const seen = new Promise<void>(resolve => {entered = resolve;});
    await page.route('**/api/sessions', async route => {
      entered(); await gate; await route.fulfill({json: api.inventory});
    });
    try {
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
      });
      await seen;
      await page.locator('#filter').focus();
      await page.keyboard.type('search');
      release();
      await page.waitForFunction(() => active.conn?.terminal?.isOpen() && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'filter');
      assert.equal(await page.locator('#filter').inputValue(), 'search');
    } finally {release(); await page.unrouteAll({behavior: 'wait'});}
  }, false, 'en');
});
