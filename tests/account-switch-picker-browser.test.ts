// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chromium, type Browser, type Route} from 'playwright-core';
import {startMesh, type Mesh} from './mesh-server-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const chrome = process.env.MESH_CHROMIUM || '';
const skip = chrome ? false : process.env.MESH_REQUIRE_BROWSER ? false : 'MESH_CHROMIUM not set';
let browser: Browser, mesh: Mesh;
before(async () => {
  if (skip) return;
  mesh = await startMesh('account-switch-picker-');
  browser = await chromium.launch(chromiumLaunchOptions(chrome, ['--no-sandbox']));
});
after(async () => { await browser?.close(); await mesh?.stop(); });

for (const [width, locale, backend] of [[1440, 'en-US', 'codex'], [390, 'fr-FR', 'codex'], [390, 'fr-FR', 'pi']] as const)
  test(`${backend} click, keyboard, cancellation and stale picker at ${width}px (${locale})`, {skip}, async () => {
    const context = await browser.newContext({viewport: {width, height: 900}, locale,
      isMobile: width === 390, hasTouch: width === 390, serviceWorkers: 'block'});
    try {
      const page = await context.newPage();
      const revision = 'a'.repeat(64), other = 'b'.repeat(64);
      let status = 'idle', account = 'work', requests = 0, created = 123;
      let requestState = 'approved';
      const listing = () => ({mesh: [{
        kind: 'mesh', id: 'bound-one', name: 'bound-one', label: 'bound-one', created,
        activity: 124, attached: 0, cwd: mesh.home, folder: null, rank: 0, notice: null,
        account, account_label: account === 'work' ? 'Work' : 'Personal',
        account_context_revision: account === 'work' ? revision : other, known_agent: backend,
        switch_qualified: true,
        agent: {type: backend, status, foreground: true, pid: 77, started: 100,
          session_id: '11111111-1111-1111-1111-111111111111'},
      }], external: [], folders: [], moved: {}, opens: {}, home: mesh.home, now: 2000, gen: 1, full: true});
      await page.route('**/api/sessions*', route => route.fulfill({json: listing()}));
      await page.route('**/api/accounts/profiles', route => route.fulfill({json: {
        version: 1, ok: true, http_status: 200, data: {configured: true, registry_revision: revision,
          profiles: [
            {backend, id: 'work', label: 'Work', enabled: true, context_revision: revision, switch_qualified: true},
            {backend, id: 'other', label: 'Personal', enabled: true, context_revision: other, switch_qualified: true},
            {backend: 'claude', id: 'wrong', label: 'Other backend', enabled: true, context_revision: other, switch_qualified: true},
            {backend, id: 'managed', label: 'Managed', managed: true, enabled: true, context_revision: other, switch_qualified: false},
          ]}}}));
      await page.route('**/api/session-actions/operator/switch', async route => {
        requests++;
        const body = route.request().postDataJSON();
        assert.deepEqual(body.source, {id: 'bound-one', created: 123, agent: backend, account: 'work',
          context_revision: revision, conversation: '11111111-1111-1111-1111-111111111111',
          agent_pid: 77, agent_started: 100});
        assert.deepEqual(body.target, {id: 'other', label: 'Personal', context_revision: other});
        await route.fulfill({status: 202, json: {request: {
          id: 'fixture', action: 'switch_account', state: 'approved'}}});
      });
      await page.route('**/api/session-actions/operator/switch/fixture', route => route.fulfill({
        json: {request: {id: 'fixture', action: 'switch_account', state: requestState,
          result: requestState === 'failed' ? {error: 'Agent stop outcome uncertain; inspect the session before resuming'} : null}},
      }));
      await page.routeWebSocket('**/ws/**', socket => socket.onMessage(() => {}));
      await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
      await page.goto(`${mesh.base}/`);
      if (width === 390) await page.locator('#btn-menu').click();
      await page.locator('#list .item[data-id="bound-one"]').click();
      const badge = page.locator('#panes .pane.active .p-account');
      await badge.waitFor();
      assert.equal(await badge.getAttribute('type'), 'button');
      assert.equal(await badge.isEnabled(), true);
      assert.equal(await page.locator('#list .item[data-id="bound-one"] .account-badge').evaluate(el => el.tagName), 'SPAN');
      await badge.focus();
      await page.keyboard.press('Enter');
      const dialog = page.locator('#dlg-account-switch');
      await dialog.waitFor({state: 'visible'});
      assert.match(await dialog.textContent() || '', /Work/);
      assert.match(await dialog.textContent() || '', /Personal/);
      assert.match(await dialog.locator('[data-switch-warning]').textContent() || '',
        locale === 'fr-FR' ? /La transcription sera copiée/ : /transcript will be copied/);
      assert.equal(await dialog.locator('[data-switch-to] option').count(), 1);
      assert.equal(requests, 0, 'opening never requests a switch');
      await dialog.locator('[data-switch-cancel]').click();
      assert.equal(requests, 0);
      await badge.click();
      await dialog.waitFor({state: 'visible'});
      status = 'busy';
      await page.evaluate(() => refresh());
      await dialog.waitFor({state: 'hidden'});
      assert.equal(await badge.isDisabled(), true, 'a busy source loses its trigger');
      assert.equal(requests, 0);
      status = 'idle'; await page.evaluate(() => refresh());
      await badge.click();
      await dialog.waitFor({state: 'visible'});
      account = 'other';
      await page.evaluate(() => refresh());
      await dialog.waitFor({state: 'hidden'});
      assert.equal(requests, 0, 'stale selection cannot be submitted');
      account = 'work'; await page.evaluate(() => refresh());
      await badge.click();
      await dialog.waitFor({state: 'visible'});
      await dialog.locator('[data-switch-confirm]').dblclick();
      assert.equal(requests, 1, 'one confirmed operation at most');
      await dialog.waitFor({state: 'visible'});
      await dialog.locator('[data-switch-status]').getByText(
         locale === 'fr-FR' ? /Changement de compte accepté/ : /Account change accepted/).waitFor();
      status = 'busy';
      await page.evaluate(() => refresh());
      assert.equal(await dialog.evaluate(el => (el as HTMLDialogElement).open), true,
        'inventory changes must not conceal an admitted request receipt');
      if (backend === 'pi') {
        created = 125;
        status = 'idle';
        account = 'other';
        await page.evaluate(() => refresh());
        await badge.getByText('Personal', {exact: true}).waitFor();
        requestState = 'completed';
        await dialog.locator('[data-switch-status]').getByText(/Changement de compte terminé/i).waitFor();
        assert.equal(requests, 1, 'reading an admitted receipt never repeats the switch');
        await dialog.locator('[data-switch-cancel]').click();
        return;
      }
      requestState = 'failed';
      await dialog.locator('[data-switch-status]').getByText(
        locale === 'fr-FR' ? /Arrêt de l’agent incertain/ : /Agent stop outcome uncertain/).waitFor();
      await dialog.locator('[data-switch-cancel]').click();
      status = 'idle';
      requestState = 'execution_unknown';
      await page.evaluate(() => refresh());
      await badge.click();
      await dialog.waitFor({state: 'visible'});
      await dialog.locator('[data-switch-status]').getByText(
        locale === 'fr-FR' ? /inconnu/ : /unknown/i).waitFor();
      assert.equal(await dialog.locator('[data-switch-confirm]').isDisabled(), true,
        'an uncertain durable request must not be retried from its receipt');
      await dialog.locator('[data-switch-confirm]').click({force: true});
      assert.equal(requests, 1);
      await dialog.locator('[data-switch-cancel]').click();
    } finally {await context.close();}
  });

for (const mode of ['transport', 'deadline', 'late-receipt', 'reload-before-reply', 'capacity'])
test(`an uncertain Pi submission avoids replay (${mode})`, {skip}, async () => {
  const stalled = mode !== 'transport';
  const context = await browser.newContext({serviceWorkers: 'block'});
  try {
    const page = await context.newPage();
    const revision = 'a'.repeat(64), other = 'b'.repeat(64);
    let posts = 0;
    let pending: Route | undefined;
    let refuse = !stalled;
    await page.route('**/api/sessions*', route => route.fulfill({json: {
      mesh: [{kind: 'mesh', id: 'uncertain', name: 'uncertain', created: 123,
        activity: 124, attached: 0, cwd: mesh.home, rank: 0, account: 'work',
        account_label: 'Work', account_context_revision: revision, known_agent: 'pi',
        switch_qualified: true, agent: {type: 'pi', status: 'idle', foreground: true,
          pid: 77, started: 100, session_id: '11111111-1111-1111-1111-111111111111'}}],
      external: [], folders: [], moved: {}, opens: {}, home: mesh.home, now: 2000, gen: 1, full: true,
    }}));
    await page.route('**/api/accounts/profiles', route => route.fulfill({json: {
      version: 1, ok: true, data: {profiles: [{backend: 'pi', id: 'other', label: 'Other',
        enabled: true, switch_qualified: true, context_revision: other}]},
    }}));
    await page.route('**/api/session-actions/operator/switch', route => {
      posts++;
      if (refuse) {
        refuse = false;
        return route.fulfill({status: 409, json: {refused: 'foreground_unavailable'}});
      }
      if (stalled) { pending = route; return; }
      return route.fulfill({status: 503, json: {error: 'reply lost'}});
    });
    await page.route('**/api/session-actions/operator/switch/late', route =>
      route.fulfill({json: {request: {id: 'late', action: 'switch_account', state: 'executing'}}}));
    await page.routeWebSocket('**/ws/**', socket => socket.onMessage(() => {}));
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    await page.goto(`${mesh.base}/`);
    await page.locator('#list .item[data-id="uncertain"]').click();
    const badge = page.locator('#panes .pane.active .p-account');
    await badge.click();
    const dialog = page.locator('#dlg-account-switch');
    if (!stalled) {
      await dialog.locator('[data-switch-confirm]').click();
      await dialog.waitFor({state: 'hidden'});
      assert.equal(posts, 1);
      await badge.click();
      await dialog.waitFor({state: "visible"});
      assert.equal(await dialog.locator('[data-switch-confirm]').isEnabled(), true);
    }
    if (mode === 'capacity') {
      const saved = await page.evaluate(() => {
        const raw = JSON.stringify(Array.from({length: 55}, (_, index) => ({
          source: {id: `session-${index}`, created: 123, agent: 'pi'},
          id: null, state: 'unknown',
        })));
        sessionStorage.setItem('mesh.accountSwitchReceipts.v1', raw);
        return raw;
      });
      await page.reload();
      await page.locator('#list .item[data-id="uncertain"]').click();
      await badge.click();
      await dialog.locator('[data-switch-confirm]').click();
      await dialog.getByText(/inventory unavailable/i).waitFor();
      assert.equal(posts, 0);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('mesh.accountSwitchReceipts.v1')), saved);
      return;
    }
    if (stalled) await page.clock.install();
    const sent = page.waitForRequest('**/api/session-actions/operator/switch');
    await dialog.locator('[data-switch-confirm]').click();
    await sent;
    if (mode === 'reload-before-reply') {
      await page.reload();
      await page.locator('#list .item[data-id="uncertain"]').click();
      await badge.click();
      await dialog.locator('[data-switch-status]').getByText(/outcome unknown/i).waitFor();
      assert.equal(posts, 1);
      return;
    }
    if (stalled) await page.clock.fastForward(11000);

    await dialog.locator('[data-switch-status]').getByText(/outcome unknown/i).waitFor();
    if (mode === 'late-receipt') {
      assert.ok(pending);
      await pending.fulfill({status: 202, json: {request: {id: 'late', action: 'switch_account', state: 'approved'}}});
      await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('mesh.accountSwitchReceipts.v1') ?? '[]')
        .some((receipt: {id: string}) => receipt.id === 'late'));
      assert.equal(posts, 1);
      return;
    }
    await dialog.locator('[data-switch-cancel]').click();
    await badge.click();
    await dialog.locator('[data-switch-status]').getByText(/outcome unknown/i).waitFor();
    assert.equal(await dialog.locator('[data-switch-confirm]').isDisabled(), true);
    await dialog.locator('[data-switch-cancel]').click();
    await page.reload();
    await page.locator('#list .item[data-id="uncertain"]').click();
    await page.locator('#panes .pane.active .p-account').click();
    await dialog.locator('[data-switch-status]').getByText(/outcome unknown/i).waitFor();
    assert.equal(await dialog.locator('[data-switch-confirm]').isDisabled(), true);
    assert.equal(posts, stalled ? 1 : 2);
  } finally {await context.close();}
});

test('real route rejects bearer, cross-origin and unsupported native profiles before dispatch', {skip}, async () => {
  const context = await browser.newContext({serviceWorkers: 'block'});
  try {
    const page = await context.newPage();
    await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
    const body = {source: {id: 'missing', created: 123, agent: 'codex', account: 'default',
      context_revision: 'a'.repeat(64), conversation: '11111111-1111-1111-1111-111111111111',
      agent_pid: 77, agent_started: 100},
    target: {id: 'other', label: 'Other', context_revision: 'b'.repeat(64)}};
    const route = `${mesh.base}/api/session-actions/operator/switch`;
    const authenticated = await page.request.post(route, {data: body, headers: {Origin: mesh.base}});
    assert.equal(authenticated.status(), 409);
    const crossOrigin = await page.request.post(route, {data: body,
      headers: {Origin: 'https://another.invalid'}});
    assert.equal(crossOrigin.status(), 403);
    const bearer = await page.request.post(route, {data: body, headers: {
      Origin: mesh.base, Authorization: `Bearer ${mesh.token()}`}});
    assert.equal(bearer.status(), 401);
    assert.equal(await page.request.post(route, {data: {...body, skip: true},
      headers: {Origin: mesh.base}}).then(response => response.status()), 400);
    assert.equal(await page.request.post(route, {data: {...body,
      target: {id: 'default', label: 'Default account', context_revision: null}},
      headers: {Origin: mesh.base}}).then(response => response.status()), 400);
    assert.equal(await page.request.post(route, {
      data: '{"source":{},"source":{},"target":{}}',
      headers: {Origin: mesh.base, 'Content-Type': 'application/json'},
    }).then(response => response.status()), 400);
    assert.equal(await page.request.post(route, {data: JSON.stringify(body),
      headers: {Origin: mesh.base, 'Content-Type': 'text/plain'},
    }).then(response => response.status()), 415);
  } finally {await context.close();}
});
