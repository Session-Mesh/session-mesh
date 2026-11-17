// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Documents panel hardening:
// - the stored table of session-opened documents (session-opened-documents.json) is read
//   strictly: a boolean version, an integer too large for a float or a non-number makes it
//   unreadable, so every document is file-scoped for a capability's life (fail closed), and
//   the server still starts;
// - the profiles of more browsers (Snap, Edge, Vivaldi, LibreWolf) are refused by name, and
//   SECURITY.md lists each of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {REPO, type Mesh, runServer, scratchHome, startMesh, stopServer} from './mesh-server-lib.ts';

const STORE = 'session-opened-documents.json';
const cleanups: (() => Promise<void> | void)[] = [];

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe('a corrupt table of session-opened documents fails closed', () => {
  const huge = '1' + '0'.repeat(400);
  const tables: Record<string, string> = {
    'a boolean version': '{"version": true, "all_until": 0, "paths": {}}',
    'an all_until beyond any float': `{"version": 1, "all_until": ${huge}, "paths": {}}`,
    'a marker beyond any float': `{"version": 1, "all_until": 0, "paths": {"/tmp/x": ${huge}}}`,
    'a string marker': '{"version": 1, "all_until": 0, "paths": {"/tmp/x": "soon"}}',
    'a boolean all_until': '{"version": 1, "all_until": false, "paths": {}}',
  };
  for (const [label, table] of Object.entries(tables)) {
    test(`${label}: the server starts and file-scopes every document`, async () => {
      const where = await scratchHome('view-table-');
      cleanups.push(() => fs.rmSync(where.scratch, {recursive: true, force: true}));
      fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(where.confDir, STORE), table);
      const {child, result, output} = await runServer(where);
      cleanups.push(() => stopServer(child));
      assert.equal(result.listened, true, result.output);
      assert.match(output(), /is unreadable \(unknown format\): documents get no directory access/);
    });
  }
});

describe('more browser profiles are refused by name', () => {
  const PROFILES = ['snap/firefox', 'snap/chromium', '.config/microsoft-edge', '.config/vivaldi', '.librewolf'];
  let mesh: Mesh;

  test('each profile is refused, its neighbour is a document, SECURITY.md lists it', async () => {
    mesh = await startMesh('view-profiles-');
    cleanups.push(() => mesh.stop());
    const security = fs.readFileSync(path.join(REPO, 'SECURITY.md'), 'utf8').split(/\s+/).join(' ');
    const view = (target: string) => fetch(`${mesh.base}/api/view`, {method: 'POST', body: JSON.stringify({target}),
      headers: {Authorization: `Bearer ${mesh.token()}`, 'Content-Type': 'application/json'}});
    for (const profile of PROFILES) {
      const cookies = path.join(mesh.home, profile, 'default', 'cookies.txt');
      fs.mkdirSync(path.dirname(cookies), {recursive: true});
      fs.writeFileSync(cookies, 'session=secret\n');
      const refused = await view(cookies);
      assert.equal(refused.status, 403, `${profile}: ${await refused.text()}`);
      assert.ok(security.includes(`\`~/${profile}\``), `SECURITY.md does not list ~/${profile}`);
    }
    const notes = path.join(mesh.home, 'snap', 'notes.md');
    fs.writeFileSync(notes, '# notes\n');
    assert.equal((await view(notes)).status, 200);
  });
});
