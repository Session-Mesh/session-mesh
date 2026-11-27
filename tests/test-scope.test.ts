// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const classifier = fileURLToPath(new URL('../scripts/test-scope.sh', import.meta.url));

test('only a documentation diff selects the small suite', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'mesh-test-scope-'));
  t.after(() => rmSync(cwd, {force: true, recursive: true}));
  const git = (...args: string[]) => execFileSync('git', args, {cwd});
  const scope = (base = 'HEAD') => execFileSync('bash', [classifier, base], {cwd, encoding: 'utf8'}).trim();
  const local = () => execFileSync('bash', [classifier, 'HEAD', '--local-files'], {cwd, encoding: 'utf8'}).split('\0').slice(0, -1);

  git('init', '-q');
  mkdirSync(join(cwd, 'docs'));
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'docs', 'guide.md'), 'old');
  writeFileSync(join(cwd, 'server.py'), 'old');
  writeFileSync(join(cwd, 'tests', 'old.test.ts'), 'old');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');

  writeFileSync(join(cwd, 'docs', 'guide.md'), 'new');
  assert.equal(scope(), 'docs');
  assert.deepEqual(local(), ['docs']);
  const testFile = 'tests/new file.test.ts';
  writeFileSync(join(cwd, testFile), 'new');
  assert.deepEqual(local(), ['full'], 'untracked files are conservative');
  git('add', testFile);
  assert.equal(scope(), 'full', 'CI still runs the full code suite');
  assert.deepEqual(local(), ['node', testFile]);
  git('reset', '-q', 'HEAD', '--', testFile);
  rmSync(join(cwd, testFile));
  rmSync(join(cwd, 'tests', 'old.test.ts'));
  assert.deepEqual(local(), ['full'], 'a deleted test requires the full suite');
  git('restore', 'tests/old.test.ts');
  writeFileSync(join(cwd, 'untracked.ts'), 'new');
  assert.equal(scope(), 'full');
  rmSync(join(cwd, 'untracked.ts'));

  renameSync(join(cwd, 'server.py'), join(cwd, 'docs', 'server.md'));
  git('add', '-A');
  assert.equal(scope(), 'full', 'moving code into docs still removes code');
  assert.deepEqual(local(), ['full']);
  assert.notEqual(spawnSync('bash', [classifier, '--help'], {cwd}).status, 0);
});
