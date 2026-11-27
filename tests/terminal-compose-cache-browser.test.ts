// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {test, harness, type Writes} from '../checks/dictation-browser-fixture.ts';

declare const active: any, ctext: HTMLTextAreaElement, cdlg: HTMLDialogElement;
declare const composeOwner: any, composeRecovery: any[];
declare let recoveredLineTarget: any;
declare const paneInput: any, line: HTMLTextAreaElement;
declare function openCompose(text: string): boolean;
declare function setActive(pane: any): void;
declare function sendCompose(submit: boolean): void;
declare function sendLine(): Promise<void>;
declare function saveRecoveredLine(): void;
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
      const entry = {};
      active.recoveredComposeDraft = {name: active.conn.name, created: active.conn.created, text: ctext.value, entry};
      active.recoveredComposeOwner = composeOwner;
      ctext.value = 'edited recovered draft';
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      return {
        drafts: composeRecovery.map(record => record.text),
        retainsEntry: composeRecovery[0].entry === entry,
        paneDraft: active.recoveredComposeDraft,
        paneOwner: active.recoveredComposeOwner,
      };
    });
    assert.deepEqual(saved, {drafts: ['edited recovered draft'], retainsEntry: true, paneDraft: null, paneOwner: null});
  }, false, 'en');
});

for (const editor of ['composer', 'line', 'line after leaving the pane'] as const) {
  test(`discarding a refused recovered ${editor} releases its original lease`, async () => {
    await harness(async (page) => {
      await page.evaluate(async editor => {
        const text = 'recovered draft';
        const {name, created} = active.conn;
        const entry = {
          input: {pendingBytes: 0, incompleteHumanInput: false},
          lease: {release() { (window as any).__draftReleased = true; }},
        };
        active.inputAcks.set(name + '\0' + created, entry);
        paneInput.deliver = (_binding: unknown, _text: string, _enter: boolean, done: Function) => {
          done({kind: 'refused', frames: 0, wireBytes: 0});
          return {cancel() {}};
        };
        if (editor === 'composer') {
          if (!openCompose(text)) throw new Error('composer unavailable');
          active.recoveredComposeDraft = {name, created, text, entry};
          active.recoveredComposeOwner = composeOwner;
          sendCompose(true);
        } else {
          recoveredLineTarget = {pane: active, name, created, entry};
          line.value = text;
          await sendLine();
          if (editor === 'line after leaving the pane') saveRecoveredLine();
        }
      }, editor);
      await page.getByRole('button', {name: en['compose.discardResult'], exact: true}).click();
      assert.equal(await page.evaluate(() => (window as any).__draftReleased), true);
    }, false, 'en');
  });
}

async function assertOriginalLeaseReleased(writes: Writes, from: number): Promise<void> {
  const deadline = Date.now() + 3000;
  do {
    const controls = (writes.get('A:0') ?? []).slice(from).flatMap(frame => {
      if (typeof frame !== 'string') return [];
      const message = JSON.parse(frame);
      return message.t === 'h' ? [message] : [];
    });
    const hold = controls.findIndex(frame => frame.dirty === true);
    if (hold !== -1 && controls.slice(hold + 1).some(frame =>
      frame.dirty === false && frame.client_id === controls[hold].client_id
      && frame.slot === controls[hold].slot && frame.generation === controls[hold].generation)) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail('expected a hold and release for the same lease on the original socket');
}

test('switching sessions releases a refused recovered line on its original transport', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    const from = writes.get('A:0')?.length ?? 0;
    const dirtyAfterSwitch = await page.evaluate(async () => {
      const pane = active;
      const {name, created} = pane.conn;
      const lease = pane.inputLease;
      const entry = {input: {pendingBytes: 0, incompleteHumanInput: false}, lease};
      pane.inputAcks.set(name + '\0' + created, entry);
      recoveredLineTarget = {pane, name, created, entry};
      line.value = 'recovered draft';
      paneInput.deliver = (_binding: unknown, _text: string, _enter: boolean, done: Function) => {
        done({kind: 'refused', frames: 0, wireBytes: 0});
        return {cancel() {}};
      };
      await sendLine();
      lease.hold();
      if (!lease.dirty) throw new Error('original lease was not held');
      pane.show('B');
      return lease.dirty;
    });
    assert.equal(dirtyAfterSwitch, false);
    await assertOriginalLeaseReleased(writes, from);
    await page.getByRole('button', {name: en['compose.discardResult'], exact: true}).click();
  }, false, 'en');
});

test('caching the page keeps the recovered composer text and releases its original lease', async () => {
  await harness(async (page, _api, _sockets, writes) => {
    const from = writes.get('A:0')?.length ?? 0;
    const state = await page.evaluate(() => {
      const pane = active;
      const {name, created} = pane.conn;
      const lease = pane.inputLease;
      if (!openCompose('recovered draft')) throw new Error('composer unavailable');
      const entry = {input: {pendingBytes: 0, incompleteHumanInput: false}, lease};
      pane.inputAcks.set(name + '\0' + created, entry);
      pane.recoveredComposeDraft = {name, created, text: ctext.value, entry};
      pane.recoveredComposeOwner = composeOwner;
      lease.hold();
      if (!lease.dirty) throw new Error('original lease was not held');
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      return {dirty: lease.dirty, text: composeRecovery[0]?.text};
    });
    assert.deepEqual(state, {dirty: false, text: 'recovered draft'});
    await assertOriginalLeaseReleased(writes, from);
  }, false, 'en');
});
