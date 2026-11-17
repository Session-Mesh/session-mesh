// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path: string) => fs.readFileSync(new URL(path, root), 'utf8');
const manifest = JSON.parse(read('static/manifest.webmanifest'));

test('install identity stays stable while icon URLs identify their PNG content', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map((icon: { src: string }) => new URL(icon.src, 'https://mesh.test').pathname), [
    '/static/icons/icon-192.png', '/static/icons/icon-512.png', '/static/icons/maskable-512.png',
  ]);
  for (const icon of manifest.icons) {
    const url = new URL(icon.src, 'https://mesh.test');
    const bytes = fs.readFileSync(new URL(url.pathname.slice(1), root));
    assert.equal(url.search, '?v=' + createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      'After editing a PNG, update its content version in the manifest, worker and apple-touch link');
    assert.equal(url.hash, '');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(icon.sizes, `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
    assert.equal(icon.type, 'image/png');
  }
  assert.equal(manifest.icons[2].purpose, 'maskable');
});

test('apple-touch and actual push notifications use the versioned manifest icon', async () => {
  const icon = manifest.icons[0].src;
  assert.ok(read('static/index.html').includes(`rel="apple-touch-icon" href="${icon}"`));
  const listeners = new Map();
  const shown: { icon: string }[] = [];
  vm.runInNewContext(read('static/sw.js'), {
    self: {
      addEventListener: (name: string, callback: unknown) => listeners.set(name, callback),
      clients: { matchAll: async () => [] },
      registration: { showNotification: async (_title: string, options: { icon: string }) => shown.push(options) },
    },
  });
  let pending: Promise<void> | undefined;
  listeners.get('push')({ data: { json: () => ({ title: 'Ready' }) }, waitUntil: (p: Promise<void>) => { pending = p; } });
  await pending;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].icon, icon);
});
