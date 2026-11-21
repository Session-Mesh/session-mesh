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
  await page.locator('#btn-new').click();
  await page.locator('#dlg-new[open]').waitFor();
  // The folder field is required: name one, as a person would (`data.home` is the default when the
  // page received it with the listing).
  const folder = fs.mkdtempSync(path.join(mesh.home, 'work-'));
  await page.locator('#form-new input[name="cwd"]').fill(folder);
  // The radio itself is display:none (the label carries the style): click the label.
  await page.locator(`#form-new label:has(input[name="preset"][value="${preset}"])`).click();
  return page;
}

const stored = () => {
  const file = path.join(mesh.confDir, 'agent-launch-options.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as {options?: Record<string, string[]>} : null;
};

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

  test('prefills a stored default and leaves the box unchecked', async () => {
    const {page, problems} = await signedIn();
    // The default is stored through the configuration route, as the Configuration dialog does, so
    // this case does not depend on the one above.
    const stored = await page.evaluate(async (token) => {
      const json = {'Content-Type': 'application/json'};
      const elevated = await fetch('/api/config/elevate', {method: 'POST', headers: json, body: JSON.stringify({token})});
      if (!elevated.ok) return `elevate ${elevated.status}`;
      const launch = (await (await fetch('/api/config', {headers: json})).json()).launch;
      const saved = await fetch('/api/config/launch-options', {method: 'POST', headers: json,
        body: JSON.stringify({revision: launch.agent_options_revision, agent_options: {pi: '-e /tmp/ext.mjs'}})});
      return saved.ok ? 'ok' : `save ${saved.status}`;
    }, mesh.token());
    assert.equal(stored, 'ok');
    await page.reload();
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    await openNew(page, 'pi');
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/ext.mjs');
    assert.equal(await page.locator('#form-new input[name="optionsDefault"]').isChecked(), false);
    await page.locator('#form-new label:has(input[name="preset"][value="codex"])').click();
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '', 'codex has no stored default');
    assert.deepEqual(problems, []);
  });

  test('a preset change starts from that agent\'s default, not from the text typed for another', async () => {
    const {page, problems} = await signedIn();
    const stored = await page.evaluate(async (token) => {
      const json = {'Content-Type': 'application/json'};
      await fetch('/api/config/elevate', {method: 'POST', headers: json, body: JSON.stringify({token})});
      const launch = (await (await fetch('/api/config', {headers: json})).json()).launch;
      const saved = await fetch('/api/config/launch-options', {method: 'POST', headers: json,
        body: JSON.stringify({revision: launch.agent_options_revision, agent_options: {pi: '-e /tmp/default.mjs'}})});
      return saved.ok ? 'ok' : `save ${saved.status}`;
    }, mesh.token());
    assert.equal(stored, 'ok');
    await page.reload();
    await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
    await openNew(page, 'pi');
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/default.mjs');
    await page.locator('#form-new input[name="options"]').fill('-e /tmp/typed.mjs');
    await page.locator('#form-new input[name="optionsDefault"]').check();
    // Another agent: its own default (none), never Pi's text and never the "make it the default" box.
    await page.locator('#form-new label:has(input[name="preset"][value="codex"])').click();
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '');
    assert.equal(await page.locator('#form-new input[name="optionsDefault"]').isChecked(), false);
    // And back: Pi's stored default, not the text typed for Pi a moment ago.
    await page.locator('#form-new label:has(input[name="preset"][value="pi"])').click();
    assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/default.mjs');
    assert.deepEqual(problems, []);
  });

  test('text typed while the configuration is still loading is kept', async () => {
    const {page, problems} = await signedIn();
    // The dialog asks /api/config on open; hold that answer so the typing happens before it lands.
    // The hold is bounded: a route handler that never answers would keep context.close() (and so the
    // whole job) waiting.
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const bounded = Promise.race([held, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    await page.route('**/api/config', async route => { await bounded; await route.continue(); });
    try {
      await page.locator('#btn-new').click();
      await page.locator('#dlg-new[open]').waitFor();
      await page.locator('#form-new input[name="cwd"]').fill(fs.mkdtempSync(path.join(mesh.home, 'work-')));
      await page.locator('#form-new label:has(input[name="preset"][value="pi"])').click();
      await page.locator('#form-new input[name="options"]').fill('-e /tmp/typed-early.mjs');
      release();
      await page.waitForTimeout(700);   // the answer lands and must not overwrite what the owner typed
      assert.equal(await page.locator('#form-new input[name="options"]').inputValue(), '-e /tmp/typed-early.mjs');
      assert.deepEqual(problems, []);
    } finally {
      release();
      await page.unroute('**/api/config').catch(() => undefined);
    }
  });
});
