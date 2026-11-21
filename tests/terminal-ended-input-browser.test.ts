// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';
declare const active: any, linePending: any, lineRecovery: any;
declare function sendLine(): Promise<void>;

test('ended replay delivery settles into original-target recovery until explicit discard', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await page.evaluate(async () => {
      active.conn.replayPending = true;
      (document.querySelector('#line-text') as HTMLTextAreaElement).value = 'fictional recovery text';
      await sendLine();
    });
    assert.equal(await page.evaluate(() => !!linePending?.operation && active.conn.queuedHumanInput.length === 1), true);
    api.inventory.mesh = api.inventory.mesh.filter(s => s.name !== 'A');
    api.inventory.management.state = 'unavailable';
    await page.evaluate(() => active.conn.ws.close());
    await page.waitForFunction(() => active.conn?.ended === true);
    assert.deepEqual(await page.evaluate(() => ({pending: linePending, text: lineRecovery?.text,
      id: lineRecovery?.target.id, created: lineRecovery?.target.created, kind: lineRecovery?.result.kind,
      frames: lineRecovery?.result.frames, wireBytes: lineRecovery?.result.wireBytes,
      queued: active.conn.queuedHumanInput.length, dirty: active.inputLease.inputDirty})),
      {pending: null, text: 'fictional recovery text', id: 'A', created: 1, kind: 'refused', frames: 0, wireBytes: 0, queued: 0, dirty: false});
    assert.equal(await page.locator('#line-text').getAttribute('readonly'), '', 'recovery is intentionally read-only');
    assert.deepEqual([...writes.values()].flat().filter(v => typeof v !== 'string'), []);
    await page.evaluate(() => active.show('B'));
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen() && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    assert.deepEqual(await page.evaluate(() => [lineRecovery.target.id, lineRecovery.target.created, lineRecovery.text]), ['A', 1, 'fictional recovery text']);
    assert.equal(await page.locator('#line-text').inputValue(), 'fictional recovery text');
    await page.getByRole('button', {name: 'Discard this result', exact: true}).click();
    assert.equal(await page.evaluate(() => !linePending && !lineRecovery && !(document.querySelector('#line-text') as HTMLTextAreaElement).readOnly), true);
    await page.locator('#line-text').fill('fresh edit');
    assert.equal(await page.locator('#line-text').inputValue(), 'fresh edit');
    assert.deepEqual([...writes.values()].flat().filter(v => typeof v !== 'string'), [], 'neither recovery nor new field edits redirect into B');
  }, false, 'en', {rows: 24, cols: 80}, {hasTouch: true, isMobile: true, viewport: {width: 390, height: 844}});
});
