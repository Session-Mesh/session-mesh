// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Real app/CSS/i18n with a synthetic listing and intercepted terminal WebSockets.
// No native host, PTY, agent or OAuth login is needed. The badge describes Mesh
// account metadata, never an authenticated provider identity.
// Needs MESH_CHROMIUM; MESH_REQUIRE_BROWSER=1 makes its absence a failure.
// MESH_SHOT_DIR optionally saves the synthetic list and pane screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Locator, type Page} from 'playwright-core';
import {type Mesh, startMesh} from './mesh-server-lib.ts';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const WORDING = {
  en: {locale: 'en-US', label: 'Mesh default',
    title: 'No Mesh account alias recorded; the active login is not verified.', named: 'Account: '},
  fr: {locale: 'fr-FR', label: 'Défaut Mesh',
    title: 'Aucun alias de compte Mesh enregistré ; la connexion effective n’est pas vérifiée.', named: 'Compte : '},
} as const;
type Fixture = {id: string; agent: {type: string; status: string} | null; known_agent?: string;
  account?: string | null; account_label?: string; badge: 'default' | 'named' | 'none'};
const SESSIONS: Fixture[] = [
  {id: 'badge-claude-default', agent: {type: 'claude', status: 'idle'}, badge: 'default'},
  {id: 'badge-codex-default', agent: {type: 'codex', status: 'idle'}, account: '', badge: 'default'},
  {id: 'badge-known-claude-default', agent: null, known_agent: 'claude', account: null, badge: 'default'},
  {id: 'badge-claude-named', agent: {type: 'claude', status: 'idle'}, account: 'work', account_label: 'Work alias', badge: 'named'},
  {id: 'badge-codex-named', agent: {type: 'codex', status: 'idle'}, account: 'personal', account_label: 'Personal alias', badge: 'named'},
  {id: 'badge-shell', agent: null, account: null, badge: 'none'},
  {id: 'badge-pi', agent: null, known_agent: 'pi', badge: 'none'},
];
declare const active: {id: string | null} | null;

async function drawer(page: Page, phone: boolean): Promise<void> {
  if (phone && !await page.evaluate(() => document.body.classList.contains('drawer'))) {
    await page.locator('#btn-menu').click();
    await page.waitForFunction(() => document.body.classList.contains('drawer'));
  }
}

async function fits(page: Page, badge?: Locator): Promise<void> {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow');
  if (!badge) return;
  const box = await badge.boundingBox();
  const width = page.viewportSize()!.width;
  assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1,
    'the account badge is visible inside the viewport');
  assert.equal(await badge.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true,
    'the short metadata label is not clipped');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, {recursive: true});
  await page.screenshot({path: path.join(SHOTS, `account-badge-${name}.png`), fullPage: true, animations: 'disabled'});
}

describe('Mesh account metadata badges in list and terminal header', {skip}, () => {
  let mesh: Mesh;
  let browser: Browser;
  before(async () => {
    mesh = await startMesh('account-badge-ui-');
    browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
  });
  after(async () => {
    try { await browser?.close(); }
    finally { await mesh?.stop(); }
  });

  for (const width of [1440, 390]) for (const language of ['en', 'fr'] as const) {
    test(`${language}, ${width}px: default, named aliases and non-agent transitions`, async () => {
      const wording = WORDING[language];
      const phone = width === 390;
      const context = await browser.newContext({locale: wording.locale, viewport: {width, height: 900},
        isMobile: phone, hasTouch: phone, serviceWorkers: 'block'});
      let pageForCleanup: Page | undefined;
      try {
        const page = await context.newPage();
        pageForCleanup = page;
        page.setDefaultTimeout(READY_TIMEOUT_MS);
        const problems: string[] = [];
        const mutations: string[] = [];
        const sockets: string[] = [];
        page.on('pageerror', error => problems.push(String(error)));
        // All polls, including deltas, get a complete deterministic snapshot.
        // Fulfill directly: no live APIResponse/route.fetch survives teardown.
        await page.route('**/api/sessions*', route => route.fulfill({json: {
          mesh: SESSIONS.map(({badge: _badge, ...session}, index) => ({...session, kind: 'mesh', name: session.id,
            label: session.id, created: 1000 + index, activity: 1000 + index, attached: 0, cwd: mesh.home,
            folder: null, rank: index, notice: null})),
          external: [], folders: [], moved: {}, opens: {}, home: mesh.home, now: 2000, gen: 1, full: true,
        }}));
        // Actual control routes: kill also carries restart decisions. Include
        // action claim/decision, restore/discard and history-based creation.
        await page.route(url => /^\/api\/(?:new|adopt|kill\/[^/]+|restore(?:\/discard)?|history\/resume|session-actions\/[^/]+\/(?:claim|decision))$/.test(url.pathname), route => {
          mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
          return route.fulfill({status: 409, body: 'The badge fixture never starts or changes sessions'});
        });
        await page.routeWebSocket('**/ws/**', socket => {
          const name = decodeURIComponent(new URL(socket.url()).pathname.slice('/ws/'.length));
          assert.ok(SESSIONS.some(session => session.id === name), 'only synthetic terminals are opened');
          sockets.push(name);
          socket.onMessage(() => {}); // deliberately no connectToServer: no native PTY exists
        });
        await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
        await page.goto(`${mesh.base}/`);
        await page.waitForFunction(lang => document.documentElement.lang === lang, language);
        await page.locator(`#list .item[data-id="${SESSIONS[0]!.id}"]`).waitFor({state: 'attached'});
        await drawer(page, phone);

        for (const session of SESSIONS) {
          const row = page.locator(`#list .item[data-id="${session.id}"]`);
          await row.waitFor({state: 'visible'});
          await row.scrollIntoViewIfNeeded();
          const badge = row.locator('.account-badge');
          if (session.badge === 'none') {
            assert.equal(await badge.count(), 0, `${session.id}: no invented default badge`);
          } else {
            const label = session.badge === 'default' ? wording.label : session.account_label!;
            const title = session.badge === 'default' ? wording.title : wording.named + label;
            assert.equal(await badge.textContent(), label);
            assert.equal(await badge.getAttribute('title'), title, 'metadata wording, never a verified OAuth identity');
            await fits(page, badge);
          }
        }
        await shot(page, `${width}-${language}-list`);

        // Reuse the active pane: leaving a default/named account for a plain
        // shell must clear both text and tooltip, not retain an old identity.
        for (const session of [...SESSIONS, SESSIONS[0]!]) {
          await drawer(page, phone);
          await page.locator(`#list .item[data-id="${session.id}"]`).click();
          const expectedText = session.badge === 'none' ? '' : session.badge === 'default' ? wording.label : session.account_label!;
          const expectedTitle = session.badge === 'none' ? '' : session.badge === 'default' ? wording.title : wording.named + expectedText;
          await page.waitForFunction(expected => {
            const badge = document.querySelector<HTMLElement>('#panes .pane.active .p-account');
            return active?.id === expected.id && badge?.textContent === expected.text
              && badge.title === expected.title && badge.hidden === expected.hidden;
          }, {id: session.id, text: expectedText, title: expectedTitle, hidden: session.badge === 'none'});
          const badge = page.locator('#panes .pane.active .p-account');
          if (session.badge === 'none') {
            assert.equal(await badge.isVisible(), false);
            assert.equal(await badge.textContent(), '');
            assert.equal(await badge.getAttribute('title'), '');
          } else {
            const label = session.badge === 'default' ? wording.label : session.account_label!;
            await page.waitForFunction(text => document.querySelector('#panes .pane.active .p-account')?.textContent === text, label);
            assert.equal(await badge.isVisible(), true);
            assert.equal(await badge.getAttribute('title'), session.badge === 'default' ? wording.title : wording.named + label);
            await fits(page, badge);
          }
          await shot(page, `${width}-${language}-${session.id}`);
        }
        assert.ok(sockets.length > 0, 'terminal connections are intercepted by the fixture');
        assert.deepEqual(mutations, [], 'no creation, kill/restart, adopt, action decision or restore API was requested');
        assert.deepEqual(problems, [], 'no uncaught page error');
      } finally {
        try { await pageForCleanup?.unrouteAll({behavior: 'wait'}); }
        finally { await context.close(); }
      }
    });
  }
});
