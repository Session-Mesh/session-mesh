// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The restore bar shows what a partial restoration says: the warnings of a result (the agent mail that stays at
// the old identity, a new name, an organisation not restored) are translated and named by session, and the bar
// warns that "Ignore" also deletes the agent mail it holds. The answer of the restore route is stubbed in the
// page; the server, its snapshot and the PTY host are real. Needs a Chromium: MESH_CHROMIUM (skipped without it;
// MESH_REQUIRE_BROWSER=1 makes the absence a failure).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {Lab} from './restore-exact-lib.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

const RESULTS = {results: {
  alpha: {ok: true, id: 'alpha', resumed: true, warnings: [
    'agent mail not transferred (kept for the old identity): the restored session is not exactly the offered one']},
  bravo: {ok: true, id: 'bravo-2', resumed: false, warnings: [
    'restored under another name: bravo-2', 'organisation not restored',
    'mail expired: agent mail is kept 24 hours after the loss; none was found for this session']},
}};

let lab: Lab;
let browser: Browser;

before(async () => {
  // A skipped describe does not skip this file-level hook: start nothing without a Chromium.
  if (skip) return;
  lab = await Lab.start();
  browser = await chromium.launch({executablePath: CHROMIUM, args: ['--no-sandbox', '--mute-audio']});
});
after(async () => {
  await browser?.close();
  await lab?.stop();
});

// What the page is shown: the answer of the restore route, and the offer the sessions listing carries (the
// real one, none, or one for sessions the notice does not speak of).
type Stub = {restore: unknown; offer: 'real' | 'none' | 'other'};

async function offered(locale: string, width: number, stub: Stub = {restore: RESULTS, offer: 'real'}): Promise<Page> {
  const context = await browser.newContext({locale, viewport: {width, height: 900}});
  const page = await context.newPage();
  await page.route('**/api/restore', route => route.request().method() === 'POST'
    ? route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(stub.restore)}) : route.continue());
  await page.route('**/api/sessions', async route => {
    if (stub.offer === 'real') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.restorable = stub.offer === 'none' ? []
      : body.restorable.map((entry: {name: string}) => ({...entry, name: `${entry.name}-other`}));
    return route.fulfill({response, json: body});
  });
  await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
  await page.goto(`${lab.mesh.base}/`);
  if (width < 700) await page.locator('#btn-menu').click();   // a phone: the sidebar holding the bar is closed
  await page.locator('#restore-go').waitFor({timeout: 30000});
  return page;
}

async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
}

describe('the restore bar and the warnings of a restoration', {skip}, () => {
  test('English, desktop: the warnings are named by session, and the bar says what Ignore does', async () => {
    const page = await offered('en-US', 1400);
    assert.equal(await page.locator('.restore-hint').innerText(), 'Ignore also deletes the agent mail kept for these sessions.');
    await page.locator('#restore-go').click();
    const flash = page.locator('#flash');
    await flash.waitFor({state: 'visible'});
    const text = await flash.innerText();
    assert.match(text, /^2 sessions restored Warnings: /);
    assert.match(text, /alpha: agent mail not transferred \(kept for the old identity\): the restored session is not exactly the offered one/);
    assert.match(text, /bravo: restored under another name: bravo-2/);
    assert.match(text, /bravo: organisation not restored/);
    assert.match(text, /bravo: mail expired: agent mail is kept 24 hours/);
    // The offer stays, and the warnings stay in it (the flash is gone after a few seconds): through the 4 s refresh.
    const notice = page.locator('#restore-warnings');
    await notice.waitFor({state: 'visible'});
    assert.equal(await notice.innerText(), text);
    assert.equal(await notice.evaluate(node => node.children.length), 0, 'plain text, no markup');
    await page.waitForTimeout(5000);
    assert.equal(await notice.innerText(), text, 'the notice survives the refresh of the offer');
    await page.context().close();
  });

  test('French, phone width: the same warnings in French, with no horizontal overflow', async () => {
    const page = await offered('fr-FR', 390);
    assert.equal(await page.locator('.restore-hint').innerText(), "Ignorer supprime aussi le courrier d'agent retenu pour ces sessions.");
    await page.locator('#restore-go').click();
    const flash = page.locator('#flash');
    await flash.waitFor({state: 'visible'});
    const text = await flash.innerText();
    assert.match(text, /Avertissements : /);
    assert.match(text, /alpha : courrier d'agent non transféré \(conservé pour l'ancienne identité\)/);
    assert.match(text, /bravo : restaurée sous un autre nom : bravo-2/);
    assert.match(text, /bravo : organisation non restaurée/);
    assert.match(text, /bravo : courrier expiré/);
    assert.ok(!/restored under|not transferred|expired:/.test(text), 'no English left');
    const notice = page.locator('#restore-warnings');
    await notice.waitFor({state: 'visible'});
    const shown = await notice.innerText();
    assert.match(shown, /Avertissements : alpha : courrier d'agent non transféré/);
    assert.match(shown, /bravo : restaurée sous un autre nom : bravo-2/);
    assert.ok(!/restored under|not transferred|expired:/.test(shown), 'no English left in the offer');
    assert.ok(await fitsWidth(page), 'the page does not overflow horizontally');
    assert.ok(await notice.evaluate(node => node.scrollWidth <= node.clientWidth), 'the notice does not overflow its box');
    await page.context().close();
  });

  // The notice speaks of the sessions of one restoration: it goes when that offer is gone or replaced, not only
  // on the next click here.
  test('the notice goes when its offer disappears elsewhere, and does not come back with the next offer', async () => {
    const stub: Stub = {restore: RESULTS, offer: 'real'};
    const page = await offered('en-US', 1400, stub);
    await page.locator('#restore-go').click();
    const notice = page.locator('#restore-warnings');
    await notice.waitFor({state: 'visible'});
    stub.offer = 'none';
    await page.locator('#restore').waitFor({state: 'hidden', timeout: 15000});
    stub.offer = 'real';
    await page.locator('#restore').waitFor({state: 'visible', timeout: 15000});
    await page.locator('#restore-warnings').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#restore-warnings').innerText(), '', 'no stale warnings in the new offer');
    await page.context().close();
  });

  test('the notice goes when the offer no longer holds the sessions it concerns', async () => {
    const stub: Stub = {restore: RESULTS, offer: 'real'};
    const page = await offered('en-US', 1400, stub);
    await page.locator('#restore-go').click();
    await page.locator('#restore-warnings').waitFor({state: 'visible'});
    stub.offer = 'other';
    await page.locator('#restore .restore-name', {hasText: 'alpha-other'}).waitFor({timeout: 15000});
    await page.locator('#restore-warnings').waitFor({state: 'hidden'});
    await page.context().close();
  });

  test('the next restore in this tab removes the notice', async () => {
    const stub: Stub = {restore: RESULTS, offer: 'real'};
    const page = await offered('en-US', 1400, stub);
    await page.locator('#restore-go').click();
    await page.locator('#restore-warnings').waitFor({state: 'visible'});
    stub.restore = {results: {alpha: {ok: true, id: 'alpha', resumed: true}, bravo: {ok: true, id: 'bravo', resumed: false}}};
    await page.locator('#restore-go').click();
    await page.locator('#restore-warnings').waitFor({state: 'hidden'});
    await page.context().close();
  });

  test('the next ignore in this tab removes the notice', async () => {
    const page = await offered('en-US', 1400);
    await page.locator('#restore-go').click();
    await page.locator('#restore-warnings').waitFor({state: 'visible'});
    await page.locator('#restore-ignore').click();
    await page.locator('#restore').waitFor({state: 'hidden', timeout: 15000});
    await page.context().close();
  });
});
