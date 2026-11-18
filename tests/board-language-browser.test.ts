// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The whiteboard's Excalidraw interface follows the language the session-mesh interface
// chose (MeshI18n): French for a French browser, English otherwise, and Excalidraw no
// longer resets <html lang> to "en".
//
// Checks the committed bundle (static/vendor/board-*.js): it passes once the bundle is
// rebuilt from static/board-src.mjs (`npm run build:board`). MESH_BOARD_STATIC points the
// server at another static/ tree, to check a build before it is committed.
// Needs a Chromium: MESH_CHROMIUM=<path>; skipped without it (MESH_REQUIRE_BROWSER=1
// makes the absence a failure).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {chromium, type Browser} from 'playwright-core';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';

const STATIC = path.resolve(process.env.MESH_BOARD_STATIC ?? path.join(import.meta.dirname, '..', 'static'));
const CHROMIUM = process.env.MESH_CHROMIUM ?? '';
const skip = !CHROMIUM && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM not set' : false;
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const EMPTY_BOARD = {elements: [], appState: {}, files: {}, version: 1};

function handle(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/board/')) {
    response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(EMPTY_BOARD));
    return;
  }
  const file = path.resolve(STATIC, url.pathname.replace(/^\/static\//, ''));
  if (!url.pathname.startsWith('/static/') || !file.startsWith(STATIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream'}).end(fs.readFileSync(file));
}

describe('whiteboard interface language', {skip}, () => {
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

  for (const [locale, lang, selection] of [['fr-FR', /^fr/, 'Sélection'], ['en-US', /^en/, 'Selection']] as const) {
    test(`a ${locale} browser gets Excalidraw in its language`, async () => {
      const context = await browser.newContext({locale});
      const page = await context.newPage();
      await page.goto(`${origin}/static/board.html?session=s`);
      const tool = page.locator('[data-testid="toolbar-selection"]');
      await tool.waitFor({state: 'attached'});
      await page.waitForFunction(expected => document.querySelector('[data-testid="toolbar-selection"]')?.getAttribute('aria-label') === expected, selection, {timeout: READY_TIMEOUT_MS});
      assert.equal(await tool.getAttribute('aria-label'), selection);
      assert.match(await page.evaluate(() => document.documentElement.lang), lang);
      await context.close();
    });
  }
});
