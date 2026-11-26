// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';
import type {WebSocketRoute} from 'playwright-core';

declare const active: any;
declare function refresh(): Promise<unknown>;

for (const transition of ['listing', 'close', 'bound-close']) test(`a cached restore remains detached after ${transition} changes its unconfirmed incarnation`, async () => {
  await harness(async (page, api) => {
    const attempts: WebSocketRoute[] = [];
    await page.routeWebSocket('**/ws/A**', socket => {attempts.push(socket); socket.onMessage(() => {});});
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => active.conn?.created === 1 && active.conn.terminal?.isOpen());
    assert.equal(await page.evaluate(() => active.conn.terminal.isBound('A', 1)), false);
    if (transition === 'bound-close') {
      attempts[0]!.send(JSON.stringify({t: 'bound', name: 'A', created: 1}));
      await page.waitForFunction(() => active.conn?.terminal?.isBound('A', 1) && active.conn.replayPending);
    }
    api.inventory.mesh[0]!.created = 2;
    if (transition === 'listing') await page.evaluate(() => refresh());
    else {
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions');
      attempts[0]!.close({code: 1008, reason: 'Fixture incarnation refused'});
      await refreshed;
      await page.waitForFunction(() => active.conn === null || active.conn.created !== 1);
    }
    assert.equal(await page.evaluate(() => active.conn === null), true);
    assert.deepEqual(attempts.map(socket => new URL(socket.url()).searchParams.get('created')), ['1']);
    await page.locator('#list .item[data-id="A"]').click();
    await page.waitForFunction(() => active.conn?.created === 2 && active.conn.terminal?.isOpen());
    assert.deepEqual(attempts.map(socket => new URL(socket.url()).searchParams.get('created')), ['1', '2'],
      'explicit selection, not cache restoration, may choose the replacement');
    if (transition === 'listing') {
      attempts[1]!.send(JSON.stringify({t: 'bound', name: 'A', created: 2}));
      attempts[1]!.send(Buffer.alloc(0));
      await page.waitForFunction(() => active.conn?.terminal?.isBound('A', 2)
        && !active.conn.replayPending && !active.conn.replaying);
      (api.inventory as any).moved = {A: 'B'};
      await page.evaluate(() => refresh());
      assert.equal(await page.evaluate(() => active.id), 'B',
        'a confirmed explicit reattachment can follow subsequent moves');
    }
  }, false, 'en');
});

test('a confirmed cache restoration resumes ordinary live replacement following', async () => {
  await harness(async (page, api) => {
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => active.conn?.terminal?.isBound('A', 1)
      && !active.conn.replayPending && !active.conn.replaying);
    api.inventory.mesh[0]!.created = 2;
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => active.conn?.terminal?.isBound('A', 2));
    assert.equal(await page.evaluate(() => active.conn.created), 2);
  }, false, 'en');
});

for (const transition of ['missing', 'moved']) test(`an unconfirmed cached restore does not follow a ${transition} target`, async () => {
  await harness(async (page, api) => {
    const attempts: WebSocketRoute[] = [];
    await page.routeWebSocket('**/ws/*', socket => {attempts.push(socket); socket.onMessage(() => {});});
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => active.conn?.created === 1 && active.conn.terminal?.isOpen());
    if (transition === 'missing') api.inventory.mesh.splice(0, 1);
    else (api.inventory as any).moved = {A: 'B'};
    await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => active.conn === null && active.id === 'A'), true);
    assert.equal(attempts.length, 1);
    if (transition === 'moved') {
      await page.evaluate(() => refresh());
      assert.equal(await page.evaluate(() => active.conn === null && active.id === 'A'), true,
        'a later listing cannot authorize a replacement');
      assert.equal(attempts.length, 1);
      await page.evaluate(() => active.show('B'));
      await page.waitForFunction(() => active.conn?.name === 'B' && active.conn.terminal?.isOpen());
      assert.equal(attempts.length, 2);
    }
  }, false, 'en');
});

test('an unknown listing retains the original unconfirmed attachment without selecting by name', async () => {
  await harness(async (page, api) => {
    const attempts: WebSocketRoute[] = [];
    await page.routeWebSocket('**/ws/A**', socket => {attempts.push(socket); socket.onMessage(() => {});});
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => active.conn?.created === 1 && active.conn.terminal?.isOpen());
    (api.inventory.mesh[0] as any).created = null;
    await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => active.conn?.created), 1);
    assert.equal(attempts.length, 1);
    api.inventory.mesh[0]!.created = 1;
    await page.evaluate(() => refresh());
    attempts[0]!.send(JSON.stringify({t: 'bound', name: 'A', created: 1}));
    attempts[0]!.send(Buffer.alloc(0));
    await page.waitForFunction(() => active.conn?.terminal?.isBound('A', 1)
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.equal(attempts.length, 1);
  }, false, 'en');
});
