// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pane's "More" menu (createMenu, static/pane-actions.ts) before the session list has named the
// pane's session. A terminal pane opens and attaches before the first listing, and until then no
// target can be captured. The menu used to ignore the click; it now opens with its entries marked
// unavailable, runs nothing from them, and binds when a refresh can capture a target. The menu is not
// marked busy (some screen readers then hold back its content), and an unbound menu does not hold a
// pending reload of the page: it holds nothing that a reload would lose. The phone's
// line waits for that listing in its own way: tests/held-line.test.ts, phone-held-line-browser.test.ts.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it.
import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const skip = !process.env.MESH_CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

type Probe = {bound: boolean; runs: string[]; released: number; holds: boolean[]; refresh(): void; close(): void};

test('an unbound pane menu opens, runs nothing, and binds on the next refresh', {skip}, async () => {
  const browser = await chromium.launch(chromiumLaunchOptions(process.env.MESH_CHROMIUM ?? '', ['--no-sandbox', '--mute-audio']));
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="pane"><button data-act="more">More</button><div role="menu" hidden></div></div>');
    await page.addScriptTag({path: path.join(ROOT, 'static/pane-actions.js')});
    await page.evaluate(() => {
      const win = window as unknown as {MeshPaneActions: {createMenu: Function}; probe: Probe};
      const probe = {bound: false, runs: [] as string[], released: 0, holds: [] as boolean[]} as Probe;
      const target = {};
      const menu = win.MeshPaneActions.createMenu(document.querySelector('.pane'), {
        activate: () => {}, canFocus: () => true, fallbackFocus: () => {}, reportError: () => {},
        hold: (held: boolean) => { probe.holds.push(held); },
        actions: () => [{id: 'compose', label: 'Write in the terminal…', messageKey: 'action.compose', danger: false}],
        capture: () => (probe.bound ? target : null),
        valid: (candidate: object) => candidate === target,
        release: () => { probe.released += 1; },
        run: (action: string) => { probe.runs.push(action); },
      });
      Object.assign(probe, {refresh: () => menu.refresh(), close: () => menu.close()});
      win.probe = probe;
    });
    const entry = page.getByRole('menuitem', {name: 'Write in the terminal…'});
    await page.locator('[data-act="more"]').click();
    assert.equal(await entry.isVisible(), true, 'the menu opens before a target exists');
    assert.equal(await entry.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('[role="menu"]').getAttribute('aria-busy'), null, 'never marked busy');
    const holds = () => page.evaluate(() => (window as unknown as {probe: Probe}).probe.holds);
    assert.equal((await holds()).includes(true), false, 'an unbound menu does not hold a reload');
    await entry.dispatchEvent('click');
    assert.deepEqual(await page.evaluate(() => (window as unknown as {probe: Probe}).probe.runs), [], 'an unbound entry runs nothing');
    assert.equal(await entry.isVisible(), true, 'and the menu stays open');

    await page.evaluate(() => { const probe = (window as unknown as {probe: Probe}).probe; probe.bound = true; probe.refresh(); });
    assert.equal(await entry.getAttribute('aria-disabled'), null);
    assert.equal((await holds()).at(-1), true, 'once bound, the open menu holds a reload');
    await entry.click();
    const after = await page.evaluate(() => { const {runs, released} = (window as unknown as {probe: Probe}).probe; return {runs, released}; });
    assert.deepEqual(after, {runs: ['compose'], released: 1});
    assert.equal(await page.locator('[role="menu"]').isHidden(), true);

    // Closing an unbound menu releases nothing (nothing was captured).
    await page.evaluate(() => { (window as unknown as {probe: Probe}).probe.bound = false; });
    await page.locator('[data-act="more"]').click();
    await page.evaluate(() => (window as unknown as {probe: Probe}).probe.close());
    assert.equal(await page.evaluate(() => (window as unknown as {probe: Probe}).probe.released), 1);
  } finally {
    await browser.close();
  }
});
