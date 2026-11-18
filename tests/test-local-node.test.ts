// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// node_tests of scripts/test-local-node.sh (sourced by scripts/test-local.sh), run by bash in a scratch
// directory with a stand-in node on PATH that logs its arguments: the files are passed sorted, and a
// failing find fails the run instead of silently dropping the Node tests.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';

const SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'scripts', 'test-local-node.sh');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'test-local-node-'));
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

function run(failingFind: boolean): {status: number | null; stderr: string; log: string} {
  const dir = fs.mkdtempSync(path.join(scratch, 'case-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'tests', 'sub'), {recursive: true});
  for (const name of ['tests/b.test.ts', 'tests/a.test.mjs', 'tests/sub/c.test.cjs', 'tests/not-a-test.ts']) fs.writeFileSync(path.join(dir, name), '');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_LOG"\n', {mode: 0o755});
  if (failingFind) fs.writeFileSync(path.join(bin, 'find'), '#!/bin/sh\nprintf "tests/b.test.ts\\0"\nexit 1\n', {mode: 0o755});
  const log = path.join(dir, 'node.log');
  const result = spawnSync('bash', ['-c', `source '${SCRIPT}'; node_tests`], {
    cwd: dir, encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log},
  });
  return {status: result.status, stderr: result.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''};
}

test('every Node test file is passed to node, sorted', () => {
  const result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.log.trim().split('\n').slice(2),
    ['tests/a.test.mjs', 'tests/b.test.ts', 'tests/sub/c.test.cjs']);
});

test('a failing find fails the run and node is not started on a partial list', () => {
  const result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /find failed/);
  assert.equal(result.log, '');
});
