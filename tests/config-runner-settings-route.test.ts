// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The runner settings (today the operator's display name): read in GET /api/config, written with a
// body {"settings": {...}} on POST /api/config/launch under the same rules as the launch settings
// (owner cookie, same origin, JSON, an active elevation), and kept in settings.json of Mesh's
// configuration folder, whether or not a launch settings file exists. Throwaway server and PTY host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

let mesh: ConfigMesh;
const file = () => path.join(mesh.confDir, 'settings.json');
const runner = async () => (await mesh.config()).runner_settings as {values: Record<string, string>; max_length: Record<string, number>};
const write = (settings: unknown, headers?: Record<string, string>) => mesh.post('/api/config/launch', {settings}, headers);

before(async () => { mesh = await ConfigMesh.start('crs-', null); });
after(async () => { await mesh?.stop(); });

describe('the runner settings', () => {
  test('read as empty with their limits before anything is saved, without a launch settings file', async () => {
    assert.deepEqual(await runner(), {values: {operator_name: ''}, max_length: {operator_name: 40}});
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
    const saved = await write({operator_name: '  Mathias  '});
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(((await saved.json()) as {runner_settings: unknown}).runner_settings,
      {values: {operator_name: 'Mathias'}, max_length: {operator_name: 40}});
    assert.equal((await runner()).values.operator_name, 'Mathias');
    assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf8')), {v: 1, operator_name: 'Mathias'});
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  });

  test('refuses a long name, hidden characters, a non-text value and unknown or missing fields, keeping the saved one', async () => {
    for (const settings of [{operator_name: 'x'.repeat(41)}, {operator_name: 'Ma‮thias'}, {operator_name: 'Ma​thias'},
      {operator_name: 'a\nb'}, {operator_name: 7}, {operator_name: null}, {colour: 'red'}, {operator_name: 'Eve', colour: 'red'}, {}, 'Eve', []]) {
      const response = await write(settings);
      assert.equal(response.status, 400, JSON.stringify(settings));
      assert.equal(((await response.json()) as {error: string}).error, 'invalid');
    }
    const mixed = await mesh.post('/api/config/launch', {settings: {operator_name: 'Eve'}, revision: 'x'});
    assert.equal(mixed.status, 400, 'settings never ride along with a launch edit');
    assert.equal((await runner()).values.operator_name, 'Mathias');
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
    fs.writeFileSync(file(), JSON.stringify({v: 1, operator_name: 'Ma‮thias'}));
    assert.equal((await runner()).values.operator_name, '');
    fs.writeFileSync(file(), JSON.stringify(['Mathias']));
    assert.equal((await runner()).values.operator_name, '');
    fs.writeFileSync(file(), JSON.stringify({v: 1, operator_name: 'Ana', other: 1}));
    assert.equal((await runner()).values.operator_name, 'Ana');
  });
});
