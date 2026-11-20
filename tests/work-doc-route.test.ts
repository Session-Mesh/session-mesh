// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The server side of the Projects document panel (static/work-doc-panel.ts) against a real server.py: POST /api/view
// decides which references may be shown (view roots, protected folders, symbolic links, traversal) and who may ask
// (the browser cookie or the master token, never a session token), and GET /view/<capability>/<path>?static=1 serves
// an HTML or SVG page without any script (CSP sandbox without allow-scripts, script-src 'none'), with its type and
// nosniff. Fictional documents only, in a temporary home; nothing here uses the default port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { REPO, type Mesh, startMesh } from './mesh-server-lib.ts';

let mesh: Mesh;
let notes: string;

const PAGE = '<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1>'
  + '<svg width="40" height="40"><circle cx="20" cy="20" r="18" fill="teal"/></svg>'
  + '<script>window.parent.postMessage("ran", "*")</script></body></html>';

before(async () => {
  mesh = await startMesh('work-doc-route-');
  notes = path.join(mesh.home, 'notes', '2026-11-20-fictional');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'plan.html'), PAGE);
  fs.writeFileSync(path.join(notes, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(notes, 'review.md'), '# Review\n\n<script>alert(1)</script>\n');
  fs.writeFileSync(path.join(notes, 'huge.html'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  fs.mkdirSync(path.join(mesh.home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(mesh.home, '.ssh', 'notes.md'), 'secret\n');
  fs.symlinkSync(path.join(REPO, 'README.md'), path.join(notes, 'outside.md'));
  fs.symlinkSync(path.join(mesh.home, '.ssh', 'notes.md'), path.join(notes, 'keys.md'));
  fs.symlinkSync(path.join(mesh.home, '.ssh'), path.join(notes, 'keydir'));
});
after(async () => { await mesh?.stop(); });

const view = (target: string, headers: Record<string, string> = { Authorization: `Bearer ${mesh.token()}` }) =>
  fetch(`${mesh.base}/api/view`, { method: 'POST', body: JSON.stringify({ target }), headers: { ...headers, 'Content-Type': 'application/json' } });

async function signed(target: string): Promise<{ url: string; ext: string }> {
  const response = await view(target);
  assert.equal(response.status, 200, `${target}: ${await response.clone().text()}`);
  const descriptor = await response.json() as { url: string; ext: string };
  assert.match(descriptor.url, /^\/view\/v2\.[fd]\./);
  return descriptor;
}

describe('which references the panel may show', () => {
  test('a document under the home folder, by a home path', async () => {
    const descriptor = await signed('~/notes/2026-11-20-fictional/plan.html');
    assert.equal(descriptor.ext, '.html');
  });

  test('outside the view roots, protected, through a symbolic link or by traversal: refused', async () => {
    for (const target of [path.join(REPO, 'README.md'), '~/.ssh/notes.md', '~/notes/2026-11-20-fictional/../../.ssh/notes.md',
      '~/notes/2026-11-20-fictional/outside.md', '~/notes/2026-11-20-fictional/keys.md', '~/notes/2026-11-20-fictional/keydir/notes.md']) {
      const response = await view(target);
      assert.ok(response.status === 403 || response.status === 404, `${target}: ${response.status}`);
    }
  });

  test('a missing document is not found', async () => {
    assert.equal((await view('~/notes/2026-11-20-fictional/none.html')).status, 404);
  });

  test('a session token, no credential, or another origin cannot ask', async () => {
    const target = '~/notes/2026-11-20-fictional/plan.html';
    assert.equal((await view(target, { Authorization: 'MeshSession v1.fictional.0123456789abcdef' })).status, 401);
    assert.equal((await view(target, {
      Authorization: 'MeshSession v1.fictional.0123456789abcdef', Cookie: 'x=y',
    })).status, 401);
    assert.equal((await view(target, {})).status, 401);
    assert.equal((await view(target, { Authorization: `Bearer ${mesh.token()}`, Origin: 'https://evil.example' })).status, 403);
  });
});

describe('what the document URL serves', () => {
  test('?static=1: an HTML page with a sandbox without scripts, script-src none, its type and nosniff', async () => {
    const { url } = await signed('~/notes/2026-11-20-fictional/plan.html');
    const response = await fetch(`${mesh.base}${url}?static=1`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    const directives = new Map(csp.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    assert.deepEqual(directives.get('sandbox'), [], csp);
    assert.deepEqual(directives.get('default-src'), ["'none'"], csp);
    assert.deepEqual(directives.get('script-src'), ["'none'"], csp);
    assert.deepEqual(directives.get('connect-src'), ["'none'"], csp);
    assert.deepEqual(directives.get('frame-src'), ["'none'"], csp);
    assert.ok(!csp.includes('allow-scripts') && !csp.includes('allow-same-origin') && !csp.includes('unsafe-eval'), csp);
    assert.ok(!/https?:/.test(csp), 'no remote source');
    assert.equal(await response.text(), PAGE, 'the bytes as written: no bridge script is added');
  });

  test('?static=1 on an SVG: the same policy, typed as SVG', async () => {
    const { url } = await signed('~/notes/2026-11-20-fictional/diagram.svg');
    const response = await fetch(`${mesh.base}${url}?static=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox; default-src 'none';.*script-src 'none'/);
  });

  test('?static=1 refuses a page over the size cap', async () => {
    const { url } = await signed('~/notes/2026-11-20-fictional/huge.html');
    assert.equal((await fetch(`${mesh.base}${url}?static=1`)).status, 404);
  });

  test('Markdown keeps the renderer: only its own scripts run, by nonce', async () => {
    const { url } = await signed('~/notes/2026-11-20-fictional/review.md');
    const response = await fetch(`${mesh.base}${url}`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), csp);
    assert.ok(!csp.includes('allow-same-origin'), csp);
  });

  test('a tampered capability or a traversal in the URL is refused', async () => {
    const { url } = await signed('~/notes/2026-11-20-fictional/plan.html');
    const capability = url.split('/')[2]!;
    // The last hex digit changed: to 0, or to 1 when it already is 0 (else the URL would be the valid one).
    const flipped = capability.slice(0, -1) + (capability.endsWith('0') ? '1' : '0');
    assert.notEqual(flipped, capability);
    for (const tampered of [`/view/${capability}/etc/passwd`, `/view/${capability}${notes}/../../.ssh/notes.md`,
      `/view/${flipped}${notes}/plan.html`, `/view/v2.d.1.${'0'.repeat(32)}${notes}/plan.html`]) {
      const response = await fetch(`${mesh.base}${tampered}?static=1`);
      assert.ok(response.status === 403 || response.status === 404, `${tampered}: ${response.status}`);
    }
  });
});
