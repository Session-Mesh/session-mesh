// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Wrapped terminal links, in the real interface: the packaged app.js and terminal-links.js, the
// xterm renderer and real mouse cells in Chromium, behind a throwaway server.py and PTY host.
// A bare Pane is mounted over the page at 48 columns; only the destinations (window.open and
// openWeb) are intercepted, no session is attached.
// Scenarios: tests/wrapped-links-modes.ts (both input modes) and tests/wrapped-links-plain.ts.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure).
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import type {Page} from 'playwright-core';
import {skip, TerminalMesh} from './terminal-browser-lib.ts';
import {COLS, mountPane} from './wrapped-links-lib.ts';
import {allModeScenarios} from './wrapped-links-modes.ts';
import {allPlainScenarios} from './wrapped-links-plain.ts';

let mesh: TerminalMesh;
let page: Page;
before(async () => {
  if (skip) return;
  mesh = new TerminalMesh();
  await mesh.start();
  await mesh.newShell('links');
  page = await mesh.signIn({width: 1280, height: 800});
});
after(async () => { await mesh?.stop(); });

test('wrapped terminal links activate real xterm cells', {timeout: 600000, skip}, async (t) => {
  async function scenario(name: string, check: (page: Page) => Promise<void>) {
    await t.test(name, async () => {
      await page.evaluate(mountPane);
      await page.waitForFunction(() => Boolean(globalThis.__linkPane?.term?.element));
      assert.equal(await page.evaluate(() => globalThis.__linkPane!.term.cols), COLS);
      await check(page);
    });
  }
  for (const mouse of [false, true]) {
    const ctx = {scenario, mouse, mode: mouse ? 'mouse-tracking' : 'normal'};
    for (const scenarios of allModeScenarios) await scenarios(ctx);
  }
  for (const scenarios of allPlainScenarios) await scenarios(scenario);
});
