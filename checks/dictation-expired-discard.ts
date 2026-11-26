// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, record, ready, dataFrames} from './dictation-browser-fixture.ts';

declare function composeDictationSession(): any;

test('explicit discard retires known missing job/resources, preserving draft unless explicitly cleared', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api); api.missing = true;
    await page.locator('#compose-send').click(); await page.waitForFunction(() => composeDictationSession().state === 'recovery');
    await page.evaluate(() => (dictation.discard(composeDictationSession()))); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (composeDictationSession().requestId)), null, 'explicit discard must retire a known missing job');
    assert.equal(await page.evaluate(() => (composeDictationSession().text)), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => (composeDictationSession().timer)), null);
    assert.equal(await page.evaluate(() => (composeDictationSession().channelTimer)), null);
    const jobRequests = () => api.seen.filter(path => path.startsWith(`/api/transcribe/${api.jobs[0]!.job_id}`)).length;
    const requests = jobRequests(); await page.waitForTimeout(1100); assert.equal(jobRequests(), requests, 'known absence must not poll forever');
    await page.locator('#compose-text').fill(''); api.missing = false;
    await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.keyboard.press('Escape'); await page.keyboard.up('Space');
    assert.equal(dataFrames(writes).length, 0); assert.equal(api.uploads.length, 1);
  });
});

test('unknown admission lookup 404 keeps same-id cancel latch, never re-POSTs', async () => {
  await harness(async (page, api, _sockets, writes) => {
    api.lose(); api.missing = true; await record(page);
    await page.waitForFunction(() => composeDictationSession().state === 'recovery');
    const id = await page.evaluate(() => (composeDictationSession().requestId));
    await page.evaluate(() => (dictation.discard(composeDictationSession()))); await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => (composeDictationSession().requestId)), id);
    assert.equal(await page.evaluate(() => (composeDictationSession().discard)), true);
    assert.equal(await page.evaluate(() => (composeDictationSession().job)), null);
    assert.equal(api.uploads.length, 1); assert.equal(dataFrames(writes).length, 0);
    api.missing = false; await page.evaluate(() => (dictation.reconcile(composeDictationSession())));
    await page.waitForFunction(() => composeDictationSession().state === 'idle');
  });
});

test('lost settle acknowledgement followed by tombstone expiry can be explicitly retired without replay', async () => {
  await harness(async (page, api, _sockets, writes) => {
    await record(page); await ready(page, api); api.loseSettle = true;
    await page.locator('#compose-send').click(); await page.waitForFunction(() => composeDictationSession().outcome === 'submitted' && !composeDictationSession().busy);
    const frames = dataFrames(writes).length; assert.equal(frames, 2); api.missing = true;
    await page.evaluate(() => (dictation.reconcile(composeDictationSession())));
    const jobRequests = () => api.seen.filter(path => path.startsWith(`/api/transcribe/${api.jobs[0]!.job_id}`)).length;
    const requests = jobRequests(); await page.waitForTimeout(1200);
    assert.equal(jobRequests(), requests, 'known missing settlement must stop automatic retries');
    await page.evaluate(() => (dictation.discard(composeDictationSession()))); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (composeDictationSession().requestId)), null);
    assert.equal(dataFrames(writes).length, frames); assert.equal(api.uploads.length, 1);
  });
});
