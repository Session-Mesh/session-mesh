// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {request, waitFor} from './ptyhost-wire-lib.ts';
import {type PaneView, recordControlMessages, settle, skip, TerminalMesh, waitForRow, withoutSince} from './terminal-browser-lib.ts';

type InputPane = {
  send(text: string): void;
  sendRaw(bytes: Uint8Array, complete?: boolean): boolean;
  term: PaneView['term'];
  inputLease?: {dirty: boolean};
  inputAck?: {state: string; pendingBytes: number; pendingHumanBytes: number; blocked?: boolean; retry(): boolean;
    binding?: {slot: number; generation: number; actorNonce: string}};
  conn?: {ws: WebSocket; v2AwaitingCapability?: boolean};
  el: HTMLElement;
};
declare const active: InputPane;
declare global {
  // eslint-disable-next-line no-var
  var __ackFrames: string[];
  // eslint-disable-next-line no-var
  var __heldTypingAcks: MessageEvent[];
  // eslint-disable-next-line no-var
  var __releaseTypingAck: () => void;
}
const VIEWPORT = {width: 1200, height: 720};
const fence = 'browser-input-owner-0123456789abcdef';

describe('acknowledged browser input against a real PTY host', {skip}, () => {
  const mesh = new TerminalMesh({EIO_BACKEND: 'posix'});
  before(() => mesh.start());
  after(() => mesh.stop());

  test('typing with delayed acknowledgements neither moves nor resizes the terminal', async () => {
    await mesh.newShell('ack-typing');
    const page = await mesh.openPage('ack-typing', VIEWPORT, recordControlMessages);
    try {
      await page.waitForFunction(() => active?.inputAck?.state === 'ready');
      await page.evaluate(() => active.term.focus());
      await settle(page);
      await page.evaluate(() => {
        const socket = active.conn!.ws, original = socket.onmessage!;
        window.__sent.length = 0;
        window.__heldTypingAcks = [];
        window.__releaseTypingAck = () => original.call(socket, window.__heldTypingAcks.shift()!);
        socket.onmessage = event => {
          if (typeof event.data === 'string') {
            const frame = JSON.parse(event.data);
            if (frame.t === 'input_ack' && frame.input_ack === true) {
              window.__heldTypingAcks.push(event);
              return;
            }
          }
          original.call(socket, event);
        };
      });
      const geometry = () => page.evaluate(() => {
        const {x, y, width, height} = active.el.querySelector('.term')!.getBoundingClientRect();
        return {x, y, width, height, rows: active.term.rows, cols: active.term.cols,
          reviewHidden: active.el.querySelector<HTMLElement>('.p-input-review')!.hidden};
      });
      const baseline = await geometry();
      assert.equal(baseline.reviewHidden, true);
      const samples = [];
      for (const key of ['x', 'y']) {
        await page.keyboard.press(key);
        await page.waitForFunction(() => window.__heldTypingAcks.length === 1 &&
          active.inputAck?.state === 'sending' && active.inputAck.pendingHumanBytes === 1);
        await page.waitForTimeout(115); // Leave time for the ResizeObserver/refit while the real ACK is held.
        samples.push(await geometry());
        await page.evaluate(() => window.__releaseTypingAck());
        await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck.pendingBytes === 0);
        await page.evaluate(() => new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        samples.push(await geometry());
      }
      const resizes = await page.evaluate(() => window.__sent.filter(frame => frame.t === 'r'));
      assert.deepEqual({samples, resizes}, {samples: [baseline, baseline, baseline, baseline], resizes: []});
      assert.equal(await page.evaluate(() => active.inputLease?.dirty), true);
    } finally { await page.context().close(); }
  });

  test('an attached browser no longer prevents acquisition, fenced bytes await review', async () => {
    await mesh.newShell('ack-browser');
    const page = await mesh.openPage('ack-browser', VIEWPORT);
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    const listing = await request(mesh.socketPath, {op: 'list_bound'}) as
      {name: string; created: number; creation_receipt: string}[];
    const entry = listing.find(s => s.name === 'ack-browser');
    assert.ok(entry);
    const control = (op: string) => request(mesh.socketPath,
      {op, name: entry.name, created: entry.created, creation_receipt: entry.creation_receipt, fence_id: fence});
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${location.host}/ws/ack-browser?rows=24&cols=80`);
      (window as typeof window & {__legacy?: WebSocket}).__legacy = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(Error('legacy attachment failed'));
    }));
    await waitFor('legacy WS attachment', 3000, async () => {
      const live = await request(mesh.socketPath, {op: 'list'}) as {name: string; attached: number}[];
      return live.some(s => s.name === 'ack-browser' && s.attached === 2);
    });
    assert.equal((await control('switch_input_acquire') as {reason: string}).reason, 'legacy_attachment');
    await page.evaluate(() => (window as typeof window & {__legacy?: WebSocket}).__legacy?.close());
    await waitFor('legacy WS detach', 3000, async () => {
      const live = await request(mesh.socketPath, {op: 'list'}) as {name: string; attached: number}[];
      return live.some(s => s.name === 'ack-browser' && s.attached === 1);
    });
    assert.deepEqual(await control('switch_input_acquire'), {ok: true});
    await page.evaluate(() => active.send("printf 'FENCED-should-not-run\\n'\r"));
    await page.waitForFunction(() => active.inputAck?.state === 'review');
    const pending = await page.evaluate(() => ({
      bytes: active.inputAck?.pendingBytes,
      visible: !active.el.querySelector<HTMLElement>('.p-input-review')?.hidden,
    }));
    assert.ok((pending.bytes ?? 0) > 0);
    assert.equal(pending.visible, true);
    assert.deepEqual(await control('switch_input_release'), {ok: true});
    // Release never submits retained bytes; the person must explicitly retry.
    assert.equal(await page.evaluate(() => active.inputAck?.state), 'review');
    await page.locator('.p-input-retry').click();
    await page.waitForFunction(() => active.inputAck?.pendingBytes === 0);
    await waitForRow(page, 'FENCED-should-not-run');
    await page.context().close();
  });

  test('disconnect with an uncertain ACK does not automatically resend on reconnect', async () => {
    await mesh.newShell('ack-uncertain');
    const page = await mesh.openPage('ack-uncertain', VIEWPORT, () => {
      window.__ackFrames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (new URL(this.url).searchParams.get('input_ack') === '2' && data instanceof Uint8Array)
          window.__ackFrames.push(new TextDecoder().decode(data.subarray(4)));
        return send.call(this, data);
      };
    });
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    const initial = await page.evaluate(() => ({
      url: active.conn!.ws.url, binding: active.inputAck!.binding,
    }));
    const opened = new URL(initial.url).searchParams;
    assert.equal(opened.get('input_ack'), '2');
    assert.equal(opened.get('input_ack_mode'), 'new');
    assert.equal(opened.has('input_ack_nonce'), false);
    assert.ok(initial.binding);
    await page.evaluate(() => {
      const socket = active.conn!.ws as WebSocket & {closedByTest?: boolean};
      const handler = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) return;
        handler.call(socket, event);
      };
      active.send('echo UNCERTAIN-ONCE\r');
      socket.closedByTest = true;
      socket.close();
    });
    await page.waitForFunction(() => active.conn?.ws?.readyState === 3);
    const beforeReconnect = await page.evaluate(() => active.inputAck?.pendingBytes);
    await page.evaluate(() => active.send('OFFLINE-NO-ADMISSION'));
    assert.equal(await page.evaluate(() => active.inputAck?.pendingBytes), beforeReconnect! + 20,
      'offline input is retained locally for review');
    assert.equal(await page.locator('.pane.active .p-input-review').isVisible(), true);
    assert.match(await page.locator('.pane.active .p-input-drafts textarea').inputValue(), /OFFLINE-NO-ADMISSION/);
    await page.waitForFunction(() => active.conn?.ws?.readyState === 1 &&
      active.conn.v2AwaitingCapability === false);
    const recovered = new URL(await page.evaluate(() => active.conn!.ws.url)).searchParams;
    assert.equal(recovered.get('input_ack'), '2');
    assert.equal(recovered.get('input_ack_mode'), 'resume');
    assert.equal(recovered.get('input_ack_nonce'), initial.binding.actorNonce);
    assert.equal(recovered.get('input_ack_slot'), String(initial.binding.slot));
    assert.equal(recovered.get('input_ack_generation'), String(initial.binding.generation));
    assert.equal(await page.evaluate(() => active.inputAck?.state), 'uncertain');
    assert.ok((await page.evaluate(() => active.inputAck?.pendingBytes))! > 0);
    assert.deepEqual((await page.evaluate(() => window.__ackFrames)).filter(
      text => text.includes('UNCERTAIN-ONCE')), ['echo UNCERTAIN-ONCE\r'],
    'reconnecting must not replay an uncertain input frame');
    assert.equal((await page.evaluate(() => window.__ackFrames)).some(text => text.includes('OFFLINE-NO-ADMISSION')),
      false, 'offline input is not automatically sent on reconnect');
    await page.locator('.pane.active .p-input-discard').click();
    assert.equal(await page.evaluate(() => active.inputAck?.state), 'halted');
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), true,
      'discarding an uncertain browser copy cannot prove the host has no unfinished human input');
    const rows = await request(mesh.socketPath, {op: 'list_bound'}) as
      {name: string; created: number; creation_receipt: string}[];
    const row = rows.find(s => s.name === 'ack-uncertain');
    assert.ok(row);
    assert.equal((await request(mesh.socketPath, {op: 'switch_input_acquire',
      name: row.name, created: row.created, creation_receipt: row.creation_receipt,
      fence_id: fence}) as {reason?: string}).reason, 'input_pending',
    'the native dirty lease must survive a local uncertain discard');
    const previousId = await page.evaluate(() => active.inputAcks.get(`ack-uncertain\0${active.conn!.created}`)?.id);
    let warning = '';
    page.once('dialog', dialog => { warning = dialog.message(); return dialog.accept(); });
    await page.locator('.p-input-retry').click();
    assert.match(warning, /already-sent terminal draft is unfinished/);
    await page.waitForFunction(() => active.conn?.ws?.readyState === 1 &&
      active.inputAck?.state === 'ready');
    assert.notEqual(await page.evaluate(() => active.inputAcks.get(`ack-uncertain\0${active.conn!.created}`)?.id),
      previousId, 'a deliberate reconnect needs a new actor');
    await page.evaluate(() => active.send("printf 'AFTER-REVIEW\\n'\r"));
    await waitForRow(page, 'AFTER-REVIEW');
    await page.context().close();
  });

  test('a fenced phone shows its bounded retained-input choice without covering the terminal', async () => {
    await mesh.newShell('ack-phone');
    const page = await mesh.openPage('ack-phone', {width: 390, height: 780}, undefined, undefined,
      {phone: true});
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    const listing = await request(mesh.socketPath, {op: 'list_bound'}) as
      {name: string; created: number; creation_receipt: string}[];
    const entry = listing.find(s => s.name === 'ack-phone');
    assert.ok(entry);
    const control = (op: string) => request(mesh.socketPath,
      {op, name: entry.name, created: entry.created, creation_receipt: entry.creation_receipt, fence_id: fence});
    assert.deepEqual(await control('switch_input_acquire'), {ok: true});
    await page.evaluate(() => active.send('phone input\r'));
    await page.waitForFunction(() => active.inputAck?.state === 'review');
    const [review, terminal] = await Promise.all([
      page.locator('.p-input-review').boundingBox(),
      page.locator('.pane.active .term').boundingBox(),
    ]);
    assert.ok(review && terminal && review.width <= 390 && review.y + review.height <= terminal.y,
      `review strip must fit above the terminal: ${JSON.stringify({review, terminal})}`);
    await page.locator('.p-input-discard').click();
    assert.deepEqual(await control('switch_input_release'), {ok: true});
    await page.context().close();
  });

  test('a reported sequence error requires discard before reconnecting a new attachment', async () => {
    await mesh.newShell('ack-rejected');
    const page = await mesh.openPage('ack-rejected', VIEWPORT);
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => {
      const socket = active.conn!.ws;
      const original = socket.onmessage!;
      socket.onmessage = function (event) {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.t === 'input_ack' && message.input_ack === true) {
            socket.onmessage = original;
            original.call(socket, new MessageEvent('message', {data: JSON.stringify({
              ...message, input_ack: false, reason: 'sequence_gap',
            })}));
            return;
          }
        }
        original.call(socket, event);
      };
      active.send('x');
    });
    await page.waitForFunction(() => active.inputAck?.state === 'halted');
    assert.ok((await page.evaluate(() => active.inputAck?.pendingBytes))! > 0);
    assert.equal(await page.locator('.p-input-retry').isVisible(), false,
      'a halted attachment with retained input cannot retry it');
    await page.locator('.p-input-discard').click();
    assert.equal(await page.locator('.p-input-retry').isVisible(), true,
      'discard makes explicit reconnection available');
    let warning = '';
    page.once('dialog', dialog => { warning = dialog.message(); return dialog.accept(); });
    await page.locator('.p-input-retry').click();
    assert.match(warning, /already-sent terminal draft is unfinished/);
    await page.waitForFunction(() => active.conn?.ws?.readyState === 1 &&
      active.inputAck?.state === 'ready');
    await settle(page);
    assert.equal(await page.evaluate(() =>
      active.sendRaw(new TextEncoder().encode("\x15printf 'RECONNECTED\\n'\r"), true)), true,
    'the replacement attachment accepts the new command');
    await waitForRow(page, 'RECONNECTED');
    await page.context().close();
  });

  test('v2 input_rejected closes its own socket and retains uncertain input', async () => {
    await mesh.newShell('ack-input-rejected');
    const page = await mesh.openPage('ack-input-rejected', VIEWPORT);
    const errors: Error[] = [];
    page.on('pageerror', error => errors.push(error));
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => {
      const socket = active.conn!.ws;
      (window as typeof window & {__rejectedSocket?: WebSocket}).__rejectedSocket = socket;
      const original = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) return;
        original.call(socket, event);
      };
      active.send('RETAIN-REJECTED');
      original.call(socket, new MessageEvent('message', {data: JSON.stringify({t: 'input_rejected'})}));
    });
    await page.waitForFunction(() => active.inputAck?.state === 'uncertain' &&
      (window as typeof window & {__rejectedSocket?: WebSocket}).__rejectedSocket?.readyState === WebSocket.CLOSED);
    assert.equal(await page.evaluate(() => active.inputAck?.blocked), true);
    assert.ok((await page.evaluate(() => active.inputAck?.pendingBytes))! > 0);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => new URL(active.conn!.ws.url).searchParams.get('input_ack')), '2');
    await page.context().close();
  });

  test('a retired actor cannot send lease controls through a new actor of the same name', async () => {
    await mesh.newShell('ack-actor-lease');
    const page = await mesh.openPage('ack-actor-lease', VIEWPORT, () => {
      (window as typeof window & {__leaseControls?: string[]}).__leaseControls = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && JSON.parse(data).t === 'h')
          (window as typeof window & {__leaseControls: string[]}).__leaseControls.push(data);
        return send.call(this, data);
      };
    });
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => {
      const pane = active as InputPane & {inputAcks: Map<string, {lease: {reconnect(): void; release(): void}}>;
        oldLease?: {reconnect(): void; release(): void}};
      const socket = pane.conn!.ws, original = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) return;
        original.call(socket, event);
      };
      pane.send('OLD-UNCERTAIN');
      original.call(socket, new MessageEvent('message', {data: JSON.stringify({t: 'input_rejected'})}));
      pane.oldLease = [...pane.inputAcks.values()][0]!.lease;
    });
    await page.locator('.p-input-discard').click();
    await page.waitForFunction(() => active.inputAck?.state === 'halted' &&
      active.inputAck.pendingBytes === 0 && active.conn?.ws?.readyState === WebSocket.CLOSED);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.p-input-retry').click();
    await page.waitForFunction(() => active.inputAck?.state === 'ready');
    const controls = await page.evaluate(() => {
      const pane = active as InputPane & {oldLease: {reconnect(): void; release(): void}};
      const sent = (window as typeof window & {__leaseControls: string[]}).__leaseControls;
      sent.length = 0;
      pane.oldLease.reconnect();
      pane.oldLease.release();
      return sent.slice();
    });
    assert.deepEqual(controls, []);
    await page.context().close();
  });

  test('only a warned explicit choice forgets an obsolete dirty draft record', async () => {
    await mesh.newShell('ack-old-draft');
    await mesh.newShell('ack-new-draft');
    const page = await mesh.openPage('ack-old-draft', VIEWPORT, () => {
      (window as typeof window & {__leaseControls?: string[]}).__leaseControls = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && JSON.parse(data).t === 'h')
          (window as typeof window & {__leaseControls: string[]}).__leaseControls.push(data);
        return send.call(this, data);
      };
    });
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => active.send('OLD-DRAFT'));
    await page.waitForFunction(() => active.inputAck?.pendingBytes === 0 && active.inputLease?.dirty);
    await page.evaluate(() => (active as InputPane & {show(name: string): void}).show('ack-new-draft'));
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck?.binding &&
      !active.conn?.v2AwaitingCapability && (active as InputPane & {id: string}).id === 'ack-new-draft');
    assert.equal(await page.locator('.pane.active .p-input-forget-draft').isVisible(), false,
      'another session’s draft is never offered as a current-session action');
    await page.evaluate(() => (active as InputPane & {show(name: string): void}).show('ack-old-draft'));
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck?.binding &&
      !active.conn?.v2AwaitingCapability && active.inputLease?.dirty &&
      (active as InputPane & {id: string}).id === 'ack-old-draft');
    const old = (await request(mesh.socketPath, {op: 'list_bound'}) as {name: string; created: number}[])
      .find(row => row.name === 'ack-old-draft');
    assert.ok(old);
    // Advance the same terminal's real incarnation. A different session's
    // draft must not be offered as an action in the current session.
    await waitFor('agent start window to elapse', 5000, async () => {
      const result = await request(mesh.socketPath, {op: 'stop_agent_if', name: old.name,
        created: old.created, agent: 'codex'}) as {ok: boolean; reason?: string};
      if (!result.ok) assert.equal(result.reason, 'agent_starting');
      return result.ok;
    });
    await page.evaluate(() => refresh());
    await page.waitForFunction(previous => active.conn?.created !== previous &&
      active.inputAck?.state === 'ready' && active.inputAck?.binding &&
      !active.conn?.v2AwaitingCapability && active.conn?.ws?.readyState === WebSocket.OPEN, old.created);
    const stale = page.locator('.pane.active .p-input-forget-draft');
    await stale.waitFor({state: 'visible'});
    assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), true);
    let warning = '';
    page.once('dialog', dialog => { warning = dialog.message(); return dialog.dismiss(); });
    await stale.click();
    assert.match(warning, /unfinished|incomplete/i);
    assert.equal(await stale.isVisible(), true);
    await page.evaluate(() => active.send('CURRENT-DRAFT'));
    await page.waitForFunction(() => active.inputAck?.pendingBytes === 0 && active.inputLease?.dirty);
    const result = await page.evaluate(() => {
      (window as typeof window & {__leaseControls: string[]}).__leaseControls.length = 0;
      return [...(active as InputPane & {inputAcks: Map<string, {lease: {dirty: boolean}}>}).inputAcks.keys()];
    });
    assert.equal(result.length, 2);
    page.once('dialog', dialog => dialog.accept());
    await stale.click();
    assert.equal(await stale.isVisible(), false);
    assert.equal(await page.evaluate(() => (active as InputPane & {inputAcks: Map<string, unknown>}).inputAcks.size), 1);
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), true,
      'an existing current draft still blocks reload');
    assert.equal(await page.evaluate(() => safeToReload()), false);
    assert.deepEqual(await page.evaluate(() => (window as typeof window & {__leaseControls: string[]}).__leaseControls), []);
    await page.context().close();
  });

  for (const phone of [false, true]) test(`closed session's acknowledged draft can be forgotten (${phone ? 'phone' : 'desktop'})`, async () => {
    const suffix = phone ? 'phone' : 'desktop';
    const old = `dirty-old-${suffix}`, current = `dirty-current-${suffix}`;
    await mesh.newShell(old);
    await mesh.newShell(current);
    const page = await mesh.signIn(phone ? {width: 390, height: 780} : VIEWPORT, () => {
      (window as any).__draftControls = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string') {
          try { if (JSON.parse(data).t === 'h') (window as any).__draftControls.push(data); } catch {}
        }
        return send.call(this, data);
      };
    }, undefined, {phone});
    try {
      if (phone) await page.locator('#btn-menu').click();
      await page.locator(`#list .loose .item[data-id="${old}"]`).click();
      await page.waitForFunction(() => active?.inputAck?.state === 'ready' && active.inputAck.binding && !active.conn?.v2AwaitingCapability);
      await page.evaluate(() => active.send('unfinished command'));
      await page.waitForFunction(() => active.inputAck?.pendingBytes === 0 && active.inputLease?.dirty);
      const entry = (await request(mesh.socketPath, {op: 'list_bound'}) as {name:string;created:number}[]).find(row => row.name === old)!;
      await page.evaluate(name => (active as any).show(name), current);
      await page.waitForFunction(name => (active as any)?.conn?.name === name && active?.conn?.ws?.readyState === WebSocket.OPEN, current);
      assert.deepEqual(await request(mesh.socketPath, {op: 'kill_if', name: old, created: entry.created}), {ok: true});
      await waitFor('old session gone', 10000, async () => !(await request(mesh.socketPath, {op: 'list'}) as {name:string}[]).some(row => row.name === old));
      const card = page.locator('.pane.active .p-input-other-draft');
      assert.equal(await card.locator('strong').textContent(), old);
      assert.equal(await card.locator('textarea').count(), 0, 'acknowledged bytes are not claimed to be recoverable');
      const forget = card.getByRole('button', {name: /Forget obsolete draft/});
      assert.equal(await forget.isVisible(), true);
      assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), true);
      await page.evaluate(() => { (window as any).__draftControls = []; });
      page.once('dialog', dialog => dialog.dismiss());
      await forget.click();
      assert.equal(await card.count(), 1, 'cancelling preserves the record');
      page.once('dialog', dialog => dialog.accept());
      await forget.click();
      assert.equal(await card.count(), 0);
      assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), false);
      assert.equal(await page.evaluate(() => reloadHolds().length), 0, 'no other recovery hold remains');
      assert.deepEqual(await page.evaluate(() => (window as any).__draftControls), [], 'forget sends no remote lease release');
    } finally { await page.context().close(); }
  });

  test('discarding a rejected final frame does not clear an acknowledged partial draft lease', async () => {
    await mesh.newShell('ack-partial');
    const page = await mesh.openPage('ack-partial', VIEWPORT);
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => active.send('PARTIAL-DRAFT'));
    await page.waitForFunction(() =>
      active.inputAck?.pendingBytes === 0 && active.inputLease?.dirty === true);
    await page.evaluate(() => {
      const socket = active.conn!.ws, original = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) {
          const ack = JSON.parse(event.data);
          if (ack.input_ack === true) {
            socket.onmessage = original;
            original.call(socket, new MessageEvent('message', {data: JSON.stringify({
              ...ack, input_ack: false, reason: 'input_pending',
            })}));
            return;
          }
        }
        original.call(socket, event);
      };
      active.send('\r');
    });
    await page.waitForFunction(() => active.inputAck?.state === 'review');
    await page.locator('.p-input-discard').click();
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), true);
    await page.context().close();
  });

  test('observed incarnation replacement rebinds without replaying old retained input', async () => {
    await mesh.newShell('ack-replace');
    const page = await mesh.openPage('ack-replace', VIEWPORT, () => {
      window.__ackFrames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (new URL(this.url).searchParams.get('input_ack') === '2' && data instanceof Uint8Array)
          window.__ackFrames.push(new TextDecoder().decode(data.subarray(4)));
        return send.call(this, data);
      };
    });
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    const old = await page.evaluate(() => active.conn!.created);
    await page.evaluate(() => {
      const socket = active.conn!.ws;
      const original = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) return;
        original.call(socket, event);
      };
      active.send('OLD-UNACKED');
    });
    await page.waitForFunction(() => (active.inputAck?.pendingBytes ?? 0) > 0);
    // A real observed row, not a speculative cached hint, replaces this name.
    // Simulate an observed row replacement without affecting the real host.
    await page.evaluate(previous => {
      const s = find('ack-replace');
      s.created = previous + 1;
      s.provisional = false;
      syncPanesWithListing(true);
    }, old);
    await page.waitForFunction(previous => active.conn?.created === previous + 1, old);
    assert.ok((await page.evaluate(() => active.inputAcks.get(`ack-replace\0${active.conn!.created - 1}`)?.input.pendingBytes))! > 0);
    assert.equal((await page.evaluate(() => window.__ackFrames)).filter(x => x === 'OLD-UNACKED').length, 1);
    assert.equal(await page.evaluate(() => active.inputAck?.pendingBytes), 0);
    assert.match(await page.locator('.p-input-state').textContent() ?? '', /Previous incarnation/);
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), false,
      'the old actor retains its dirty lease independently of the fresh incarnation');
    await page.context().close();
  });

  test('pane close and automatic reload retain pending input until an explicit decision', async () => {
    await mesh.newShell('ack-close');
    const page = await mesh.openPage('ack-close', VIEWPORT);
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => {
      const socket = active.conn!.ws, original = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) return;
        original.call(socket, event);
      };
      active.send('RETAIN-ME');
    });
    await page.waitForFunction(() => (active.inputAck?.pendingBytes ?? 0) > 0);
    assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-ack')), true);
    assert.equal(await page.evaluate(() => safeToReload()), false);
    assert.equal(await page.evaluate(() => {
      const prior = reloadApp;
      let reloaded = false;
      reloadApp = () => { reloaded = true; };
      try {
        if (!loadedVersion) throw Error('client version missing from test page');
        Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
        checkClientVersion('review-test-new-version');
        return reloaded;
      } finally { reloadApp = prior; }
    }), false, 'a hidden page with pending ACK bytes must not reload automatically');
    let warning = '';
    page.once('dialog', dialog => { warning = dialog.message(); return dialog.dismiss(); });
    await page.evaluate(() => requestReload());
    assert.match(warning, /some bytes may already have arrived/i);
    assert.ok((await page.evaluate(() => active.inputAck?.pendingBytes))! > 0,
      'declining the manual reload keeps the pending bytes and pane');
    await page.evaluate(() => addPane());
    page.once('dialog', dialog => dialog.dismiss());
    await page.evaluate(() => closePane(panes.find(p => p.id === 'ack-close')));
    assert.ok((await page.evaluate(() => panes.find(p => p.id === 'ack-close')?.inputAck?.pendingBytes))! > 0);
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(() => closePane(panes.find(p => p.id === 'ack-close')));
    assert.equal(await page.evaluate(() => panes.some(p => p.id === 'ack-close')), false);
    await page.context().close();
  });

  test('an acknowledged partial draft and post-discard dirty lease block automatic reload and warn on close', async () => {
    await mesh.newShell('ack-dirty-draft');
    const page = await mesh.openPage('ack-dirty-draft', VIEWPORT);
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => active.send('PARTIAL-DRAFT'));
    await page.waitForFunction(() => active.inputAck?.pendingBytes === 0 && active.inputLease?.dirty);
    assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), true);
    assert.equal(await page.evaluate(() => safeToReload()), false);
    await page.evaluate(() => addPane());
    let closeWarning = '';
    page.once('dialog', dialog => { closeWarning = dialog.message(); return dialog.dismiss(); });
    await page.evaluate(() => closePane(panes.find(p => p.id === 'ack-dirty-draft')));
    assert.match(closeWarning, /already[- ]sent/i);
    assert.equal(await page.evaluate(() => panes.find(p => p.id === 'ack-dirty-draft')?.inputLease?.dirty), true);
    await page.evaluate(() => setActive(panes.find(p => p.id === 'ack-dirty-draft')));
    let reloadWarning = '';
    page.once('dialog', dialog => { reloadWarning = dialog.message(); return dialog.dismiss(); });
    await page.evaluate(() => requestReload());
    assert.match(reloadWarning, /already[- ]sent/i);
    await page.evaluate(() => {
      const socket = active.conn!.ws, original = socket.onmessage!;
      socket.onmessage = event => {
        if (typeof event.data === 'string' && event.data.includes('"t": "input_ack"')) return;
        original.call(socket, event);
      };
      active.send('UNCONFIRMED');
      socket.close();
    });
    await page.waitForFunction(() => active.inputAck?.state === 'uncertain' && active.inputAck.pendingBytes > 0);
    await page.locator('.pane.active .p-input-discard').click();
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), true);
    assert.equal(await page.evaluate(() => reloadHolds().some(h => h.kind === 'input-draft')), true);
    assert.equal(await page.evaluate(() => safeToReload()), false);
    await page.context().close();
  });

  test('listing-enabled attachment keeps only the selected pane’s pending keyboard focus', async () => {
    await mesh.newShell('ack-focus');
    const page = await mesh.openPage('ack-focus', VIEWPORT);
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => {
      active.conn!.waitingListing = true;
      active.conn!.focusRequested = true;
      syncPanesWithListing(true);
    });
    await page.waitForFunction(() =>
      active.conn?.ws?.readyState === WebSocket.OPEN && active.conn?.focusRequested === false &&
      document.activeElement === active.term.textarea);
    // A passive pane may wait for the same listing, but must not take focus
    // away from a different pane the person selected in the meantime.
    await page.evaluate(() => {
      const previous = active;
      addPane();
      setActive(panes.find(p => p !== previous));
      previous.conn!.waitingListing = true;
      previous.conn!.focusRequested = true;
      syncPanesWithListing(true);
    });
    assert.equal(await page.evaluate(() => panes.some(p => p !== active && p.conn?.focusRequested)), false);
    await page.context().close();
  });

  test('observed legacy listing keeps raw input across a reconnect', async () => {
    await mesh.newShell('legacy-reconnect');
    const page = await mesh.signIn(VIEWPORT, undefined, undefined, {routes: async page => {
      await page.route('**/api/sessions*', async route => {
        const response = await route.fetch({url: withoutSince(route.request().url())});
        const listing = await response.json() as {mesh: {name: string; pty_capabilities?: string[]}[]};
        for (const row of listing.mesh) if (row.name === 'legacy-reconnect') row.pty_capabilities = [];
        await route.fulfill({response, json: listing});
      });
    }});
    await page.locator('#list .item[data-id="legacy-reconnect"]').click();
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    assert.equal(await page.evaluate(() => active.inputAck), null);
    assert.equal(new URL(await page.evaluate(() => active.conn!.ws.url)).searchParams.has('input_ack'), false);
    await page.evaluate(() => active.send("printf 'LEGACY-FIRST\\n'\r"));
    await waitForRow(page, 'LEGACY-FIRST');
    await page.evaluate(() => active.conn!.ws.close());
    await page.waitForFunction(() => active?.conn?.ws?.readyState === WebSocket.OPEN);
    await page.evaluate(() => active.send("printf 'LEGACY-SECOND\\n'\r"));
    await waitForRow(page, 'LEGACY-SECOND');
    await page.context().close();
  });

  test('real focus and SGR mouse reports ACK without a draft; blur cannot clear human input', async () => {
    await mesh.newShell('ack-reports');
    const page = await mesh.openPage('ack-reports', VIEWPORT, () => {
      window.__ackFrames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (new URL(this.url).searchParams.get('input_ack') === '2' && data instanceof Uint8Array)
          window.__ackFrames.push(new TextDecoder().decode(data.subarray(4)));
        return send.call(this, data);
      };
    });
    await page.waitForFunction(() => active?.inputAck?.state === 'ready');
    await page.evaluate(() => {
      active.send("stty raw -echo; printf '\\033[?1049h\\033[?1004h\\033[?1003h\\033[?1006h\\033[2J'; exec cat >/dev/null");
      active.send('\r');
    });
    await page.waitForFunction(() => {
      const modes = (active as typeof active & {term: {modes: {sendFocusMode: boolean; mouseTrackingMode: string}}}).term.modes;
      return modes.sendFocusMode && modes.mouseTrackingMode === 'any' &&
        active.inputAck?.state === 'ready' && active.inputAck.pendingBytes === 0;
    });
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), false,
      `the setup command should be complete: ${JSON.stringify(await page.evaluate(() => window.__ackFrames))}`);
    const listing = await request(mesh.socketPath, {op: 'list_bound'}) as
      {name: string; created: number; creation_receipt: string}[];
    const entry = listing.find(s => s.name === 'ack-reports');
    assert.ok(entry);
    let fenceId = fence;
    const control = (op: string) => request(mesh.socketPath,
      {op, name: entry.name, created: entry.created, creation_receipt: entry.creation_receipt, fence_id: fenceId});
    await page.locator('.pane.active .xterm textarea').focus();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.waitForFunction(() => window.__ackFrames.some(frame => frame === '\x1b[O'));
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck.pendingBytes === 0);
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), false);
    await waitFor('focus report drained without dirty draft', 3000,
      async () => (await control('switch_input_acquire') as {ok?: boolean}).ok === true);
    assert.deepEqual(await control('switch_input_release'), {ok: true});
    assert.equal((await control('switch_input_acquire') as {reason?: string}).reason, 'fence_retired');
    fenceId = `${fence}-mouse`;

    const box = await page.locator('.pane.active .xterm-screen').boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() =>
      window.__ackFrames.some(frame => /^\x1b\[<0;\d+;\d+M$/.test(frame)) &&
      window.__ackFrames.some(frame => /^\x1b\[<0;\d+;\d+m$/.test(frame)));
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck.pendingBytes === 0);
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), false);
    await waitFor('mouse reports drained without dirty draft', 3000,
      async () => (await control('switch_input_acquire') as {ok?: boolean}).ok === true);
    assert.deepEqual(await control('switch_input_release'), {ok: true});
    fenceId = `${fence}-human`;

    await page.evaluate(() => active.send('HUMAN-DRAFT'));
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck.pendingBytes === 0);
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), true);
    const priorFocusOuts = await page.evaluate(() =>
      window.__ackFrames.filter(frame => frame === '\x1b[O').length);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.waitForFunction(before =>
      window.__ackFrames.filter(frame => frame === '\x1b[O').length > before, priorFocusOuts);
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputAck.pendingBytes === 0);
    assert.equal(await page.evaluate(() => active.inputLease?.dirty), true,
      'focus-out and its ACK cannot mark a human draft complete');
    assert.equal((await control('switch_input_acquire') as {reason: string}).reason, 'input_pending');
    await page.evaluate(() => active.send('\r'));
    await page.waitForFunction(() => active.inputAck?.state === 'ready' && active.inputLease?.dirty === false);
    await waitFor('human completion releases lease', 3000,
      async () => (await control('switch_input_acquire') as {ok?: boolean}).ok === true);
    assert.deepEqual(await control('switch_input_release'), {ok: true});
    await page.context().close();
  });
});
