// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test, harness, record, ready, closeCompose, select, open, typeNative, holdEnter, runEnter, wire} from './dictation-browser-fixture.ts';

for (const replacement of [false, true]) test(`native prefix during HTTP preflight refuses voice on ${replacement ? 'replacement A' : 'original A'}`, async () => {
  await harness(async (page, api, sockets, writes) => {
    await record(page); await ready(page, api);
    if (replacement) {
      await closeCompose(page); await select(page, 'B'); await select(page, 'C'); await select(page, 'A'); await open(page);
    }
    api.holdRead(); await page.locator('#compose-send').click();
    for (let i = 0; !api.readHeld && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(api.readHeld, true, 'manual Send must reach async preflight');
    await closeCompose(page); await typeNative(page, 'human-prefix ');
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), true);
    api.releaseRead(); await page.waitForTimeout(200);
    const original = wire(writes, 'A:0').join('');
    assert.equal(original, replacement ? '' : 'human-prefix ', 'foreign native input must invalidate all voice frames');
    if (replacement) assert.equal(wire(writes, `A:${sockets.get('A')!.length - 1}`).join(''), 'human-prefix ',
      'the replacement connection must receive only the human prefix');
    assert.equal(api.jobs[0]!.outcome, null, 'invalidated voice cannot settle submitted');
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), true, 'must preserve human dirty state');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).text)), 'alpha\nbeta');
    assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'recovery');
    assert.equal(api.uploads.length, 1);
  });
});

for (const replacement of [false, true]) test(`native suffix suppresses delayed Enter on ${replacement ? 'replacement A' : 'original A'}`, async () => {
  await harness(async (page, api, sockets, writes) => {
    await record(page); await ready(page, api);
    if (replacement) {
      await closeCompose(page); await select(page, 'B'); await select(page, 'C'); await select(page, 'A'); await open(page);
    }
    await holdEnter(page); await page.locator('#compose-send').click();
    await page.waitForFunction(() => (window as any).voiceEnter.length === 1); await closeCompose(page);
    await typeNative(page, 'suffix'); await runEnter(page); await page.waitForTimeout(100);
    assert.deepEqual(wire(writes, 'A:0'), replacement ? ['alpha\rbeta'] : ['alpha\rbeta', ...'suffix'], 'foreign native input must suppress Enter');
    if (replacement) assert.equal(wire(writes, `A:${sockets.get('A')!.length - 1}`).join(''), 'suffix',
      'the replacement connection must receive only the human suffix');
    assert.equal(api.jobs[0]!.outcome, null);
    assert.equal(await page.evaluate(() => (active.inputLease.dirty)), true);
    assert.equal(await page.evaluate(() => (dictation.session("A",1).state)), 'recovery');
    await page.evaluate(() => (dictation.reconcile(dictation.session("A",1))));
    assert.equal(wire(writes, 'A:0').at(-1) === '\r', false, 'recovery must not replay input');
  });
});
