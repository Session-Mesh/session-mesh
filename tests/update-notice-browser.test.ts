// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The update banner in the page, end to end: the native PTY host runs the check (here against a
// stand-in curl, so no request leaves the machine), logs one line at startup and answers the
// server's `update_notice` request; the server relays it in /api/sessions; the page shows the
// banner, and closing it is remembered for that release only (in the page's memory when the
// browser's storage is unusable).
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {startUpdateHost, NOTES, type UpdateHost} from './helpers/update-host.ts';
import {startMesh, type Mesh} from './mesh-server-lib.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
let command = '';   // the upgrade command the host reports: it names the installation's own directory
let line = '';

let mesh: Mesh;
let host: UpdateHost;
let browser: Browser;

before(async () => {
  if (skip) return;
  mesh = await startMesh('upd-');
  host = startUpdateHost(mesh, {release: true});
  for (let attempt = 0; attempt < 200 && !line; attempt += 1) {
    const listed = await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base}})).json() as
      {update: {line?: string; upgrade_command?: string} | null};
    if (listed.update) ({line = '', upgrade_command: command = ''} = listed.update);
    else await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(line, 'the host announced the release');
  browser = await chromium.launch({executablePath: CHROMIUM, args: ['--no-sandbox', '--mute-audio']});
});
after(async () => {
  await browser?.close();
  await host?.stop();
  await mesh?.stop();
});

async function signedIn(locale: string, width = 1280): Promise<{page: Page; problems: string[]}> {
  const context = await browser.newContext({locale, viewport: {width, height: 800}});
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) problems.push(message.text()); });
  page.on('request', request => {
    const url = request.url();
    if (/^(https?|wss?):/.test(url) && !url.startsWith(mesh.base) && !url.startsWith(mesh.base.replace('http', 'ws'))) problems.push(`request to ${url}`);
  });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  return {page, problems};
}

describe('update notice banner', {skip}, () => {
  test('the PTY host logs one line at startup', () => {
    assert.equal(host.log().split(`mesh-ptyhost: ${line}`).length - 1, 1);
    assert.equal(mesh.output().includes('is available'), false, 'and the server none');
  });

  test('shows the release, its notes and the command; closing it holds until a newer release', async () => {
    const {page, problems} = await signedIn('en-US');
    const banner = page.locator('#update-notice');
    await banner.waitFor({state: 'visible', timeout: 15000});
    assert.equal(await banner.getAttribute('role'), 'status');
    assert.match(await banner.innerText(), /Session Mesh v0\.2\.0 is available, with a security fix\./);
    assert.equal(await banner.locator('a').getAttribute('href'), NOTES);
    assert.equal(await banner.locator('a').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await banner.locator('code').innerText(), command);
    const close = page.getByRole('button', {name: 'Hide this notice until the next release'});
    await close.click();
    await banner.waitFor({state: 'hidden'});
    assert.equal(await page.evaluate(() => localStorage.getItem('mesh.update.dismissed')), 'v0.2.0');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#update-notice')?.hasAttribute('hidden') === true);
    await page.waitForTimeout(3000);   // several /api/sessions polls: still closed
    assert.equal(await banner.isVisible(), false);

    // Dismissed for an older release only: the newer one comes back.
    await page.evaluate(() => localStorage.setItem('mesh.update.dismissed', 'v0.1.9'));
    await page.reload();
    await banner.waitFor({state: 'visible', timeout: 15000});
    assert.deepEqual(problems, []);
  });

  test('without usable storage a closed banner stays closed at the next poll', async () => {
    const context = await browser.newContext({locale: 'en-US', viewport: {width: 1280, height: 800}});
    await context.addInitScript(() => {
      const blocked = () => { throw new Error('storage blocked'); };
      Object.defineProperty(Storage.prototype, 'getItem', {value: blocked});
      Object.defineProperty(Storage.prototype, 'setItem', {value: blocked});
    });
    const page = await context.newPage();
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    const banner = page.locator('#update-notice');
    await banner.waitFor({state: 'visible', timeout: 15000});
    await page.getByRole('button', {name: 'Hide this notice until the next release'}).click();
    await banner.waitFor({state: 'hidden'});
    await page.waitForTimeout(3000);   // several /api/sessions polls
    assert.equal(await banner.isVisible(), false);
    await context.close();
  });

  test('French, and no sideways scroll on a phone', async () => {
    const {page, problems} = await signedIn('fr-FR', 360);
    const banner = page.locator('#update-notice');
    await banner.waitFor({state: 'visible', timeout: 15000});
    assert.match(await banner.innerText(), /Session Mesh v0\.2\.0 est disponible, avec un correctif de sécurité\./);
    assert.ok(await page.getByRole('button', {name: "Masquer cet avis jusqu'à la prochaine version"}).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(problems, []);
  });
});
