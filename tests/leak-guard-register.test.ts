// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The CLA register (CLA-SIGNATORIES.md) publishes signatories' commit addresses on purpose: the
// email rule is lifted for the address cell of its signatory rows only, never elsewhere, and no
// other rule is lifted there.
import assert from 'node:assert/strict';
import {after, describe, test} from 'node:test';
import {loadPublicRules, type Gate, type RuleSet, scanText} from '../tools/leak-guard/rules.ts';
import {ALLOWED, FAKE, git, initRepo, remove, runCli, write} from './leak-guard-fixtures.ts';
import path from 'node:path';

const REGISTER = 'CLA-SIGNATORIES.md';
const ruleSet: RuleSet = {publicRules: loadPublicRules(), privateRules: [], privateSource: null};
const rulesIn = (text: string, file: string, gate: Gate = 'content') => scanText(ruleSet, {gate, path: file}, text).map(f => f.rule);
const row = (address: string, name = 'Jane Doe') => `| ${name} | ${address} | 1.0 | 2026-11-19 |`;

describe('CLA register: the address cell of a signatory row', () => {
  test('a real address in a register row passes', () => assert.deepEqual(rulesIn(row(FAKE.email), REGISTER), []));
  test('a backquoted address in a register row passes', () => assert.deepEqual(rulesIn(row('`' + FAKE.email + '`'), REGISTER), []));
  test('the GitHub noreply form passes in the register and elsewhere, as before', () => {
    assert.deepEqual(rulesIn(row(ALLOWED.noreply), REGISTER), []);
    assert.deepEqual(rulesIn(row(ALLOWED.noreply), 'README.md'), []);
  });
});

describe('CLA register: the scope of the exclusion', () => {
  test('the same row in another file is reported', () => assert.deepEqual(rulesIn(row(FAKE.email), 'README.md'), ['email']));
  test('a file of the same name elsewhere in the tree is reported', () => assert.deepEqual(rulesIn(row(FAKE.email), `docs/${REGISTER}`), ['email']));
  test('the same row in a commit message is reported', () => assert.deepEqual(rulesIn(row(FAKE.email), REGISTER, 'message'), ['email']));
  test('free text of the register is reported', () => assert.deepEqual(rulesIn(`Write to ${FAKE.email} for help.`, REGISTER), ['email']));
  test('an address in another cell of a row is reported', () => assert.deepEqual(rulesIn(row(ALLOWED.noreply, FAKE.email), REGISTER), ['email']));
  // Only the address cell is lifted: the copy in the name cell is the one finding.
  test('the address repeated in the name cell is reported', () => assert.deepEqual(rulesIn(row(FAKE.email, FAKE.email), REGISTER), ['email']));
  test('an address inside a longer address cell is reported', () => assert.deepEqual(rulesIn(row(`x<${FAKE.email}>`), REGISTER), ['email']));
  test('an address followed by more text in its cell is reported', () => assert.deepEqual(rulesIn(row(`${FAKE.email},more`), REGISTER), ['email']));
  test('a row without a version and a date is reported', () => assert.deepEqual(rulesIn(`| Jane Doe | ${FAKE.email} | | |`, REGISTER), ['email']));
  test('other rules still apply to the address cell of a row', () => assert.deepEqual(rulesIn(row(FAKE.tailscaleKey), REGISTER), ['tailscale-key']));
  test('other rules still apply to the rest of a row', () => assert.deepEqual(rulesIn(row(FAKE.email, `Jane ${FAKE.tailnetHost}`), REGISTER), ['tailnet-host']));
});

describe('CLA register through the CLI', () => {
  const root = initRepo('register');
  after(() => remove(path.dirname(root)));
  const haveGitleaks = !runCli(root, ['message', '/dev/null']).output.includes('gitleaks not found');
  test('worktree passes a register row and reports the same row in README.md', () => {
    write(root, REGISTER, `# CLA signatories\n\n| Public name | Commit e-mail | CLA version | Date |\n|---|---|---|---|\n${row(FAKE.email)}\n`);
    write(root, 'README.md', `${row(FAKE.email)}\n`);
    git(root, ['add', '.']);
    const run = runCli(root, ['worktree']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /^README\.md:1 {2}\[content\] email/m);
    assert.ok(!run.stdout.includes(`${REGISTER}:`), run.stdout);
  });
  test('a token in the register is still a secret', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    write(root, REGISTER, `${row(FAKE.email)}\ntoken = "${FAKE.token}"\n`);
    const run = runCli(root, ['worktree']);
    assert.match(run.stdout, new RegExp(`^${REGISTER.replace('.', '\\.')}:2 {2}\\[content\\] secret`, 'm'));
    assert.ok(!run.stdout.includes(`${REGISTER}:1 `), run.stdout);
  });
});
