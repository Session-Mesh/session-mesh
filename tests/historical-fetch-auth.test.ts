// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {apiAuthentication} from '../tools/fetch-historical-releases.ts';

test('API authentication keeps the token out of command arguments', () => {
  assert.deepEqual(apiAuthentication(undefined), {args: []});
  const auth = apiAuthentication('synthetic_token-123');
  assert.deepEqual(auth.args, ['--config', '-']);
  assert.equal(auth.input, 'header = "Authorization: Bearer synthetic_token-123"\n');
  assert.throws(() => apiAuthentication('bad\nheader'), /invalid GitHub token/);
});
