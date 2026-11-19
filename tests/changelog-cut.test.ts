// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Assembling and cutting the changelog (tools/changelog/changelog-file.ts and the command line of
// tools/changelog/changelog.ts): golden outputs for the transition (bullets already under
// Unreleased plus fragments), a patch cut of chosen fragments, and the refusals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {assemble, cut, splitUnreleased} from '../tools/changelog/changelog-file.ts';
import {run} from '../tools/changelog/changelog.ts';
import type {Fragment} from '../tools/changelog/fragments.ts';

const CHANGELOG = `# Changelog

Intro.

## Unreleased

Pointer to changelog.d.

- **Old entry.** Written in CHANGELOG.md before the fragments,
  over two lines.
- **Second old entry.**

## 0.1.1

A patch release.

- **A fix.**

## 0.1.0 (first public release)

- **First.**
`;

const fragment = (name: string, number: number | null, kind: Fragment['kind'], bullet: string): Fragment => ({name, number, kind, bullet});
const FRAGMENTS = [
  fragment('9-sec.md', 9, 'security', '- **Security fix.** Nine.'),
  fragment('12-new.md', 12, 'added', '- **New thing.** Twelve,\n  wrapped.'),
  fragment('3-fix.md', 3, 'fixed', '- **Bug fix.** Three.'),
];

describe('the Unreleased section', () => {
  test('is split into preamble, entries and the rest', () => {
    const section = splitUnreleased(CHANGELOG);
    assert.deepEqual(section.preamble, ['Pointer to changelog.d.']);
    assert.equal(section.entries.length, 3);
    assert.equal(section.after[0], '## 0.1.1');
  });
  test('is required exactly once', () => {
    assert.throws(() => splitUnreleased('# Changelog\n\n## 0.1.0\n'), /exactly one "## Unreleased" heading, it has 0/);
    assert.throws(() => splitUnreleased(`${CHANGELOG}\n## Unreleased\n`), /it has 2/);
    assert.throws(() => splitUnreleased(CHANGELOG.replace(/\n/g, '\r\n')), /carriage returns/);
  });
});

describe('assemble', () => {
  test('golden: preamble, existing bullets, then fragments', () => {
    assert.equal(assemble(CHANGELOG, FRAGMENTS), `Pointer to changelog.d.

- **Old entry.** Written in CHANGELOG.md before the fragments,
  over two lines.
- **Second old entry.**
- **Security fix.** Nine.
- **New thing.** Twelve,
  wrapped.
- **Bug fix.** Three.
`);
  });
  test('golden: --entries-only', () => {
    assert.equal(assemble(CHANGELOG, FRAGMENTS.slice(0, 1), true), '- **Old entry.** Written in CHANGELOG.md before the fragments,\n  over two lines.\n- **Second old entry.**\n- **Security fix.** Nine.\n');
  });
  test('an empty section with no fragment assembles to nothing', () => {
    assert.equal(assemble('# C\n\n## Unreleased\n\n## 0.1.0\n', []), '');
  });
});

describe('cut', () => {
  test('golden: a minor release takes the old bullets and every fragment', () => {
    assert.equal(cut(CHANGELOG, FRAGMENTS, {version: '0.2.0', intro: 'Projects and fixes.'}), `# Changelog

Intro.

## Unreleased

Pointer to changelog.d.

## 0.2.0

Projects and fixes.

- **Old entry.** Written in CHANGELOG.md before the fragments,
  over two lines.
- **Second old entry.**
- **Security fix.** Nine.
- **New thing.** Twelve,
  wrapped.
- **Bug fix.** Three.

## 0.1.1

A patch release.

- **A fix.**

## 0.1.0 (first public release)

- **First.**
`);
  });
  test('golden: a patch cut of chosen fragments leaves the old bullets under Unreleased', () => {
    const updated = cut(CHANGELOG, [FRAGMENTS[2]], {version: '0.1.2', date: '2026-11-20', fragmentsOnly: true});
    assert.equal(updated.split('## 0.1.1')[0], `# Changelog

Intro.

## Unreleased

Pointer to changelog.d.

- **Old entry.** Written in CHANGELOG.md before the fragments,
  over two lines.
- **Second old entry.**

## 0.1.2 (2026-11-20)

- **Bug fix.** Three.

`);
  });
  test('cutting twice, then assembling, is stable', () => {
    const once = cut(CHANGELOG, FRAGMENTS, {version: '0.2.0'});
    assert.equal(assemble(once, []), 'Pointer to changelog.d.\n');
    assert.throws(() => cut(once, [], {version: '0.2.1'}), /nothing to cut/);
    assert.match(cut(once, FRAGMENTS.slice(0, 1), {version: '0.2.1'}), /## Unreleased\n\nPointer to changelog.d.\n\n## 0.2.1\n\n- \*\*Security fix/);
  });
  const refusals: [string, Parameters<typeof cut>[2], RegExp][] = [
    ['a version already cut', {version: '0.1.1'}, /already has a "## 0.1.1" heading/],
    ['a version with a suffixed heading', {version: '0.1.0'}, /already has a "## 0.1.0" heading/],
    ['a version that is not semver', {version: 'v0.2.0'}, /is not a version/],
    ['a version with a newline', {version: '0.2.0\n## x'}, /is not a version/],
    ['a bad date', {version: '0.2.0', date: '20-11-2026'}, /is not a date/],
    ['a month 13', {version: '0.2.0', date: '2026-13-01'}, /is not a calendar date/],
    ['a day 45', {version: '0.2.0', date: '2026-01-45'}, /is not a calendar date/],
    ['February 30', {version: '0.2.0', date: '2026-02-30'}, /is not a calendar date/],
    ['February 29 of a common year', {version: '0.2.0', date: '2026-02-29'}, /is not a calendar date/],
    ['day 0', {version: '0.2.0', date: '2026-03-00'}, /is not a calendar date/],
    ['an intro that underlines a heading', {version: '0.2.0', intro: 'Text\n---'}, /one paragraph/],
    ['an intro with a bullet', {version: '0.2.0', intro: '- **Sneaky.**'}, /one paragraph/],
    ['an intro with a heading', {version: '0.2.0', intro: 'Text\n## 9.9.9'}, /one paragraph/],
  ];
  for (const [label, options, error] of refusals) {
    test(`refused: ${label}`, () => assert.throws(() => cut(CHANGELOG, FRAGMENTS, options), error));
  }
  test('a leap day is a date', () => {
    assert.match(cut(CHANGELOG, FRAGMENTS, {version: '0.2.0', date: '2028-02-29'}), /\n## 0\.2\.0 \(2028-02-29\)\n/);
  });
});

describe('the command line on a copy of a repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-cli-'));
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  const call = (...argv: string[]) => {
    let out = '';
    let err = '';
    const status = run([...argv, '--root', root], {out: (text) => { out += text; }, err: (text) => { err += text; }});
    return {status, out, err};
  };
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), CHANGELOG);
  fs.mkdirSync(path.join(root, 'changelog.d'));
  fs.writeFileSync(path.join(root, 'changelog.d', 'README.md'), '# Fragments\n');
  fs.writeFileSync(path.join(root, 'changelog.d', '12-new.md'), '---\nkind: added\n---\n- **New thing.** Twelve,\n  wrapped.\n');
  fs.writeFileSync(path.join(root, 'changelog.d', '3-fix.md'), '---\nkind: fixed\n---\n- **Bug fix.** Three.\n');
  fs.writeFileSync(path.join(root, 'changelog.d', '9-sec.md'), '---\nkind: security\n---\n- **Security fix.** Nine.\n');

  test('check, assemble and a dry run change nothing', () => {
    assert.deepEqual(call('check'), {status: 0, out: '3 changelog fragment(s), all valid\n', err: ''});
    assert.equal(call('assemble').out, assemble(CHANGELOG, FRAGMENTS));
    assert.equal(call('cut', '0.2.0', '--dry-run').out, cut(CHANGELOG, FRAGMENTS, {version: '0.2.0'}));
    assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
    assert.equal(fs.readdirSync(path.join(root, 'changelog.d')).length, 4);
  });
  test('usage errors exit 2, refusals 1', () => {
    assert.equal(call('cut').status, 2);
    assert.equal(call('cut', '0.2.0', '--only').status, 2);
    assert.equal(call('cut', '0.2.0', '--only', '77-none.md').status, 2);
    assert.equal(call('cut', '0.1.1').status, 1);
    assert.equal(call('frobnicate').status, 2);
    assert.equal(call('assemble', '--bogus').status, 2);
  });
  // --only takes file names of changelog.d/ only: a path is refused, never reduced to its last part.
  for (const given of ['changelog.d/3-fix.md', '/tmp/x/3-fix.md', '../changelog.d/3-fix.md', 'changelog.d\\3-fix.md', './3-fix.md']) {
    test(`--only refuses the path ${given}`, () => {
      const result = call('cut', '0.1.2', '--only', given, '--dry-run');
      assert.equal(result.status, 2);
      assert.match(result.err, /--only takes file names of changelog\.d\/, not paths: /);
      assert.equal(result.out, '');
    });
  }
  test('--only accepts the version after the file names', () => {
    const result = call('cut', '--only', '3-fix.md', '9-sec.md', '0.1.2', '--dry-run');
    assert.equal(result.status, 0, result.err);
    assert.equal(result.out, cut(CHANGELOG, [FRAGMENTS[0], FRAGMENTS[2]], {version: '0.1.2', fragmentsOnly: true}));
  });
  test('a patch cut with --only deletes the named fragment alone', () => {
    const result = call('cut', '0.1.2', '--only', '3-fix.md');
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(fs.readdirSync(path.join(root, 'changelog.d')).sort(), ['12-new.md', '9-sec.md', 'README.md']);
    assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /- \*\*Second old entry\.\*\*\n\n## 0\.1\.2\n\n- \*\*Bug fix\.\*\* Three\.\n\n## 0\.1\.1\n/);
  });
  test('an invalid fragment stops a cut before anything is written', () => {
    fs.writeFileSync(path.join(root, 'changelog.d', '40-bad.md'), 'not a bullet\n');
    const before = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const result = call('cut', '0.2.0');
    assert.equal(result.status, 1);
    assert.match(result.err, /40-bad\.md: the bullet starts with/);
    assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), before);
    fs.unlinkSync(path.join(root, 'changelog.d', '40-bad.md'));
  });
  test('a fragment that cannot be deleted after the write is named, with the recovery', (context) => {
    const realUnlink = fs.unlinkSync;
    context.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
      if (String(file).endsWith('9-sec.md')) throw Object.assign(new Error('EACCES: permission denied, unlink'), {code: 'EACCES'});
      realUnlink(file);
    });
    const result = call('cut', '0.2.0');
    context.mock.restoreAll();
    assert.equal(result.status, 1);
    assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /\n## 0\.2\.0\n/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'changelog.d')).sort(), ['9-sec.md', 'README.md']);
    assert.match(result.err, /CHANGELOG\.md now has "## 0\.2\.0", but 1 fragment\(s\) it moved could not be deleted \(EACCES\): changelog\.d\/9-sec\.md\n/);
    assert.match(result.err, /Delete exactly these files by hand and nothing else: rm changelog\.d\/9-sec\.md\n/);
    assert.match(result.err, /Do not run cut again/);
    // The recovery the message gives leaves nothing unreleased twice.
    fs.unlinkSync(path.join(root, 'changelog.d', '9-sec.md'));
    assert.equal(call('assemble').out, 'Pointer to changelog.d.\n');
  });
});
