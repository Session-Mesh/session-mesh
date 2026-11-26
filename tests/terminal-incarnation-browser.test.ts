// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {until} from '../checks/dictation-fixture.ts';
import {TerminalMesh, skip, settle, rows, type PaneView} from './terminal-browser-lib.ts';

declare const active: PaneView & {conn: any; inputLease: any; show(name: string): void;
  sendRaw(bytes: Uint8Array): boolean};
declare const meshPageCache: unknown;
declare function refresh(): Promise<unknown>;
declare function find(name: string): any;
declare function rowAuthoritative(session: any): boolean;
type SavedPage = Window & {oldConnection: any; oldLease: any};

describe('ordinary terminal incarnation recovery without dictation', {skip}, () => {
  const mesh = new TerminalMesh({MESH_WHISPER_URL: ''});
  const editor = path.join(mesh.home, 'input-witness.cjs');
  before(async () => {
    await mesh.start();
    fs.writeFileSync(editor, `const fs = require('node:fs');
      require('node:child_process').execFileSync('stty', ['raw', '-echo'], {stdio: 'inherit'});
      const oracle = process.argv[2]; let input = '';
      const save = () => {fs.writeFileSync(oracle + '.tmp', input); fs.renameSync(oracle + '.tmp', oracle);};
      process.stdin.on('data', chunk => {input += chunk; save();}); save();
      process.stdout.write('INPUT_WITNESS_READY');`);
  });
  after(() => mesh.stop());

  async function call(route: string, body: unknown) {
    const response = await fetch(mesh.base + route, {method: 'POST',
      headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body)});
    assert.equal(response.status, 200, await response.text());
  }
  async function create(name: string, generation: string): Promise<string> {
    const oracle = path.join(mesh.home, `${name}-${generation}.input`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await call('/api/new', {name, cwd: mesh.home, preset: 'custom',
      command: `exec ${quote(process.execPath)} ${quote(editor)} ${quote(oracle)}`});
    await until(() => fs.existsSync(oracle));
    return oracle;
  }
  async function saveOriginal(page: Page): Promise<number> {
    return page.evaluate(() => {
      const saved = window as unknown as SavedPage;
      saved.oldConnection = active.conn; saved.oldLease = active.inputLease;
      return active.conn.created;
    });
  }
  async function type(page: Page, text: string): Promise<void> {
    await page.locator('.pane.active .xterm-helper-textarea').focus();
    await page.keyboard.type(text);
  }
  async function assertFreshInput(page: Page, oracle: string): Promise<void> {
    assert.equal(fs.readFileSync(oracle, 'utf8'), '', 'no previous input is replayed into the replacement');
    assert.equal(await page.evaluate(() => active.inputLease.dirty), false);
    assert.equal(await page.evaluate(() => {
      try {return (window as unknown as SavedPage).oldLease.write(new TextEncoder().encode('stale-lease'));}
      catch {return false;}
    }), false, 'the old lease cannot deliver through the replacement connection');
    await type(page, 'fresh-input');
    await until(() => fs.readFileSync(oracle, 'utf8') === 'fresh-input');
  }

  test('socket close and same-name replacement normally reattach to the new incarnation', {timeout: 45000}, async () => {
    const name = 'ordinary-restart', oldInput = await create(name, 'old');
    const page = await mesh.openPage(name, {width: 1200, height: 700});
    let release = () => {};
    try {
      const original = await saveOriginal(page);
      await type(page, 'unfinished-old');
      await until(() => fs.readFileSync(oldInput, 'utf8') === 'unfinished-old');
      // Hold the close handler's authoritative refresh until the replacement exists.
      const inventory = new Promise<void>(resolve => {release = resolve;});
      await page.route('**/api/sessions*', async route => {await inventory; await route.continue();});
      await page.evaluate(() => active.conn.ws.close());
      await page.waitForFunction(() => (window as unknown as SavedPage).oldConnection.ws.readyState === WebSocket.CLOSED);
      assert.equal(await page.evaluate(() => active.sendRaw(new TextEncoder().encode('disconnected-input'))), true);
      await page.waitForFunction(() => [...document.querySelectorAll('.p-input-drafts textarea')]
        .some(field => (field as HTMLTextAreaElement).value.includes('disconnected-input')));
      await call(`/api/kill/${name}`, {created: original});
      const replacementInput = await create(name, 'new');
      release();
      await page.waitForFunction(created => active.conn?.terminal?.isOpen()
        && active.conn.created !== created && active.conn.terminal.isBound(active.id, active.conn.created), original);
      await settle(page);
      assert.equal(await page.evaluate(() => active.inputLease !== (window as unknown as SavedPage).oldLease), true);
      assert.equal(await page.evaluate(() => [...active.inputAcks.values()].some(entry =>
        entry.input.retainedText.includes('disconnected-input'))), true, 'old input remains available for review');
      await assertFreshInput(page, replacementInput);
    } finally {release(); await page.context().close();}
  });

  test('synthetic cached-page return keeps the original target fence across same-name replacement', {timeout: 45000}, async () => {
    const name = 'cached-restart', oldInput = await create(name, 'old');
    const page = await mesh.openPage(name, {width: 1200, height: 700});
    const sockets: string[] = [];
    page.on('websocket', socket => sockets.push(socket.url()));
    try {
      const original = await saveOriginal(page);
      await type(page, 'unfinished-old');
      await until(() => fs.readFileSync(oldInput, 'utf8') === 'unfinished-old');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
      await page.waitForFunction(() => (window as unknown as SavedPage).oldConnection.ws.readyState === WebSocket.CLOSED);
      await call(`/api/kill/${name}`, {created: original});
      const replacementInput = await create(name, 'new');
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
        const old = (window as unknown as SavedPage).oldConnection.ws;
        old.onmessage({data: new TextEncoder().encode('STALE_OUTPUT\x1b[6n').buffer}); old.onclose({});
      });
      await page.waitForFunction(() => meshPageCache === null);
      await page.evaluate(() => refresh());
      assert.equal(await page.evaluate(() => active.id), name);
      assert.equal(await page.evaluate(() => active.conn), null, 'pageshow and later inventory cannot retarget a frozen page');
      assert.deepEqual(sockets, [], 'no automatic socket is opened for the new incarnation');
      assert.equal(await page.evaluate(() => active.sendRaw(new TextEncoder().encode('cached-input'))), false);
      assert.equal((await rows(page)).some(row => row.includes('STALE_OUTPUT')), false, 'stale output cannot reach the retained view');
      assert.equal(fs.readFileSync(replacementInput, 'utf8'), '', 'cached input and stale terminal replies never reach the new process');
      // An explicit user selection, unlike pageshow, grants authority to the current target.
      await page.waitForFunction(({name, original}) => {
        const session = find(name);
        return session?.created !== original && session?.kind === 'mesh' && rowAuthoritative(session);
      }, {name, original});
      assert.equal(await page.evaluate(() => active.conn), null);
      assert.deepEqual(sockets, [], 'authoritative replacement inventory still cannot retarget the cached page');
      await page.locator(`#list .item[data-id="${name}"]`).click();
      await page.waitForFunction(created => active.conn?.terminal?.isOpen()
        && active.conn.created !== created && active.conn.terminal.isBound(active.id, active.conn.created), original);
      await settle(page);
      await assertFreshInput(page, replacementInput);
    } finally {await page.context().close();}
  });
});
