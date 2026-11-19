// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The CLA register (CLA-SIGNATORIES.md) publishes signatories' commit addresses on purpose: the
// email rule is lifted for the address cell of its signatory rows only, never elsewhere, and no
// other rule is lifted there.
import assert from 'node:assert/strict';
import {after, describe, test} from 'node:test';
import {loadPublicRules, type Gate, type RuleSet, scanLines, scanText} from '../tools/leak-guard/rules.ts';
import {ALLOWED, FAKE, git, initRepo, remove, runCli, VARIANT, write} from './leak-guard-fixtures.ts';
import path from 'node:path';

const REGISTER = 'CLA-SIGNATORIES.md';
const ruleSet: RuleSet = {publicRules: loadPublicRules(), privateRules: [], privateSource: null};
const rulesIn = (text: string, file: string, gate: Gate = 'content') => scanText(ruleSet, {gate, path: file}, text).map(f => f.rule);
const row = (address: string, name = 'Jane Doe') => `| ${name} | ${address} | 1.0 | 2026-11-19 |`;

describe('CLA register: the address cell of a signatory row', () => {
  test('a real address in a register row passes', () => assert.deepEqual(rulesIn(row(FAKE.email), REGISTER), []));
  test('a backquoted address in a register row passes', () => assert.deepEqual(rulesIn(row('`' + FAKE.email + '`'), REGISTER), []));
  // cla-check compares addresses in ASCII lower case, as Git authors may write them in any case.
  test('an address with capitals in a register row passes', () => assert.deepEqual(rulesIn(row(FAKE.email.toUpperCase()), REGISTER), []));
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
  test('a private literal in the address cell is still reported', () => {
    const withPrivate: RuleSet = {...ruleSet, privateRules: [
      {id: 'host', literal: FAKE.privateHost, caseInsensitive: false},
      {id: 'addr', literal: FAKE.email, caseInsensitive: true},
    ]};
    const privateIn = (address: string) => scanText(withPrivate, {gate: 'content', path: REGISTER}, row(address)).map(f => f.rule);
    assert.deepEqual(privateIn(`jane@${FAKE.privateHost}.org`), ['private:host']);
    // The literal is the whole address cell: only the email hit is lifted.
    assert.deepEqual(privateIn(FAKE.email), ['private:addr']);
  });
  test('fullwidth and U+2223 pipes do not make a row', () => {
    assert.deepEqual(rulesIn(row(FAKE.email).replaceAll('|', '｜'), REGISTER), ['email']);
    assert.deepEqual(rulesIn(row(FAKE.email).replaceAll('|', '∣'), REGISTER), ['email']);
  });
  test('rows with CRLF line ends pass', () => assert.deepEqual(rulesIn(`${row(FAKE.email)}\r\n${row(FAKE.email, 'Joe')}\r\n`, REGISTER), []));
});

// A row is lifted only when tools/cla-check counts it as a signature, since only then does the
// required `cla` check tie the address to a commit authored with it.
describe('CLA register: only rows cla-check counts', () => {
  const variant = (version: string, date: string, name = 'Jane Doe', address = FAKE.email) => `| ${name} | ${address} | ${version} | ${date} |`;
  test('another CLA version is reported', () => assert.deepEqual(rulesIn(variant('9.9', '2026-11-19'), REGISTER), ['email']));
  test('an impossible date is reported', () => assert.deepEqual(rulesIn(variant('1.0', '2026-13-45'), REGISTER), ['email']));
  test('a blank name cell is reported', () => assert.deepEqual(rulesIn(variant('1.0', '2026-11-19', '  '), REGISTER), ['email']));
  test('an unpaired backquote is reported', () => {
    assert.deepEqual(rulesIn(row('`' + FAKE.email), REGISTER), ['email']);
    assert.deepEqual(rulesIn(row(FAKE.email + '`'), REGISTER), ['email']);
  });
  test('a %40-encoded address is reported', () => assert.deepEqual(rulesIn(row(VARIANT.encodedEmail), REGISTER), ['email']));
  test('a row inside an HTML comment is reported', () => {
    assert.deepEqual(rulesIn(`<!--\n${row(FAKE.email)}\n-->\n${row(FAKE.email, 'Joe')}`, REGISTER), ['email']);
  });
  test('a row inside a fenced block is reported', () => {
    assert.deepEqual(rulesIn(`~~~\n${row(FAKE.email)}\n~~~\n${row(FAKE.email, 'Joe')}`, REGISTER), ['email']);
    assert.deepEqual(rulesIn(`\`\`\`md\n${row(FAKE.email)}\n\`\`\``, REGISTER), ['email']);
  });
  // Known limit (README): added lines alone (`staged`, `commits`) carry no fence or comment state.
  test('an added line alone is judged as a row', () => {
    assert.deepEqual(scanLines(ruleSet, {gate: 'content', path: REGISTER}, [row(FAKE.email)], [2]), []);
  });
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
  test('worktree reports a row inside an HTML comment of the register', () => {
    write(root, REGISTER, `${row(FAKE.email, 'Joe')}\n<!--\n${row(FAKE.email)}\n-->\n`);
    write(root, 'README.md', 'nothing\n');
    const run = runCli(root, ['worktree']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, new RegExp(`^${REGISTER.replace('.', '\\.')}:3 {2}\\[content\\] email`, 'm'));
    assert.ok(!run.stdout.includes(`${REGISTER}:1 `), run.stdout);
  });
  test('a token in the register is still a secret', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    write(root, REGISTER, `${row(FAKE.email)}\ntoken = "${FAKE.token}"\n`);
    const run = runCli(root, ['worktree']);
    assert.match(run.stdout, new RegExp(`^${REGISTER.replace('.', '\\.')}:2 {2}\\[content\\] secret`, 'm'));
    assert.ok(!run.stdout.includes(`${REGISTER}:1 `), run.stdout);
  });
});
