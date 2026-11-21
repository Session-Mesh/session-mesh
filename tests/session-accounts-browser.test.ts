// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "Account" choice of the New session dialog in the real interface, for any number of aliases. An alias
// without a folder for the chosen agent stays selected but greyed, and a browser's form leaves a disabled option
// out of what it sends: the dialog must then refuse, never start the session under the default account. So
// must an alias remembered on this device but no longer declared. The default account sends no `account`; an
// alias sends its id only. The list is sorted by label, works from the keyboard and fits a 390 px phone with
// 64 aliases. POST /api/new is intercepted (nothing is started): the server's own refusals are in
// session-accounts.test.ts.
// Needs MESH_CHROMIUM, MESH_PTYHOST_CMD and mesh-platform (MESH_MESH_PLATFORM_CMD or the dune build; with
// MESH_REQUIRE_MESH_PLATFORM=1 its absence is a failure).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {REPO, TerminalMesh, skip} from './terminal-browser-lib.ts';

declare function openNew(): Promise<void>;
declare function fillAccounts(accounts: unknown[]): void;
declare const meshContext: {storagePrefix: string};

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
const SKIP = skip || (fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built (${PLATFORM})`);

type Alias = {id: string; label: string; claude_config_dir?: string; codex_home?: string};

describe('account choice of the New session dialog', {skip: SKIP}, () => {
  const mesh = new TerminalMesh({MESH_MESH_PLATFORM_CMD: PLATFORM});
  const accounts = path.join(mesh.home, '.agent-accounts');
  const pages: Page[] = [];

  /** An alias whose folders exist (0700) under ~/.agent-accounts/<id>. */
  function alias(id: string, label: string, claude: boolean, codex: boolean): Alias {
    const folder = path.join(accounts, id);
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    fs.chmodSync(accounts, 0o700);
    return {id, label, ...claude ? {claude_config_dir: path.join(folder, '.claude')} : {},
      ...codex ? {codex_home: path.join(folder, '.codex')} : {}};
  }
  function declare(list: Alias[]): void {
    fs.writeFileSync(path.join(mesh.home, '.config', 'session-mesh', 'accounts.json'), JSON.stringify({v: 1, accounts: list}),
      {mode: 0o600});
  }
  // three aliases, out of label order in the file: Claude only, Codex only, both
  const three = () => [alias('zeta', 'Zeta', true, false), alias('perso', 'Perso', false, true), alias('work', 'Atacama', true, true)];

  before(async () => {
    await mesh.start();
    await mesh.newShell('base');
  });
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  const account = (page: Page) => page.locator('#form-new select[name="account"]');
  const submit = (page: Page) => page.locator('#form-new button[value="ok"]').click();
  const preset = (page: Page, value: string) => page.locator(`#form-new .presets label:has(input[value="${value}"])`).click();
  const optionTexts = (page: Page) => account(page).evaluate((select: HTMLSelectElement) => [...select.options].map(option => option.text));

  /** The dialog, open, with `count` account options loaded; every POST /api/new is recorded and answered 400.
   * `remembered`: the alias this device chose last time. */
  async function dialog(count: number, options: {remembered?: string; phone?: boolean} = {}):
    Promise<{page: Page; sent: Record<string, unknown>[]}> {
    const sent: Record<string, unknown>[] = [];
    const viewport = options.phone ? {width: 390, height: 844} : {width: 1440, height: 900};
    const page = await mesh.signIn(viewport, undefined, undefined, {phone: options.phone, routes: async target => {
      await target.route('**/api/new', route => {
        sent.push(route.request().postDataJSON() as Record<string, unknown>);
        return route.fulfill({status: 400, contentType: 'text/plain', body: 'Unknown or disabled preset'});
      });
    }});
    pages.push(page);
    if (options.remembered) {   // what a successful start with that alias leaves on this device (store.set)
      await page.evaluate(id => localStorage.setItem(`${meshContext.storagePrefix}.account`, JSON.stringify(id)), options.remembered);
    }
    await page.evaluate(() => { void openNew(); });
    await page.locator('#dlg-new[open]').waitFor();
    await page.waitForFunction(want => (document.querySelector('#form-new select[name="account"]') as HTMLSelectElement).options.length === want,
      count, {timeout: 10000});
    await page.locator('#form-new input[name="cwd"]').fill(mesh.home);
    return {page, sent};
  }

  test('three aliases, sorted by label; one without a folder for the agent is refused in the dialog', async () => {
    declare(three());
    const {page, sent} = await dialog(4);
    assert.deepEqual(await optionTexts(page), ['Default account', 'Atacama', 'Perso', 'Zeta']);
    await preset(page, 'codex');
    await account(page).selectOption('perso');
    await preset(page, 'claude');   // Perso has no Claude folder
    assert.deepEqual(await account(page).evaluate((select: HTMLSelectElement) =>
      [select.value, select.selectedOptions[0]!.disabled]), ['perso', true], 'still shown, greyed');
    await submit(page);
    await page.waitForFunction(() => document.querySelector('#new-err')?.textContent !== '', undefined, {timeout: 5000});
    assert.match(await page.locator('#new-err').textContent() ?? '', /Perso.*Claude/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(sent, [], 'no session requested, under no account');
    assert.equal(await page.locator('#dlg-new[open]').count(), 1, 'the dialog stays open');
  });

  test('backend-qualified labels follow the preset without changing the selected account id', async () => {
    declare(three());
    const {page, sent} = await dialog(4, {remembered: 'work'});
    await page.evaluate(() => fillAccounts([{id: 'work', label: 'Fallback', claude: true, codex: true,
      backend_labels: {claude: 'Claude Work', codex: '<img> Codex Work'}}]));
    await preset(page, 'claude');
    assert.equal(await account(page).inputValue(), 'work');
    assert.equal(await account(page).locator('option:checked').textContent(), 'Claude Work');
    await preset(page, 'codex');
    assert.equal(await account(page).inputValue(), 'work');
    assert.equal(await account(page).locator('option:checked').textContent(), '<img> Codex Work');
    assert.equal(await account(page).locator('img').count(), 0);
    assert.deepEqual(sent, [], 'changing the displayed backend label must not launch a session');
  });

  test('the default account sends no account; an alias sends its id only', async () => {
    declare(three());
    const {page, sent} = await dialog(4);
    await preset(page, 'claude');
    await account(page).selectOption('');
    await submit(page);
    await page.waitForFunction(() => document.querySelector('#new-err')?.textContent !== '', undefined, {timeout: 5000});
    await account(page).selectOption('zeta');
    await submit(page);
    for (let attempt = 0; attempt < 50 && sent.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sent.length, 2);
    assert.equal('account' in sent[0]!, false, JSON.stringify(sent[0]));
    assert.equal(sent[1]!.account, 'zeta');
    assert.equal(sent[1]!.preset, 'claude');
  });

  test('an alias remembered on this device but removed from the runner is refused, never the default account', async () => {
    declare(three().filter(item => item.id !== 'perso'));
    const {page, sent} = await dialog(4, {remembered: 'perso'});   // default, Atacama, Zeta, and the removed one
    assert.deepEqual(await account(page).evaluate((select: HTMLSelectElement) =>
      [select.value, select.selectedOptions[0]!.disabled, select.selectedOptions[0]!.text]), ['perso', true, 'perso (no longer declared)']);
    await preset(page, 'codex');
    await submit(page);
    await page.waitForFunction(() => document.querySelector('#new-err')?.textContent !== '', undefined, {timeout: 5000});
    assert.equal(await page.locator('#new-err').textContent(),
      'The account perso chosen last time on this device is no longer declared on the runner: choose an account');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(sent, [], 'no session requested, under no account');
    await account(page).selectOption('');   // an explicit choice of the default account is honoured
    await submit(page);
    for (let attempt = 0; attempt < 50 && sent.length < 1; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sent.length, 1);
    assert.equal('account' in sent[0]!, false);
  });

  test('64 aliases on a 390 px phone: the list fits, and the keyboard moves through it', async () => {
    const many = Array.from({length: 64}, (_, index) => alias(`m${index}`, `Account ${String(index).padStart(2, '0')}`,
      index % 3 !== 1, index % 3 !== 0));
    declare(many);
    const {page} = await dialog(65, {phone: true});
    await preset(page, 'claude');
    const box = await account(page).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow');
    await account(page).selectOption('');
    await account(page).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await account(page).inputValue(), 'm0', 'the first alias that has a Claude folder');
  });
});
