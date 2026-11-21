// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, open, closeCompose, record, dataFrames} from './dictation-browser-fixture.ts';

declare const dictation: any;
declare function composeDictationSession(): any;

for (const ackFirst of [true, false]) test(`actual request lookup 404 ${ackFirst ? 'after' : 'before'} POST acknowledgement preserves cancellation`, async () => {
  await harness(async (page, api, _sockets, writes) => {
    const held: {post?: () => Promise<void>; lookup?: () => Promise<void>} = {};
    await page.route('**/api/transcribe', route => {held.post = () => route.continue();});
    await page.route('**/api/transcribe/request/*', async route => {
      const response = await route.fetch(); assert.equal(response.status(), 404, 'lookup genuinely precedes admission');
      held.lookup = () => route.fulfill({response});
    });
    await record(page); await closeCompose(page);
    for (let i = 0; !held.post && i < 200; i++) await page.waitForTimeout(10); assert.ok(held.post);
    await page.getByRole('button', {name: 'Abandonner la dictée', exact: true}).click();
    for (let i = 0; !held.lookup && i < 200; i++) await page.waitForTimeout(10); assert.ok(held.lookup);
    if (!ackFirst) {await held.lookup!(); await page.waitForFunction(() => !dictation.session('A', 1).reconciling);}
    await held.post!();
    for (let i = 0; !api.jobs.length && i < 200; i++) await page.waitForTimeout(10); assert.equal(api.jobs.length, 1);
    api.ack('A');
    if (ackFirst) {
      await page.waitForFunction(() => dictation.session('A', 1).job !== null && dictation.session('A', 1).discard);
      await held.lookup!();
    }
    await page.waitForFunction(() => dictation.session('A', 1).state === 'idle');
    assert.equal(api.jobs[0]!.state, 'cancelled', 'an obsolete lookup 404 cannot erase the confirmed cancel latch');
    assert.ok(api.seen.some(path => path.endsWith('/cancel')));
    assert.equal(api.uploads.length, 1); assert.equal(dataFrames(writes).length, 0);
  });
});

test('a held positive lookup cannot downgrade a newer authoritative POST acknowledgement', async () => {
  await harness(async (page, api, _sockets, writes) => {
    const held: {lookup?: () => Promise<void>} = {};
    await page.route('**/api/transcribe/request/*', async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      held.lookup = () => route.fulfill({response});
    });
    await record(page);
    for (let i = 0; !api.jobs.length && i < 200; i++) await page.waitForTimeout(10);
    await page.evaluate(() => (void dictation.reconcile(composeDictationSession())));
    for (let i = 0; !held.lookup && i < 200; i++) await page.waitForTimeout(10); assert.ok(held.lookup);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'newer authoritative text'; api.ack('A');
    await page.waitForFunction(() => composeDictationSession().state === 'ready');
    await held.lookup!(); await page.waitForFunction(() => !composeDictationSession().reconciling);
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'ready', 'obsolete positive lookup cannot replace the newer job state');
    assert.equal(await page.locator('#compose-text').inputValue(), 'newer authoritative text');
    assert.equal(api.uploads.length, 1); assert.equal(dataFrames(writes).length, 0);
  });
});

test('explicit discard before real stopped capture begins POST prevents the deferred POST entirely', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'recording'); await page.waitForTimeout(350);
    await page.evaluate(() => {const recorder=dictation.capture.recorder,done=recorder.onstop;recorder.onstop=e=>{window.finalizeCapture=()=>done(e)}});
    await page.keyboard.up('Space'); await page.waitForFunction(() => typeof (window as any).finalizeCapture === 'function');
    await closeCompose(page); await page.getByRole('button', {name: 'Abandonner la dictée', exact: true}).click();
    await page.evaluate(() => (window.finalizeCapture())); await page.waitForTimeout(150);
    assert.equal(api.uploads.length, 0, 'a locally cancelled not-yet-started POST must never start later');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'idle');
    assert.equal(dataFrames(writes).length, 0);
  });
});

test('request lookup can supersede a held POST response without a stale queued reply undoing ready/submitted', async () => {
  await harness(async (page, api, _sockets, writes) => {
    const held: {release?: () => Promise<void>} = {};
    await page.route('**/api/transcribe', async route => {
      const response = await route.fetch({timeout: 7000}); held.release = () => route.fulfill({response});
    });
    await record(page);
    for (let i = 0; !api.jobs.length && i < 200; i++) await page.waitForTimeout(10);
    api.ack('A'); for (let i = 0; !held.release && i < 200; i++) await page.waitForTimeout(10);
    assert.ok(held.release);
    api.jobs[0]!.state = 'ready'; api.jobs[0]!.text = 'recovered';
    await page.evaluate(() => (dictation.reconcile(composeDictationSession())));
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'ready');
    assert.equal(await page.evaluate(() => (composeDictationSession().busy)), false);
    await page.locator('#compose-send').click(); await page.waitForFunction(() => composeDictationSession().state === 'idle');
    await held.release!(); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'idle');
    assert.equal(api.jobs[0]!.outcome, 'submitted'); assert.equal(dataFrames(writes).length, 2); assert.equal(api.uploads.length, 1);
  });
});

for (const successor of ['recording', 'uploading']) for (const failure of [false, true]) test(`retired admission late ${failure ? 'failure' : 'success'} cannot mutate successor ${successor}/draft/busy ownership`, async () => {
  await harness(async (page, api, _sockets, writes) => {
    const held: {release?: () => Promise<void>} = {};
    let posts = 0;
    await page.route('**/api/transcribe', async route => {
      if (posts++ > 0) {await route.continue(); return;}
      const response = await route.fetch({timeout: 7000});
      held.release = () => failure ? route.fulfill({status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"Lost ack"}}'}) : route.fulfill({response});
    });
    await record(page); await closeCompose(page);
    for (let i = 0; !api.jobs.length && i < 200; i++) await page.waitForTimeout(10);
    api.ack('A'); for (let i = 0; !held.release && i < 200; i++) await page.waitForTimeout(10);
    assert.ok(held.release, 'actual POST response must be held');
    await page.getByRole('button', {name: 'Abandonner la dictée', exact: true}).click();
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'idle', 'discard must retire a recovered job before the held POST response');
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.evaluate(() => {ctext.value="successor draft";composeOwner.change();syncDictationDraft()});
    if (successor === 'uploading') {
      await page.waitForTimeout(350); await page.keyboard.up('Space');
      for (let i = 0; api.uploads.length < 2 && i < 200; i++) await page.waitForTimeout(10);
      assert.equal(api.uploads.length, 2); assert.equal(await page.evaluate(() => (composeDictationSession().busy)), true);
    }
    await held.release!(); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), successor, 'retired POST completion must not change successor state');
    assert.equal(await page.locator('#compose-text').inputValue(), 'successor draft');
    assert.equal(await page.evaluate(() => (composeDictationSession().busy)), successor === 'uploading', 'old finally cannot release successor IO');
    assert.equal(api.uploads.length, successor === 'uploading' ? 2 : 1); assert.equal(dataFrames(writes).length, 0);
    await page.evaluate(() => (dictation.dispose())); await page.keyboard.up('Space');
  });
});
