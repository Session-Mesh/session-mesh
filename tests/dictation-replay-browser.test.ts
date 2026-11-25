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

test('actual same-pane A→B→C jobs submit once on original sockets without changing C focus, draft or size', async () => {
  await harness(async (page, api, sockets, writes) => {
    await page.evaluate(() => dictation.setAutoSend(true));
    for (const [index, name] of ['A', 'B'].entries()) {
      if (name !== 'A') await select(page, name);
      await page.evaluate(() => openCompose());
      await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
      await page.waitForFunction(() => dictation.session(active.id, active.conn.created).state === 'recording');
      await page.waitForTimeout(350); await page.keyboard.up('Space');
      for (let i = 0; api.uploads.length < index + 1 && i < 500; i++) await page.waitForTimeout(10);
      assert.equal(api.uploads.length, index + 1);
      await closeCompose(page);
    }
    await select(page, 'C');
    await page.evaluate(() => openCompose());
    await page.locator('#compose-text').fill('C draft');
    const before = await page.evaluate(() => ({rows: active.term.rows, cols: active.term.cols,
      text: (document.querySelector('#compose-text') as HTMLTextAreaElement).value,
      focus: document.activeElement?.id}));
    for (const name of ['B', 'A']) {
      const job = api.jobs.find(job => job.session === name)!;
      job.state = 'ready'; job.text = `spoken ${name}`; api.ack(name);
      await page.waitForFunction(({name, created}) => dictation.session(name, created).state === 'idle',
        {name, created: name === 'A' ? 1 : 2});
    }
    assert.deepEqual(wire(writes, 'A:0'), ['spoken A', '\r']);
    assert.deepEqual(wire(writes, 'B:0'), ['spoken B', '\r']);
    assert.deepEqual(wire(writes, 'C:0'), []);
    assert.equal(sockets.get('A')!.length, 1); assert.equal(sockets.get('B')!.length, 1);
    assert.deepEqual(await page.evaluate(() => ({rows: active.term.rows, cols: active.term.cols,
      text: (document.querySelector('#compose-text') as HTMLTextAreaElement).value,
      focus: document.activeElement?.id})), before);
    assert.equal(api.uploads.length, 2);
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

test('new-base busy session and nonempty draft refuse media before permission', async () => {
  await harness(async (page, api) => {
    (api.inventory.mesh[0] as any).agent = {status: 'busy'};
    await page.evaluate(() => refresh());
    await page.evaluate(() => openCompose());
    await page.locator('#compose-mic').focus();
    await page.keyboard.down('Space'); await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).state), 'idle');
    (api.inventory.mesh[0] as any).agent = {status: 'waiting'};
    await page.evaluate(() => refresh());
    await page.locator('#compose-text').fill(' ');
    await page.locator('#compose-mic').focus();
    await page.keyboard.down('Space'); await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 0);
  });
});

test('cache return with failed inventory preserves native lease history and never rewires the old job', async () => {
  await harness(async (page, api, sockets, writes) => {
    await page.evaluate(() => openCompose());
    await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'recording');
    await page.waitForTimeout(350); await page.keyboard.up('Space');
    for (let i = 0; !api.uploads.length && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.uploads.length, 1); api.ack('A');
    await page.waitForFunction(() => dictation.session('A', 1).state === 'queued');
    await closeCompose(page);
    await page.locator('.pane.active .xterm-helper-textarea').focus(); await page.keyboard.type('before');
    let unavailable = true, failedReads = 0;
    await page.route('**/api/sessions', route => {
      if (!unavailable) return route.fallback();
      failedReads++; return route.fulfill({status: 503, body: '{}', contentType: 'application/json'});
    });
    await page.evaluate(() => {
      (window as any).cachedLease = active.inputLease;
      (window as any).oldRequest = dictation.session('A', 1).requestId;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    for (let i = 0; !failedReads && i < 500; i++) await page.waitForTimeout(10);
    assert.ok(failedReads);
    assert.equal(await page.evaluate(() => active.conn), null);
    assert.equal(await page.evaluate(() => !!meshPageCache), true);
    unavailable = false; await page.evaluate(() => refresh());
    await page.waitForFunction(() => active.conn?.terminal?.isOpen() && dictationInventoryReady
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.equal(await page.evaluate(() => active.inputLease === (window as any).cachedLease), true);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true);
    assert.equal(await page.evaluate(() => active.inputLease.retired), false);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'retained';
    await page.evaluate(() => dictation.reconcile(dictation.session('A', 1)));
    assert.equal(await page.evaluate(() => dictation.session('A', 1).channel), null);
    assert.equal(await page.evaluate(() => dictation.session('A', 1).requestId === (window as any).oldRequest), true);
    assert.equal(await page.evaluate(() => dictation.send(dictation.session('A', 1))), false);
    assert.equal(sockets.get('A')!.length, 2);
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type('after'); await page.keyboard.press('Enter'); await page.waitForTimeout(50);
    assert.deepEqual(wire(writes, 'A:1'), ['a', 'f', 't', 'e', 'r', '\r']);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), false);
    assert.equal(api.uploads.length, 1);
  });
});

for (const held of ['headers', 'body']) test(`cache return bounds held inventory ${held} and ignores its late obsolete identity`, async () => {
  await harness(async (page, _api, sockets, writes) => {
    await page.evaluate(held => {
      const w = window as any, fetch = window.fetch.bind(window), obsolete = structuredClone(data);
      obsolete.mesh[0].created = 99;
      let first = true;
      window.fetch = (input, init) => {
        if (String(input) !== '/api/sessions' || !first) return fetch(input, init);
        first = false;
        // Deliberately ignore AbortSignal: both headers and body must be raced.
        return held === 'headers' ? new Promise(resolve => {w.releaseOldInventory = () => resolve(new Response(JSON.stringify(obsolete)));})
          : Promise.resolve({ok: true, status: 200,
            json: () => new Promise(resolve => {w.releaseOldInventory = () => resolve(obsolete);})} as Response);
      };
      w.resumedControllers = 0;
      for (const controller of [dictation, inlineDictation]) {
        const resume = controller.resumeFromPageCache.bind(controller);
        controller.resumeFromPageCache = () => {w.resumedControllers++; resume();};
      }
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    }, held);
    await page.waitForFunction(() => (window as any).resumedControllers === 2, null, {timeout: 8000});
    await page.waitForFunction(() => active.conn?.created === 1 && active.conn.terminal?.isOpen()
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining, null, {timeout: 10000});
    assert.equal(sockets.get('A')!.length, 2, 'only validated exact-target polling reconnects');
    await page.evaluate(async () => {(window as any).releaseOldInventory(); await Promise.resolve(); await Promise.resolve();});
    assert.equal(await page.evaluate(() => data.mesh[0].created), 1);
    assert.equal(await page.evaluate(() => active.conn.created), 1);
    assert.deepEqual(wire(writes, 'A:0'), []); assert.deepEqual(wire(writes, 'A:1'), []);
  });
});
