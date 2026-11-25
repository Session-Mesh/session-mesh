// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';

test('the flow client typechecks and its browser bundle is current', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const result = spawnSync('npm', ['run', 'check:flow'], {cwd: root, encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
