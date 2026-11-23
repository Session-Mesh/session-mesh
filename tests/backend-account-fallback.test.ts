// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Real fallback-layout app/bin lookup and native policy over HTTP, not a built release archive.
// Installer/link-manifest behavior is independently exercised by install-release-programs.test.ts.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, scratchHome, removeScratch} from './mesh-server-lib.ts';

const PROFILE = process.env.MESH_PROFILE_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_profile_main.exe');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const skip = fs.existsSync(PROFILE) || process.env.MESH_REQUIRE_MESH_PROFILE ? false : 'build mesh-profile';

test('native-program fallback serves real settings HTTP with neither runtime nor helper override', {skip, timeout: 30000}, async () => {
  const where = await scratchHome('account-fallback-http-', {PATH: '/usr/bin:/bin', MESH_PTYHOST_CMD: '/bin/false'});
  fs.mkdirSync(where.confDir, {recursive: true, mode: 0o700}); fs.chmodSync(where.confDir, 0o700);
  const release = path.join(where.home, 'release'), app = path.join(release, 'app'), bin = path.join(release, 'bin');
  fs.mkdirSync(path.join(app, 'bin'), {recursive: true, mode: 0o700}); fs.mkdirSync(bin, {mode: 0o700});
  for (const entry of fs.readdirSync(REPO, {withFileTypes: true})) {
    if (entry.isFile() && (/\.(py|json)$/.test(entry.name) || entry.name === 'VERSION')) {
      fs.copyFileSync(path.join(REPO, entry.name), path.join(app, entry.name));
    }
  }
  for (const directory of ['static', 'docs']) fs.symlinkSync(path.join(REPO, directory), path.join(app, directory));
  fs.copyFileSync(PROFILE, path.join(bin, 'mesh-profile')); fs.chmodSync(path.join(bin, 'mesh-profile'), 0o700);
  fs.symlinkSync('../../bin/mesh-profile', path.join(app, 'bin/mesh-profile'));
  for (const key of ['MESH_PROFILE_CMD', 'MESH_MESH_PROFILE_CMD', 'MESH_BIN_DIR', 'MESH_OPAM_SWITCH', 'OPAM_SWITCH_PREFIX']) delete where.env[key];
  let output = '';
  const child = spawn(PYTHON, ['server.py'], {cwd: app, env: where.env, stdio: ['ignore', 'pipe', 'pipe']});
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-65536); });
  const base = `http://127.0.0.1:${where.port}`;
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      assert.equal(child.exitCode, null, output);
      if (fs.existsSync(path.join(where.confDir, 'token'))) {
        const probe = await fetch(`${base}/login`).catch(() => null);
        if (probe?.status === 200) break;
      }
      assert.ok(Date.now() < deadline, 'fallback-layout server did not start');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const token = fs.readFileSync(path.join(where.confDir, 'token'), 'utf8').trim();
    const cookie = `mesh_auth=${createHmac('sha256', token).update('session-mesh').digest('hex')}`;
    const profiles = await fetch(`${base}/api/accounts/profiles`, {headers: {Cookie: cookie}});
    assert.equal(profiles.status, 200, await profiles.clone().text());
    assert.equal((await profiles.json()).data.configured, false);
    const saved = await fetch(`${base}/api/accounts/consent/set-global`, {method: 'POST',
      headers: {Cookie: cookie, Origin: base, 'Content-Type': 'application/json'},
      body: JSON.stringify({expected_revision: 0, confirmation: 'skip'})});
    assert.equal(saved.status, 200, await saved.clone().text());
    const policy = await fetch(`${base}/api/accounts/consent`, {headers: {Cookie: cookie}});
    assert.equal(policy.status, 200); assert.equal((await policy.json()).data.global, 'skip');
  } finally {
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { child.kill('SIGTERM'); await closed; } finally { clearTimeout(kill); removeScratch(where.scratch); }
  }
});
