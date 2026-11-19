// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The changelog rule of a pull request (tools/changelog/pr-check.ts and `changelog.ts check-pr`):
// a pull request to main with a semver label adds a fragment or says "Changelog: none: <reason>".
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {judgePull, parseNameStatus, type Change} from '../tools/changelog/pr-check.ts';
import {run} from '../tools/changelog/changelog.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATCH = 'semver: patch';
const change = (status: string, filePath: string): Change => ({status, path: filePath});
const pull = (changes: Change[], body = '', labels = [PATCH], baseRef = 'main') => judgePull({baseRef, labels, body, changes});
const CODE = change('M', 'server.py');

describe('a pull request to main', () => {
  const accepted: [string, ReturnType<typeof pull>][] = [
    ['an added fragment', pull([CODE, change('A', 'changelog.d/12-fix.md')])],
    ['an unnumbered fragment', pull([CODE, change('A', 'changelog.d/fix.md')])],
    ['a changed fragment', pull([change('M', 'changelog.d/12-fix.md')])],
    ['the opt-out line with a reason', pull([CODE], 'What\n\nChangelog: none: tests only\n')],
    ['the opt-out in parentheses', pull([CODE], 'Changelog: none (CI only)')],
    ['the opt-out with CRLF', pull([CODE], 'x\r\nChangelog: none: release cut\r\n')],
    ['the opt-out after a closed fence', pull([CODE], '```\ncode\n```\n\nChangelog: none: tests only\n')],
    ['the opt-out after a closed HTML comment', pull([CODE], '<!-- a\nnote -->\nChangelog: none: tests only\n')],
    ['a base that is not main', pull([CODE], '', [PATCH], 'release/latest')],
    ['no semver label (judged by the semver label check)', pull([CODE], '', [])],
  ];
  for (const [label, verdict] of accepted) test(`accepted: ${label}`, () => assert.equal(verdict.ok, true, verdict.reason));
  const refused: [string, ReturnType<typeof pull>][] = [
    ['no fragment', pull([CODE])],
    ['a direct edit of CHANGELOG.md', pull([CODE, change('M', 'CHANGELOG.md')])],
    ['a deleted fragment', pull([change('D', 'changelog.d/12-fix.md')])],
    ['the README of changelog.d', pull([change('M', 'changelog.d/README.md')])],
    ['a file in a subdirectory', pull([change('A', 'changelog.d/x/12-fix.md')])],
    ['a file of another directory', pull([change('A', 'docs/changelog.d/12-fix.md')])],
    ['the opt-out without reason', pull([CODE], 'Changelog: none')],
    ['the opt-out with a one-word reason', pull([CODE], 'Changelog: none: tests')],
    ['the opt-out inside a line', pull([CODE], 'I wrote Changelog: none: tests only')],
    ['a look-alike opt-out', pull([CODE], 'Changelog: nonessential change here')],
    ['a minor label too', pull([CODE], '', ['semver: minor'])],
    ['the placeholder of the template', pull([CODE], 'Changelog: none: <reason>')],
    ['the placeholder with more words', pull([CODE], 'Changelog: none: <reason> here')],
    ['the opt-out inside a code fence', pull([CODE], 'Example:\n\n```\nChangelog: none: tests only\n```\n')],
    ['the opt-out inside a tilde fence', pull([CODE], '~~~md\nChangelog: none: tests only\n~~~\n')],
    ['the opt-out inside an unclosed fence', pull([CODE], '```\nChangelog: none: tests only\n')],
    ['the opt-out inside an HTML comment', pull([CODE], '<!--\nChangelog: none: tests only\n-->\n')],
  ];
  for (const [label, verdict] of refused) {
    test(`refused: ${label}`, () => {
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /no changelog fragment: add one file changelog\.d\/<number>-<slug>\.md/);
    });
  }
});

describe('git --name-status output', () => {
  test('is parsed, rename scores dropped', () => {
    assert.deepEqual(parseNameStatus('A\tchangelog.d/1-a.md\nM\tserver.py\nR100\tx\n\n'),
      [change('A', 'changelog.d/1-a.md'), change('M', 'server.py'), change('R', 'x')]);
  });
  test('anything else is refused', () => assert.throws(() => parseNameStatus('A changelog.d/1-a.md\n'), /not a --name-status line/));
});

describe('check-pr on the command line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-pr-'));
  after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const event = path.join(dir, 'event.json');
  const changes = path.join(dir, 'changes.txt');
  const call = () => {
    let out = '';
    let err = '';
    const status = run(['check-pr', '--event', event, '--changes', changes], {out: (text) => { out += text; }, err: (text) => { err += text; }});
    return {status, out, err};
  };
  const write = (body: unknown, diff: string) => {
    fs.writeFileSync(event, JSON.stringify({pull_request: {base: {ref: 'main'}, labels: [{name: PATCH}], body}}));
    fs.writeFileSync(changes, diff);
  };
  test('exit 0 with a fragment, 1 without, 2 on unreadable input', () => {
    write('', 'A\tchangelog.d/5-x.md\n');
    assert.equal(call().status, 0);
    write(null, 'M\tserver.py\n');
    const refused = call();
    assert.equal(refused.status, 1);
    assert.match(refused.err, /^refused: no changelog fragment/);
    fs.writeFileSync(event, '{not json');
    assert.equal(call().status, 2);
    fs.writeFileSync(event, '{"pull_request": {}}');
    assert.equal(call().status, 2);
  });
});

// The changes of a pull request are the diff from the merge base (three dots). A two-dot diff from
// the tip of main also lists, as added on the pull request's side, every fragment that main deleted
// since the branch was made (a release cut), and would accept a pull request without a fragment.
describe('the changes of a pull request after a release cut on main', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-pr-git-'));
  after(() => fs.rmSync(repo, {recursive: true, force: true}));
  const git = (...args: string[]): string => {
    const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args],
      {cwd: repo, encoding: 'utf8', env: {...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1'}});
    assert.equal(done.status, 0, done.stderr);
    return done.stdout;
  };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '-m', message); };
  const fragmentNames = ['401-change-1.md', '402-change-2.md'];
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'code.txt'), 'one\n');
  fs.mkdirSync(path.join(repo, 'changelog.d'));
  for (const name of fragmentNames) fs.writeFileSync(path.join(repo, 'changelog.d', name), '- **Change.**\n');
  commit('base');
  git('checkout', '-q', '-b', 'topic');
  fs.writeFileSync(path.join(repo, 'code.txt'), 'two\n');
  commit('a change without fragment');
  git('checkout', '-q', 'main');
  for (const name of fragmentNames) fs.unlinkSync(path.join(repo, 'changelog.d', name));
  commit('cut 0.2.0');
  const judge = (diff: string) => judgePull({baseRef: 'main', labels: [PATCH], body: '', changes: parseNameStatus(diff)});

  test('the merge-base diff of the documented recipe holds the pull request alone, and is refused', () => {
    const diff = git('diff', '--name-status', '--no-renames', 'main...topic');
    assert.equal(diff, 'M\tcode.txt\n');
    assert.equal(judge(diff).ok, false);
  });
  test('the two-dot diff, which the tool does not assume, would wrongly accept it', () => {
    const diff = git('diff', '--name-status', '--no-renames', 'main', 'topic');
    assert.match(diff, /^A\tchangelog\.d\/401-change-1\.md$/m);
    assert.equal(judge(diff).ok, true);
  });
  test('the recipe in the tool header and the docs is the merge-base diff', () => {
    for (const file of ['tools/changelog/changelog.ts', 'docs/changelog-fragments.md']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.match(text, /git diff --name-status --no-renames "\$BASE_SHA"\.\.\."\$HEAD_SHA"/, file);
      assert.doesNotMatch(text, /--no-renames\s+(?:\/\/\s*)?(?:<base>\s+<head>|"\$BASE_SHA"\s+"\$HEAD_SHA")/, file);
    }
  });
});
