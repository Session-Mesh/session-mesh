// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The wait that test setups use for a server's token file (tests/wait-for-token.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {waitForToken} from './wait-for-token.ts';

function scratch(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'wait-token-')); }

test('a token file written after 300 ms is read', async () => {
  const dir = scratch();
  const file = path.join(dir, 'token');
  setTimeout(() => fs.writeFileSync(file, 'secret\n'), 300);
  try {
    assert.equal(await waitForToken(file, 5000, 20), 'secret');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('a file that exists but is still empty is waited for', async () => {
  const dir = scratch();
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, '');
  setTimeout(() => fs.writeFileSync(file, 'later'), 200);
  try {
    assert.equal(await waitForToken(file, 5000, 20), 'later');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('a token file that never appears fails with a clear message after the bound, not ENOENT', async () => {
  const dir = scratch();
  const file = path.join(dir, 'token');
  const started = Date.now();
  try {
    await assert.rejects(waitForToken(file, 400, 20), (error: Error) => {
      assert.match(error.message, /wrote no token file .* within 400 ms/);
      assert.doesNotMatch(error.message, /ENOENT/);
      return true;
    });
    assert.ok(Date.now() - started >= 400, 'it waited the whole bound');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
