// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import type {Page} from 'playwright-core';
import {TerminalMesh, skip} from './terminal-browser-lib.ts';

declare const panes: any[];
declare function openWeb(target: string): Promise<void>;

test('document load invalidates an early menu; a frame-loaded document can be re-described safely', {skip, timeout: 30000}, async t => {
  const mesh = new TerminalMesh();
  let release = () => {};
  let page: Page | undefined;
  try {
    await mesh.start(); await mesh.newShell('document-owner');
    const markdown = path.join(mesh.home, 'README.md');
    fs.writeFileSync(markdown, '# Document readiness\n');
    page = await mesh.openPage('document-owner', {width: 1200, height: 800});
    const response = await fetch(mesh.base + '/api/view', {method: 'POST',
      headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({target: markdown})});
    assert.equal(response.status, 200);
    const described = await response.json();
    const loading = new Promise<void>(resolve => {release = resolve;});
    await page.route('**/view/**', async route => {await loading; await route.continue();});
    await page.evaluate(target => openWeb(target), markdown);
    const frame = page.locator('iframe.web:not([hidden])');
    await frame.waitFor();
    const pane = page.locator('section.pane', {has: frame});
    assert.equal(await frame.getAttribute('sandbox'), described.sandbox);
    await frame.evaluate(frame => {
      const pane = panes.find(pane => pane.el.querySelector('iframe.web') === frame);
      (window as any).documentPane = pane;
      const events = (window as any).menuInvalidations = [];
      const invalidate = pane.invalidateActionView.bind(pane);
      pane.invalidateActionView = () => {events.push(new Error().stack); invalidate();};
    });
    await pane.locator('[data-act="more"]').click();
    assert.equal(await pane.getByRole('menuitem', {name: 'Reload', exact: true}).isVisible(), true);
    release();
    await page.waitForFunction(() => (window as any).documentPane.identityLoad === 'frame-loaded');
    await pane.locator('[role="menu"]').waitFor({state: 'hidden'});
    const invalidations = await page.evaluate(() => (window as any).menuInvalidations as string[]);
    assert.ok(invalidations.some(stack => stack.includes('frameLoaded')), 'initial iframe load retires the menu target');
    t.diagnostic('With inventory already settled, initial iframe load called frameLoaded -> invalidateActionView and closed the early menu.');
    await pane.locator('[data-act="more"]').click();
    const refreshed = page.waitForResponse(result => result.request().method() === 'POST' && result.url().endsWith('/api/view'));
    await pane.getByRole('menuitem', {name: 'Reload', exact: true}).click();
    assert.equal((await refreshed).ok(), true);
    assert.equal(await frame.getAttribute('sandbox'), described.sandbox, 're-description preserves the server sandbox policy');
  } finally {
    try {release(); await page?.unrouteAll({behavior: 'wait'});}
    finally {await mesh.stop();}
  }
});
