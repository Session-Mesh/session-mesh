// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A document's file name must never decide two different things in two different ways.
// The panel leaves PDFs and images without a sandbox (the browser's own viewer renders them);
// everything else gets `Content-Security-Policy: sandbox`. Both that decision and the
// Content-Type come from the same suffix: a name such as `ab:evil.html?.png` (read as a URL,
// its "path" ends in .html) must not be served as HTML without a sandbox.
//
// Over HTTP: /api/view and /view agree, and only an exact list of types goes unsandboxed.
// In Chromium (MESH_CHROMIUM): the trapped file's own script reaches neither the mesh page
// nor its API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {type Mesh, startMesh} from './mesh-server-lib.ts';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

// Globals of static/app.js, read inside page functions.
declare const openWeb: unknown;
declare const panes: unknown[];

const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skipBrowser = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const INERT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PROBE = `(async () => {
  let title = 'blocked', api = 'blocked';
  try { title = parent.document.title; parent.document.documentElement.dataset.pwned = '1'; } catch (e) {}
  try { api = String((await fetch('/api/sessions')).status); } catch (e) {}
  parent.postMessage({trap: true, title, api, origin: self.origin}, '*');
})();`;
const HTML = `<!doctype html><title>trap</title><script>${PROBE}</script>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>${PROBE.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</script></svg>`;
// name -> content. Every name has an inert-looking last suffix or an active type hidden
// behind a URL delimiter, a percent escape, a second extension or letter case.
const TRAPS: Record<string, string> = {
  'ab:evil.html?.png': HTML,
  'ab:x.svg#.pdf': SVG,
  'evil.html?.png': HTML,
  'evil.html#.png': HTML,
  'evil.html#.pdf': HTML,
  'evil.htm?x=1.jpg': HTML,
  'evil.html%3F.png': HTML,
  'evil.html%23.pdf': HTML,
  'ab:EVIL.HTML?.PNG': HTML,
  'Evil.Html?.Gif': HTML,
  'evil.html.png': HTML,
  'evil.svg.webp': SVG,
  'evil.png.html': HTML,
  'evil.pdf.HTML': HTML,
  'EVIL.SVG': SVG,
  'data:evil.html?.jpeg': HTML,
  'http:evil.html?.png': HTML,
};

let mesh: Mesh;
let docs = '';

before(async () => {
  mesh = await startMesh('view-filename-');
  docs = path.join(mesh.home, 'docs');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'control.html'), HTML);
  for (const [name, content] of Object.entries(TRAPS)) fs.writeFileSync(path.join(docs, name), content);
});

after(async () => { await mesh?.stop(); });

type Described = {url: string; sandbox: string | null; inert?: boolean};

async function describeDoc(name: string): Promise<Described> {
  const response = await fetch(`${mesh.base}/api/view`, {method: 'POST', body: JSON.stringify({target: path.join(docs, name)}),
    headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, `${name}: ${await response.clone().text()}\n${mesh.output()}`);
  return await response.json() as Described;
}

describe('the sandbox and the Content-Type come from the same suffix', () => {
  for (const name of Object.keys(TRAPS)) {
    for (const dest of ['iframe', 'document', 'image', undefined]) {
      test(`${name} (Sec-Fetch-Dest: ${dest ?? 'absent'})`, async () => {
        const described = await describeDoc(name);
        const response = await fetch(mesh.base + described.url, {headers: dest ? {'Sec-Fetch-Dest': dest} : {}});
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
        const csp = response.headers.get('Content-Security-Policy') ?? '';
        const sandboxed = /^sandbox( |;|$)/.test(csp);
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
        // only an exact list of types is ever served without a sandbox
        assert.ok(sandboxed || INERT_TYPES.includes(type), `${name}: ${type} served without a sandbox`);
        // /api/view tells the frame the same thing the response does
        assert.equal(described.sandbox === null, INERT_TYPES.includes(type), `${name}: sandbox ${described.sandbox} for ${type}`);
        assert.equal(described.inert === true, INERT_TYPES.includes(type));
        if (described.sandbox !== null) assert.ok(sandboxed, `${name}: frame sandboxed but response is not`);
      });
    }
  }

  test('a real image and a real PDF keep their type and stay unsandboxed', async () => {
    for (const [name, type] of [['photo.PNG', 'image/png'], ['doc.pdf', 'application/pdf'], ['a.b.JPeG', 'image/jpeg']]) {
      fs.writeFileSync(path.join(docs, name), 'x');
      const described = await describeDoc(name);
      const response = await fetch(mesh.base + described.url);
      assert.equal(response.headers.get('Content-Type'), type);
      assert.equal(response.headers.get('Content-Security-Policy'), null);
      assert.deepEqual([described.sandbox, described.inert], [null, true]);
    }
  });
});

describe('a trapped file name runs no script in the mesh origin', {skip: skipBrowser}, () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox']));
    page = await (await browser.newContext()).newPage();
    await page.goto(`${mesh.base}/login?token=${mesh.token()}`);
    // A function, not a string: the main page's CSP refuses string evaluation (no 'unsafe-eval').
    await page.waitForFunction(() => typeof openWeb === 'function' && panes.length > 0);
    await page.evaluate(() => {
      const seen: unknown[] = [];
      (window as unknown as {trapMessages: unknown[]}).trapMessages = seen;
      window.addEventListener('message', event => { if (event.data?.trap) seen.push(event.data); });
    });
  });
  after(async () => { await browser?.close(); });

  type Report = {title: string; api: string; origin: string};

  async function openAndCollect(name: string): Promise<{reports: Report[]; pwned: boolean; sandbox: string | null}> {
    await page.evaluate(() => {
      (window as unknown as {trapMessages: unknown[]}).trapMessages.length = 0;
      delete document.documentElement.dataset.pwned;
    });
    const served = page.waitForResponse(response => response.url().includes('/view/v2.')
      && decodeURIComponent(new URL(response.url()).pathname).endsWith(`/${name}`));
    await page.evaluate(target => (window as unknown as {openWeb: (t: string) => unknown}).openWeb(target), path.join(docs, name));
    await served;
    await page.waitForFunction(() => (window as unknown as {trapMessages: unknown[]}).trapMessages.length > 0, undefined, {timeout: 1500})
      .catch(() => undefined);
    return await page.evaluate(() => ({
      reports: (window as unknown as {trapMessages: Report[]}).trapMessages.slice(),
      pwned: document.documentElement.dataset.pwned === '1',
      sandbox: document.querySelector('iframe.web:not([hidden])')?.getAttribute('sandbox') ?? null,
    }));
  }

  test('the control page runs its script, isolated', async () => {
    const {reports, pwned} = await openAndCollect('control.html');
    assert.deepEqual(reports, [{trap: true, title: 'blocked', api: 'blocked', origin: 'null'}]);
    assert.equal(pwned, false);
  });

  for (const name of Object.keys(TRAPS)) {
    test(`${name} reads neither parent.document nor the API`, async () => {
      const {reports, pwned} = await openAndCollect(name);
      assert.equal(pwned, false, `${name} wrote into the mesh page`);
      for (const report of reports) {
        assert.deepEqual([report.title, report.api, report.origin], ['blocked', 'blocked', 'null'], name);
      }
    });
  }

  test('a document described without a sandbox value is still framed with one', async () => {
    // The page must not drop the attribute because a field is missing: only an explicit
    // "inert" answer from the server does that.
    await page.route('**/api/view', async route => {
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      delete body.sandbox;
      delete body.inert;
      await route.fulfill({response, json: body});
    });
    try {
      const {reports, pwned, sandbox} = await openAndCollect('control.html');
      assert.equal(sandbox, '');
      assert.equal(pwned, false);
      assert.deepEqual(reports, []);
    } finally {
      await page.unroute('**/api/view');
    }
  });
});
