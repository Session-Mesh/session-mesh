// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "Management" view: a compact, read-only list of the active Mesh sessions, heaviest first,
// then the sessions recently stopped or lost. External sessions are only counted, there is no
// token line and no provenance line (the source of a figure is a tooltip). It displays what
// /api/sessions already carried: it makes no request of its own and has no control. Run in
// headless Chromium on a throwaway server whose session snapshot is the test's own.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1 makes the
// absence a failure). MESH_SHOT_DIR=<dir> also saves screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {type Mesh, startMesh} from './mesh-server-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
// app.js's script-scope snapshot, read inside page functions.
declare const data: {management?: {sessions?: unknown}} | undefined;
const NOW = 2_000_000;

type Metric = {state: string; source: string; value: number | null; observed_at: number | null;
  window: {start: number; end: number} | null; reason: string | null};
const metric = (state: string, source: string, value: number | null = null, window: Metric['window'] = null,
  reason: string | null = null): Metric =>
  ({state, source, value, observed_at: value === null ? null : NOW, window, reason});
const absent = (reason: string) => metric('unknown', 'not-recognized-agent', null, null, reason);

function active(name: string, agent: string, status: string, age: number, cpu: number | null, rss: number | null) {
  return {name, created: NOW - age, source: 'mesh', agent_type: agent, lifecycle: 'active',
    last_observed_agent_status: status, time_basis: 'created', time: NOW - age,
    metrics: {
      observed_duration_seconds: metric('derived', 'management-lifecycle', age, {start: NOW - age, end: NOW}),
      cpu_percent: cpu === null ? absent('not-collected') : metric('derived', 'procfs-stat', cpu, {start: NOW - 10, end: NOW}),
      rss_bytes: rss === null ? absent('not-collected') : metric('reported', 'procfs-statm', rss, {start: NOW, end: NOW}),
      tokens: metric('unavailable', 'no-approved-adapter', null, null, 'not-collected'),
    }};
}
const closed = (name: string, source: string, lifecycle: string, basis: string, ago: number) => ({
  name, created: NOW - 3 * ago, source, agent_type: 'claude', lifecycle, last_observed_agent_status: 'idle',
  time_basis: basis, time: NOW - ago,
  metrics: {observed_duration_seconds: metric('unknown', 'management-lifecycle', null, null, 'no-lifecycle-window'),
    cpu_percent: metric('unknown', 'not-current-mesh-agent', null, null, 'not-live'),
    rss_bytes: metric('unknown', 'not-current-mesh-agent', null, null, 'not-live'),
    tokens: metric('unavailable', 'no-approved-adapter', null, null, 'not-collected')}});
const external = () => ({name: null, created: null, source: 'external', agent_type: 'unknown', lifecycle: 'active',
  last_observed_agent_status: 'unknown', time_basis: 'unknown', time: null,
  metrics: {observed_duration_seconds: metric('unknown', 'management-lifecycle', null, null, 'no-lifecycle-window'),
    cpu_percent: absent('not-collected'), rss_bytes: absent('not-collected'),
    tokens: metric('unavailable', 'no-approved-adapter', null, null, 'not-collected')}});

const SNAPSHOT = {
  state: 'observed', retention: {max_entries: 200, keep_seconds: 14 * 86400},
  sessions: [
    active('light', 'codex', 'idle', 600, 0.5, 40_000_000),
    active('<img src=x onerror=window.__pwn=1>', 'claude', 'busy', 90, 12.5, 900_000_000),
    active('nodata', 'pi', 'shell', 30, null, null),
    active('medium', 'claude', 'waiting', 7200, 3, 300_000_000),
    ...Array.from({length: 6}, external),
    closed('stopped-one', 'observed-stop', 'stopped-observed', 'observed_stopped_at', 500),
    closed('lost-one', 'restart-recovery', 'lost-recovery', 'lost_at', 86400),
  ],
  observability: {state: 'observed', sampling: {cadence_seconds: 10, max_tracked_identities: 200,
    retention: {mode: 'none', persistent: false}}, window: {kind: 'current-snapshot', start: NOW, end: NOW}},
};

let mesh: Mesh;
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  // A skipped describe does not skip this file-level hook: start nothing without a Chromium.
  if (skip) return;
  mesh = await startMesh('mgmtui-');
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
after(async () => {
  for (const context of contexts) {
    // A route handler still fetching when the page closes would reject with "Target page ... has been closed".
    await Promise.all(context.pages().map(page => page.unrouteAll({behavior: 'ignoreErrors'}).catch(() => undefined)));
    await context.close().catch(() => undefined);
  }
  await browser?.close();
  await mesh?.stop();
});

async function opened(locale: string, width: number, management: unknown = SNAPSHOT) {
  const context = await browser.newContext({locale, viewport: {width, height: 900}});
  contexts.push(context);
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.route('**/api/sessions*', async route => {   // also a poll with `since`
    const response = await route.fetch();
    await route.fulfill({response, json: {...(await response.json()), now: NOW, management}});
  });
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`);
  await page.goto(`${mesh.base}/`);
  await page.waitForFunction(() => data?.management?.sessions !== undefined);
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-management"]').click();
  } else {
    await page.locator('#btn-management').click();
  }
  await page.waitForFunction(() => document.body.classList.contains('managing'));
  return {page, requests};
}

async function noOverflow(page: Page): Promise<void> {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#management .management-row')]
    .filter(row => row.scrollWidth > row.clientWidth + 1).map(row => row.textContent)), []);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, {recursive: true});
  // Only the #management element: the sidebar beside it lists this machine's real sessions.
  await page.locator('#management').screenshot({path: path.join(SHOTS, `${name}.png`)});
}

describe('the Management view', {skip}, () => {
  for (const width of [1440, 390]) {
    test(`lists active sessions heaviest first, counts external ones, hides noise, at ${width}px`, async () => {
      const {page, requests} = await opened('en-US', width);
      const names = await page.locator('#management-rows .management-row-title b').allTextContents();
      assert.deepEqual(names, ['<img src=x onerror=window.__pwn=1>', 'medium', 'light', 'nodata'], 'by memory, then CPU');
      assert.equal(await page.locator('#management img, #management script').count(), 0);
      assert.equal(await page.evaluate(() => (window as any).__pwn), undefined);
      const text = await page.locator('#management').innerText();
      assert.match(text, /6 external sessions are not tracked/);
      assert.equal(text.match(/identity not collected|Tokens|source:|measured/i)?.[0], undefined);
      assert.ok(!text.includes('not collected'));
      assert.equal(await page.locator('#management .management-row', {hasText: 'external'}).count(), 0, 'no card per external session');
      const first = page.locator('#management-rows .management-row').first();
      assert.match(await first.innerText(), /CPU 12\.5\s?%.*RSS .*MB/s);
      assert.match(await first.locator('.management-metric[data-kind="rss_bytes"]').getAttribute('title') ?? '', /source: procfs-statm/);
      const unmeasured = page.locator('#management-rows .management-row', {hasText: 'nodata'});
      assert.match(await unmeasured.innerText(), /CPU —/);
      const recent = await page.locator('#management-recent .management-row-title b').allTextContents();
      assert.deepEqual(recent, ['stopped-one', 'lost-one']);
      assert.match(text, /not exit times/);
      assert.equal(await page.locator('#management button, #management select, #management input, #management [data-act]').count(), 0);
      assert.deepEqual(requests.filter(p => p === '/api/management'), []);
      await noOverflow(page);
      await shot(page, `management-${width}-en`);
    });
  }

  test('is in French and makes it explicit when nothing is observed', async () => {
    const {page} = await opened('fr-FR', 1440, {state: 'unavailable', retention: SNAPSHOT.retention, sessions: []});
    const text = await page.locator('#management').innerText();
    assert.match(text, /ptyhost indisponible/);
    assert.match(text, /Aucune session Mesh active/);
    assert.match(text, /Aucun arrêt ni perte observé/);
    assert.ok(!/management\.[a-z]/.test(text), 'no raw key');
  });

  test('refuses a malformed metric instead of displaying it', async () => {
    const bad = structuredClone(SNAPSHOT);
    (bad.sessions[1] as any).metrics.cpu_percent = {state: 'reported', source: 'procfs-stat', value: 'private metric canary',
      observed_at: NOW, window: {start: NOW - 10, end: NOW}, reason: null};
    const {page} = await opened('en-US', 1440, bad);
    assert.ok(!(await page.locator('#management').innerText()).includes('private metric canary'));
  });

  test('Escape leaves the view', async () => {
    const {page} = await opened('en-US', 1440);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.body.classList.contains('managing')), false);
  });
});
