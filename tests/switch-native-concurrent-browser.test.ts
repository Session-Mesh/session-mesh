// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Experimental end-to-end test. All accounts, transcripts and processes are fixtures.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {installFakeCodex, launchesIn, rolloutIn} from './fake-codex-lib.ts';
import {appendFixturePath} from './fixture-login-path.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';
import {REPO, settle, skip, TerminalMesh} from './terminal-browser-lib.ts';

type Row = {id: string; pid: number; created: number; agent: {pid: number; session_id: string} | null};
type Bound = {name: string; created: number; creation_receipt: string};
declare const active: {conn?: {ws?: WebSocket}; inputAck?: {state: string}};

async function openPrimary(page: Page, phone: boolean): Promise<void> {
  if (phone) await page.locator('#btn-menu').click();
  const entry = page.locator('#list .loose .item[data-id="fenced-account"]');
  await entry.waitFor({state: 'visible', timeout: 30_000});
  assert.equal(await entry.count(), 1, 'one primary row in the unfiled sessions list');
  await entry.click();
  await page.waitForFunction(() => active?.conn?.ws?.readyState === 1, undefined, {timeout: 30_000});
  await settle(page);
}

describe('fenced native switch with desktop and phone', {skip}, () => {
  let bin: string, fake: ReturnType<typeof installFakeCodex>, mesh: TerminalMesh, marker: string, release: string;
  before(async () => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-switch-browser-bin-'));
    fake = installFakeCodex(bin);
    marker = path.join(bin, 'carry-entered');
    release = path.join(bin, 'release-carry');
    const platform = process.env.MESH_MESH_PLATFORM_CMD || path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
    const wrapper = path.join(bin, 'platform-wrapper');
    fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = accounts ] && [ "$2" = carry ]; then\n  : > '${marker}'\n  count=0\n  while [ ! -e '${release}' ]; do\n    [ "$count" -lt 150 ] || exit 124\n    sleep .1\n    count=$((count+1))\n  done\nfi\nexec '${platform}' "$@"\n`, {mode: 0o700});
    mesh = new TerminalMesh({PATH: fake.PATH, EIO_BACKEND: 'posix',
      MESH_MESH_PLATFORM_CMD: wrapper,
      MESH_MESH_PROFILE_CMD: process.env.MESH_PROFILE_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_profile_main.exe')});
    await mesh.start(); appendFixturePath(mesh.home, fake.PATH);
  });
  after(async () => {
    spawnSync('pkill', ['-KILL', '-f', path.join(bin, 'real', 'codex')]);
    await mesh.stop();
    fs.rmSync(bin, {recursive: true, force: true});
  });

  test('input during carry remains retained while switch keeps the PTY and conversation', {timeout: 90_000}, async () => {
    const conf = path.join(mesh.home, '.config/session-mesh');
    const target = path.join(mesh.home, 'work-codex'), state = path.join(mesh.home, 'work-state');
    for (const dir of [conf, target, state]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.chmodSync(path.dirname(conf), 0o700); fs.chmodSync(conf, 0o700);
    fs.writeFileSync(path.join(conf, 'backend-profiles.json'), JSON.stringify({version: 1, profiles: [
      {backend: 'codex', id: 'work', label: 'Work', enabled: true, roots: {config: target, state}},
    ]}), {mode: 0o600});
    const auth = {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'};
    const created = await fetch(`${mesh.base}/api/new`, {method: 'POST', headers: auth,
      body: JSON.stringify({preset: 'codex', cwd: mesh.home, name: 'fenced-account'})});
    assert.equal(created.status, 200, await created.clone().text());
    const listing = async (): Promise<Row | undefined> => {
      const response = await fetch(`${mesh.base}/api/sessions`, {headers: auth});
      return ((await response.json()) as {mesh: Row[]}).mesh.find(row => row.id === 'fenced-account');
    };
    await waitFor('fixture conversation and token', 30_000, async () =>
      Boolean((await listing())?.agent?.session_id && launchesIn(fake.log).find(row => row[2] === 'fenced-account')?.[4]));
    const before = (await listing())!;
    const launchesBefore = launchesIn(fake.log);
    const token = launchesBefore.find(row => row[2] === 'fenced-account')![4]!;
    const sid = before.agent!.session_id;
    const transcript = rolloutIn(path.join(mesh.home, '.codex'), sid);
    const original = fs.readFileSync(transcript);
    const desktop = await mesh.signIn({width: 1200, height: 720}, () => {
      Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (value: string) => { (window as any).__copiedDraft = value; }}, configurable: true});
    });
    let phone: Page | undefined;
    let decision: Promise<Response> | undefined;
    let decisionSettled: Promise<unknown> | undefined;
    try {
      await openPrimary(desktop, false);
      phone = await mesh.signIn({width: 390, height: 780}, () => {
        Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (value: string) => { (window as any).__copiedDraft = value; }}, configurable: true});
        const send = WebSocket.prototype.send;
        (window as any).__inputFrames = [];
        WebSocket.prototype.send = function(data) {
          if (data instanceof Uint8Array && data.length >= 4)
            (window as any).__inputFrames.push(new TextDecoder().decode(data.subarray(4)));
          return send.call(this, data);
        };
      }, undefined, {phone: true});
      await openPrimary(phone, true);
      for (const page of [desktop, phone]) await page.waitForFunction(() => active?.inputAck?.state === 'ready');
      const bound = (await request(mesh.socketPath, {op: 'list_bound'}) as Bound[]).find(row => row.name === 'fenced-account')!;
      assert.ok(bound);
      assert.equal(bound.created, before.created);
      const cookie = (await desktop.context().cookies()).map(item => `${item.name}=${item.value}`).join('; ');
      const owner = {Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'};
      const asked = await fetch(`${mesh.base}/api/session-actions/@self/request`, {method: 'POST',
        headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'switch_account', account: 'work'})});
      assert.equal(asked.status, 202, await asked.clone().text());
      const item = (await asked.json() as {request: {id: string}}).request;
      const claim = await fetch(`${mesh.base}/api/session-actions/${item.id}/claim`, {method: 'POST', headers: owner,
        body: JSON.stringify({tab_nonce: 'b'.repeat(32)})});
      assert.equal(claim.status, 200, await claim.clone().text());
      const {claim_nonce} = await claim.json() as {claim_nonce: string};
      decision = fetch(`${mesh.base}/api/session-actions/${item.id}/decision`, {method: 'POST', headers: owner,
        body: JSON.stringify({approve: true, claim_nonce}), signal: AbortSignal.timeout(25_000)});
      decisionSettled = decision.then(() => undefined, () => undefined);
      await waitFor('carry helper entered', 7000, () => fs.existsSync(marker));
      assert.equal(await phone.evaluate(() => active.inputAck?.state), 'ready');
      const sent = await phone.evaluate(() => { const pane = active as any; return {created:pane.conn.created, before:pane.inputAck.state, accepted:pane.sendRaw(new TextEncoder().encode('phone-during-switch')), pending:pane.inputAck.pendingBytes}; });
      assert.deepEqual({before:sent.before, accepted:sent.accepted, pending:sent.pending}, {before: 'ready', accepted: true, pending: 19});
      await phone.waitForFunction(created => {
        const input = (active as any).inputAcks.get(`fenced-account\0${created}`)?.input;
        return input && ['review', 'uncertain', 'halted'].includes(input.state);
      }, sent.created, {timeout: 4000});
      const retained = await phone.evaluate(created => {
        const input = (active as any).inputAcks.get(`fenced-account\0${created}`)?.input;
        return input && {bytes: input.pendingBytes, text: input.retainedText};
      }, sent.created);
      assert.deepEqual(retained, {bytes: 19, text: 'phone-during-switch'}, 'accepted input remains available for review on its original incarnation');
      assert.deepEqual(launchesIn(fake.log), launchesBefore, 'target has not launched while carry is held');
      assert.deepEqual(fs.readFileSync(transcript), original);
      assert.equal(fs.existsSync(rolloutIn(target, sid)), false);
      fs.writeFileSync(release, 'release');
      const response = await decision;
      assert.equal(response.status, 200, await response.clone().text());
      const outcome = await response.json() as {request: {state: string; result: {id?: string}}};
      assert.equal(outcome.request.state, 'completed', JSON.stringify(outcome));
      assert.equal(outcome.request.result.id, before.id);
      await waitFor('switched conversation listed', 15_000, async () => {
        const row = await listing();
        return Boolean(row && row.created !== before.created && row.agent?.session_id === sid);
      });
      const after = (await listing())!;
      assert.equal(after.pid, before.pid, 'the PTY shell remains the same');
      assert.notEqual(after.created, before.created, 'the session incarnation advances');
      assert.equal(after.agent?.session_id, sid, 'the same conversation is resumed');
      assert.ok(sent.created === before.created || sent.created === after.created, 'input stays tied to an observed incarnation');
      const calls = launchesIn(fake.log).filter(row => row[2] === 'fenced-account');
      assert.equal(calls.length, 2);
      assert.equal(calls[1]![1], target, 'the resumed agent uses the target account');
      assert.match(calls[1]![3]!, new RegExp(`^resume ${sid}(?:\\s|$)`));
      assert.equal(fs.existsSync(rolloutIn(target, sid)), true);
      assert.equal(await phone.evaluate(created => (active as any).inputAcks.get(`fenced-account\0${created}`)?.input.retainedText,
        sent.created), 'phone-during-switch', 'input remains bound to its original incarnation');
      const attempted = await phone.evaluate(() => (window as any).__inputFrames);
      assert.ok(attempted.length <= 1 && attempted.every((frame: string) => frame === 'phone-during-switch'),
        'the text is never replayed automatically');
      await phone.evaluate(() => active.conn!.ws!.close());
      await phone.waitForFunction(created => (active as any)?.conn?.created === created &&
        active?.conn?.ws?.readyState === WebSocket.OPEN, after.created, {timeout: 15000});
      const draft = phone.locator('#line-text');
      await phone.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement).value === 'phone-during-switch');
      assert.equal(await phone.evaluate(() => [...(active as any).inputAcks.values()].reduce((sum: number, entry: any) => sum + entry.input.pendingBytes, 0)), 0, 'old bytes are moved to the editor');
      assert.equal(await draft.inputValue(), 'phone-during-switch');
      await phone.evaluate(() => {
        const pane = active as any;
        pane.inputAcks.set('another-session\0fixture', {input: {pendingBytes: 6, pendingHumanBytes: 6, retainedText: 'secret', state: 'review'}});
        pane.renderRetainedInput();
      });
      assert.equal(await draft.count(), 1, 'another session is not treated as the current draft');
      assert.equal(await draft.inputValue(), 'phone-during-switch');
      assert.equal(await phone.locator('.pane.active .p-input-other-draft strong').textContent(), 'another-session');
      await phone.evaluate(() => { const pane = active as any; pane.inputAcks.delete('another-session\0fixture'); pane.renderRetainedInput(); });
      await desktop.evaluate(() => {
        const pane = active as any;
        pane.inputAcks.set(`${pane.conn.name}\0desktop-fixture`, {recoveryBlocked: true, input: {pendingBytes: 13, pendingHumanBytes: 13, retainedText: 'desktop-draft', state: 'review'}});
        pane.renderRetainedInput();
      });
      assert.equal(await desktop.locator('.pane.active .p-input-drafts textarea').inputValue(), 'desktop-draft');
      assert.equal(await draft.inputValue(), 'phone-during-switch', 'desktop and phone drafts remain independent');
      await desktop.evaluate(() => {
        const pane = active as any;
        const input = {pendingBytes: 8, pendingHumanBytes: 8, retainedText: 'old text', state: 'review', deliveryUncertain: false,
          incompleteHumanInput: false, discard() { this.pendingBytes = 0; this.pendingHumanBytes = 0; }};
        pane.inputAcks.set('closed-desktop\0fixture', {input}); pane.renderRetainedInput();
      });
      const desktopOther = desktop.locator('.pane.active .p-input-other-draft');
      assert.equal(await desktopOther.locator('strong').textContent(), 'closed-desktop');
      await desktopOther.getByRole('button', {name: 'Copy', exact: true}).click();
      assert.equal(await desktop.evaluate(() => (window as any).__copiedDraft), 'old text');
      await desktop.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('unavailable'); }; });
      await desktopOther.getByRole('button', {name: 'Copy', exact: true}).click();
      assert.deepEqual(await desktopOther.locator('textarea').evaluate((field: HTMLTextAreaElement) =>
        [document.activeElement === field, field.selectionStart, field.selectionEnd]), [true, 0, 8], 'clipboard refusal selects text for manual copy');
      await desktopOther.getByRole('button', {name: /Discard/}).click();
      assert.equal(await desktopOther.count(), 0);
      assert.equal(await desktop.locator('.pane.active .p-input-drafts textarea').inputValue(), 'desktop-draft');
      await desktop.evaluate(() => { const pane = active as any; pane.inputAcks.delete(`${pane.conn.name}\0desktop-fixture`); pane.renderRetainedInput(); });
      assert.deepEqual(await phone.evaluate(() => (window as any).__inputFrames), attempted, 'reconnection does not resend input');
      await mesh.newShell('other-draft-session');
      await phone.waitForFunction(() => document.querySelector('#list .loose .item[data-id="other-draft-session"]') !== null);
      await phone.locator('#btn-menu').click();
      await phone.locator('#list .loose .item[data-id="other-draft-session"]').click();
      await phone.waitForFunction(() => (active as any)?.conn?.name === 'other-draft-session' && active?.conn?.ws?.readyState === WebSocket.OPEN);
      assert.equal(await draft.inputValue(), '', 'session A is not inserted into session B');
      assert.equal(await phone.locator('.pane.active .p-input-drafts textarea').count(), 0, 'session A is not visible in B');
      await phone.evaluate(() => {
        const pane = active as any;
        const input = {pendingBytes: 7, pendingHumanBytes: 7, retainedText: 'draft B', state: 'review', deliveryUncertain: false,
          incompleteHumanInput: false, discard() { this.pendingBytes = 0; this.pendingHumanBytes = 0; }};
        pane.inputAcks.set(`${pane.conn.name}\0fixture`, {input, recoveryBlocked: true});
        pane.renderRetainedInput();
      });
      assert.equal(await phone.locator('.pane.active .p-input-drafts textarea').inputValue(), 'draft B');
      assert.match(await phone.locator('.pane.active .p-input-state').innerText(), /7/);
      await phone.locator('.pane.active .p-input-discard').click();
      assert.equal(await phone.locator('.pane.active .p-input-drafts textarea').count(), 0);
      const other = phone.locator('.pane.active .p-input-other-draft');
      assert.equal(await other.locator('strong').textContent(), 'fenced-account');
      assert.equal(await other.locator('textarea').inputValue(), 'phone-during-switch');
      await other.getByRole('button', {name: 'Copy', exact: true}).click();
      assert.equal(await phone.evaluate(() => (window as any).__copiedDraft), 'phone-during-switch');
      assert.deepEqual(await phone.evaluate(() => (window as any).__inputFrames), attempted, 'copy never sends a frame');
      await phone.locator('#btn-menu').click();
      await phone.locator('#list .loose .item[data-id="fenced-account"]').click();
      await phone.waitForFunction(() => (active as any)?.conn?.name === 'fenced-account' && active?.conn?.ws?.readyState === WebSocket.OPEN);
      await phone.waitForFunction(() => (document.querySelector('#line-text') as HTMLTextAreaElement).value === 'phone-during-switch');
      await phone.locator('#btn-menu').click();
      await phone.locator('#list .loose .item[data-id="other-draft-session"]').click();
      await phone.waitForFunction(() => (active as any)?.conn?.name === 'other-draft-session' && active?.conn?.ws?.readyState === WebSocket.OPEN);
      const stopped = await request(mesh.socketPath, {op: 'kill_if', name: 'fenced-account', created: after.created}) as {ok:boolean};
      assert.equal(stopped.ok, true);
      await waitFor('original session gone', 10000, async () => !(await listing()));
      assert.equal(await other.locator('textarea').inputValue(), 'phone-during-switch', 'closed session input remains copyable');
      await phone.evaluate(() => {
        const pane = active as any;
        const input = {pendingBytes: 7, pendingHumanBytes: 7, retainedText: 'draft B', state: 'review', deliveryUncertain: false,
          incompleteHumanInput: false, discard() { this.pendingBytes = 0; this.pendingHumanBytes = 0; }};
        pane.inputAcks.set(`${pane.conn.name}\0fixture`, {input, recoveryBlocked: true}); pane.renderRetainedInput();
      });
      await other.getByRole('button', {name: /Discard/}).click();
      assert.equal(await other.locator('textarea').count(), 0, 'discard removes the retained bytes');
      assert.equal(await other.count(), 0, 'forget removes only the chosen closed-session record');
      assert.equal(await phone.locator('.pane.active .p-input-drafts textarea').inputValue(), 'draft B');
      assert.deepEqual(await phone.evaluate(() => (window as any).__inputFrames), attempted, 'discard never sends a frame');
    } finally {
      try {
        fs.writeFileSync(release, 'release');
      } finally {
        await decisionSettled;
        await desktop.context().close();
        await phone?.context().close();
      }
    }
  });
});
