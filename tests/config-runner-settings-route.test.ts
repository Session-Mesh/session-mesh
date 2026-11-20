// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The runner settings (today the operator's display name): read in GET /api/config, written with a
// body {"settings": {...}} on POST /api/config/launch under the same rules as the launch settings
// (owner cookie, same origin, JSON, an active elevation), and kept in settings.json of Mesh's
// configuration folder, whether or not a launch settings file exists. Throwaway server and PTY host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

let mesh: ConfigMesh;
const file = () => path.join(mesh.confDir, 'settings.json');
const runner = async () => (await mesh.config()).runner_settings as {values: Record<string, unknown>; max_length: Record<string, number>};
const write = (settings: unknown, headers?: Record<string, string>) => mesh.post('/api/config/launch', {settings}, headers);

before(async () => { mesh = await ConfigMesh.start('crs-', null); });
after(async () => { await mesh?.stop(); });

describe('the runner settings', () => {
  test('read as empty with their limits before anything is saved, without a launch settings file', async () => {
    assert.deepEqual(await runner(), {values: {operator_name: '', recent_folders: []}, max_length: {operator_name: 40, recent_folders: 8}});
    assert.equal(fs.existsSync(file()), false);
  });

  test('cannot be written without the owner cookie, from another origin, or without an elevation', async () => {
    const json = {'Content-Type': 'application/json', Origin: mesh.base};
    assert.equal((await write({operator_name: 'Eve'}, json)).status, 401);
    assert.equal((await write({operator_name: 'Eve'}, {...json, Authorization: `Bearer ${mesh.token()}`})).status, 401);
    assert.equal((await write({operator_name: 'Eve'}, {...mesh.owner(false), Origin: 'https://evil.example'})).status, 403);
    const locked = await write({operator_name: 'Eve'}, mesh.owner(false));
    assert.equal(locked.status, 403);
    assert.equal(((await locked.json()) as {error: string}).error, 'elevation-required');
    assert.equal(fs.existsSync(file()), false, 'nothing was written');
  });

  test('an elevated owner saves the name, trimmed; every reader sees it and the file is private', async () => {
    assert.equal((await mesh.elevate()).status, 200);
    const saved = await write({operator_name: '  Camille  '});
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(((await saved.json()) as {runner_settings: unknown}).runner_settings,
      {values: {operator_name: 'Camille', recent_folders: []}, max_length: {operator_name: 40, recent_folders: 8}});
    assert.equal((await runner()).values.operator_name, 'Camille');
    assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf8')), {v: 1, operator_name: 'Camille', recent_folders: []});
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  });

  test('refuses a long name, hidden characters, a non-text value and unknown or missing fields, keeping the saved one', async () => {
    for (const settings of [{operator_name: 'x'.repeat(41)}, {operator_name: 'Ca\u202emille'}, {operator_name: 'Ca\u200bmille'},
      {operator_name: 'a\nb'}, {operator_name: '\u034f'}, {operator_name: 'Ca\ufe0fmille'}, {operator_name: 7}, {operator_name: null}, {colour: 'red'}, {operator_name: 'Eve', colour: 'red'}, {}, 'Eve', []]) {
      const response = await write(settings);
      assert.equal(response.status, 400, JSON.stringify(settings));
      assert.equal(((await response.json()) as {error: string}).error, 'invalid');
    }
    const mixed = await mesh.post('/api/config/launch', {settings: {operator_name: 'Eve'}, revision: 'x'});
    assert.equal(mixed.status, 400, 'settings never ride along with a launch edit');
    assert.equal((await runner()).values.operator_name, 'Camille');
  });

  test('forty characters are accepted, an empty name clears it', async () => {
    assert.equal((await write({operator_name: 'é'.repeat(40)})).status, 200);
    assert.equal((await runner()).values.operator_name, 'é'.repeat(40));
    assert.equal((await write({operator_name: '   '})).status, 200);
    assert.equal((await runner()).values.operator_name, '');
  });

  test('a broken or hand-edited file reads as the defaults, a bad field alone is ignored', async () => {
    fs.writeFileSync(file(), '{not json');
    assert.equal((await runner()).values.operator_name, '');
    fs.writeFileSync(file(), JSON.stringify({v: 1, operator_name: 'Ca\u202emille'}));
    assert.equal((await runner()).values.operator_name, '');
    fs.writeFileSync(file(), JSON.stringify(['Camille']));
    assert.equal((await runner()).values.operator_name, '');
    fs.writeFileSync(file(), JSON.stringify({v: 1, operator_name: 'Ana', other: 1}));
    assert.equal((await runner()).values.operator_name, 'Ana');
  });

  test('a deeply nested file, under the size limit, reads as the defaults and a save repairs it', async () => {
    // Written by any process of the same user: it must not take the whole Configuration dialog down.
    fs.writeFileSync(file(), '['.repeat(16000));
    assert.equal((await runner()).values.operator_name, '', 'GET /api/config still answers');
    const repaired = await write({operator_name: 'Ana'});
    assert.equal(repaired.status, 200, await repaired.clone().text());
    assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf8')), {v: 1, operator_name: 'Ana', recent_folders: []});
  });

  test('lengths count code points: forty astral characters fit, forty-one do not', async () => {
    assert.equal((await write({operator_name: '\u{1f600}'.repeat(40)})).status, 200);
    assert.equal((await runner()).values.operator_name, '\u{1f600}'.repeat(40));
    assert.equal((await write({operator_name: '\u{1f600}'.repeat(41)})).status, 400);
    assert.equal((await runner()).values.operator_name, '\u{1f600}'.repeat(40));
  });

  test('the name is stored in NFC, and measured after normalisation', async () => {
    const decomposed = 'é'.normalize('NFD').repeat(40);
    assert.equal(decomposed.length, 80);
    assert.equal((await write({operator_name: decomposed})).status, 200);
    assert.equal((await runner()).values.operator_name, 'é'.repeat(40));
    assert.equal((await write({operator_name: 'Nguy\u1ec5n'.normalize('NFD')})).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file(), 'utf8')).operator_name, 'Nguy\u1ec5n'.normalize('NFC'));
  });

  test('refuses invisible fillers and long runs of combining marks', async () => {
    for (const filler of ['\u3164', '\uffa0', '\u115f', '\u1160', '\u2800', '\u180b', '\u180c', '\u180d', '\u180f', '\ufffc']) {
      for (const name of [filler, filler.repeat(3), `Ca${filler}mille`]) {
        assert.equal((await write({operator_name: name})).status, 400, JSON.stringify(name));
      }
    }
    assert.equal((await write({operator_name: `q${'\u0336'.repeat(4)}`})).status, 400, 'four marks on one letter');
    assert.equal((await write({operator_name: 'x' + '\u0301'.repeat(39)})).status, 400, 'a pile of accents');
    assert.equal((await write({operator_name: `q${'\u0336'.repeat(3)}`})).status, 200, 'three marks are allowed');
    fs.writeFileSync(file(), JSON.stringify({v: 1, operator_name: '\u3164'}));
    assert.equal((await runner()).values.operator_name, '', 'a filler stored by hand reads as no name');
  });

  test('a save replaces the file atomically: a hard link keeps the old text, no temporary file stays', async () => {
    assert.equal((await write({operator_name: 'Ana'})).status, 200);
    const old = path.join(mesh.confDir, 'settings.old');
    fs.rmSync(old, {force: true});
    fs.linkSync(file(), old);
    const before = {inode: fs.statSync(file()).ino, names: fs.readdirSync(mesh.confDir).sort()};
    assert.equal((await write({operator_name: 'Bea'})).status, 200);
    assert.notEqual(fs.statSync(file()).ino, before.inode, 'a new file took the name');
    assert.equal(JSON.parse(fs.readFileSync(old, 'utf8')).operator_name, 'Ana', 'the old file was not rewritten in place');
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(mesh.confDir).sort(), before.names);
    fs.rmSync(old);
  });

  test('an elevation that ends while the body is still arriving refuses the write', async () => {
    assert.equal((await write({operator_name: 'Ana'})).status, 200);
    const control = await slowWrite({operator_name: 'Cid'}, async () => undefined);
    assert.equal(control.status, 200, `a slow body alone is accepted: ${control.body}`);
    const revoked = await slowWrite({operator_name: 'Eve'}, async () => {
      assert.equal((await mesh.post('/api/config/elevate/revoke', {})).status, 200);
    });
    assert.equal(revoked.status, 403, revoked.body);
    assert.equal(JSON.parse(revoked.body).error, 'elevation-required');
    assert.equal((await runner()).values.operator_name, 'Cid', 'nothing was written');
    assert.equal((await mesh.elevate()).status, 200);
  });
});

/** POST a runner settings write whose body arrives in two parts; `between` runs once the server has the headers
 *  (and so has passed the elevation check made before the body is read). */
function slowWrite(settings: unknown, between: () => Promise<void>): Promise<{status: number; body: string}> {
  const body = Buffer.from(JSON.stringify({settings}));
  return new Promise((resolve, reject) => {
    const request = http.request(`${mesh.base}/api/config/launch`,
      {method: 'POST', headers: {...mesh.owner(), 'Content-Length': String(body.length)}}, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve({status: response.statusCode ?? 0, body: text}));
      });
    request.on('error', reject);
    request.flushHeaders();
    request.write(body.subarray(0, 5));
    setTimeout(() => { between().then(() => request.end(body.subarray(5)), reject); }, 300);
  });
}
