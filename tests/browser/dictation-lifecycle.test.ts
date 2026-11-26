// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Synthetic PageTransitionEvents exercise production hooks, not real BFCache eligibility.
import assert from 'node:assert/strict';
import {test, harness, open, record, closeCompose, select, typeNative, holdEnter, runEnter, wire} from '../../checks/dictation-browser-fixture.ts';
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
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && !active.conn.replayPending
      && !active.conn.replaying && !active.conn.draining);
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
    const deadline = performance.now() + 5000;
    while (!wire(writes, key).join('').includes('after\r') && performance.now() < deadline)
      await page.waitForTimeout(10);
    assert.ok(wire(writes, key).join('').includes('after\r'), 'the fixture received typing on the restored socket');
    assert.doesNotMatch(wire(writes, 'A:0').join(''), /\x1b\[\d+;\d+R/);
    assert.doesNotMatch(wire(writes, key).join(''), /\x1b\[\d+;\d+R/);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), false);
    assert.equal(api.uploads.length, 0);
    assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
  });
});

test('synthetic cache transition cancels pending auto Enter, preserves manual recovery and permits a new capture only after discard', async () => {
  await harness(async (page, api, sockets, writes) => {
    await page.evaluate(() => dictation.setAutoSend(true)); await record(page); await holdEnter(page);
    await waitUploads(page, api, 1);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta'; api.ack('A');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'delivering' && (window as any).voiceEnter.length === 1);
    await closeCompose(page); await select(page, 'C');
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    await page.evaluate(() => {
      dictation.session('C', 3).edit('C draft');
      (window as any).cFocus = document.activeElement;
      (window as any).cSize = [active.term.rows, active.term.cols];
      (window as any).oldJob = dictation.session('A', 1).requestId;
      (window as any).oldSocket = active.conn.ws;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    await page.waitForFunction(() => active?.id === 'C' && active.conn?.terminal?.isOpen() && active.conn.ws !== (window as any).oldSocket
      && dictationInventoryReady && !active.conn.replaying && !active.conn.draining);
    await runEnter(page);
    assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta']);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).text), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => dictation.session('A', 1).requestId === (window as any).oldJob), true);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).channel), null);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).autoAuthorized), false);
    assert.equal(await page.evaluate(() => dictation.autoSend), true);
    assert.equal(await page.evaluate(() => (window as any).micCalls), 1, 'return never reacquires media');
    assert.equal(await page.evaluate(() => dictation.session('C', 3).text), 'C draft');
    assert.equal(await page.evaluate(() => document.activeElement === (window as any).cFocus), true);
    assert.equal(await page.evaluate(() => JSON.stringify([active.term.rows, active.term.cols]) === JSON.stringify((window as any).cSize)), true);
    assert.equal(api.uploads.length, 1); assert.equal(api.seen.some(path => path.endsWith('/settle')), false);
    assert.equal(sockets.get('A')!.length, 1, 'retained A is never rebound while C is foreground');
    await select(page, 'A'); await open(page);
    assert.equal(await page.locator('#compose-text').inputValue(), 'alpha\nbeta');
    await page.evaluate(() => dictation.discard(dictation.session('A', 1)));
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    await page.locator('#compose-text').fill(''); await closeCompose(page);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true,
      'discarding the job must not pretend its already-pasted terminal line was cleared');
    await typeNative(page, ''); await page.keyboard.press('Control+u'); await page.keyboard.press('Control+c');
    await record(page);
    await page.waitForFunction(() => dictation.session('A', 1).state === 'uploading');
    await waitUploads(page, api, 2); api.ack('A');
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
    assert.equal(await page.evaluate(() => dictation.session('A', 1).text), 'ordinary');
  });
});

test('synthetic cache restore refuses a replacement session incarnation', async () => {
  await harness(async (page, api, sockets) => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
    api.inventory.mesh[0]!.created = 99;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    await page.waitForFunction(() => meshPageCache === null && dictationInventoryReady);
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
    assert.equal(await page.evaluate(() => dictation.autoSend), false); assert.equal(sockets.get('A')!.length, 1);
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
      assert.equal(await page.evaluate(() => dictation.autoSend), false);
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
      assert.equal(await page.evaluate(() => dictation.session('A', 1).text), 'paused draft');
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
    await page.waitForTimeout(300);
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

test('held direct paste is recovered when its terminal incarnation retires', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await page.evaluate(() => {
      const line = document.querySelector('#line-text') as HTMLTextAreaElement;
      line.value = 'held-private-text';
      lineDirect = {pane: active, conn: active.conn, session: active.id, heldInputType: 'insertFromPaste'};
      endDirectLine();
    });
    assert.equal(await page.locator('#line-text').inputValue(), '');
    assert.equal(await page.evaluate(() => lineRecovery?.text), 'held-private-text');
    assert.equal(await page.evaluate(() => lineRecovery?.target.displayName), 'A');
    await page.evaluate(() => sendLine());
    assert.deepEqual(wire(writes, 'A:0'), []);
  });
});

test('retrying a held paste classifies refusal and uncertainty before teardown', async () => {
  await harness(async (page) => {
    for (const outcome of ['refused', 'uncertain']) {
      const observed = await page.evaluate((kind: string) => {
        const saved = paneInput.deliver;
        const field = document.querySelector('#line-text') as HTMLTextAreaElement;
        lineRecovery = null;
        field.value = 'held-private-text';
        lineDirect = {pane: active, conn: active.conn, session: active.id, heldInputType: 'insertFromPaste'};
        (paneInput as any).deliver = (_binding: unknown, _text: string, _submit: boolean, done: Function) => done({kind});
        try {
          flushDirectField('insertText', true);
          return {recovery: lineRecovery?.result.kind ?? null, value: field.value};
        } finally { (paneInput as any).deliver = saved; }
      }, outcome);
      assert.equal(observed.recovery, outcome === 'refused' ? 'refused' : null);
      assert.equal(observed.value, '');
    }
  });
});

test('a later authoritative refresh reconnects ordinary input but cannot rebind or replay an old dictation job', async () => {
  await harness(async (page, api, sockets, writes) => {
    await page.evaluate(() => dictation.setAutoSend(true)); await record(page); await holdEnter(page);
    await waitUploads(page, api, 1);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'alpha\nbeta'; api.ack('A');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'delivering' && (window as any).voiceEnter.length === 1);
    const id = api.jobs[0]!.request_id;
    const recover = await failCachedInventory(page); await runEnter(page); recover(); await page.evaluate(() => refresh());
    await page.waitForFunction(() => active?.conn?.terminal?.isOpen() && !active.conn.replayPending && !active.conn.draining);
    assert.equal(sockets.get('A')!.length, 2); assert.deepEqual(wire(writes, 'A:0'), ['alpha\rbeta']);
    assert.deepEqual(wire(writes, 'A:1'), []);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).requestId), id);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).text), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => dictation.session('A', 1).channel), null);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).autoAuthorized), false);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).state), 'recovery');
    assert.equal(api.uploads.length, 1); assert.equal(api.seen.some(path => path.endsWith('/settle')), false);
  });
});
