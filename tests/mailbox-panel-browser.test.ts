// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The envelope button of a terminal pane opens that session's mailbox: the messages it received
// and sent with their text (shown inert), the approval requests that concern it with the three
// existing choices, and its permanent permissions with a revoke button. The long-message dialog
// moved to the pane's "More" menu. Run in headless Chromium on a throwaway server, PTY host and
// fake agents; each session is the test's own.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure).
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {AgentMesh, type Agent} from './helpers/agent-mail-mesh.ts';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
// app.js script-scope functions, used inside page functions (the page's policy refuses string eval).
declare function refresh(): Promise<void>;
declare const panes: {id: string}[];
declare const restoringWorkspace: boolean;
declare const active: {id?: string; conn?:{ws?: {readyState: number}}} | null;

const HOSTILE = [
  '<img src=x onerror="window.__pwn=1">', '<script>window.__pwn=1</script>',
  '<a href="javascript:window.__pwn=1">click me</a> https://example.invalid/phish',
  '‮evil‬ ' + 'A'.repeat(3000), 'last line',
].join('\n');
const HOSTILE_SHOWN = HOSTILE.replace('‮', '<U+202E>').replace('‬', '<U+202C>');
const ROUTE = '/api/agent-mail/messages';

let lab: AgentMesh;
let browser: Browser;
let beta: Agent;
const contexts: BrowserContext[] = [];

before(async () => {
  // A skipped describe does not skip this file-level hook: start nothing without a Chromium.
  if (skip) return;
  lab = await AgentMesh.start('mbxui-', ['alpha', 'beta', 'gamma']);
  beta = lab.agents.beta!;
  await lab.send(lab.agents.alpha!, beta, HOSTILE);
  await lab.send(lab.agents.gamma!, beta, 'task for beta', 'task');
  await lab.send(beta, lab.agents.alpha!, 'beta answers alpha');
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  await lab?.stop();
});

async function signedIn(locale: string, width = 1400, height = 900): Promise<{page: Page; errors: string[]; calls: () => number}> {
  const context = await browser.newContext({locale, viewport: {width, height}});
  contexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  let calls = 0;
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (new URL(request.url()).pathname === ROUTE) calls += 1; });
  await page.goto(`${lab.mesh.base}/login?token=${encodeURIComponent(lab.mesh.token())}`);
  await page.goto('about:blank');
  await page.goto(`${lab.mesh.base}/#beta`);
  await page.waitForFunction(() => panes.some(pane => pane.id === 'beta') && !restoringWorkspace, undefined, {timeout: READY_TIMEOUT_MS});
  return {page, errors, calls: () => calls};
}

const envelope = (page: Page) => page.locator('.pane.active [data-act="compose"]');
const dialog = (page: Page) => page.locator('#dlg-mailbox');

async function noHorizontalOverflow(page: Page): Promise<void> {
  const fits = await page.evaluate(() => {
    const box = document.querySelector('#dlg-mailbox') as HTMLElement;
    const texts = [...box.querySelectorAll<HTMLElement>('.mailbox-text, .mailbox-meta, .mailbox-request p')];
    return {document: document.documentElement.scrollWidth <= innerWidth, dialog: box.scrollWidth <= box.clientWidth,
      texts: texts.every(node => node.scrollWidth <= node.clientWidth),
      inside: box.getBoundingClientRect().left >= 0 && box.getBoundingClientRect().right <= innerWidth};
  });
  assert.deepEqual(fits, {document: true, dialog: true, texts: true, inside: true});
}

// Every approval row, its action row and each of their buttons sits inside the dialog and inside
// its own parent, whatever the width, and nothing in them is wider than its own box.
async function requestRowsFit(page: Page): Promise<number> {
  const result = await page.evaluate(() => {
    const box = document.querySelector('#dlg-mailbox') as HTMLElement;
    const inside = (child: Element, parent: Element): boolean => {
      const a = child.getBoundingClientRect(), b = parent.getBoundingClientRect();
      return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
    };
    const rows = [...box.querySelectorAll<HTMLElement>('.mailbox-request')];
    const problems: string[] = [];
    for (const row of rows) {
      if (!inside(row, box) || row.scrollWidth > row.clientWidth) problems.push('row');
      const actions = row.querySelector<HTMLElement>('.mailbox-actions')!;
      if (!inside(actions, row) || actions.scrollWidth > actions.clientWidth) problems.push('actions');
      for (const button of actions.querySelectorAll<HTMLElement>('.btn')) {
        if (!inside(button, actions) || button.scrollWidth > button.clientWidth) problems.push(`button ${button.textContent}`);
      }
    }
    return {rows: rows.length, problems, page: document.documentElement.scrollWidth <= innerWidth};
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.page, true);
  return result.rows;
}

/** A fresh approval request for beta from alpha, dismissed on the page's own prompt ("Later"). */
async function pendingRequest(page: Page, text: string): Promise<string> {
  const before = new Set(await lab.inbox(beta));
  await lab.send(lab.agents.alpha!, beta, text);
  const [id] = (await lab.inbox(beta)).filter(known => !before.has(known));
  assert.ok(id, 'the new message reached the inbox');
  assert.equal((await lab.readAs(beta, id)).status, 202);
  await page.evaluate(() => refresh());
  await page.locator('#dlg-agent-mail-consent[open]').waitFor();
  await page.locator('#dlg-agent-mail-consent button[value="later"]').click();
  const request = (await lab.consent()).requests.find(item => item.message_id === id);
  assert.ok(request, 'the read created an approval request');
  return request.id;
}

describe('the pane mailbox', {skip}, () => {
  test('the envelope lists received and sent messages with their text, inert, and loads once', async () => {
    const {page, errors, calls} = await signedIn('en-US');
    assert.equal(await envelope(page).getAttribute('aria-label'), "Open the mailbox of this session");
    assert.equal(await envelope(page).getAttribute('title'), 'Mailbox: messages between agents for this session');
    await envelope(page).click();
    await dialog(page).locator('.mailbox-message').first().waitFor();
    assert.equal(await page.locator('#dlg-compose').evaluate((node: HTMLDialogElement) => node.open), false);
    assert.match(await page.locator('#mailbox-session').innerText(), /Session “beta” \(claude\)/);

    const received = dialog(page).locator('.mailbox-message.incoming');
    assert.equal(await received.count(), 2);
    const incoming = await received.evaluateAll(rows => rows.map(row => ({meta: row.querySelector('.mailbox-meta')!.textContent,
      text: row.querySelector('.mailbox-text')!.textContent})));
    assert.deepEqual(incoming.map(row => row.text), ['task for beta', HOSTILE_SHOWN], 'newest first, exact text');
    assert.match(incoming[0]!.meta!, /^From another agent: “gamma” \(claude\) · task · /);
    assert.match(incoming[1]!.meta!, /^From another agent: “alpha” \(claude\) · message · /);
    const outgoing = await dialog(page).locator('.mailbox-message.outgoing').evaluateAll(rows =>
      rows.map(row => [row.querySelector('.mailbox-meta')!.textContent, row.querySelector('.mailbox-text')!.textContent]));
    assert.equal(outgoing.length, 1);
    assert.match(outgoing[0]![0]!, /^To “alpha” \(claude\) · message · /);
    assert.equal(outgoing[0]![1], 'beta answers alpha');

    // Hostile text became text only: no element, no link, no script ran.
    assert.equal(await page.locator('#mailbox-body').evaluate(body => body.querySelectorAll('a, img, script, iframe, [onerror]').length), 0);
    assert.equal(await page.evaluate(() => (window as unknown as {__pwn?: number}).__pwn), undefined);
    await noHorizontalOverflow(page);

    // Opening loaded once; a snapshot without a change in the requests loads nothing more.
    await page.evaluate(() => refresh());
    await page.evaluate(() => refresh());
    await page.waitForTimeout(500);
    assert.equal(calls(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await dialog(page).evaluate((node: HTMLDialogElement) => node.open), false);
    assert.deepEqual(errors, []);
  });

  test('an approval request lights the badge, shows in the open panel and is decided there', async () => {
    const {page, errors} = await signedIn('en-US');
    const [hostile, task] = (await lab.inbox(beta));
    assert.equal((await lab.readAs(beta, hostile!)).status, 202);
    assert.equal((await lab.readAs(beta, task!)).status, 202);
    await page.evaluate(() => refresh());
    // The page also asks on its own, one request after the other; "Later" decides nothing.
    for (let asked = 0; asked < 2; asked += 1) {
      await page.locator('#dlg-agent-mail-consent[open]').waitFor();
      await page.locator('#dlg-agent-mail-consent button[value="later"]').click();
    }
    const badge = envelope(page).locator('.mail-badge');
    await badge.waitFor({state: 'visible'});
    assert.equal(await badge.locator('.mail-badge-count').textContent(), '2');
    assert.equal(await badge.locator('.sr-only').textContent(), 'Approval requests waiting: 2');
    assert.equal(await envelope(page).evaluate(node => (node as HTMLElement).getBoundingClientRect().width), 44);

    await envelope(page).click();
    const requests = dialog(page).locator('.mailbox-request');
    await requests.first().waitFor();
    assert.equal(await requests.count(), 2);
    assert.deepEqual(await requests.first().locator('button').allInnerTexts(), ['Refuse', 'Read this time', 'Always for this exact session']);
    assert.match(await requests.first().locator('p').innerText(), /^“beta” asks to read a message from “(alpha|gamma)” \(claude\), received /);

    // Read this time: the agent's own read now succeeds once, and the list reloads.
    const taskRequest = requests.filter({hasText: '“gamma”'});
    await taskRequest.getByRole('button', {name: 'Read this time'}).click();
    await page.waitForFunction(() => document.querySelectorAll('#dlg-mailbox .mailbox-request').length === 1);
    assert.equal((await lab.readAs(beta, task!)).status, 200);
    assert.equal((await lab.readAs(beta, task!)).status, 202);

    // A request that arrives while the panel is open appears without reopening it.
    await page.evaluate(() => refresh());
    await page.waitForFunction(() => document.querySelectorAll('#dlg-mailbox .mailbox-request').length === 2);

    // Refuse drops the hostile message.
    await dialog(page).locator('.mailbox-request').filter({hasText: '“alpha”'}).getByRole('button', {name: 'Refuse'}).click();
    await page.waitForFunction(() => document.querySelectorAll('#dlg-mailbox .mailbox-message.incoming').length === 1);
    assert.deepEqual(await lab.inbox(beta), [task]);
    assert.equal(await dialog(page).locator('.mailbox-request').count(), 1);

    // Always for this exact session: a permission appears, and revoking removes it.
    await dialog(page).locator('.mailbox-request').getByRole('button', {name: 'Always for this exact session'}).click();
    await dialog(page).locator('.mailbox-policy').waitFor();
    assert.match(await dialog(page).locator('.mailbox-policy span').innerText(), /^This session may read messages from “gamma” \(claude\)\.$/);
    assert.equal((await lab.consent()).always.length, 1);
    await dialog(page).getByRole('button', {name: 'Revoke'}).click();
    await page.waitForFunction(() => document.querySelectorAll('#dlg-mailbox .mailbox-policy').length === 0);
    assert.equal((await lab.consent()).always.length, 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => refresh());
    await badge.waitFor({state: 'hidden'});
    assert.deepEqual(errors, []);
  });

  test('the long-message dialog opens from the More menu', async () => {
    const {page} = await signedIn('en-US');
    await page.waitForFunction(() => active?.conn?.ws?.readyState === 1);
    await page.locator('.pane.active [data-act="more"]').click();
    await page.getByRole('menuitem', {name: 'Write in the terminal…'}).click();
    await page.locator('#dlg-compose').waitFor({state: 'visible'});
    await page.locator('#compose-text').fill('a long message\nover two lines');
    assert.equal(await page.locator('#dlg-mailbox').evaluate((node: HTMLDialogElement) => node.open), false);
    await page.keyboard.press('Escape');
  });

  test('a plain shell session has no envelope button, but keeps the long message in the More menu', async () => {
    await fetch(`${lab.mesh.base}/api/new`, {method: 'POST', headers: {Authorization: `Bearer ${lab.mesh.token()}`,
      Origin: lab.mesh.base, 'Content-Type': 'application/json'}, body: JSON.stringify({preset: 'shell', cwd: lab.mesh.home, name: 'plainsh'})});
    const {page} = await signedIn('en-US');
    await page.goto('about:blank');
    await page.goto(`${lab.mesh.base}/#plainsh`);
    await page.waitForFunction(() => panes.some(pane => pane.id === 'plainsh'));
    await page.waitForFunction(() => active?.id === 'plainsh' && active?.conn?.ws?.readyState === 1);
    assert.equal(await envelope(page).isHidden(), true);
    assert.equal(await page.locator('#dlg-mailbox').evaluate((node: HTMLDialogElement) => node.open), false);
    await page.locator('.pane.active [data-act="more"]').click();
    await page.getByRole('menuitem', {name: 'Write in the terminal…'}).click();
    await page.locator('#dlg-compose').waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    // The agent session of the same page still has its button.
    await page.goto('about:blank');
    await page.goto(`${lab.mesh.base}/#beta`);
    await page.waitForFunction(() => active?.id === 'beta');
    assert.equal(await envelope(page).isVisible(), true);
  });

  test('a French browser gets the button, the panel and the menu entry in French', async () => {
    const {page} = await signedIn('fr-FR');
    assert.equal(await envelope(page).getAttribute('aria-label'), 'Ouvrir la messagerie de cette session');
    await envelope(page).click();
    await dialog(page).locator('.mailbox-message').first().waitFor();
    assert.equal(await dialog(page).locator('h2').innerText(), 'Messagerie');
    assert.match(await dialog(page).locator('.mailbox-message.incoming .mailbox-meta').first().innerText(), /^D’un autre agent : « gamma »/);
    assert.equal(await dialog(page).getByText('Reçus', {exact: true}).count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('.pane.active [data-act="more"]').click();
    assert.equal(await page.getByRole('menuitem', {name: 'Écrire dans le terminal…'}).count(), 1);
  });

  test('at phone width the button is reachable, the panel fits and the keys bar keeps its pen', async () => {
    const {page} = await signedIn('en-US', 390, 800);
    assert.equal(await envelope(page).isVisible(), true);
    const box = await envelope(page).boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the header fits');
    await envelope(page).click();
    await dialog(page).locator('.mailbox-message').first().waitFor();
    await noHorizontalOverflow(page);
    const height = await dialog(page).evaluate(node => node.getBoundingClientRect().height);
    assert.ok(height <= 800, String(height));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-k="compose"]').count(), 1, 'the pen key of the keys bar stays');
  });

  for (const [locale, width, label] of [['en-US', 320, 'Always for this exact session'], ['en-US', 390, 'Always for this exact session'],
    ['fr-FR', 320, 'Toujours pour cette session exacte'], ['fr-FR', 390, 'Toujours pour cette session exacte']] as const) {
    test(`an approval request fits at ${width}px in ${locale}: the buttons wrap instead of overflowing`, async () => {
      const {page, errors} = await signedIn(locale, width, 800);
      const requestId = await pendingRequest(page, `fit ${locale} ${width}`);
      await envelope(page).click();
      await dialog(page).locator('.mailbox-request').first().waitFor();
      assert.ok(await dialog(page).getByRole('button', {name: label}).count() >= 1, label);
      assert.equal(await requestRowsFit(page), 1);
      await noHorizontalOverflow(page);
      assert.deepEqual(errors, []);
      await lab.decide(requestId, 'no');
    });
  }

  for (const [locale, expected] of [['en-US', 'This request was already decided elsewhere; the list was refreshed.'],
    ['fr-FR', 'Cette demande a déjà été tranchée ailleurs ; la liste a été actualisée.']] as const) {
    test(`a request decided elsewhere says so neutrally in ${locale} and the list is refreshed`, async () => {
      const {page} = await signedIn(locale);
      const requestId = await pendingRequest(page, `stale ${locale}`);
      await envelope(page).click();
      const rows = dialog(page).locator('.mailbox-request');
      await rows.first().waitFor();
      // The decision is taken elsewhere just before the click reaches the server: a real 404.
      let status = 0;
      await page.route(`**/api/agent-mail/consent/${requestId}/decision`, async route => {
        await lab.decide(requestId, 'no');
        const response = await route.fetch();
        status = response.status();
        await route.fulfill({response});
      });
      await rows.first().locator('button').nth(1).click();
      const notice = dialog(page).locator('#mailbox-body > p[role="status"]').first();
      await notice.waitFor();
      assert.equal(status, 404);
      assert.equal(await notice.innerText(), expected);
      assert.doesNotMatch(await notice.innerText(), /could not be saved|n’a pas pu/);
      assert.equal(await rows.count(), 0, 'the list was refreshed');
    });
  }

  test('a failing decision still says it could not be saved', async () => {
    const {page} = await signedIn('en-US');
    const requestId = await pendingRequest(page, 'failing decision');
    await envelope(page).click();
    const rows = dialog(page).locator('.mailbox-request');
    await rows.first().waitFor();
    await page.route(`**/api/agent-mail/consent/${requestId}/decision`, route => route.fulfill({status: 500, body: 'no'}));
    await rows.first().locator('button').nth(1).click();
    await dialog(page).getByText('The decision could not be saved; the list was reloaded.').waitFor();
    await page.unroute(`**/api/agent-mail/consent/${requestId}/decision`);
    await lab.decide(requestId, 'no');
  });
});
