// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, open, dataFrames} from './dictation-browser-fixture.ts';

declare function composeDictationSession(): any;

for (const key of ['Space', 'Enter']) test(`${key} hold then Tab/release cancels recording and tracks without admission`, async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down(key);
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.keyboard.press('Tab'); await page.keyboard.up(key); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window.micStreams.some(s=>s.getTracks().some(t=>t.readyState === "live")))), false,
      'keyboard focus loss must stop live microphone tracks');
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'idle');
    assert.equal(api.uploads.length, 0); assert.equal(dataFrames(writes).length, 0);
  });
});

for (const [owner, second] of [['Space', 'Enter'], ['Enter', 'Space']]) test(`overlapping ${owner}/${second} preserves the first release owner`, async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down(owner!);
    await page.waitForFunction(() => composeDictationSession().state === 'recording'); await page.waitForTimeout(350);
    await page.keyboard.down(second!); await page.keyboard.up(second!);
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'recording', 'blocked second key cannot release the first owner');
    assert.equal(api.uploads.length, 0); await page.keyboard.up(owner!);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window.micStreams.some(s=>s.getTracks().some(t=>t.readyState === "live")))), false,
      'owning release must stop tracks even after a blocked second activation');
    assert.notEqual(await page.evaluate(() => (composeDictationSession().state)), 'recording');
    for (let i = 0; !api.uploads.length && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(api.uploads.length, 1); assert.equal(await page.evaluate(() => (window.micCalls)), 1);
    assert.equal(dataFrames(writes).length, 0);
  });
});

for (const key of ['Space', 'Enter']) test(`cancelled ${key} keyup cannot cancel a new pointer capture`, async () => {
  await harness(async (page, api, _sockets, writes) => {
    await open(page); await page.locator('#compose-mic').focus(); await page.keyboard.down(key);
    await page.waitForFunction(() => composeDictationSession().state === 'recording'); await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'idle', 'Tab must first cancel only the keyboard owner');
    const b = (await page.locator('#compose-mic').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.waitForFunction(() => composeDictationSession().state === 'recording');
    await page.keyboard.up(key); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (composeDictationSession().state)), 'recording', 'stale keyup must not own newer pointer capture');
    await page.waitForTimeout(250); await page.mouse.up();
    for (let i = 0; !api.uploads.length && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(api.uploads.length, 1); assert.equal(dataFrames(writes).length, 0);
  });
});
