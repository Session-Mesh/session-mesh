// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Changelog fragments (tools/changelog/fragments.ts, changelog.d/README.md): the format of one
// fragment, hostile inputs, the assembly order, the reading of a directory, and the fragments of
// this repository, which this test validates on every CI run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {compareFragments, parseFragment, readFragmentDir, type Fragment} from '../tools/changelog/fragments.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const parse = (name: string, text: string) => parseFragment(name, bytes(text));
const BULLET = '- **Idle sessions no longer show as working.** A Claude Code session that had been idle\n  for hours could be listed as working.\n';

describe('one fragment', () => {
  test('a bullet without front matter is of kind "changed"', () => {
    const {fragment, problems} = parse('412-idle.md', BULLET);
    assert.deepEqual(problems, []);
    assert.deepEqual(fragment, {name: '412-idle.md', number: 412, kind: 'changed', bullet: BULLET.trimEnd()});
  });
  test('a front matter sets the kind; a name without number has none', () => {
    const {fragment, problems} = parse('idle.md', `---\nkind: fixed\n---\n${BULLET}\n\n`);
    assert.deepEqual(problems, []);
    assert.equal(fragment?.kind, 'fixed');
    assert.equal(fragment?.number, null);
    assert.equal(fragment?.bullet, BULLET.trimEnd());
  });
  test('a long link target does not count against the width', () => {
    const line = `  See [Restoring](docs/operations.md#${'a'.repeat(120)}).`;
    assert.deepEqual(parse('1-link.md', `- **Lead.** Text.\n${line}\n`).problems, []);
  });
  const refused: [string, string, string, RegExp][] = [
    ['an upper-case name', 'Idle.md', BULLET, /name is not/],
    ['a name with a leading zero number', '012-idle.md', BULLET, /name is not/],
    ['a name with a path separator', '..md', BULLET, /name is not/],
    ['README.md itself', 'README.md', BULLET, /name is not/],
    ['a text file', '1-idle.txt', BULLET, /name is not/],
    ['an empty file', '1-a.md', '', /no bullet/],
    ['a front matter only', '1-a.md', '---\nkind: fixed\n---\n', /no bullet/],
    ['an unclosed front matter', '1-a.md', `---\nkind: fixed\n${BULLET}`, /never closed/],
    ['an unknown kind', '1-a.md', `---\nkind: feature\n---\n${BULLET}`, /unknown kind "feature"/],
    ['an unknown key', '1-a.md', `---\npr: 12\n---\n${BULLET}`, /unknown front matter key "pr"/],
    ['a kind given twice', '1-a.md', `---\nkind: fixed\nkind: added\n---\n${BULLET}`, /given twice/],
    ['YAML that is not "key: value"', '1-a.md', `---\nkind: [fixed]\n---\n${BULLET}`, /front matter line/],
    ['a plain paragraph', '1-a.md', 'Idle sessions are fixed.\n', /starts with "- \*\*"/],
    ['a bullet without bold lead', '1-a.md', '- Idle sessions are fixed.\n', /starts with "- \*\*"/],
    ['an unclosed bold lead', '1-a.md', '- **Idle sessions are fixed.\n', /never closed/],
    ['two bullets', '1-a.md', `${BULLET}- **Another.** Entry.\n`, /not indented/],
    ['two paragraphs', '1-a.md', `${BULLET}\n  More text.\n`, /blank/],
    ['an unindented continuation', '1-a.md', '- **Lead.** Text\nmore text.\n', /not indented/],
    ['a heading that would end the section', '1-a.md', '- **Lead.** Text\n## 9.9.9\n', /not indented|starts with "#"/],
    ['an indented heading', '1-a.md', '- **Lead.** Text\n  # Title\n', /starts with "#"/],
    ['a trailing space', '1-a.md', '- **Lead.** Text \n', /ends with a space/],
    ['a line of 101 columns', '1-a.md', `- **Lead.** ${'x'.repeat(89)}\n`, /wider than 100/],
    ['CRLF line endings', '1-a.md', BULLET.replace(/\n/g, '\r\n'), /carriage returns/],
    ['a tab', '1-a.md', '- **Lead.**\tText\n', /control/],
    ['a NUL byte', '1-a.md', '- **Lead.** Te\u0000xt\n', /control/],
    ['an escape sequence', '1-a.md', '- **Lead.** \u001b[31mred\n', /control/],
    ['a bidirectional override', '1-a.md', '- **Lead.** abc‮dcba\n', /bidirectional/],
    ['a zero-width space', '1-a.md', '- **Lead.** a​b\n', /zero-width/],
    ['a byte order mark', '1-a.md', `﻿${BULLET}`, /byte-order-mark/],
  ];
  for (const [label, name, text, problem] of refused) {
    test(`refused: ${label}`, () => {
      const parsed = parse(name, text);
      assert.equal(parsed.fragment, null);
      assert.match(parsed.problems.join('\n'), problem);
    });
  }
  test('refused: bytes that are not UTF-8', () => {
    const parsed = parseFragment('1-a.md', Uint8Array.from([0x2d, 0x20, 0xff, 0xfe]));
    assert.equal(parsed.fragment, null);
    assert.match(parsed.problems.join('\n'), /not valid UTF-8/);
  });
  test('refused: a file over 8 KiB', () => {
    const parsed = parse('1-a.md', `- **Lead.** x\n${'  word word\n'.repeat(1000)}`);
    assert.match(parsed.problems.join('\n'), /larger than 8192 bytes/);
  });
  test('the width counts characters, not bytes', () => {
    assert.deepEqual(parse('1-a.md', `- **Lead.** ${'é'.repeat(88)}\n`).problems, []);
  });
});

describe('assembly order', () => {
  const fragment = (name: string, number: number | null, kind: Fragment['kind']): Fragment => ({name, number, kind, bullet: `- **${name}.**`});
  test('by kind, then number, unnumbered last, then name', () => {
    const shuffled = [
      fragment('b.md', null, 'fixed'), fragment('30-x.md', 30, 'added'), fragment('a.md', null, 'fixed'),
      fragment('7-y.md', 7, 'fixed'), fragment('9-s.md', 9, 'security'), fragment('2-z.md', 2, 'internal'),
      fragment('100-w.md', 100, 'fixed'), fragment('5-c.md', 5, 'changed'), fragment('1-d.md', 1, 'docs'),
    ];
    assert.deepEqual([...shuffled].sort(compareFragments).map((item) => item.name),
      ['9-s.md', '30-x.md', '5-c.md', '7-y.md', '100-w.md', 'a.md', 'b.md', '1-d.md', '2-z.md']);
    assert.deepEqual([...shuffled].reverse().sort(compareFragments), [...shuffled].sort(compareFragments));
  });
});

describe('a changelog.d directory', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-dir-'));
  after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  test('a missing directory holds no fragment', () => {
    assert.deepEqual(readFragmentDir(path.join(temporary, 'missing')), {fragments: [], problems: []});
  });
  test('README.md is skipped; links, directories and bad files are reported', () => {
    const dir = path.join(temporary, 'changelog.d');
    fs.mkdirSync(path.join(dir, 'nested'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'README.md'), '# not a fragment\n');
    fs.writeFileSync(path.join(dir, '20-b.md'), BULLET);
    fs.writeFileSync(path.join(dir, '3-a.md'), `---\nkind: security\n---\n${BULLET}`);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(temporary, 'outside.md'), BULLET);
    fs.symlinkSync(path.join(temporary, 'outside.md'), path.join(dir, '4-link.md'));
    const report = readFragmentDir(dir);
    assert.deepEqual(report.fragments.map((item) => item.name), ['3-a.md', '20-b.md']);
    assert.equal(report.problems.length, 3, report.problems.join('\n'));
    assert.match(report.problems.join('\n'), /4-link\.md: not a regular file/);
    assert.match(report.problems.join('\n'), /nested: not a regular file/);
    assert.match(report.problems.join('\n'), /notes\.txt: the name is not/);
  });
});

describe('this repository', () => {
  test('every fragment of changelog.d/ is valid', () => {
    const report = readFragmentDir(path.join(ROOT, 'changelog.d'));
    assert.deepEqual(report.problems, []);
  });
});
