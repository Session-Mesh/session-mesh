// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Options field of "New session", end to end in headless Chromium against the real server and
// PTY host: it belongs to a known agent, it is prefilled with the stored default, the "make this the
// default" box is unchecked until the owner ticks it, and storing needs the master token — asked for
// in the dialog, once. A refused save never blocks the session that was already started.
//
// Needs MESH_CHROMIUM (skipped without it unless MESH_REQUIRE_BROWSER=1). The fake `pi` and the
// fake switch give a Pi launch the binary and the board server it needs, so no OCaml build is
// involved: the web server and the PTY host are the Python ones.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

declare const newSubmitGeneration: number | null;
declare const newAccountsReady: boolean;
declare const launchOptionsRevision: string;
declare const active: {id?: string} | null;

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false;

let browser: Browser;
let mesh: Mesh;
const contexts: BrowserContext[] = [];
let bin = '';
let host: ChildProcess | undefined;

before(async () => {
  if (skip) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-options-browser-'));
  bin = path.join(scratch, 'bin');
  const board = path.join(scratch, 'switch', '_opam', 'bin', 'mesh-board-mcp');
  fs.mkdirSync(bin, {recursive: true});
  fs.mkdirSync(path.dirname(board), {recursive: true});
  fs.writeFileSync(board, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'pi'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.0; exit 0; fi\nexec sleep 60\n`, {mode: 0o755});
  const PATH = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('launch-options-browser-', {PATH, MESH_OPAM_SWITCH: path.join(scratch, 'switch')});
  // startMesh runs the web server alone: the PTY host is the one that starts sessions.
  const [hostCommand, ...hostArguments] = ptyhostArgv();
  host = spawn(hostCommand!, hostArguments, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C'}});
  const socket = path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock');
  for (let attempt = 0; attempt < 150 && !fs.existsSync(socket); attempt += 1) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(socket), 'the PTY host listens');
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});

afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  host?.kill('SIGKILL');
  await browser?.close();
  await mesh?.stop();
  if (bin) fs.rmSync(path.dirname(bin), {recursive: true, force: true});
});

async function signedIn(width = 1440): Promise<{page: Page; problems: string[]}> {
  const context = await browser.newContext({locale: 'en-US', viewport: {width, height: 900}});
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  return {page, problems};
}

async function openNew(page: Page, preset: string): Promise<Page> {
  const loaded = page.waitForResponse(response => response.url().endsWith('/api/config')
    && response.request().method() === 'GET');
  await page.locator('#btn-new').click();
  await page.locator('#dlg-new[open]').waitFor();
  // The folder field is required: name one, as a person would (`data.home` is the default when the
  // page received it with the listing).
  const folder = fs.mkdtempSync(path.join(mesh.home, 'work-'));
  await page.locator('#form-new input[name="cwd"]').fill(folder);
  const configuration = await (await loaded).json();
  await page.waitForFunction('revision => newAccountsReady && launchOptionsRevision === revision',
    configuration.launch.agent_options_revision);
  // Dismiss the suggestions before clicking: blur collapses their layout.
  await page.locator('#form-new input[name="cwd"]').blur();
  await page.locator('#new-folder-list').waitFor({state: 'hidden'});
  // The radio itself is display:none (the label carries the style): click the label.
  await page.locator(`#form-new label:has(input[name="preset"][value="${preset}"])`).click();
  assert.equal(await page.locator(`#form-new input[name="preset"][value="${preset}"]`).isChecked(), true);
  return page;
}

const stored = () => {
  const file = path.join(mesh.confDir, 'agent-launch-options.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as {options?: Record<string, string[]>} : null;
};

async function waitStoredHint(page: Page, expected: string): Promise<void> {
  try {
    await page.locator('#new-options-stored').filter({hasText: expected}).waitFor();
  } catch (cause) {
    const details = await page.evaluate(() => ({
      text: document.querySelector('#new-options-stored')?.textContent,
      hidden: (document.querySelector('#new-options-stored') as HTMLElement | null)?.hidden,
      error: document.querySelector('#new-err')?.textContent,
      preset: (document.querySelector('#form-new input[name="preset"]:checked') as HTMLInputElement | null)?.value,
      accountReady: newAccountsReady,
      optionsRevision: launchOptionsRevision,
    })).catch(() => null);
    throw new Error(`stored options hint did not reach ${expected}: ${JSON.stringify(details)}`, {cause});
  }
}

/** Store a default through the configuration route, as the Configuration dialog does. */
async function storeDefault(page: Page, agentOptions: Record<string, string>): Promise<string> {
  return await page.evaluate(async ({token, agentOptions: wanted}) => {
    const json = {'Content-Type': 'application/json'};
    const elevated = await fetch('/api/config/elevate', {method: 'POST', headers: json, body: JSON.stringify({token})});
    if (!elevated.ok) return `elevate ${elevated.status}`;
    const launch = (await (await fetch('/api/config', {headers: json})).json()).launch;
    const saved = await fetch('/api/config/launch-options', {method: 'POST', headers: json,
      body: JSON.stringify({revision: launch.agent_options_revision, agent_options: wanted})});
    return saved.ok ? 'ok' : `save ${saved.status}`;
  }, {token: mesh.token(), agentOptions});
}

/** Hold one genuine response after the server handled it; always release on failure. */
async function holdResponse(page: Page, pattern: string) {
  let signalEntered!: () => void, release!: () => void, signalDone!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { signalDone = resolve; });
  let first = true, expired = false, failure: unknown, status: number | undefined;
  const handler = async (route: import('playwright-core').Route) => {
    if (!first) { await route.continue(); return; }
    first = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await route.fetch();
      status = response.status();
      signalEntered();
      await Promise.race([released, new Promise<void>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(); }, 5000);
      })]);
      await route.fulfill({response});
    } catch (error) {
      failure = error;
      signalEntered();
      await route.abort().catch(() => undefined);
    } finally {
      clearTimeout(timer);
      signalDone();
    }
  };
  await page.route(pattern, handler);
  return {async entered() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([entered, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`response not reached: ${pattern}`)), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    }, release, status: () => status,
    async settled() { await done; assert.equal(failure, undefined); assert.equal(expired, false, 'explicit release won'); },
    async close() { release(); await page.unroute(pattern, handler); }};
}

describe('the Options field of New session', {skip}, () => {
  test('belongs to a known agent and is unchecked by default', async () => {
    const {page, problems} = await signedIn();
    await openNew(page, 'pi');
    assert.equal(await page.locator('#new-options-row').isVisible(), true, 'Pi shows the field');
    assert.equal(await page.locator('#new-options-default-row').isVisible(), true);
    assert.equal(await page.locator('#form-new input[name="optionsDefault"]').isChecked(), false);
    await page.locator('#form-new label:has(input[name="preset"][value="shell"])').click();
    assert.equal(await page.locator('#new-options-row').isVisible(), false, 'shell has no argv Mesh builds');
    assert.equal(await page.locator('#new-options-default-row').isVisible(), false);
    assert.deepEqual(problems, []);
    await page.locator('#dlg-new button[value="cancel"], #dlg-new [data-close-dialog]').first().click();
  });

  test('stores the default with the master token, and a refused save never blocks the session', async () => {
    const {page, problems} = await signedIn();
    await openNew(page, 'pi');
    await page.locator('#form-new input[name="options"]').fill('-e /tmp/ext.mjs');
    await page.locator('#form-new input[name="optionsDefault"]').check();
    await page.locator('#dlg-new button[value="ok"]').click();
    // No elevation yet: the session starts, and the dialog asks for the token instead of closing.
    await page.locator('#new-elevation-row').waitFor({state: 'visible'});
    assert.match(await page.locator('#new-err').innerText(), /not saved/i);
    assert.equal(stored(), null, 'nothing is written without the token');
    await page.locator('#form-new input[name="masterToken"]').fill(mesh.token());
    await page.locator('#dlg-new button[value="ok"]').click();
    await page.locator('#dlg-new[open]').waitFor({state: 'detached'});
    await page.locator('.pane').first().waitFor();
    assert.deepEqual(stored()?.options?.pi, ['-e', '/tmp/ext.mjs']);
    assert.deepEqual(problems, []);
  });

  test('a failed default save opens the already created session without a second launch', async () => {
    const {page, problems} = await signedIn();
    assert.equal(await storeDefault(page, {pi: '-e /tmp/before-failure.mjs'}), 'ok');
    await page.locator('#btn-flow').click();
    await page.locator('#flow').waitFor({state: 'visible'});
    await openNew(page, 'pi');
    let launches = 0, created = '';
    await page.route('**/api/new', async route => {
      launches++;
      const response = await route.fetch();
      if (response.ok()) created = (await response.json()).id;
      await route.fulfill({response});
    });
    await page.route('**/api/config/launch-options', route => route.fulfill({status:500, body:'failed'}));
    try {
      await page.locator('#form-new input[name="options"]').fill('-e /tmp/one-launch.mjs');
      await page.locator('#form-new input[name="optionsDefault"]').check();
      await page.locator('#dlg-new button[value="ok"]').click();
      await page.locator('#new-err').filter({hasText:/not saved/i}).waitFor();
      assert.equal(launches, 1); assert.ok(created);
      assert.equal(await page.locator('#dlg-new[open]').count(), 1);
      await page.locator('#dlg-new button[value="ok"]').click();
      await page.locator('#dlg-new[open]').waitFor({state:'detached'});
      await page.waitForFunction(id => active?.id === id, created);
      assert.equal(await page.locator('#flow').isHidden(), true, 'recovery exposes the created session');
      assert.equal(await page.locator('#panes').isVisible(), true);
      assert.equal(launches, 1, 'closing recovery cannot create a second session');
      assert.deepEqual(problems, []);
    } finally { await page.unrouteAll({behavior:'wait'}); }
  });

  test('a stale default can be saved after the token is entered again', async () => {
    const {page, problems} = await signedIn();
    const other = await signedIn();
    assert.equal(await storeDefault(other.page, {pi: '-e /tmp/before-retry.mjs'}), 'ok');
    await openNew(page, 'pi');
    await waitStoredHint(page, '/tmp/before-retry.mjs');
    await page.locator('#form-new input[name="options"]').fill('-e /tmp/retry.mjs');
    await page.locator('#form-new input[name="optionsDefault"]').check();
    await page.locator('#dlg-new button[value="ok"]').click();
    await page.locator('#new-elevation-row').waitFor({state: 'visible'});
    assert.equal(await storeDefault(other.page, {pi: '-e /tmp/other.mjs'}), 'ok');
    const previousError = await page.locator('#new-err').innerText();
    await page.locator('#form-new input[name="masterToken"]').fill(mesh.token());
    const stale = page.waitForResponse(response => response.url().endsWith('/api/config/launch-options')
      && response.request().method() === 'POST');
    await page.locator('#dlg-new button[value="ok"]').click();
    const staleResponse = await stale;
    assert.equal(staleResponse.status(), 409);
    assert.equal((await staleResponse.json()).error, 'stale-revision');
    await page.waitForFunction(previous => document.querySelector('#new-err')?.textContent !== previous, previousError);
    assert.equal(await page.locator('#dlg-new[open]').count(), 1);
    await page.locator('#form-new input[name="masterToken"]').fill(mesh.token());
    const saved = page.waitForResponse(response => response.url().endsWith('/api/config/launch-options')
      && response.request().method() === 'POST');
    await page.locator('#dlg-new button[value="ok"]').click();
    assert.equal((await saved).status(), 200);
    await page.locator('#dlg-new[open]').waitFor({state: 'detached'});
    assert.deepEqual(stored()?.options?.pi, ['-e', '/tmp/retry.mjs']);
    assert.deepEqual(problems, []);
    assert.deepEqual(other.problems, []);
  });

  test('shows the stored default beside the field and leaves the field and the box empty', async () => {
    const {page, problems} = await signedIn();
    assert.equal(await storeDefault(page, {pi: '-e /tmp/ext.mjs'}), 'ok');
    await page.reload();
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    await openNew(page, 'pi');
    // The field holds only this launch's arguments: sending the default here would add it twice.
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '');
    await waitStoredHint(page, '-e /tmp/ext.mjs');
    assert.equal(await page.locator('#form-new input[name="optionsDefault"]').isChecked(), false);
    await page.locator('#form-new label:has(input[name="preset"][value="codex"])').click();
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '', 'codex has no stored default');
    assert.match(await page.locator('#new-options-stored').innerText(), /No stored default/);
    assert.deepEqual(problems, []);
  });

  test('a preset change starts from that agent\'s default, not from the text typed for another', async () => {
    const {page, problems} = await signedIn();
    assert.equal(await storeDefault(page, {pi: '-e /tmp/default.mjs'}), 'ok');
    await page.reload();
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    await openNew(page, 'pi');
    await waitStoredHint(page, '-e /tmp/default.mjs');
    await page.locator('#form-new input[name="options"]').fill('-e /tmp/typed.mjs');
    await page.locator('#form-new input[name="optionsDefault"]').check();
    // Another agent: its own default (none), never Pi's text and never the "make it the default" box.
    await page.locator('#form-new label:has(input[name="preset"][value="codex"])').click();
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '');
    assert.equal(await page.locator('#form-new input[name="optionsDefault"]').isChecked(), false);
    assert.match(await page.locator('#new-options-stored').innerText(), /No stored default/);
    // And back to Pi: its stored default is shown, and the field is still empty (nothing to send twice).
    await page.locator('#form-new label:has(input[name="preset"][value="pi"])').click();
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '');
    assert.match(await page.locator('#new-options-stored').innerText(), /-e \/tmp\/default\.mjs/);
    assert.deepEqual(problems, []);
  });

  test('text typed while the configuration is still loading is kept', async () => {
    const {page, problems} = await signedIn();
    assert.equal(await storeDefault(page, {pi: '-e /tmp/stored.mjs'}), 'ok');
    await page.reload();
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    // The dialog asks /api/config on open; hold that answer so the typing happens before it lands.
    // The hold is bounded: a route handler that never answers would keep context.close() waiting.
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const bounded = Promise.race([held, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    await page.route('**/api/config', async route => { await bounded; await route.continue(); });
    try {
      await page.locator('#btn-new').click();
      await page.locator('#dlg-new[open]').waitFor();
      await page.locator('#form-new input[name="cwd"]').fill(fs.mkdtempSync(path.join(mesh.home, 'work-')));
      await page.locator('#form-new input[name="cwd"]').blur();
      await page.locator('#new-folder-list').waitFor({state: 'hidden'});
      await page.locator('#form-new label:has(input[name="preset"][value="pi"])').click();
      await page.locator('#form-new input[name="options"]').fill('-e /tmp/typed-early.mjs');
      release();
      // The hint names the stored default only once the answer landed: that is the completion signal,
      // not a delay.
      await page.locator('#new-options-stored').filter({hasText: '/tmp/stored.mjs'}).waitFor();
      assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/typed-early.mjs',
        'the configuration answer must not touch the typed field');
      assert.deepEqual(problems, []);
    } finally {
      release();
      await page.unroute('**/api/config').catch(() => undefined);
    }
  });

  for (const checked of [false, true]) {
    test(`the default-save choice is captured at submit (initially ${checked})`, async () => {
      const {page, problems} = await signedIn();
      assert.equal(await storeDefault(page, {pi: ''}), 'ok'); // this context may save without another token
      await openNew(page, 'pi');
      await page.locator('#new-options-stored').filter({hasText: 'No stored default'}).waitFor();
      await page.locator('#form-new input[name="options"]').fill('-e /tmp/submitted.mjs');
      await page.locator('#form-new input[name="optionsDefault"]').setChecked(checked);
      const held = await holdResponse(page, '**/api/new');
      try {
        await page.locator('#dlg-new button[value="ok"]').click();
        await held.entered();
        await page.locator('#form-new input[name="options"]').fill('-e /tmp/later.mjs');
        await page.locator('#form-new input[name="optionsDefault"]').setChecked(!checked);
        held.release();
        await held.settled();
        await page.locator('#dlg-new[open]').waitFor({state: 'detached'});
        assert.deepEqual(stored()?.options?.pi, checked ? ['-e', '/tmp/submitted.mjs'] : undefined);
        assert.deepEqual(problems, []);
      } finally { await held.close(); }
    });
  }

  for (const phase of ['create', 'saved', 'refused', 'elevating'] as const) {
    test(`a late ${phase} response leaves a reopened dialog intact`, async () => {
      const {page, problems} = await signedIn();
      const other = await signedIn();
      assert.equal(await storeDefault(phase === 'saved' ? page : other.page, {pi: ''}), 'ok');
      await openNew(page, 'pi');
      await page.locator('#new-options-stored').filter({hasText: 'No stored default'}).waitFor();
      await page.locator('#form-new input[name="options"]').fill('-e /tmp/old-opening.mjs');
      await page.locator('#form-new input[name="optionsDefault"]').check();
      const posts: string[] = [];
      page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
      if (phase === 'elevating') {
        await page.locator('#dlg-new button[value="ok"]').click();
        await page.locator('#new-elevation-row').waitFor({state: 'visible'});
        await page.locator('#form-new input[name="masterToken"]').fill(mesh.token());
      }
      const held = await holdResponse(page, phase === 'create' ? '**/api/new'
        : phase === 'elevating' ? '**/api/config/elevate' : '**/api/config/launch-options');
      try {
        await page.locator('#dlg-new button[value="ok"]').click();
        await held.entered();
        await page.locator('#dlg-new button[value="cancel"], #dlg-new [data-close-dialog]').first().click();
        await openNew(page, 'pi');
        await waitStoredHint(page, phase === 'saved' ? '/tmp/old-opening.mjs' : 'No stored default');
        await page.locator('#form-new input[name="options"]').fill('-e /tmp/new-draft.mjs');
        held.release();
        await held.settled();
        assert.equal(held.status(), phase === 'refused' ? 403 : 200);
        await page.waitForFunction(() => newSubmitGeneration === null);
        assert.equal(await page.locator('#dlg-new[open]').count(), 1);
        assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/new-draft.mjs');
        assert.equal(await page.locator('#form-new input[name="optionsDefault"]').isChecked(), false);
        assert.equal(await page.locator('#new-elevation-row').isVisible(), false);
        assert.equal(await page.locator('#new-err').innerText(), '');
        assert.equal(await page.locator('#dlg-new').getAttribute('data-pending-default'), null);
        assert.equal(await page.locator('#form-new input[name="masterToken"]').inputValue(), '');
        assert.equal(posts.filter(url => url === '/api/new').length, 1);
        assert.equal(posts.filter(url => url === '/api/config/launch-options').length, phase === 'create' ? 0 : 1);
        assert.deepEqual(problems, []);
        assert.deepEqual(other.problems, []);
      } finally { await held.close(); }
    });
  }

  test('configuration from an earlier opening cannot replace the current hint or draft', async () => {
    const {page, problems} = await signedIn();
    const other = await signedIn();
    assert.equal(await storeDefault(other.page, {pi: '-e /tmp/old-config.mjs'}), 'ok');
    const held = await holdResponse(page, '**/api/config');
    // Observe the actual exported opening promise, including its final configuration application.
    const firstOpening = page.evaluate('openNew()');
    try {
      await held.entered();
      await page.locator('#dlg-new button[value="cancel"], #dlg-new [data-close-dialog]').first().click();
      assert.equal(await storeDefault(other.page, {pi: '-e /tmp/current-config.mjs'}), 'ok');
      await openNew(page, 'pi');
      await page.locator('#new-options-stored').filter({hasText: '/tmp/current-config.mjs'}).waitFor();
      await page.locator('#form-new input[name="options"]').fill('-e /tmp/current-draft.mjs');
      held.release();
      await held.settled();
      await firstOpening;
      assert.match(await page.locator('#new-options-stored').innerText(), /current-config/);
      assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/current-draft.mjs');
      assert.equal(await page.locator('#dlg-new[open]').count(), 1);
      assert.deepEqual(problems, []);
      assert.deepEqual(other.problems, []);
    } finally { await held.close(); await firstOpening; }
  });
});
