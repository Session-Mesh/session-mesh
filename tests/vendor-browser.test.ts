// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pages that use third-party files still work without the files the license
// rule removed (static/vendor/THIRD_PARTY.md): the code viewer colours CSS and HTML
// without Monaco's CSS and HTML workers, and the whiteboard draws its Virgil and
// Cascadia text with the free fonts of static/vendor/fonts/, with no Mermaid entry.
//
// A small static server stands in for the mesh: it serves static/, Monaco under
// /viewlib/monaco/, code.html filled in as codeview.py does, and a one-board API.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1
// makes the absence a failure).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser, type Page} from 'playwright-core';
import {chromiumLaunchOptions} from './helpers/browser-launch.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATIC = path.join(ROOT, 'static');
const MONACO = path.join(STATIC, 'vendor', 'monaco');
const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const SAMPLES: Record<string, [string, string]> = {
  'style.css': ['css', 'body { color: #333; margin: 0 auto; }\n@media (max-width: 40em) { .nav > a:hover { display: none; } }\n'],
  'page.html': ['html', '<!doctype html>\n<html lang="en"><head><title>x</title></head>\n<body class="a"><p id="b">Hello</p></body></html>\n'],
};
const NONCE = 'test-nonce';
const CODE_CSP = `sandbox allow-scripts; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
  `font-src 'self' data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; script-src 'nonce-${NONCE}'`;

function sendFile(response: http.ServerResponse, base: string, relative: string, cors = false): void {
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end();
    return;
  }
  const headers: Record<string, string> = {'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream'};
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  response.writeHead(200, headers).end(fs.readFileSync(file));
}

// code.html filled in as codeview.code_page does it.
function codePage(name: string): string {
  const [lang, text] = SAMPLES[name];
  const src = JSON.stringify(text).replaceAll('</', '<\\/');
  const values: Record<string, string> = {title: name, src, nonce: NONCE, lang, monaco: 'test'};
  return fs.readFileSync(path.join(STATIC, 'code.html'), 'utf8')
    .replace(/\{\{(title|src|nonce|lang|monaco)\}\}/g, (_, key: string) => values[key]);
}

const board = {elements: [{type: 'text', id: 't1', x: 10, y: 10, width: 80, height: 25, text: 'hello', fontFamily: 1,
  fontSize: 20, version: 1, versionNonce: 1, seed: 1, angle: 0, strokeColor: '#000', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], isDeleted: false,
  textAlign: 'left', verticalAlign: 'top', baseline: 18, originalText: 'hello', lineHeight: 1.25}],
appState: {}, files: {}, version: 1};

function handle(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/code/')) {
    response.writeHead(200, {'Content-Type': 'text/html', 'Content-Security-Policy': CODE_CSP}).end(codePage(url.pathname.slice(6)));
  } else if (url.pathname.startsWith('/viewlib/monaco/')) {
    sendFile(response, MONACO, url.pathname.slice('/viewlib/monaco/'.length), true);
  } else if (url.pathname.startsWith('/api/board/')) {
    response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(request.method === 'PUT' ? {version: 2} : board));
  } else if (url.pathname.startsWith('/static/')) {
    sendFile(response, STATIC, url.pathname.slice('/static/'.length));
  } else {
    response.writeHead(404).end();
  }
}

type Watch = {requests: string[]; errors: string[]};

function watch(page: Page): Watch {
  const seen: Watch = {requests: [], errors: []};
  page.on('request', request => seen.requests.push(request.url()));
  page.on('pageerror', error => seen.errors.push(String(error)));
  return seen;
}

describe('pages without the removed third-party files', {skip}, () => {
  let server: http.Server;
  let origin = '';
  let browser: Browser;

  before(async () => {
    server = http.createServer(handle);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch(chromiumLaunchOptions(CHROMIUM, ['--no-sandbox']));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  for (const name of Object.keys(SAMPLES)) {
    test(`the code viewer colours ${name} without the language worker`, async () => {
      const page = await browser.newPage({locale: 'en-US'});
      const seen = watch(page);
      await page.goto(`${origin}/code/${name}`);
      await page.locator('.view-lines span[class^="mtk"]').first().waitFor();
      await page.waitForTimeout(500);
      const classes = await page.$$eval('.view-lines span[class^="mtk"]', spans => [...new Set(spans.map(span => span.className))]);
      assert.ok(classes.length >= 3, `token classes: ${classes.join(' ')}`);
      assert.deepEqual(seen.requests.filter(url => /(css|html)Worker\.js/.test(url)), []);
      assert.deepEqual(seen.errors, []);
      await page.close();
    });
  }

  test('the whiteboard uses the free fonts for Virgil and Cascadia and offers no Mermaid dialog', async () => {
    const page = await browser.newPage({locale: 'en-US'});
    const seen = watch(page);
    await page.goto(`${origin}/static/board.html?session=s`);
    await page.locator('.excalidraw .App-toolbar').waitFor();
    const loaded = await page.evaluate(async () => {
      await Promise.all([document.fonts.load('20px Virgil'), document.fonts.load('20px Cascadia')]);
      return [document.fonts.check('20px Virgil'), document.fonts.check('20px Cascadia')];
    });
    assert.deepEqual(loaded, [true, true]);
    assert.ok(seen.requests.some(url => url.endsWith('/static/vendor/fonts/Excalifont-Regular.woff2')), 'Excalifont requested');
    assert.ok(seen.requests.some(url => url.endsWith('/static/vendor/fonts/ComicShanns2-Regular.ttf')), 'Comic Shanns requested');
    assert.deepEqual(seen.requests.filter(url => /Virgil\.woff2|Cascadia\.woff2/.test(url)), []);
    assert.equal(await page.locator('[data-testid="toolbar-image"]').count(), 0);
    await page.locator('.App-toolbar__extra-tools-trigger').click();
    await page.locator('[data-testid="toolbar-frame"]').waitFor();
    assert.equal(await page.getByText('Web Embed').filter({visible: true}).count(), 1);
    assert.equal(await page.getByText('Mermaid', {exact: false}).filter({visible: true}).count(), 0);
    assert.deepEqual(seen.errors, []);
    await page.close();
  });
});
