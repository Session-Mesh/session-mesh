// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';

declare const panes: {header(): void}[];
declare const data: {mesh: {name: string; created: number}[]};

test('actual Tools retains focused controls on inventory render and fences a replaced session dialog', {skip, timeout: 45000}, async () => {
  const mesh = new TerminalMesh();
  try {
    await mesh.start(); await mesh.newShell('tools-fixture');
    const page = await mesh.openPage('tools-fixture', {width: 1440, height: 900});
    await page.locator('.p-tools summary').first().click();
    const button = page.locator('.p-tools-body button').first(); await button.focus();
    assert.deepEqual(await page.evaluate(() => {
      const before = document.activeElement!;
      for (const pane of panes) pane.header();
      return {connected: before.isConnected, same: before === document.querySelector('.p-tools-body button'), focused: document.activeElement === before};
    }), {connected: true, same: true, focused: true});
    await page.route('**/api/session-artifacts/*', route => route.fulfill({json: {references: [{connector: 'notes', id: 'synthetic', kind: 'note', title: 'Synthetic reference', availability: 'observed-present', url: 'https://example.invalid/shared#fixture'}]}}));
    await page.context().route('https://example.invalid/**', route => route.abort());
    await button.click(); await page.locator('dialog.session-artifacts a').waitFor();
    const headers = {Authorization: 'Bearer ' + mesh.token(), 'Content-Type': 'application/json'};
    const before = await (await fetch(mesh.base + '/api/sessions', {headers})).json();
    const old = before.mesh.find((s: {name: string}) => s.name === 'tools-fixture'); assert.ok(old);
    const killed = await fetch(mesh.base + '/api/kill/tools-fixture', {method: 'POST', headers, body: JSON.stringify({created: old.created})}); assert.equal(killed.status, 200);
    await mesh.newShell('tools-fixture'); await page.evaluate('refresh()');
    await page.waitForFunction(created => data.mesh.some(s => s.name === 'tools-fixture' && s.created !== created), old.created);
    const pages = page.context().pages().length;
    await page.locator('dialog.session-artifacts a').click();
    assert.equal(await page.locator('dialog.session-artifacts a').count(), 0);
    assert.equal(page.context().pages().length, pages, 'the old capability did not open a tab');
    await page.getByText('This session was replaced or closed.', {exact: false}).waitFor();
  } finally {await mesh.stop();}
});
