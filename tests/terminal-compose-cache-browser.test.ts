// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test, harness} from '../checks/dictation-browser-fixture.ts';

declare const active: any, ctext: HTMLTextAreaElement, cdlg: HTMLDialogElement;
declare const composeOwner: any, composeRecovery: any[];
declare function openCompose(text: string): boolean;
declare function setActive(pane: any): void;
const en = JSON.parse(fs.readFileSync('static/i18n/en.json', 'utf8'));

test('a cached unsent composer draft remains reviewable without retaining its old delivery binding', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    assert.equal(await page.evaluate(() => openCompose('draft sample')), true);
    await page.evaluate(() => {
      (window as any).originalComposeBinding = composeOwner.binding;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    });
    const saved = await page.evaluate(() => ({owner: composeOwner, open: cdlg.open,
      recovery: composeRecovery.map(record => ({text: record.text, name: record.target.name,
        created: record.target.created, keys: Object.keys(record).sort(), result: record.result}))}));
    assert.equal(saved.owner, null); assert.equal(saved.open, false);
    assert.equal(saved.recovery.length, 1);
    assert.equal(saved.recovery[0].text, 'draft sample');
    assert.equal(saved.recovery[0].name, 'A'); assert.equal(saved.recovery[0].created, 1);
    assert.deepEqual(saved.recovery[0].keys, ['result', 'target', 'text']);
    assert.equal(saved.recovery[0].result.kind, 'refused');
    assert.equal(saved.recovery[0].result.frames, 0); assert.equal(saved.recovery[0].result.wireBytes, 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    await page.waitForFunction(() => active.conn?.terminal?.isOpen() && !active.conn.replayPending
      && !active.conn.replaying && !active.conn.draining);
    assert.equal(await page.evaluate(() => composeRecovery[0].text), 'draft sample');
    assert.equal([...writes.values()].flat().filter(frame => typeof frame !== 'string').length, 0);
    await page.evaluate(() => {active.show('B'); setActive(active);});
    await page.waitForFunction(() => active.id === 'B' && active.conn?.terminal?.isOpen()
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    page.once('dialog', dialog => {void dialog.accept();});
    await page.getByRole('button', {name: en['compose.recovery.newDraft'], exact: true}).click();
    assert.deepEqual(await page.evaluate(() => ({text: ctext.value, open: cdlg.open,
      recovery: composeRecovery.length, target: composeOwner.target.name,
      reused: composeOwner.binding === (window as any).originalComposeBinding})),
    {text: 'draft sample', open: true, recovery: 0, target: 'B', reused: false});
  }, false, 'en');
});

test('suspending a recovered composer transfers its edited draft exactly once', async () => {
  await harness(async (page) => {
    assert.equal(await page.evaluate(() => openCompose('recovered draft')), true);
    const saved = await page.evaluate(() => {
      active.recoveredComposeDraft = {name: active.conn.name, created: active.conn.created, text: ctext.value};
      active.recoveredComposeOwner = composeOwner;
      ctext.value = 'edited recovered draft';
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      return {
        drafts: composeRecovery.map(record => record.text),
        paneDraft: active.recoveredComposeDraft,
        paneOwner: active.recoveredComposeOwner,
      };
    });
    assert.deepEqual(saved, {drafts: ['edited recovered draft'], paneDraft: null, paneOwner: null});
  }, false, 'en');
});
