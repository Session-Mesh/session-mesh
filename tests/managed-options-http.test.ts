// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {startMesh} from './mesh-server-lib.ts';

test('managed launches refuse unreadable stored agent options before resolving a profile', async () => {
  const mesh = await startMesh('managed-options-', {}, where => {
    fs.mkdirSync(where.confDir, {recursive:true, mode:0o700});
    fs.writeFileSync(path.join(where.confDir, 'agent-launch-options.json'), '{broken', {mode:0o600});
  });
  try {
    const login = await fetch(`${mesh.base}/login`, {method:'POST', redirect:'manual',
      headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({token:mesh.token()})});
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(`${mesh.base}/api/new`, {method:'POST',
      headers:{Cookie:cookie, Origin:mesh.base, 'Content-Type':'application/json'},
      body:JSON.stringify({preset:'codex', cwd:mesh.home, managed_profile:{backend:'codex',
        id:'p-0123456789abcdef', context_revision:'a'.repeat(64)}})});
    assert.equal(response.status, 409);
    assert.match(await response.text(), /stored launch options cannot be read/i);
  } finally { await mesh.stop(); }
});
