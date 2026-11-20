// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// GET /api/update/notes and GET /api/update/image: the "What's new" panel of the update banner.
// The notes come from the PTY host (here a stand-in that names them), which keeps them from the releases list
// it already fetches: the route makes no request. The image route is a proxy for the images written in those
// notes: only https URLs on github.com or *.githubusercontent.com that appear in the notes, public addresses
// only, PNG/JPEG/GIF/WebP up to 5 MiB, redirects inside the same allowlist. The "GitHub" here is a local
// stand-in (tests/helpers/fake-github.ts) reached through MESH_UPDATE_IMAGE_TEST_HOSTS: nothing leaves the machine.
import assert from 'node:assert/strict';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {startFakeHost, type FakeHost} from './fake-pty-host.ts';
import {PNG, startFakeGithub, type FakeGithub} from './helpers/fake-github.ts';
import {startMesh, type Mesh} from './mesh-server-lib.ts';

const GH = 'https://github.com/user-attachments/assets';
const IMAGES = ['ok', 'moved', 'away', 'plain', 'loop', 'svg', 'html', 'liar', 'huge', 'huge-declared', 'missing']
  .map(name => `![${name}](${GH}/${name})`);
// Written in the notes too, so that only the allowlist can refuse them.
const REFUSED = ['http://github.com/user-attachments/assets/ok', 'https://127.0.0.1/user-attachments/assets/ok',
  'https://[::1]/user-attachments/assets/ok', 'https://example.com/user-attachments/assets/ok',
  'https://github.com.example.com/user-attachments/assets/ok', 'https://github.com:8443/user-attachments/assets/ok',
  `https://user:secret${'@'}github.com/user-attachments/assets/ok`, 'https://evilgithubusercontent.com/ok',
  'https://raw.githubusercontent.com/private/ok'];
const NOTES = {
  tag: 'v0.2.0', published: '2026-11-19T10:00:00Z', truncated: false,
  notes_url: 'https://github.com/Session-Mesh/session-mesh/releases/tag/v0.2.0',
  body: ['## What changed', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', ...IMAGES, ...REFUSED.map(url => `![x](${url})`)].join('\n'),
};

let mesh: Mesh;
let host: FakeHost;
let github: FakeGithub;
let cookie = '';

before(async () => {
  github = await startFakeGithub();
  // raw.githubusercontent.com is sent to "localhost": a name that resolves to a loopback address, refused after DNS
  mesh = await startMesh('upd-notes-', {MESH_UPDATE_IMAGE_TEST_HOSTS: [
    `github.com=127.0.0.1:${github.port}`, `private-user-images.githubusercontent.com=127.0.0.1:${github.port}`,
    `raw.githubusercontent.com=localhost:${github.port}`].join(',')});
  host = await startFakeHost(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {sessions: [], notes: NOTES});
  const login = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.match(cookie, /^mesh_auth=/);
});
after(async () => {
  await host?.stop();
  await mesh?.stop();
  await github?.stop();
});

const image = (url: string, headers: Record<string, string> = {Cookie: cookie}) =>
  fetch(`${mesh.base}/api/update/image?url=${encodeURIComponent(url)}`, {headers, redirect: 'manual'});

describe('GET /api/update/notes', () => {
  test('the owner\'s page gets the notes the host holds', async () => {
    const answer = await fetch(`${mesh.base}/api/update/notes`, {headers: {Cookie: cookie}});
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await answer.json(), NOTES);
    assert.ok(host.ops().includes('update_notes'));
    assert.deepEqual(github.requests, [], 'showing the notes makes no request');
  });

  test('only the owner cookie, from this server\'s own page', async () => {
    const url = `${mesh.base}/api/update/notes`;
    assert.equal((await fetch(url)).status, 401, 'no cookie');
    assert.equal((await fetch(url, {headers: {Authorization: `Bearer ${mesh.token()}`}})).status, 401, 'the master token');
    assert.equal((await fetch(url, {headers: {Cookie: cookie, Authorization: `Bearer ${mesh.token()}`}})).status, 401, 'a header beside the cookie');
    assert.equal((await fetch(url, {headers: {Authorization: 'MeshSession v1.x.y'}})).status, 401, 'an agent session token');
    assert.equal((await fetch(url, {headers: {Cookie: cookie, Origin: 'https://evil.example'}})).status, 403, 'a foreign Origin');
    assert.equal((await fetch(url, {headers: {Cookie: cookie, 'Sec-Fetch-Site': 'cross-site'}})).status, 403, 'a cross-site request');
    assert.equal((await fetch(`${url}?x=1`, {headers: {Cookie: cookie}})).status, 400, 'no query');
    assert.equal((await fetch(url, {headers: {Cookie: cookie, Origin: mesh.base}})).status, 200, 'its own Origin');
  });

  test('nothing announced (check=0, notice=none, an older host): 404, and no image either', async () => {
    host.control({sessions: [], notes: null});
    try {
      assert.equal((await fetch(`${mesh.base}/api/update/notes`, {headers: {Cookie: cookie}})).status, 404);
      assert.equal((await image(`${GH}/ok`)).status, 404);
      assert.deepEqual(github.requests, []);
    } finally {
      host.control({sessions: [], notes: NOTES});
    }
  });
});

describe('GET /api/update/image', () => {
  test('an image of the notes, through the server only', async () => {
    const answer = await image(`${GH}/ok`);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'image/png');
    assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(answer.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.match(answer.headers.get('cache-control') ?? '', /^private, max-age=\d+$/);
    assert.deepEqual(Buffer.from(await answer.arrayBuffer()), PNG);
    const sent = github.requests.at(-1)!;
    assert.equal(sent, 'session-mesh-update-check - - /user-attachments/assets/ok', 'fixed User-Agent, no cookie, no credential');
  });

  test('a redirect inside the allowlist is followed (GitHub attachments)', async () => {
    const answer = await image(`${GH}/moved`);
    assert.equal(answer.status, 200);
    assert.deepEqual(Buffer.from(await answer.arrayBuffer()), PNG);
  });

  test('a redirect out of the allowlist, to plain HTTP, or in a loop is refused', async () => {
    for (const name of ['away', 'plain', 'loop']) assert.equal((await image(`${GH}/${name}`)).status, 502, name);
    assert.equal(github.requests.filter(line => line.endsWith('/loop')).length, 4, 'three redirects at most');
  });

  test('only PNG, JPEG, GIF or WebP that is what it says, up to 5 MiB', async () => {
    assert.equal((await image(`${GH}/svg`)).status, 415, 'SVG never');
    assert.equal((await image(`${GH}/html`)).status, 415, 'HTML');
    assert.equal((await image(`${GH}/liar`)).status, 502, 'HTML labelled image/png');
    assert.equal((await image(`${GH}/huge`)).status, 413, 'over 5 MiB, streamed');
    assert.equal((await image(`${GH}/huge-declared`)).status, 413, 'over 5 MiB, declared');
    assert.equal((await image(`${GH}/missing`)).status, 502, 'an error answer');
  });

  test('an URL outside the allowlist, or absent from the notes, makes no request', async () => {
    const before = github.requests.length;
    for (const url of REFUSED.slice(0, -1)) assert.equal((await image(url)).status, 404, url);
    assert.equal((await image(`${GH}/not-in-the-notes`)).status, 404, 'not in the notes');
    assert.equal((await image('javascript:alert(1)')).status, 404);
    assert.equal(github.requests.length, before);
  });

  test('a name that resolves to a private address is refused after DNS', async () => {
    const before = github.requests.length;
    assert.equal((await image('https://raw.githubusercontent.com/private/ok')).status, 502);
    assert.equal(github.requests.length, before, 'no connection to the loopback address');
  });

  test('the same authentication as the notes', async () => {
    const url = `${GH}/ok`;
    assert.equal((await image(url, {})).status, 401);
    assert.equal((await image(url, {Authorization: `Bearer ${mesh.token()}`})).status, 401);
    assert.equal((await image(url, {Cookie: cookie, Origin: 'https://evil.example'})).status, 403);
    const extra = await fetch(`${mesh.base}/api/update/image?url=${encodeURIComponent(url)}&x=1`, {headers: {Cookie: cookie}});
    assert.equal(extra.status, 400);
    const twice = await fetch(`${mesh.base}/api/update/image?url=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}`, {headers: {Cookie: cookie}});
    assert.equal(twice.status, 400);
  });

  test('at most 60 fetches in ten minutes, for all browsers together', async () => {
    let refused = 0;
    for (let index = 0; index < 70; index += 1) if ((await image(`${GH}/ok`)).status === 429) refused += 1;
    assert.ok(refused >= 10, `refused ${refused}`);
  });
});
