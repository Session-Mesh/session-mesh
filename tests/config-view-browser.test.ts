// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "Configuration" dialog: a read-only view of the paths, versions, agents, network and
// notification state this mesh is using, with a copy button on each path. Run in headless
// Chromium on a throwaway server; the page's data is the test's own.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure). MESH_SHOT_DIR=<dir> also saves screenshots of the dialog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {type Mesh} from './mesh-server-lib.ts';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

let lab: AgentMesh;
let mesh: Mesh;
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  // A skipped describe does not skip this file-level hook: start nothing without a Chromium.
  if (skip) return;
  lab = await AgentMesh.start('cfgui-', ['alpha']);
  mesh = lab.mesh;
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  await lab?.stop();
});

async function signedIn(locale: string, width: number, height = 900): Promise<{page: Page; problems: string[]; calls: string[]}> {
  const context = await browser.newContext({locale, viewport: {width, height}, permissions: ['clipboard-read', 'clipboard-write']});
  contexts.push(context);
  const page = await context.newPage();
  const problems: string[] = [];
  const calls: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => { if (/Content Security Policy|violat/i.test(message.text())) problems.push(message.text()); });
  page.on('request', request => { const {pathname} = new URL(request.url()); if (pathname === '/api/config') calls.push(request.method()); });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForSelector('#btn-config', {state: 'attached'});
  return {page, problems, calls};
}

async function openConfig(page: Page, width: number): Promise<void> {
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-config"]').click();
  } else {
    await page.locator('#btn-config').click();
  }
  await page.locator('#dlg-config[open] .config-section').first().waitFor();
}

async function fits(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const box = document.querySelector('#dlg-config') as HTMLElement;
    const rect = box.getBoundingClientRect();
    const wide = [...box.querySelectorAll<HTMLElement>('.config-value, .config-row, dt, dd')]
      .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent);
    return {document: document.documentElement.scrollWidth <= innerWidth, dialog: box.scrollWidth <= box.clientWidth,
      inside: rect.left >= 0 && rect.right <= innerWidth, wide};
  });
  assert.deepEqual(result, {document: true, dialog: true, inside: true, wide: []});
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, {recursive: true});
  const width = page.viewportSize()!.width;
  await page.setViewportSize({width, height: width > 600 ? 1500 : 2600});
  // Only the #dlg-config element: the sidebar behind it lists this machine's real sessions.
  await page.locator('#dlg-config').screenshot({path: path.join(SHOTS, `${name}.png`)});
}

describe('the Configuration dialog', {skip}, () => {
  for (const width of [1440, 390]) {
    test(`shows the paths, version, host, agents, network and notifications at ${width}px, English`, async () => {
      const {page, problems, calls} = await signedIn('en-US', width);
      await openConfig(page, width);
      const dialog = page.locator('#dlg-config');
      const text = await dialog.innerText();
      assert.deepEqual(calls, ['GET'], 'one read, nothing else');
      for (const label of ['Paths', 'Version', 'Terminal host', 'Agents', 'Network', 'Notifications and language',
        'Configuration folder', 'Terminal host socket', 'Uploads cache', 'mesh-open (installation)', 'mesh-board-mcp',
        'Port', 'Tailscale', 'Interface language']) assert.ok(text.includes(label), label);
      assert.ok(text.includes(mesh.confDir), 'the effective configuration folder');
      assert.ok(text.includes(path.join(mesh.home, '.cache', 'session-mesh', 'uploads')));
      assert.ok(text.includes('version not detected'), 'no agent version is guessed');
      assert.ok(text.includes('not seen in this request'));
      assert.ok(text.includes('accepting connections') && text.includes('native'), 'the test host is the native one');
      assert.ok(text.includes(String(mesh.port)));
      assert.equal(await dialog.locator('button, a, input, select, textarea').evaluateAll(
        nodes => nodes.filter(node => !node.matches('.config-copy, .config-edit, [data-close-dialog]')).length), 0, 'copy and close are the only controls');
      await shot(page, `config-${width}-en`);
      await fits(page);
      assert.deepEqual(problems, []);
    });
  }

  test('is translated in French and keeps the French catalog keys out of English', async () => {
    const {page} = await signedIn('fr-FR', 1440);
    await openConfig(page, 1440);
    const text = await page.locator('#dlg-config').innerText();
    for (const label of ['Chemins', 'Dossier de configuration', 'Host des terminaux', 'Capacités annoncées', 'Réseau',
      'Langue de l’interface', 'version non détectée']) assert.ok(text.includes(label), label);
    assert.ok(!/config\.[a-z]/.test(text), 'no raw key is displayed');
    await shot(page, 'config-1440-fr');
  });

  test('copies a path to the clipboard and shows no secret', async () => {
    const {page} = await signedIn('en-US', 1440);
    await openConfig(page, 1440);
    const row = page.locator('.config-row', {hasText: 'Configuration folder'});
    await row.locator('.config-copy').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), mesh.confDir);
    const shown = await page.locator('#dlg-config').innerText();
    for (const secret of [mesh.token(), 'vapid.pem', 'push.json', 'session-requests', 'PRIVATE KEY']) {
      assert.ok(!shown.includes(secret), secret.slice(0, 8));
    }
  });

  test('is closed with Escape and reopens with fresh data', async () => {
    const {page, calls} = await signedIn('en-US', 1440);
    await openConfig(page, 1440);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#dlg-config').evaluate((node: HTMLDialogElement) => node.open), false);
    await openConfig(page, 1440);
    assert.equal(calls.length, 2);
  });

  test('treats hostile values as text', async () => {
    const {page} = await signedIn('en-US', 1440);
    await page.route('**/api/config', route => route.fulfill({json: {
      paths: {config_dir: '/x/<img src=x onerror=window.__pwn=1>'}, version: {client: '<script>window.__pwn=1</script>', commit: null, install_name: 'a'},
      host: {running: true, kind: 'native', executable: 'mesh-ptyhost', version: null, capabilities: ['<b>x</b>']},
      agents: [{agent: 'claude', path: '/bin/claude', version: null, enabled: true}], launch: {configured: false, workspace_roots: []},
      network: {port: 1, listen_host: '127.0.0.1', loopback_only: true, trust_proxy: false, request_scheme: 'http', request_host: 'h', tailscale: 'not-seen'},
      notifications: {vapid_key_present: false, subscriptions: 0}}}));
    await openConfig(page, 1440);
    assert.equal(await page.locator('#dlg-config img, #dlg-config script, #dlg-config b').count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as {__pwn?: number}).__pwn), undefined);
    assert.ok((await page.locator('#dlg-config').innerText()).includes('<img src=x'));
  });

  test('says so when the configuration cannot be loaded', async () => {
    const {page} = await signedIn('en-US', 390);
    await page.route('**/api/config', route => route.fulfill({status: 500, body: 'no'}));
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-config"]').click();
    await page.locator('#dlg-config[open]').waitFor();
    await page.locator('#config-body', {hasText: 'could not be loaded'}).waitFor({timeout: 5000});
  });
});
