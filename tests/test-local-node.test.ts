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

function run(failingFind: boolean, extraEnv: NodeJS.ProcessEnv = {}): {status: number | null; stderr: string; log: string; env: string} {
  const dir = fs.mkdtempSync(path.join(scratch, 'case-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'tests', 'sub'), {recursive: true});
  for (const name of ['tests/b.test.ts', 'tests/a.test.mjs', 'tests/sub/c.test.cjs', 'tests/not-a-test.ts']) fs.writeFileSync(path.join(dir, name), '');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_LOG"; printf "LC_ALL=%s LANG=%s LANGUAGE=%s\\n" "$LC_ALL" "$LANG" "$LANGUAGE" > "$FAKE_LOG.env"\n', {mode: 0o755});
  if (failingFind) fs.writeFileSync(path.join(bin, 'find'), '#!/bin/sh\nprintf "tests/b.test.ts\\0"\nexit 1\n', {mode: 0o755});
  const log = path.join(dir, 'node.log');
  const result = spawnSync('bash', ['-c', `source '${SCRIPT}'; node_tests`], {
    cwd: dir, encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...extraEnv},
  });
  return {status: result.status, stderr: result.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    env: fs.existsSync(`${log}.env`) ? fs.readFileSync(`${log}.env`, 'utf8') : ''};
}

test('every Node test file is passed to node, sorted', () => {
  const result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.log.trim().split('\n').filter(line => line.startsWith('tests/')),
    ['tests/a.test.mjs', 'tests/b.test.ts', 'tests/sub/c.test.cjs']);
});

test('a failing find fails the run and node is not started on a partial list', () => {
  const result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /find failed/);
  assert.equal(result.log, '');
});

const concurrencyOf = (log: string): number => Number(/^--test-concurrency=(\d+)$/m.exec(log)?.[1]);

test('the number of files run at once is passed to node, between 1 and 4 by default', () => {
  const result = run(false, {MESH_TEST_CONCURRENCY: ''});
  assert.equal(result.status, 0, result.stderr);
  const n = concurrencyOf(result.log);
  assert.ok(n >= 1 && n <= 4, `default concurrency ${n}`);
});

test('MESH_TEST_CONCURRENCY sets the number of files run at once', () => {
  assert.equal(concurrencyOf(run(false, {MESH_TEST_CONCURRENCY: '2'}).log), 2);
});

test('an invalid MESH_TEST_CONCURRENCY fails the run before node starts', () => {
  for (const value of ['0', '-1', 'two', '1.5', '02']) {
    const result = run(false, {MESH_TEST_CONCURRENCY: value});
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /MESH_TEST_CONCURRENCY must be a positive integer/, value);
    assert.equal(result.log, '', value);
  }
});

test('node runs under a fixed English locale whatever the locale of the caller', () => {
  const result = run(false, {LC_ALL: 'fr_FR.UTF-8', LANG: 'fr_FR.UTF-8', LANGUAGE: 'fr'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.env, 'LC_ALL=C.UTF-8 LANG=C.UTF-8 LANGUAGE=en_US:en\n');
});
