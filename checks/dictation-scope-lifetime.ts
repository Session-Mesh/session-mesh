// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, open, select, typeNative} from './dictation-browser-fixture.ts';

declare const active: any;

test('retired dirty A can be explicitly completed on a new user-opened A before voice becomes eligible', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await typeNative(page, 'draft');
    const oldClient = (writes.get('A:0') || []).filter((v): v is string => typeof v === 'string').map(v => JSON.parse(v)).find(v => v.t === 'h').client_id;
    await page.evaluate(() => {window.oldA=active; addPane("C"); closePane(window.oldA)}); await select(page, 'A');
    await page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
    await page.keyboard.press('Control+c'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (active.inputLease.inputDirty)), false, 'explicit completion must recover retired dirty ownership');
    const ids = (writes.get('A:1') || []).filter((v): v is string => typeof v === 'string').map(v => JSON.parse(v)).filter(v => v.t === 'h').map(v => v.client_id);
    assert.deepEqual([...new Set(ids)], [oldClient], 'adopt retired H identity before first H, never replace an existing connection identity');
    await open(page); assert.equal(await page.evaluate(() => (dictation.reason(composeDictationSession()))), '');
  });
});

test('a still-live dirty A is not cleared by another A completing its own input', async () => {
  await harness(async page => {
    await typeNative(page, 'live foreign draft'); await page.evaluate(() => {window.liveA=active; addPane("A")});
    await page.waitForFunction(() => active.conn?.terminal?.isOpen());
    await page.locator('.pane.active .xterm-helper-textarea').evaluate(e => (e as HTMLElement).focus());
    await page.keyboard.press('Control+c'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (window.liveA.inputLease.dirty)), true);
    assert.equal(await page.evaluate(() => (active.inputLease.inputDirty)), true, 'live foreign dirty state must remain blocking');
  });
});

test('forty clean closed views remove their observations and clean context disposal empties scopes', async () => {
  await harness(async page => {
    await page.evaluate(() => {window.observedScope=[...humanInputScopes.values()][0];window.scopeReads=0;
      const observe=window.observedScope.observe.bind(window.observedScope);
      window.observedScope.observe=read=>observe(()=>{window.scopeReads++;return read();});});
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => (window.cleanA=addPane("A")));
      await page.waitForFunction(() => (window as any).cleanA.conn?.terminal?.isOpen());
      await page.evaluate(() => (closePane(window.cleanA)));
    }
    await page.evaluate(() => {window.scopeReads=0;window.observedScope.dirty;});
    assert.equal(await page.evaluate(() => (window.scopeReads <= 1)), true, 'clean disposed view observations must not accumulate');
    await page.evaluate(() => ((async()=>{const ui=await localMesh;ui.dispose();window.scopeReads=0;window.observedScope.dirty;})()));
    assert.equal(await page.evaluate(() => (window.scopeReads)), 0);
    assert.equal(await page.evaluate(() => (humanInputScopes.size)), 0);
    assert.equal(await page.evaluate(() => (localTerminalHandles.size)), 0);
  });
});
