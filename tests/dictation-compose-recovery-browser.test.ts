// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: actual-page fake-device tests, discovered by browser shards.

import assert from 'node:assert/strict';
import {test, harness, record, ready, wire, open, select, closeCompose} from '../checks/dictation-browser-fixture.ts';

declare function composeDictationSession(): any;
declare const active: any, composeRecovery: any[], dictation: any;

test('an empty ready draft can be explicitly discarded inside the composer before recording again', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    await page.locator('#compose-text').fill('');
    assert.equal(await page.locator('#compose-mic').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#compose-send').isDisabled(), true);
    assert.match(await page.locator('#dictation-status').innerText(), /brouillon vide/i);
    await page.locator('#dictation-discard').click();
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
    assert.equal(api.jobs[0].state, 'cancelled');
    assert.equal(await page.locator('#dlg-compose').evaluate(dialog => (dialog as HTMLDialogElement).open), true);
    assert.equal(await page.locator('#compose-mic').getAttribute('aria-disabled'), 'false');
    await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.waitForTimeout(350);
    await page.keyboard.up('Space');
    for (let i = 0; api.uploads.length < 2 && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.uploads.length, 2, 'the second recording must reach admission with usable audio');
    assert.notEqual(api.uploads[1]!.headers['x-mesh-request-id'], api.uploads[0]!.headers['x-mesh-request-id']);
    api.ack('A');
    await page.waitForFunction(() => composeDictationSession().state === 'queued');
    assert.deepEqual(wire(writes, 'A:0'), [], 'discard/re-record must not submit terminal input');
  });
});

test('discarding a ready dictation in the composer preserves an edited nonempty draft', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    await page.locator('#compose-text').fill('keep this edited draft');
    await page.locator('#dictation-discard').click();
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
    assert.equal(await page.locator('#compose-text').inputValue(), 'keep this edited draft');
    assert.equal(await page.locator('#compose-mic').getAttribute('aria-disabled'), 'true');
    assert.equal(api.jobs[0].state, 'cancelled');
    assert.deepEqual(wire(writes, 'A:0'), []);
  });
});

test('microphone permission failure can be dismissed inside the composer without reloading', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await open(page);
    await page.locator('#compose-mic[aria-disabled="false"]').waitFor({state: 'visible'});
    await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'error');
    await page.keyboard.up('Space');
    await page.locator('#dictation-discard').click();
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
    assert.equal(await page.locator('#dictation-discard').isDisabled(), true);
    assert.equal(await page.locator('#compose-mic').getAttribute('aria-disabled'), 'false');
    assert.deepEqual(wire(writes, 'A:0'), []);
  });
});

test('unconfirmed discard keeps capture blocked and never repeats the audio admission', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api);
    await page.locator('#compose-text').fill('');
    let failedCancels = 0;
    await page.route('**/api/transcribe/*/cancel', async route => {
      await route.fulfill({status: 503, json: {error: {code: 'unavailable'}}}); failedCancels++;
    });
    await page.locator('#dictation-discard').click();
    await page.waitForFunction(() => composeDictationSession().state === 'recovery');
    for (let i = 0; failedCancels === 0 && i < 500; i++) await page.waitForTimeout(10);
    assert.ok(failedCancels > 0, 'a real cancellation response must fail before the route recovers');
    assert.equal(await page.locator('#dictation-discard').isDisabled(), true);
    assert.equal(await page.locator('#compose-mic').getAttribute('aria-disabled'), 'true');
    await page.locator('#compose-mic').focus(); await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => (window as any).micCalls), 1);
    assert.equal(api.uploads.length, 1);
    assert.deepEqual(wire(writes, 'A:0'), []);
    await page.unroute('**/api/transcribe/*/cancel');
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
    assert.equal(await page.locator('#compose-mic').getAttribute('aria-disabled'), 'false');
    assert.equal(api.jobs[0]!.state, 'cancelled', 'cleanup must reach the fake remote job after 503 is removed');
    assert.equal(api.uploads.length, 1, 'cleanup never readmits the audio');
  });
});

for (const destination of ['cancel', 'replace', 'empty']) test(`recovery transfer ${destination} preserves drafts until explicit replacement consent`, async () => {
  await harness(async (page, _api, _sockets, writes) => {
    await select(page, 'B'); await open(page);
    if (destination !== 'empty') await page.locator('#compose-text').fill('keep B draft');
    await closeCompose(page); await select(page, 'A'); await open(page);
    await page.locator('#compose-text').fill('recover A');
    await page.evaluate(() => {active.term.paste = () => {throw Error('test-owned paste failure');};});
    await page.locator('#compose-send').click();
    await page.waitForFunction(() => composeRecovery.length === 1);
    await select(page, 'B');
    const dialogs: string[] = [];
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message());
      if (dialogs.length === 2 && destination === 'cancel') await dialog.dismiss(); else await dialog.accept();
    });
    await page.getByRole('button', {name: 'Create a new draft (risk of duplicate)…', exact: true}).click();
    if (destination === 'cancel') {
      assert.equal(dialogs.length, 2, 'nonempty destination requires a separate replacement decision');
      assert.match(dialogs[1]!, /replace.*nonempty.*draft/i);
      assert.deepEqual(await page.evaluate(() => composeRecovery.map(record => record.text)), ['recover A']);
      assert.equal(await page.evaluate(() => dictation.session('B', 2).text), 'keep B draft');
      assert.equal(await page.locator('#dlg-compose').evaluate(dialog => (dialog as HTMLDialogElement).open), false);
    } else {
      assert.equal(dialogs.length, destination === 'empty' ? 1 : 2);
      assert.equal(await page.locator('#compose-text').inputValue(), 'recover A');
      assert.equal(await page.evaluate(() => composeRecovery.length), 0);
    }
    assert.deepEqual(wire(writes, 'A:0'), []); assert.deepEqual(wire(writes, 'B:0'), []);
  }, false, 'en');
});
