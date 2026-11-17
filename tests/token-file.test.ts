// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The master token file. A file left empty (disk full, or the process killed between creating
// and writing it) must never become an empty token: an empty token would make
// `Authorization: Bearer ` and `/login?token=` valid. The server writes the file in one step and
// refuses to start on a token that is empty or shorter than it would ever generate.
// A credential that is not ASCII is refused like any wrong one (401), not with a 500.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {type Mesh, runServer, scratchHome, startMesh, stopServer} from './mesh-server-lib.ts';

const MIN_TOKEN_CHARS = 32;

async function startWithTokenFile(content: string): Promise<{listened: boolean; code: number | null; output: string; emptyLogin: number | null}> {
  const where = await scratchHome('token-file-');
  fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(where.confDir, 'token'), content, {mode: 0o600});
  const {child, result} = await runServer(where);
  let emptyLogin: number | null = null;
  if (result.listened) {
    // 302 with a cookie is a login; 200 is the login page again
    emptyLogin = (await fetch(`http://127.0.0.1:${where.port}/login?token=`, {redirect: 'manual'})).status;
    await stopServer(child);
  }
  fs.rmSync(where.scratch, {recursive: true, force: true});
  return {...result, emptyLogin};
}

describe('a damaged token file stops the server', () => {
  for (const [label, content] of [['empty', ''], ['only a newline', '\n'], ['only spaces', '   \n'],
    ['short', 'abc\n'], ['one character under the minimum', `${'a'.repeat(MIN_TOKEN_CHARS - 1)}\n`]] as const) {
    test(`${label} token file`, async () => {
      const run = await startWithTokenFile(content);
      assert.equal(run.listened, false, `the server listens; /login?token= (empty) answers ${run.emptyLogin}`);
      assert.notEqual(run.code, 0);
      assert.match(run.output, /session-mesh: refusing to start: the token in .*\/token is /);
      assert.doesNotMatch(run.output, /Traceback/);
    });
  }

  test('a token of the minimum length is accepted', async () => {
    const run = await startWithTokenFile(`${'a'.repeat(MIN_TOKEN_CHARS)}\n`);
    assert.equal(run.listened, true, run.output);
    assert.equal(run.emptyLogin, 200);
  });
});

// Header values are given as the bytes to put on the wire (one character per byte):
// node:http sends them as they are, where fetch() would refuse anything outside ASCII.
// Header values are given as the bytes to put on the wire (one character per byte):
// node:http sends them as they are, where fetch() would refuse anything outside ASCII.
// Header values are given as the bytes to put on the wire (one character per byte):
// node:http sends them as they are, where fetch() would refuse anything outside ASCII.
function rawGet(port: number, route: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port, path: route, method: 'GET', headers}, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}

const utf8Bytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');

describe('a generated token and the credentials checked against it', () => {
  let mesh: Mesh;
  before(async () => { mesh = await startMesh('token-auth-'); });
  after(async () => { await mesh?.stop(); });

  test('the file is created whole, private, with no temporary file left', () => {
    const tokenFile = path.join(mesh.confDir, 'token');
    assert.ok(mesh.token().length >= MIN_TOKEN_CHARS);
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(mesh.confDir).filter(name => name.startsWith('.token')), []);
  });

  test('the token itself is accepted', async () => {
    assert.equal(await rawGet(mesh.port, '/api/dirs', {Authorization: `Bearer ${mesh.token()}`}), 200);
  });

  for (const [label, headers] of [
    ['an empty Bearer', {Authorization: 'Bearer '}],
    ['a non-ASCII (UTF-8) Bearer', {Authorization: utf8Bytes('Bearer jeton-é-ü')}],
    ['a Bearer of bytes that are not UTF-8', {Authorization: 'Bearer \xff\xfe\x80'}],
    ['a non-ASCII cookie', {Cookie: utf8Bytes('mesh_auth=é')}],
    ['a cookie of bytes that are not UTF-8', {Cookie: 'mesh_auth=\xff\xfe'}],
  ] as const) {
    test(`${label} is a 401`, async () => {
      assert.equal(await rawGet(mesh.port, '/api/dirs', headers), 401, mesh.output());
      assert.doesNotMatch(mesh.output(), /Traceback|TypeError/);
    });
  }

  test('a non-ASCII or empty token on /login sets no cookie', async () => {
    for (const query of ['token=', 'token=%C3%A9', 'token=%FF']) {
      const response = await fetch(`${mesh.base}/login?${query}`, {redirect: 'manual'});
      assert.equal(response.status, 200, `${query}: ${mesh.output()}`);
      assert.equal(response.headers.get('Set-Cookie'), null);
    }
    const posted = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'token=%C3%A9'});
    assert.equal(posted.status, 302);
    assert.equal(posted.headers.get('Location'), '/login?bad=1');
    assert.equal(posted.headers.get('Set-Cookie'), null);
    assert.doesNotMatch(mesh.output(), /Traceback|TypeError/);
  });
});
