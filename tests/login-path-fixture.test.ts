// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {scratchHome, removeScratch} from './mesh-server-lib.ts';

test('an explicit fixture PATH survives login profiles literally, without shell expansion', async () => {
  const where = await scratchHome('login-path-');
  try {
    const marker = path.join(where.scratch, 'must-not-exist');
    const declared = `/fake/a'b/$(touch ${marker}):/usr/bin:/bin`;
    const configured = await scratchHome('login-path-configured-', {PATH: declared});
    try {
      const result = spawnSync('/bin/bash', ['--login', '-c', 'printf "%s" "$PATH"'], {
        env: {HOME: configured.home, PATH: '/usr/bin:/bin'}, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, declared);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.statSync(path.join(configured.home, '.bash_profile')).mode & 0o777, 0o600);
    } finally { removeScratch(configured.scratch); }
  } finally { removeScratch(where.scratch); }
});

test('a fixture without an explicit PATH does not replace its login profile', async () => {
  const where = await scratchHome('login-path-default-');
  try { assert.equal(fs.existsSync(path.join(where.home, '.bash_profile')), false); }
  finally { removeScratch(where.scratch); }
});
