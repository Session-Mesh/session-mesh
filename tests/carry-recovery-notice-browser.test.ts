// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {startMesh} from './mesh-server-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const executable = process.env.MESH_CHROMIUM;
declare const sessionRequestGate: {consider(requests: object[]): void};
declare const MeshI18n: {locale(): string; serverMessage(message: string): string};
test('the owner sees the translated recovery warning on desktop and phone', {skip: !executable}, async () => {
  const mesh = await startMesh('carry-notice-');
  const browser = await chromium.launch(chromiumLaunchOptions(executable!, ['--no-sandbox', '--mute-audio']));
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({locale: 'fr', viewport: {width, height: 850}, serviceWorkers: 'block'});
      try {
        const page = await context.newPage();
        page.on('dialog', dialog => { void dialog.accept(); });
        await context.route('**/api/session-actions/*/claim', route => route.fulfill({json: {claim_nonce: 'a'.repeat(32)}}));
        await context.route('**/api/session-actions/*/decision', route => route.fulfill({json: {request: {
          state: 'completed', result: {notice: 'An older target copy was retained for recovery. It may receive late writes; review it before cleanup.'}
        }}}));
        await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
        await page.goto(`${mesh.base}/`);
        await page.waitForFunction(() => typeof sessionRequestGate !== 'undefined' && MeshI18n.locale().startsWith('fr'));
        await page.waitForFunction(() => MeshI18n.serverMessage('An older target copy was retained for recovery. It may receive late writes; review it before cleanup.').startsWith('Une ancienne'));
        await page.evaluate(id => sessionRequestGate.consider([{id, action: 'switch_account', state: 'pending',
          source: {id: 'example'}, account: 'work', from_account: 'default', preset: 'codex', model: null}]), `mock-${width}`);
        const flash = page.locator('#flash');
        await flash.waitFor({state: 'visible'});
        assert.match(await flash.innerText(), /ancienne copie.*conservée/i);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await mesh.stop(); }
});
