// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Timeline tab colours each bar by task status (static/work-frise-view.ts, .work-bar-* in static/style.css) in
// headless Chromium against the real server and the real work-read program on a fictional tracker with a task in
// each status: the computed bar colours differ by status, the legend lists them, a bar carries its status as a
// name, and nothing overflows at 1440 and 390 px in the default dark theme, Gruvbox dark and a light theme.
// Free MESH_PORT, temporary home and MESH_CONF_DIR, WL_HOME in a temporary directory; never a real tracker.
// Needs MESH_CHROMIUM, MESH_WORK_READ_CMD / MESH_WORK_WRITE_CMD (default: the dune build outputs) and
// MESH_PTYHOST_CMD; skipped without a Chromium or the programs. MESH_SHOT_DIR=<dir> saves screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { type Mesh, REPO, startMesh } from './mesh-server-lib.ts';
import { chromiumLaunchOptions } from './helpers/browser-launch.ts';

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const SHOTS = process.env.MESH_SHOT_DIR ?? '';
const READER = process.env.MESH_WORK_READ_CMD || path.join(REPO, 'ocaml/_build/default/work_read/bin/work_read_main.exe');
const WRITER = process.env.MESH_WORK_WRITE_CMD || path.join(REPO, 'ocaml/_build/default/work_write/bin/work_write_main.exe');
const skip = (!CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false)
  || ((!fs.existsSync(READER) || !fs.existsSync(WRITER)) && !process.env.MESH_REQUIRE_WORK_READ && !process.env.CI
    ? 'built work-read and work-write are required' : false);
const FIXTURE = path.join(REPO, 'ocaml/worklog/test/fixture');
const WIDTHS = [1440, 390] as const;
const THEMES = ['default', 'gruvbox-dark', 'light'] as const;
const STATUSES = ['todo', 'in_progress', 'waiting', 'blocked', 'done', 'dropped'] as const;

const EVENTS = STATUSES.flatMap((status, index) => {
  const task = `T-c0${index}0`;
  const day = String(index + 1).padStart(2, '0');
  const events: object[] = [
    { ts: `2026-11-${day}T09:00:00Z`, task, type: 'created', title: `Colour check ${status}`, project: 'gateway', category: 'platform', priority: 'P2', status: 'todo' },
    { ts: `2026-11-${day}T09:01:00Z`, task, type: 'set', field: 'project', to: 'P-5e6f' },
  ];
  if (status !== 'todo') events.push({ ts: `2026-11-${day}T10:00:00Z`, task, type: 'set', field: 'status', to: status });
  return events;
});

let browser: Browser;
let mesh: Mesh;
const contexts: BrowserContext[] = [];
const scratch: string[] = [];

before(async () => {
  if (skip) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frise-colours-'));
  scratch.push(directory);
  const tracker = path.join(directory, 'tracker');
  fs.cpSync(FIXTURE, tracker, { recursive: true });
  fs.writeFileSync(path.join(tracker, 'events', '2026-11.hostc.jsonl'), EVENTS.map(event => JSON.stringify(event)).join('\n') + '\n');
  mesh = await startMesh('frisecol-', { WL_HOME: tracker, WL_HOST: 'testhost', WL_NOW: '2026-11-10T00:00:00Z',
    MESH_WORK_READ_CMD: READER, MESH_WORK_WRITE_CMD: WRITER, MESH_WORK_READ_TIMEOUT: '90' });
  browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox', '--mute-audio']));
});
afterEach(async () => { for (const context of contexts.splice(0)) await context.close().catch(() => undefined); });
after(async () => {
  await browser?.close();
  await mesh?.stop();
  for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: true });
});

async function openTimeline(locale: string, width: number, theme: string): Promise<Page> {
  const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
  contexts.push(context);
  await context.addInitScript(name => { try { localStorage.setItem('mesh.theme', JSON.stringify(name)); } catch { /* default theme */ } }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  await page.goto(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, { timeout: 180_000 });
  await page.goto(`${mesh.base}/`, { timeout: 180_000 });
  await page.waitForSelector('#btn-projects', { state: 'attached' });
  await page.waitForFunction('typeof meshContext !== "undefined" && meshContext !== null');
  if (width <= 600) {
    await page.locator('#btn-mobile-actions').click();
    await page.locator('[data-mobile-action="btn-projects"]').click();
  } else {
    await page.locator('#btn-projects').click();
  }
  await page.locator('.work-entry-project', { hasText: 'Delivery rollout' }).click();
  await page.locator('.work-tab').nth(2).click();
  await page.locator('#work-panel-frise .work-bar-span').first().waitFor();
  return page;
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    describe(`Timeline status colours at ${width}px in ${theme}`, { skip }, () => {
      test('bars differ by status, carry their status as a name, and the legend lists every status', { timeout: 900_000 }, async () => {
        const page = await openTimeline('en-US', width, theme);
        assert.equal(await page.evaluate(() => document.documentElement.dataset['theme']), theme);
        const seen = await page.evaluate(() => {
          const result: Record<string, { color: string; pattern: string; label: string | null; title: string | null; role: string | null }> = {};
          for (const row of document.querySelectorAll('#work-panel-frise .work-frise-row')) {
            const title = row.querySelector('.work-frise-title')?.textContent ?? '';
            const bar = row.querySelector<HTMLElement>('.work-bar-span');
            const match = /^Colour check (\w+)$/.exec(title);
            if (!bar || !match) continue;
            const style = getComputedStyle(bar);
            result[match[1]!] = { color: [style.backgroundColor, style.borderTopStyle, style.borderTopColor, style.backgroundImage, getComputedStyle(bar, '::after').content].join('|'),
              pattern: style.backgroundImage, label: bar.getAttribute('aria-label'), title: bar.getAttribute('title'), role: bar.getAttribute('role') };
          }
          return result;
        });
        assert.deepEqual(Object.keys(seen).sort(), [...STATUSES].sort());
        const words: Record<string, string> = { todo: 'to do', in_progress: 'in progress', waiting: 'waiting', blocked: 'blocked', done: 'done', dropped: 'dropped' };
        for (const status of STATUSES) {
          const bar = seen[status]!;
          assert.equal(bar.role, 'img', status);
          assert.equal(bar.label, `Status: ${words[status]}`, status);
          assert.equal(bar.title, bar.label, status);
        }
        const looks = new Set(STATUSES.map(status => seen[status]!.color));
        assert.equal(looks.size, STATUSES.length, 'each status has its own computed colour and pattern');
        // the colour of a solid bar is the status dot's colour
        const dot = (status: string): Promise<string> => page.evaluate(name => {
          const row = [...document.querySelectorAll('#work-panel-frise .work-frise-row')].find(item => item.textContent?.includes(`Colour check ${name}`))!;
          return getComputedStyle(row.querySelector('.work-dot')!).backgroundColor;
        }, status);
        const solid = async (status: string): Promise<string> => page.evaluate(name => {
          const row = [...document.querySelectorAll('#work-panel-frise .work-frise-row')].find(item => item.textContent?.includes(`Colour check ${name}`))!;
          return getComputedStyle(row.querySelector('.work-bar-span')!).backgroundColor;
        }, status);
        for (const status of ['in_progress', 'done', 'blocked']) assert.equal(await solid(status), await dot(status), `${status} bar uses the dot colour`);
        const legend = await page.locator('.work-frise-status-legend li').allTextContents();
        assert.deepEqual(legend.map(text => text.trim()), ['to do', 'in progress', 'waiting', 'blocked', 'done', 'dropped']);
        assert.equal(await page.locator('.work-frise-status-legend').getAttribute('aria-label'), 'Bar by status');
        const swatches = await page.locator('.work-frise-status-legend .work-bar-swatch').evaluateAll(nodes =>
          nodes.map(node => getComputedStyle(node).backgroundColor + '|' + getComputedStyle(node).borderTopColor + '|' + getComputedStyle(node).backgroundImage));
        assert.equal(new Set(swatches).size, 6, 'the six swatches look different');
        const overflow = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          wide: [...document.querySelectorAll<HTMLElement>('#work-root *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 5).map(node => `${node.tagName}.${node.className}`),
        }));
        assert.equal(overflow.page, 0);
        assert.deepEqual(overflow.wide, []);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `frise-colours-${theme}-${width}.png`) }); }
      });
    });
  }
}

describe('Timeline legend in French', { skip }, () => {
  test('the legend and the bar names are in French', { timeout: 900_000 }, async () => {
    const page = await openTimeline('fr-FR', 1440, 'default');
    const legend = await page.locator('.work-frise-status-legend li').allTextContents();
    assert.deepEqual(legend.map(text => text.trim()), ['à faire', 'en cours', 'en attente', 'bloquée', 'terminée', 'abandonnée']);
    const names = await page.locator('#work-panel-frise .work-bar-span').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.ok(names.includes('Statut : en cours'));
  });
});
