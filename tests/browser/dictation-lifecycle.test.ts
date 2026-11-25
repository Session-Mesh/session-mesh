// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Synthetic PageTransitionEvents exercise production hooks, not real BFCache eligibility.
import assert from 'node:assert/strict';
import {test, harness, open, closeCompose, select, typeNative, holdEnter, runEnter, wire} from '../../checks/dictation-browser-fixture.ts';
declare const active: any, dictation: any, dictationInventoryReady: boolean, composeOwner: any, linePending: any, localMesh: any;
declare function sendLine(): void;
declare function requestLocal(path: string, init?: RequestInit): Promise<Response>;
declare function refresh(): Promise<unknown>;
declare const inventoryPoller: {state(): {stopped: boolean; inFlightSince: number | null}} | null, meshPageCache: any;
async function waitUploads(page: any, api: any, count: number): Promise<void> {
  for (let i = 0; api.uploads.length < count && i < 500; i++) await page.waitForTimeout(10);
  assert.equal(api.uploads.length, count);
}

test('synthetic cache return reconnects ordinary keyboard with Whisper disabled', async () => {
  await harness(async (page, api, sockets, writes) => {
    api.disable(); await page.reload();
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && !active.conn.replaying && !active.conn.draining);
    await typeNative(page, 'before');
    await page.evaluate(() => {
      (window as any).cachedSocket = active.conn.ws; (window as any).cachedLease = active.inputLease;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && active.conn.ws !== (window as any).cachedSocket
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.equal(await page.evaluate(() => active.inputLease.retired), false);
    assert.equal(await page.evaluate(() => active.inputLease === (window as any).cachedLease), true,
      'reconnect preserves the original native lease identity and dirty history');
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true, 'unfinished human input survives reconnect');
    const key = `A:${sockets.get('A')!.length - 1}`;
    await page.evaluate(() => {
      const old = (window as any).cachedSocket;
      old.onmessage({data: new TextEncoder().encode('\x1b[6n').buffer}); old.onclose({});
    });
    await typeNative(page, 'after'); await page.keyboard.press('Enter');
    assert.ok(wire(writes, key).join('').includes('after\r'));
    assert.equal(await page.evaluate(() => active.inputLease.dirty), false);
    assert.equal(api.uploads.length, 0);
    assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
  });
});
test('synthetic cache transition cancels ordinary composer and mobile-line delayed Enters', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await open(page); await page.locator('#compose-text').fill('ordinary'); await holdEnter(page);
    await page.locator('#compose-send').click();
    assert.equal(await page.evaluate(() => composeOwner.pending), true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
    await runEnter(page); assert.deepEqual(wire(writes, 'A:0'), ['ordinary']);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && !active.conn.replayPending && !active.conn.draining);
    await page.evaluate(() => {const line = document.querySelector('#line-text') as HTMLTextAreaElement; line.value = 'mobile';});
    await holdEnter(page); await page.evaluate(() => sendLine());
    assert.equal(await page.evaluate(() => !!linePending), true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
    await runEnter(page); assert.deepEqual(wire(writes, 'A:1'), ['mobile']);
  });
});

test('synthetic cache restore refuses a replacement session incarnation', async () => {
  await harness(async (page, api, sockets) => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
    api.inventory.mesh[0]!.created = 99;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    await page.waitForFunction(() => meshPageCache === null);
    assert.equal(await page.evaluate(() => active.id), 'A');
    assert.equal(await page.evaluate(() => active.conn), null); assert.equal(sockets.get('A')!.length, 1);
  });
});

test('nonpersisted pagehide stays final; a later synthetic pageshow cannot revive it', async () => {
  await harness(async (page, _api, sockets) => {
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    assert.equal(await page.evaluate(() => active.conn?.terminal?.isOpen() ?? false), false);
  });
});

for (const final of ['dispose', 'logout']) {
  test(`${final} during synthetic cache suspension cannot resurrect sockets or dictation`, async () => {
    await harness(async (page, _api, sockets) => {
      await page.evaluate(async final => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        if (final === 'dispose') (await localMesh).dispose();
        else {
          window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
          await requestLocal('/api/logout', {method: 'POST'});
          window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        }
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
      }, final);
      assert.equal(await page.evaluate(() => active.conn?.terminal?.isOpen() ?? false), false);
      assert.equal(sockets.get('A')!.length, 1);
    });
  });
}

for (const failure of ['503', 'rejected', 'malformed']) {
  test(`synthetic cache return retries after ${failure} inventory through a later authoritative refresh (Whisper off)`, async () => {
    await harness(async (page, api, sockets, writes) => {
      api.disable(); await page.reload();
      await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && !active.conn.replayPending && !active.conn.draining);
      const originalCount = sockets.get('A')!.length, originalKey = `A:${originalCount - 1}`;
      await typeNative(page, 'before'); await open(page); await page.locator('#compose-text').fill('paused draft');
      await holdEnter(page); await page.locator('#compose-send').click();
      let failing = true;
      await page.route('**/api/sessions', route => {
        if (!failing) return route.fallback();
        if (failure === 'rejected') return route.abort();
        return route.fulfill({status: failure === '503' ? 503 : 200, contentType: 'application/json',
          body: JSON.stringify(failure === '503' ? {error: 'unavailable'} : {mesh: 'malformed', external: []})});
      });
      await page.evaluate(() => {
        (window as any).oldPoller = inventoryPoller; (window as any).oldSocket = active.conn.ws;
        (window as any).oldLease = active.inputLease;
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
      });
      await page.waitForFunction(() => inventoryPoller !== (window as any).oldPoller
        && inventoryPoller?.state().stopped === false && inventoryPoller.state().inFlightSince === null);
      await runEnter(page);
      assert.equal(await page.evaluate(() => active.conn), null, 'unavailable identity cannot reconnect by name');
      const oldFrames = wire(writes, originalKey); assert.equal(oldFrames.includes('\r'), false);
      assert.ok(oldFrames.join('').includes('paused draft'));
      failing = false; await page.evaluate(() => refresh());
      await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && active.conn.ws !== (window as any).oldSocket
        && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
      assert.equal(await page.evaluate(() => active.inputLease === (window as any).oldLease && active.inputLease.dirty), true);
      assert.equal(await page.evaluate(() => meshPageCache), null, 'authoritative snapshot consumes the pending bindings');
      assert.equal(sockets.get('A')!.length, originalCount + 1); assert.deepEqual(wire(writes, originalKey), oldFrames);
      await typeNative(page, 'after'); await page.keyboard.press('Enter');
      assert.ok(wire(writes, `A:${originalCount}`).join('').includes('after\r'));
      assert.equal(await page.evaluate(() => active.inputLease.dirty), false);
      assert.equal(api.uploads.length, 0); assert.equal(api.seen.some(path => path.endsWith('/settle')), false);
      assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
    });
  });
}

async function failCachedInventory(page: any): Promise<() => void> {
  let failing = true;
  await page.route('**/api/sessions*', (route: any) => failing ? route.fulfill({status: 503,
    contentType: 'application/json', body: JSON.stringify({error: 'unavailable'})}) : route.fallback());
  await page.evaluate(() => {
    (window as any).oldPoller = inventoryPoller;
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
  });
  await page.waitForFunction(() => inventoryPoller !== (window as any).oldPoller
    && inventoryPoller?.state().stopped === false && inventoryPoller.state().inFlightSince === null);
  assert.equal(await page.evaluate(() => meshPageCache !== null), true);
  return () => {failing = false;};
}

test('an authoritative absence consumes pending bindings and never reconnects a later replacement', async () => {
  await harness(async (page, api, sockets) => {
    const recover = await failCachedInventory(page);
    const original = api.inventory.mesh.shift()!; recover(); await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => meshPageCache), null);
    assert.equal(await page.evaluate(() => active.conn), null);
    api.inventory.mesh.unshift({...original, created: 99}); await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => active.conn), null); assert.equal(sockets.get('A')!.length, 1);
  });
});

test('a manual selection while inventory is unavailable retires the old cached pane binding', async () => {
  await harness(async (page, _api, sockets) => {
    const recover = await failCachedInventory(page); await select(page, 'B'); recover(); await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => meshPageCache), null);
    assert.equal(await page.evaluate(() => active.id), 'B'); assert.equal(sockets.get('A')!.length, 1);
    assert.equal(sockets.get('B')!.length, 1);
  });
});
