// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Real server policy, authenticated relay and worker; only microphone input and
// the upstream transcription service are test-owned substitutes. No model calls.
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {constants} from 'node:fs';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {chromium, type Browser, type BrowserContext} from 'playwright-core';
import {REPO, startMesh, type Mesh} from './mesh-server-lib.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

declare const active: {id: string; conn?: {terminal?: {isOpen(): boolean}; replayPending?: boolean; replaying?: boolean; draining?: boolean}};
declare const dictationInventoryReady: boolean;
declare function composeDictationSession(): {state: string; text: string} | null;
const chrome = process.env.MESH_CHROMIUM ?? '';
const skip = !chrome && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

async function policyWatch(context: BrowserContext): Promise<unknown[]> {
  const violations: unknown[] = [];
  await context.exposeBinding('__dictationCspViolation', (_source, violation) => { violations.push(violation); });
  await context.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    (window as any).__dictationCspViolation({directive: event.effectiveDirective, blocked: event.blockedURI});
  }));
  return violations;
}

async function stopHost(host: ChildProcess, socket: string): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  try {
    const sessions = await request(socket, {op: 'list'}) as {name: string}[];
    for (const session of sessions) await request(socket, {op: 'kill', name: session.name});
    await waitFor('private CSP sessions reaped', 15000, async () => (await request(socket, {op: 'list'}) as unknown[]).length === 0);
  } finally {
    host.kill('SIGTERM');
    try { await waitFor('private CSP host exit', 5000, () => host.exitCode !== null || host.signalCode !== null); }
    catch { host.kill('SIGKILL'); await waitFor('private CSP host reaped', 3000, () => host.exitCode !== null || host.signalCode !== null); }
  }
}

async function cleanup(tasks: (() => Promise<unknown>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const task of tasks) try { await task(); } catch (error) { errors.push(error); }
  assert.deepEqual(errors, [], 'every private CSP resource must be cleaned up');
}

async function createSession(mesh: Mesh): Promise<void> {
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST',
    headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'csp-dictation', cwd: mesh.home, preset: 'shell'})});
  assert.equal(response.status, 200, await response.clone().text());
}

for (const language of ['en', 'fr']) test(`dictation uses real main-page CSP and localized controls (${language})`, {skip, timeout:90000}, async () => {
  assert.ok(chrome, 'MESH_CHROMIUM must name an executable when browser tests are required');
  assert.ok(process.env.MESH_PTYHOST_CMD, 'MESH_PTYHOST_CMD must select this tree\'s fresh native build explicitly');
  const command = [process.env.MESH_PTYHOST_CMD];
  assert.equal(command.length, 1, 'MESH_PTYHOST_CMD is one plain executable path, not a shell command');
  assert.ok(path.isAbsolute(command[0]), 'MESH_PTYHOST_CMD must be an absolute executable path');
  await access(command[0], constants.X_OK);
  let uploads = 0;
  const upstreamErrors: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      let bytes = 0; for await (const chunk of req) bytes += chunk.length;
      assert.ok(bytes > 0); uploads++;
      res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({text: 'known synthetic transcript'}));
    } catch (error) { upstreamErrors.push(error); res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as {port: number}).port;
  let mesh: Mesh | undefined, host: ChildProcess | undefined, browser: Browser | undefined, socket = '';
  try {
    mesh = await startMesh('dcsp-', {MESH_WHISPER_URL: `http://127.0.0.1:${port}/transcriptions`, MESH_PTYHOST_CMD: command[0]});
    const runtime = path.join(mesh.home, 'run'); socket = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    host = spawn(command[0], [], {cwd: REPO, stdio: 'ignore', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: mesh.home, XDG_RUNTIME_DIR: runtime, LANG: 'C', SHELL: '/bin/sh'}});
    await waitFor('private CSP host socket', 10000, () => request(socket, {op: 'list'}).then(() => true, () => false));
    await createSession(mesh);
    browser = await chromium.launch(chromiumLaunchOptions(chrome,
      ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      {headless: true}));
    const context = await browser.newContext({locale: language});
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(15000);
    await context.addInitScript(() => {
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), root = window as any;
      root.micStreams = [];
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await gum(constraints); root.micStreams.push(stream); return stream;
      };
    });
    const violations = await policyWatch(context), page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${mesh.base}/login`);
    await page.locator('input[name="token"]').fill(mesh.token());
    await Promise.all([page.waitForURL(`${mesh.base}/`), page.getByRole('button').click()]);
    await page.goto(`${mesh.base}/#csp-dictation`); await page.reload();
    await page.waitForFunction(() => active?.id === 'csp-dictation' && active.conn?.terminal?.isOpen() && dictationInventoryReady
      && !active.conn.replayPending && !active.conn.replaying && !active.conn.draining);
    const policy = await page.request.get(mesh.base);
    const scriptPolicy = (policy.headers()['content-security-policy'] ?? '').split(';').find(part => part.trim().startsWith('script-src'));
    assert.equal(scriptPolicy?.trim(), "script-src 'self'");
    await page.locator('.pane.active [data-act="more"]').click();
    await page.locator('.pane.active [data-menu-action="compose"]').click();
    assert.equal(await page.locator('#dictation-auto-send').isChecked(), false);
    assert.match(await page.locator('#compose-mic').getAttribute('aria-label') ?? '', language === 'fr' ? /dicter/i : /dictat/i);
    await page.locator('#compose-mic[aria-disabled="false"]').waitFor({state: 'visible'});
    await page.locator('#compose-mic').focus(); await page.keyboard.down('Space');
    await page.waitForFunction(() => composeDictationSession()?.state === 'recording');
    await page.waitForTimeout(350); await page.keyboard.up('Space');
    await page.waitForFunction(() => composeDictationSession()?.state === 'ready');
    assert.equal(await page.locator('#compose-text').inputValue(), 'known synthetic transcript');
    assert.equal(uploads, 1);
    assert.equal(await page.evaluate(() => (window as any).micStreams.length), 1);
    assert.equal(await page.evaluate(() => (window as any).micStreams.every((stream: MediaStream) =>
      stream.getTracks().every(track => track.readyState === 'ended'))), true);
    assert.deepEqual(upstreamErrors, []);
    assert.deepEqual(errors, []); assert.deepEqual(violations, []);
  } finally {
    await cleanup([async () => browser?.close(), async () => host && stopHost(host, socket), async () => mesh?.stop(), async () => {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    }]);
  }
});
