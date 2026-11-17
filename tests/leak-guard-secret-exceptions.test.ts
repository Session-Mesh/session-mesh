// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A reviewed exception can cover one gitleaks secret: one path and one exact value,
// named by the SHA-256 of the value (never the value itself), so that a public key a
// generated third-party file carries can be accepted without silencing anything else.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {applyExceptions, loadExceptions} from '../tools/leak-guard/exceptions.ts';
import {FAKE, TRAILER, git, initRepo, remove, runCli, tempDir, write} from './leak-guard-fixtures.ts';

const scratch = tempDir('secret-exceptions');
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const SECRET_MATCH = `github-pat:sha256:${digest(FAKE.token)}`;
const tokenLine = `token = "${FAKE.token}"\n`;
const exception = {path: 'conf.env', rule: 'secret', substring: SECRET_MATCH, reason: 'test: a public value'};

function exceptionsFile(name: string, exceptions: object[]): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, JSON.stringify({schema: 1, exceptions}));
  return file;
}

describe('secret exceptions: loading', () => {
  test('a secret exception naming a gitleaks rule and a SHA-256 loads', () => {
    assert.deepEqual(loadExceptions(exceptionsFile('ok.json', [exception])), [exception]);
  });
  for (const substring of [FAKE.token, `sha256:${digest(FAKE.token)}`, `github-pat:${FAKE.token}`, 'github-pat:sha256:abc',
    `github-pat:sha256:${digest(FAKE.token).toUpperCase()}`]) {
    test(`a secret exception whose value is not "<rule>:sha256:<64 hex>" is refused (${substring.slice(0, 18)}…)`, () => {
      assert.throws(() => loadExceptions(exceptionsFile('bad.json', [{...exception, substring}])), /sha256/);
    });
  }
  test('Tailscale key exceptions stay refused', () => {
    assert.throws(() => loadExceptions(exceptionsFile('ts.json', [{...exception, rule: 'tailscale-key'}])));
  });
});

describe('secret exceptions: matching', () => {
  const finding = {gate: 'content' as const, path: 'conf.env', line: 1, rule: 'secret', excerpt: 'github-pat: REDACTED', match: SECRET_MATCH};
  test('the exact path and value are covered', () => assert.deepEqual(applyExceptions([finding], [exception], true), []));
  test('another path or another value is not covered', () => {
    const elsewhere = {...finding, path: 'other.env'};
    const other = {...finding, match: `github-pat:sha256:${digest('another')}`};
    assert.deepEqual(applyExceptions([elsewhere, other], [exception], false), [elsewhere, other]);
  });
  test('a finding from a commit range is matched on its tree path', () => {
    const fromLog = {...finding, path: '0123456789:conf.env', treePath: 'conf.env'};
    assert.deepEqual(applyExceptions([fromLog], [exception], false), []);
  });
  test('an unused secret exception is not reported stale when no secret scan ran', () => {
    assert.deepEqual(applyExceptions([], [exception], true, false), []);
    assert.deepEqual(applyExceptions([], [exception], true).map(f => f.rule), ['stale-exception']);
  });
});

describe('secret exceptions: through gitleaks', () => {
  const haveGitleaks = !runCli(scratch, ['message', '/dev/null']).output.includes('gitleaks not found');
  const skip = !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped';

  test('tree, staged and commits accept the excepted value and nothing else', {skip}, () => {
    const file = exceptionsFile('repo.json', [exception]);
    const root = initRepo('secret-exception');
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `a\n\n${TRAILER}`]);
    write(root, 'conf.env', tokenLine);
    git(root, ['add', '.']);
    assert.equal(runCli(root, ['--exceptions', file, 'staged']).status, 0);
    git(root, ['commit', '-q', '--no-verify', '-m', `b\n\n${TRAILER}`]);
    assert.equal(runCli(root, ['--exceptions', file, 'commits', 'HEAD~1..HEAD']).status, 0);
    assert.equal(runCli(root, ['--exceptions', file, 'tree', '.']).status, 0);
    write(root, 'copy.env', tokenLine);
    const run = runCli(root, ['--exceptions', file, 'tree', '.']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /copy\.env:1 {2}\[content\] secret {2}github-pat: REDACTED/);
    assert.ok(!run.stdout.includes(FAKE.token));
    remove(path.dirname(root));
  });

  test('a report never prints the secret or its digest in the excerpt', {skip}, () => {
    const dir = tempDir('secret-report');
    write(dir, 'conf.env', tokenLine);
    const run = runCli(dir, ['tree', '.']);
    assert.equal(run.status, 1, run.output);
    assert.ok(!run.output.includes(FAKE.token));
    assert.ok(!run.output.includes(digest(FAKE.token)));
    remove(dir);
  });
});
