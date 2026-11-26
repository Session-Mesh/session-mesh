// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {TerminalMesh, skip, withoutSince} from './terminal-browser-lib.ts';

declare const find: (name: string) => {created: number; provisional: boolean; pty_capabilities: string[]};
declare const syncPanesWithListing: (observed: boolean) => void;
declare const addPane: () => void;
declare const closePane: (pane: unknown) => void;
declare const setActive: (pane: unknown) => void;
declare const panes: unknown[];
declare const active: {
  conn: {ws: WebSocket & {announce: (cap?: object) => void; receipt: (ack: object) => void}} | null;
  inputAck: {state: string; pendingBytes: number; binding: {slot: number; generation: number} | null};
  inputLease: {dirty: boolean};
  send: (text: string) => void;
  el: HTMLElement;
};
declare global {
  // eslint-disable-next-line no-var
  var __v2Sockets: {url: string; announce(cap?: object): void; receipt(ack: object): void; close(): void}[];
  // Number of upcoming upgrades refused before the socket opens.
  var __v2FailBeforeOpen: number;
  // eslint-disable-next-line no-var
  var __v2Frames: {url: string; kind: 'binary' | 'control'; data: string | number[]}[];
}

const mesh = new TerminalMesh({EIO_BACKEND: 'posix'});
const viewport = {width: 1200, height: 720};
const installFakeBridge = () => {
  window.__v2Sockets = [];
  window.__v2Frames = [];
  window.__v2FailBeforeOpen = 0;
  const RealSocket = WebSocket;
  class BridgeSocket {
    static OPEN = RealSocket.OPEN;
    static CLOSED = RealSocket.CLOSED;
    url: string;
    readyState = 0;
    binaryType = 'blob';
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      window.__v2Sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        if (window.__v2FailBeforeOpen > 0) {
          window.__v2FailBeforeOpen--;
          this.close();
          return;
        }
        this.readyState = RealSocket.OPEN;
        this.onopen?.(new Event('open'));
      }, 0);
    }
    announce(cap: object = {t: 'input_capability', version: 2, supported: true,
      created: Number(new URL(this.url).searchParams.get('input_ack_created')), slot: 4, generation: 17,
      actor_nonce: '0123456789abcdef0123456789abcdef'}) {
      this.onmessage?.(new MessageEvent('message', {data: JSON.stringify(cap)}));
      if (this.readyState === RealSocket.OPEN) {
        const created = Number(new URL(this.url).searchParams.get('created'));
        const name = decodeURIComponent(new URL(this.url).pathname.split('/').at(-1)!);
        this.onmessage?.(new MessageEvent('message', {data: JSON.stringify({t: 'bound', name, created})}));
        this.onmessage?.(new MessageEvent('message', {data: new Uint8Array().buffer}));
      }
    }
    receipt(ack: object) {
      this.onmessage?.(new MessageEvent('message', {data: JSON.stringify({t: 'input_ack',
        version: 2, ...ack})}));
    }
    send(data: string | Uint8Array) {
      window.__v2Frames.push({url: this.url, kind: typeof data === 'string' ? 'control' : 'binary',
        data: typeof data === 'string' ? data : [...data]});
    }
    close() {
      if (this.readyState === RealSocket.CLOSED) return;
      this.readyState = RealSocket.CLOSED;
      this.onclose?.(new CloseEvent('close'));
    }
  }
  // The page's other sockets still use the real implementation.
  window.WebSocket = class extends BridgeSocket {
    constructor(url: string) {
      if (!url.includes('/ws/')) return new RealSocket(url) as unknown as InstanceType<typeof BridgeSocket>;
      super(url);
    }
  } as unknown as typeof WebSocket;
};

describe('v2 ACK browser binding against a fake bridge and real Chromium', {skip}, () => {
  before(async () => { await mesh.start(); await mesh.newShell('v2-terminal'); });
  after(() => mesh.stop());
  const open = (phone = false) => mesh.signIn(phone ? {width: 390, height: 780} : viewport, installFakeBridge, undefined, {phone, routes: async page => {
    await page.route('**/api/sessions*', async route => {
      try {
        const response = await route.fetch({url: withoutSince(route.request().url())});
        const listing = await response.json() as {mesh: {name: string; pty_capabilities?: string[]}[]};
        for (const row of listing.mesh) if (row.name === 'v2-terminal')
          row.pty_capabilities = ['acknowledged_input_v1', 'acknowledged_input_v2'];
        await route.fulfill({response, json: listing});
      } catch { /* Closing the isolated page cancels a concurrent refresh. */ }
    });
  }});

  test('v2 wins, gates I/H before capability, resumes exact binding and requires review for uncertain input', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    const first = await page.evaluate(() => window.__v2Sockets.at(-1)!.url);
    assert.match(first, /input_ack=2&input_ack_mode=new&input_ack_created=/);
    assert.doesNotMatch(first, /input_ack_(?:slot|generation|id)=/);
    await page.evaluate(() => active.send('RETAINED-BEFORE-CAP'));
    assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), 19);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), false,
      'unadmitted v2 bytes are not an already-sent dirty draft');
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'binary' || JSON.parse(f.data as string).t === 'h')), []);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.waitForFunction(() => active.inputAck?.binding?.generation === 17);
    assert.equal(await page.evaluate(() => active.inputAck?.state), 'review');
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'control' && JSON.parse(f.data as string).t === 'h').map(f => JSON.parse(f.data as string))),
    [{t: 'h', slot: 4, generation: 17, dirty: false}]);
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary')), []);
    await page.locator('.p-input-retry').click();
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'control' && JSON.parse(f.data as string).t === 'h').map(f => JSON.parse(f.data as string))),
    [{t: 'h', slot: 4, generation: 17, dirty: false},
      {t: 'h', slot: 4, generation: 17, dirty: true}]);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.close());
    await page.waitForFunction(() => window.__v2Sockets.length >= 2);
    const resumed = await page.evaluate(() => window.__v2Sockets.at(-1)!.url);
    assert.match(resumed, /input_ack=2&input_ack_mode=resume&input_ack_created=.*&input_ack_slot=4&input_ack_generation=17&input_ack_nonce=0123456789abcdef0123456789abcdef/);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    assert.equal(await page.evaluate(() => active.inputAck?.state), 'uncertain');
    await page.evaluate(() => window.__v2Sockets.at(-1)!.receipt({
      input_ack: true, seq: 1, created: active.conn!.ws.url &&
        Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')), slot: 4, generation: 18,
    }));
    assert.equal(await page.evaluate(() => active.inputAck?.pendingBytes), 19);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.receipt({
      input_ack: true, seq: 1, created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')),
      slot: 4, generation: 17,
    }));
    assert.equal(await page.evaluate(() => active.inputAck?.pendingBytes), 0);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true);
    await page.evaluate(() => active.send('\r'));
    await page.evaluate(() => window.__v2Sockets.at(-1)!.receipt({
      input_ack: true, seq: 2, created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')),
      slot: 4, generation: 17,
    }));
    assert.equal(await page.evaluate(() => active.inputLease.dirty), false);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'control' && JSON.parse(f.data as string).t === 'h').some(f =>
        JSON.parse(f.data as string).dirty === false && f.url.includes('input_ack_mode=resume'))), true);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('a refused first capability retains the draft without I/H or an automatic new actor', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => {
      active.send('NEVER-ADMITTED');
      window.__v2Sockets.at(-1)!.announce({t: 'input_capability', version: 2,
        supported: false, created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created'))});
      window.__v2Sockets.at(-1)!.close();
    });
    assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), 14);
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 1);
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary')), []);
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'control' && JSON.parse(f.data as string).t === 'h')), []);
    assert.equal(await page.evaluate(() => !active.el.querySelector<HTMLElement>('.p-input-review')?.hidden), true);
    assert.match(await page.locator('.p-input-state').textContent() ?? '', /not admitted/i);
    await page.locator('.p-input-discard').click();
    await page.locator('.p-input-retry').click();
    await page.waitForFunction(() => window.__v2Sockets.length === 2);
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url), /input_ack=2&input_ack_mode=new/);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('missing actor nonce fails closed and never silently falls back to v1 or raw', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => {
      active.send('NOT-SENT');
      window.__v2Sockets.at(-1)!.announce({t: 'input_capability', version: 2, supported: true,
        created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')),
        slot: 4, generation: 17});
      window.__v2Sockets.at(-1)!.close();
    });
    assert.equal(await page.evaluate(() => active.inputAck?.binding), null);
    assert.equal(await page.evaluate(() => active.inputAck?.pendingBytes), 8);
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary')), []);
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 1);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('a colliding slot and generation with a different nonce cannot resume old input', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.waitForFunction(() => active.inputAck?.binding?.generation === 17);
    await page.evaluate(() => active.send('OLD-QUEUE'));
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.close());
    await page.waitForFunction(() => window.__v2Sockets.length === 2);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce({
      t: 'input_capability', version: 2, supported: true,
      created: Number(new URL(window.__v2Sockets.at(-1)!.url).searchParams.get('input_ack_created')),
      slot: 4, generation: 17, actor_nonce: 'ffffffffffffffffffffffffffffffff',
    }));
    assert.equal(await page.evaluate(() => active.inputAck?.binding?.actorNonce),
      '0123456789abcdef0123456789abcdef');
    assert.ok((await page.evaluate(() => active.inputAck?.pendingBytes))! > 0);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('refused v2 resume of an ACKed partial draft requires a warning before new input binding', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.waitForFunction(() => active.inputAck?.binding?.generation === 17);
    await page.evaluate(() => active.send('PARTIAL'));
    await page.evaluate(() => window.__v2Sockets.at(-1)!.receipt({
      input_ack: true, seq: 1, created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')),
      slot: 4, generation: 17,
    }));
    assert.deepEqual(await page.evaluate(() => [active.inputAck.pendingBytes, active.inputLease.dirty]), [0, true]);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.close());
    await page.waitForFunction(() => window.__v2Sockets.length === 2);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce({
      t: 'input_capability', version: 2, supported: false,
      created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')),
    }));
    await page.waitForFunction(() => active.inputAck?.state === 'halted');
    const clean = () => page.evaluate(() => window.__v2Frames.filter(frame =>
      frame.kind === 'control' && JSON.parse(frame.data as string).t === 'h' &&
      JSON.parse(frame.data as string).dirty === false).length);
    const before = await clean();
    assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), true);
    let warning = '';
    page.once('dialog', dialog => { warning = dialog.message(); return dialog.dismiss(); });
    await page.locator('.p-input-retry').click();
    assert.match(warning, /already[- ]sent.*unfinished/i);
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 2);
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true);
    assert.equal(await clean(), before, 'refused resume and dismissed rebind cannot clean the old actor');
    page.once('dialog', dialog => { warning = dialog.message(); return dialog.accept(); });
    await page.locator('.p-input-retry').click();
    await page.waitForFunction(() => window.__v2Sockets.length === 3);
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url), /input_ack=2&input_ack_mode=new/);
    assert.equal(await clean(), before, 'an explicit fresh actor cannot release the old native lease');
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce({
      t: 'input_capability', version: 2, supported: true,
      created: Number(new URL(window.__v2Sockets.at(-1)!.url).searchParams.get('input_ack_created')),
      slot: 5, generation: 1, actor_nonce: 'ffffffffffffffffffffffffffffffff',
    }));
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(frame =>
      frame.url.includes('input_ack_mode=resume') && frame.kind === 'control' &&
      JSON.parse(frame.data as string).t === 'h' &&
      JSON.parse(frame.data as string).dirty === false).length), 0,
    'the fresh actor must never clean the refused resume binding');
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('a retained actor refused before capability stops reconnecting and keeps uncertain input', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.evaluate(() => active.send('UNCERTAIN'));
    assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), 9);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.close());
    await page.waitForFunction(() => window.__v2Sockets.length === 2);
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url), /input_ack_mode=resume/);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.close());
    await page.waitForFunction(() => !active.el.querySelector<HTMLElement>('.p-input-review')?.hidden);
    await page.waitForTimeout(2000);
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 2, 'no automatic reattachment after refusal');
    assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), 9);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1,
      'the uncertain frame was not replayed');
    assert.equal(await page.locator('.p-input-retry').isVisible(), false);
    await page.locator('.p-input-discard').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.p-input-retry').click();
    await page.waitForFunction(() => window.__v2Sockets.length === 3);
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url), /input_ack_mode=new/);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('one failed upgrade after an outage can recover without replaying uncertain input', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.evaluate(() => { active.send('UNCERTAIN'); window.__v2FailBeforeOpen = 1;
      window.__v2Sockets.at(-1)!.close(); });
    await page.waitForFunction(() => window.__v2Sockets.length === 3 && active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    assert.equal(await page.evaluate(() => active.inputAck.state), 'uncertain');
    assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), 9);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('repeated rejected upgrades stop after the bounded healthy-server retry', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.evaluate(() => { active.send('UNCERTAIN'); window.__v2FailBeforeOpen = 2;
      window.__v2Sockets.at(-1)!.close(); });
    await page.waitForFunction(() => window.__v2Sockets.length === 3);
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 3);
    assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), 9);
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    assert.equal(await page.locator('.p-input-retry').isVisible(), false);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('an obsolete dirty draft is logged and forgotten while the current terminal has no ACK', async () => {
    await mesh.newShell('no-ack-terminal');
    const page = await open();
    await page.route('**/api/sessions*', async route => {
      const response = await route.fetch({url: withoutSince(route.request().url())});
      const listing = await response.json() as {mesh: {name: string; pty_capabilities?: string[]}[]};
      for (const row of listing.mesh) {
        if (row.name === 'v2-terminal') row.pty_capabilities = ['acknowledged_input_v1', 'acknowledged_input_v2'];
        if (row.name === 'no-ack-terminal') row.pty_capabilities = [];
      }
      await route.fulfill({response, json: listing});
    });
    await page.evaluate(() => refresh());
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.evaluate(() => active.send('OLD-DRAFT'));
    await page.evaluate(() => window.__v2Sockets.at(-1)!.receipt({input_ack: true, seq: 1,
      created: Number(new URL(active.conn!.ws.url).searchParams.get('input_ack_created')), slot: 4, generation: 17}));
    assert.equal(await page.evaluate(() => active.inputLease.dirty), true);
    await page.evaluate(() => (active as typeof active & {show(name: string): void}).show('no-ack-terminal'));
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN && !active.inputAck);
    const forget = page.locator('.pane.active .p-input-forget-draft');
    assert.equal(await forget.isVisible(), false,
      'a draft belonging to a different session is not a current-session action');
    await page.evaluate(() => (active as typeof active & {show(name: string): void}).show('v2-terminal'));
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    // Simulate a replacement of this same session whose host has no ACK.
    // The bridge is fake here; the real-host test covers actual reincarnation.
    await page.evaluate(() => {
      const session = find('v2-terminal');
      session.created += 1;
      session.provisional = false;
      session.pty_capabilities = [];
      syncPanesWithListing(true);
    });
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN && !active.inputAck);
    await forget.waitFor({state: 'hidden'});
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mesh-obsolete-input-log') || '[]')
      .some((entry: {name: string}) => entry.name === 'v2-terminal')), true);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  for (const phone of [false, true]) test(`retained text from a replaced attachment opens as an editable draft without replay (${phone ? 'phone' : 'desktop'})`, async () => {
    if (phone) await mesh.newShell('recovery-other');
    const page = await open(phone);
    if (phone) await page.locator('#btn-menu').click();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.evaluate(() => active.send('RECOVER THIS TEXT'));
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    if (phone) await page.locator('#line-text').fill('existing draft');
    const oldCreated = await page.evaluate(() => find('v2-terminal').created);
    let nextCreated = oldCreated + 1;
    await page.route('**/api/sessions*', async route => {
      const response = await route.fetch({url: withoutSince(route.request().url())});
      const listing = await response.json();
      const session = listing.mesh.find((row: {name: string}) => row.name === 'v2-terminal');
      session.created = nextCreated;
      session.pty_capabilities = ['acknowledged_input_v1', 'acknowledged_input_v2'];
      await route.fulfill({response, json: listing});
    });
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => window.__v2Sockets.length >= 2 && active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    if (phone) {
      assert.equal(await page.locator('#line-text').inputValue(), 'existing draft', 'never overwrite existing text');
      await page.locator('#line-text').clear();
      await page.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement).value === 'RECOVER THIS TEXT');
    } else {
      await page.locator('#dlg-compose[open]').waitFor();
      assert.equal(await page.locator('#compose-text').inputValue(), 'RECOVER THIS TEXT');
      await page.locator('#compose-text').fill('edited recovered text');
      await page.locator('#dlg-compose [data-close-dialog]').click();
      await page.locator('#dlg-compose').waitFor({state: 'hidden'});
      await page.evaluate(() => (window as any).openCompose());
      await page.locator('#dlg-compose[open]').waitFor();
      assert.equal(await page.locator('#compose-text').inputValue(), 'edited recovered text', 'closing the editor preserves the draft');
    }
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1,
      'recovery never replays the uncertain frame');
    if (!phone) {
      await page.locator('#dlg-compose [data-close-dialog]').click();
      const sockets = await page.evaluate(() => window.__v2Sockets.length);
      nextCreated++;
      await page.evaluate(() => refresh());
      await page.waitForFunction(count => window.__v2Sockets.length > count && active?.conn?.ws?.readyState === WebSocket.OPEN, sockets);
      await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
      const review = page.locator('.p-input-other-draft').filter({hasText: 'v2-terminal'});
      assert.equal(await review.locator('textarea').inputValue(), 'edited recovered text');
      await review.getByRole('button').last().click();
      await review.waitFor({state: 'detached'});
    }
    if (phone) {
      await page.locator('#btn-menu').click();
      await page.locator('#list .item[data-id="recovery-other"]').click();
      await page.waitForFunction(() => active?.id === 'recovery-other');
      assert.equal(await page.locator('#line-text').inputValue(), '', 'the recovered text stays with its session');
      await page.locator('#line-text').fill('different session draft');
      assert.equal(await page.locator('#line-text').inputValue(), 'different session draft');
      assert.equal(await page.locator('.p-input-other-draft textarea').inputValue(), 'RECOVER THIS TEXT');
      assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1,
        'a recovered draft is not sent to a different session');
      await page.locator('#line-text').clear();
      await page.evaluate(() => { (window as any).__draftPane = active; addPane(); });
      page.once('dialog', dialog => dialog.dismiss());
      await page.evaluate(() => closePane((window as any).__draftPane));
      assert.equal(await page.evaluate(() => panes.includes((window as any).__draftPane)), true,
        'declining pane closure keeps its recovered draft');
      await page.evaluate(() => setActive((window as any).__draftPane));
      await page.locator('#btn-menu').click();
      await page.locator('#list .item[data-id="v2-terminal"]').click();
      await page.waitForFunction(() => active?.id === 'v2-terminal' && active.conn?.ws?.readyState === WebSocket.OPEN);
      await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
      await page.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement).value === 'RECOVER THIS TEXT');
      assert.equal(await page.locator('.p-input-other-draft').count(), 0, 'the restored draft is not duplicated in the review panel');
      await page.locator('#line-text').press('Enter');
      await page.waitForFunction(() => window.__v2Frames.filter(f => f.kind === 'binary').length === 2);
      const acknowledge = (seq: number) => page.evaluate(sequence => {
        const original = (window as any).__draftPane;
        const socket = window.__v2Sockets.find(candidate => candidate === original.conn.ws)!;
        const {slot, generation} = original.inputAck.binding;
        const created = Number(new URL(socket.url).searchParams.get('input_ack_created'));
        socket.receipt({input_ack: true, seq: sequence, created, slot, generation});
      }, seq);
      await page.evaluate(() => setActive(panes.find(pane => pane !== (window as any).__draftPane)!));
      await acknowledge(1);
      await page.waitForFunction(() => window.__v2Frames.filter(f => f.kind === 'binary').length === 3);
      await acknowledge(2);
      await page.waitForFunction(() => !(document.querySelector('#line-text') as HTMLTextAreaElement).readOnly);
      await page.evaluate(() => setActive((window as any).__draftPane));
      assert.equal(await page.locator('#line-text').inputValue(), '', 'an acknowledged draft does not return after switching panes');
      assert.equal(await page.evaluate(() => (window as any).__draftPane.recoveredLineDrafts.size), 0);
    }
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('a logging failure keeps retained input for review without repeatedly reopening the editor', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'mesh-obsolete-input-log') throw new DOMException('quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      active.send('KEEP THIS TEXT');
    });
    const oldCreated = await page.evaluate(() => find('v2-terminal').created);
    await page.route('**/api/sessions*', async route => {
      const response = await route.fetch({url: withoutSince(route.request().url())});
      const listing = await response.json();
      const session = listing.mesh.find((row: {name: string}) => row.name === 'v2-terminal');
      session.created = oldCreated + 1;
      session.pty_capabilities = ['acknowledged_input_v1', 'acknowledged_input_v2'];
      await route.fulfill({response, json: listing});
    });
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => window.__v2Sockets.length >= 2 && active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => window.__v2Sockets.at(-1)!.announce());
    await page.waitForFunction(() => [...active.inputAcks.values()].some((entry: any) => entry.recoveryBlocked));
    assert.equal(await page.locator('#dlg-compose').isVisible(), false);
    assert.equal(await page.locator('.p-input-drafts textarea').inputValue(), 'KEEP THIS TEXT');
    assert.equal(await page.evaluate(() => window.__v2Frames.filter(f => f.kind === 'binary').length), 1);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  const cachedV1 = async () => {
    const page = await open();
    let releaseListing!: () => void;
    const listingGate = new Promise<void>(resolve => { releaseListing = resolve; });
    let listingHeld!: () => void;
    const held = new Promise<void>(resolve => { listingHeld = resolve; });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mesh.knownSessions') ?? '{}').rows
      ?.some((row: {name: string}) => row.name === 'v2-terminal'));
    await page.evaluate(() => {
      const known = JSON.parse(localStorage.getItem('mesh.knownSessions')!);
      known.rows.find((row: {name: string}) => row.name === 'v2-terminal').pty_capabilities = ['acknowledged_input_v1'];
      localStorage.setItem('mesh.knownSessions', JSON.stringify(known));
      store.set('workspace.v1', {active: 'v2-terminal',
        columns: [{active: 0, grow: 1, tabs: [{id: 'v2-terminal', kind: 'terminal'}]}]});
    });
    await page.route('**/api/sessions*', async route => {
      try {
        const response = await route.fetch({url: withoutSince(route.request().url())});
        const listing = await response.json() as {mesh: {name: string; pty_capabilities?: string[]}[]};
        for (const row of listing.mesh) if (row.name === 'v2-terminal')
          row.pty_capabilities = ['acknowledged_input_v1', 'acknowledged_input_v2'];
        listingHeld();
        await listingGate;
        await route.fulfill({response, json: listing});
      } catch { /* The isolated page may close during a refresh. */ }
    });
    await page.reload();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    const early = await page.evaluate(() => window.__v2Sockets.at(-1)!.url);
    assert.match(early, /input_ack=1&input_ack_created=/);
    await page.evaluate(() => {
      const socket = window.__v2Sockets.at(-1)!;
      socket.announce({t: 'input_capability', supported: true,
        created: Number(new URL(socket.url).searchParams.get('input_ack_created')),
        id: new URL(socket.url).searchParams.get('input_ack_id')});
    });
    await held;
    return {page, releaseListing};
  };

  test('clean early cached-v1 attachment upgrades to observed same-incarnation v2', async () => {
    const {page, releaseListing} = await cachedV1();
    releaseListing();
    await page.waitForFunction(() => window.__v2Sockets.length === 2, undefined, {timeout: 7000});
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url),
      /input_ack=2&input_ack_mode=new/);
    assert.equal(await page.evaluate(() => active.inputAck?.version), 2);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('an attempted v2 attachment cannot rebind as v1 or raw after a same-incarnation v1 listing', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    assert.match(await page.evaluate(() => window.__v2Sockets[0]!.url), /input_ack=2/);
    await page.route('**/api/sessions*', async route => {
      try {
        const response = await route.fetch({url: withoutSince(route.request().url())});
        const listing = await response.json() as {mesh: {name: string; pty_capabilities?: string[]}[]};
        for (const row of listing.mesh) if (row.name === 'v2-terminal')
          row.pty_capabilities = ['acknowledged_input_v1'];
        await route.fulfill({response, json: listing});
      } catch { /* The isolated page may close during a refresh. */ }
    });
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => {
      const session = find('v2-terminal');
      return session?.pty_capabilities?.length === 1 &&
        session.pty_capabilities[0] === 'acknowledged_input_v1';
    });
    assert.equal(await page.evaluate(() => listedInputVersion(find('v2-terminal'))), 0);
    await page.evaluate(() => active.attach('v2-terminal'));
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 1,
      'the attempted v2 incarnation must not retry as v1 or raw');
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  for (const dirty of [false, true]) {
    test(`cached-v1 ${dirty ? 'ACKed partial draft' : 'pending bytes'} prevents observed v2 upgrade`, async () => {
      const {page, releaseListing} = await cachedV1();
      await page.evaluate(() => active.send('UNFINISHED'));
      if (dirty) await page.evaluate(() => {
        const socket = window.__v2Sockets.at(-1)!;
        socket.receipt({input_ack: true, seq: 1,
          created: Number(new URL(socket.url).searchParams.get('input_ack_created')),
          id: new URL(socket.url).searchParams.get('input_ack_id')});
      });
      assert.equal(await page.evaluate(() => active.inputLease.dirty), true);
      assert.equal(await page.evaluate(() => active.inputAck.pendingBytes), dirty ? 0 : 10);
      releaseListing();
      await page.waitForFunction(() => inventoryLoaded &&
        !document.querySelector('#list .item[data-id="v2-terminal"].row-loading'), undefined, {timeout: 7000});
      assert.equal(await page.evaluate(() => window.__v2Sockets.length), 1);
      assert.equal(await page.evaluate(() => active.inputAck?.version), 1);
      assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), true);
      await page.unrouteAll({behavior: 'wait'});
      await page.context().close();
    });
  }

  test('a missing first capability leaves input unadmitted and requires explicit fresh disposition', async () => {
    const page = await open();
    await page.locator('#list .item[data-id="v2-terminal"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => active.send('WAITING'));
    await page.waitForFunction(() => active.inputAck?.blocked === true, undefined, {timeout: 8000});
    assert.equal(await page.evaluate(() => active.inputAck?.pendingBytes), 7);
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'binary' || JSON.parse(f.data as string).t === 'h')), []);
    assert.equal(await page.evaluate(() => window.__v2Sockets.length), 1);
    assert.match(await page.locator('.p-input-state').textContent() ?? '', /not admitted/i);
    await page.locator('.p-input-discard').click();
    await page.locator('.p-input-retry').click();
    await page.waitForFunction(() => window.__v2Sockets.length === 2);
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url), /input_ack=2&input_ack_mode=new/);
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });

  test('a trusted cached v2 hint attaches before the listing without sending input', async () => {
    const page = await open();
    await page.waitForFunction(() =>
      JSON.parse(localStorage.getItem('mesh.knownSessions') ?? '{}').rows
        ?.some((row: {name: string; pty_capabilities?: string[]}) =>
          row.name === 'v2-terminal' && row.pty_capabilities?.includes('acknowledged_input_v2')));
    let answered = false;
    let releaseListing!: () => void;
    const listingGate = new Promise<void>(resolve => { releaseListing = resolve; });
    let listingHeld!: () => void;
    const held = new Promise<void>(resolve => { listingHeld = resolve; });
    await page.route('**/api/sessions*', async route => {
      try {
        const response = await route.fetch({url: withoutSince(route.request().url())});
        const listing = await response.json() as {mesh: {name: string; pty_capabilities?: string[]}[]};
        for (const row of listing.mesh) if (row.name === 'v2-terminal')
          row.pty_capabilities = ['acknowledged_input_v1', 'acknowledged_input_v2'];
        listingHeld();
        await listingGate;
        answered = true;
        await route.fulfill({response, json: listing});
      } catch { /* Page closed before a delayed listing finishes. */ }
    });
    await page.evaluate(() => active?.conn?.ws?.close());
    await page.evaluate(() => store.set('workspace.v1', {active: 'v2-terminal',
      columns: [{active: 0, grow: 1, tabs: [{id: 'v2-terminal', kind: 'terminal'}]}]}));
    await page.reload();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await held;
    assert.equal(answered, false);
    assert.match(await page.evaluate(() => window.__v2Sockets.at(-1)!.url),
      /input_ack=2&input_ack_mode=new/);
    assert.deepEqual(await page.evaluate(() => window.__v2Frames.filter(f =>
      f.kind === 'binary' || JSON.parse(f.data as string).t === 'h')), []);
    releaseListing();
    await page.unrouteAll({behavior: 'wait'});
    await page.context().close();
  });
});
