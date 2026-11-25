// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';
declare const active: any, panes: any[], meshPageCache: any, paneTargets: any;
declare function addPane(name: string): any;
declare function refresh(): Promise<unknown>;

for (const focus of ['unchanged', 'filter']) test(`second suspension preserves pending B, with ${focus} latest focus`, async () => {
  await harness(async (page, api) => {
    await page.evaluate(() => {addPane('B');});
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen() && !active.conn.draining && !active.conn.replaying);
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    let release!: () => void, entered!: () => void, finished!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const seen = new Promise<void>(resolve => {entered = resolve;});
    const done = new Promise<void>(resolve => {finished = resolve;});
    let first = true;
    await page.route('**/api/sessions', async route => {
      if (first) {first = false; entered(); await gate;}
      try {await route.fulfill({json: api.inventory});} finally {finished();}
    });
    try {
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
      });
      await seen;
      await page.evaluate(() => panes.find(p => p.id === 'A').show('A'));
      await page.waitForFunction(() => panes.find(p => p.id === 'A').conn?.terminal?.isOpen());
      if (focus === 'filter') {await page.locator('#filter').focus(); await page.keyboard.type('search');}
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
      assert.deepEqual(await page.evaluate(() => meshPageCache.bindings.map((b: any) => [b.id, b.created])), [['A', 1], ['B', 2]]);
      release(); await done;
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
      await page.waitForFunction(() => panes.every(p => p.conn?.terminal?.isOpen() && !p.conn.replayPending && !p.conn.replaying && !p.conn.draining) && meshPageCache === null);
      assert.equal(await page.evaluate(() => panes.find(p => p.id === 'B').conn.created), 2);
      if (focus === 'filter') {
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'filter', 'retained B identity must not retain its first suspension focus');
        await page.evaluate(() => {
          const w = window as any;
          w.sent = [];
          for (const p of panes) {
            const send = p.conn.ws.send.bind(p.conn.ws);
            p.conn.ws.send = (data: any) => {if (typeof data !== 'string') w.sent.push(new TextDecoder().decode(data)); send(data);};
          }
        });
        await page.keyboard.type('z');
        assert.equal(await page.locator('#filter').inputValue(), 'searchz');
        assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
      } else assert.equal(await page.evaluate(() => document.activeElement === active.term.textarea), true);
    } finally {release(); await page.unrouteAll({behavior: 'wait'});}
  }, false, 'en');
});

test('observed unknown created preserves original positive cached identity without a legacy socket', async () => {
  await harness(async (page, api, sockets) => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
    delete (api.inventory.mesh.find(s => s.name === 'A') as any).created;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    await page.waitForFunction(() => paneTargets.identity('A')?.created === null);
    assert.equal(await page.evaluate(() => active.conn), null);
    assert.equal(await page.evaluate(() => meshPageCache.bindings[0].created), 1);
    assert.equal(sockets.get('A')!.length, 1);
    await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => active.conn), null, 'generic refresh cannot select a legacy unknown incarnation');
    assert.equal(sockets.get('A')!.length, 1);
    api.inventory.mesh.find(s => s.name === 'A')!.created = 1;
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => active.conn?.terminal?.isOpen() && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.equal(sockets.get('A')!.length, 2);
    assert.equal(new URL(sockets.get('A')![1].url()).searchParams.get('created'), '1');
    assert.equal(await page.evaluate(() => meshPageCache), null);
  }, false, 'en');
});
