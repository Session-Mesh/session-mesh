// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test as nodeTest} from 'node:test';
import {test, harness, withFixtureServer, sendReplay} from '../../checks/dictation-browser-fixture.ts';

for (const geometry of [null, {rows: 24, cols: 80}]) nodeTest(`dictation fixture sends optional geometry before the initial empty binary replay (${geometry ? 'geometry' : 'legacy'})`, () => {
  const frames: (string | Buffer)[] = [];
  sendReplay({send: data => {frames.push(data);}}, geometry);
  assert.deepEqual(frames, geometry ? [JSON.stringify({t: 'g', ...geometry}), Buffer.alloc(0)] : [Buffer.alloc(0)]);
});

nodeTest('dictation fixture serves real assets, public CSP and JSON catalogs without external traversal', {timeout: 10000}, async () => {
  await withFixtureServer(async base => {
    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') || '', /script-src 'self';/);
    assert.match(await index.text(), /<script src="\/static\/local-entry\.js"><\/script>/);
    for (const language of ['en', 'fr']) {
      const catalog = await fetch(`${base}/static/i18n/${language}.json?v=fixture`);
      assert.equal(catalog.status, 200);
      assert.match(catalog.headers.get('content-type') || '', /^application\/json/);
      assert.equal(typeof await catalog.json(), 'object');
    }
    for (const path of ['/package.json', '/static/%2fetc/passwd', '/static/%2e%2e%2fpackage.json', '/static/..%5cpackage.json']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  });
});

nodeTest('dictation pending fixture omits only the actual external local entry script', {timeout: 10000}, async () => {
  await withFixtureServer(async base => {
    const html = await (await fetch(base)).text();
    assert.doesNotMatch(html, /<script src="\/static\/local-entry\.js"><\/script>/);
    assert.match(html, /<script src="\/static\/app\.js"><\/script>/);
    assert.match(html, /<script src="\/static\/i18n\.js/);
  }, true);
});

test('dictation fixture smoke loads unchanged pending Mesh assets and French catalogs under public CSP', async () => {
  await harness(async (page, api, sockets) => {
    assert.equal(await page.evaluate(() => (MeshI18n.lang)), 'fr');
    assert.equal(await page.evaluate(() => (meshContext)), null);
    assert.equal(await page.locator('script[src="/static/local-entry.js"]').count(), 0);
    assert.deepEqual(api.seen, []); assert.equal(sockets.size, 0);
    assert.equal(await page.evaluate(() => (window.micCalls)), 0);
  }, true);
});
