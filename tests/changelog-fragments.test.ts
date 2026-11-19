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
import {cut, splitUnreleased} from '../tools/changelog/changelog-file.ts';
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
    ['a bidirectional override', '1-a.md', '- **Lead.** abc\u202edcba\n', /bidirectional/],
    ['a zero-width space', '1-a.md', '- **Lead.** a\u200bb\n', /zero-width/],
    ['a byte order mark', '1-a.md', `\ufeff${BULLET}`, /byte-order-mark/],
    ['an empty bold lead', '1-a.md', '- **** Text.\n', /bold lead of the bullet is empty/],
    ['a blank bold lead', '1-a.md', '- ** ** Text.\n', /bold lead of the bullet is empty/],
    ['a nested bullet', '1-a.md', '- **Lead.** Text\n  - **Second.** Text\n', /list marker/],
    ['a nested star bullet', '1-a.md', '- **Lead.** Text\n    * item\n', /list marker/],
    ['a nested numbered item', '1-a.md', '- **Lead.** Text\n  1. item\n', /list marker/],
    ['a setext underline', '1-a.md', '- **Lead.** Text\n  ---\n', /heading underline or rule/],
    ['a setext "=" underline', '1-a.md', '- **Lead.** Text\n  ===\n', /heading underline or rule/],
    ['a code fence', '1-a.md', '- **Lead.** Text\n  ```sh\n', /code fence/],
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
  // Invisible or reordering characters beyond the list above: format characters (Cf), line and
  // paragraph separators, private use, unassigned, variation selectors and other default-ignorable
  // code points.
  const invisible: [string, number][] = [
    ['ARABIC LETTER MARK', 0x061c], ['LINE SEPARATOR', 0x2028], ['PARAGRAPH SEPARATOR', 0x2029],
    ['SOFT HYPHEN', 0x00ad], ['TAG LATIN CAPITAL LETTER A', 0xe0041], ['CANCEL TAG', 0xe007f],
    ['LANGUAGE TAG', 0xe0001], ['WORD JOINER', 0x2060], ['INVISIBLE TIMES', 0x2062],
    ['MONGOLIAN VOWEL SEPARATOR', 0x180e], ['HANGUL FILLER', 0x3164], ['COMBINING GRAPHEME JOINER', 0x034f],
    ['VARIATION SELECTOR-16', 0xfe0f], ['VARIATION SELECTOR-17', 0xe0100], ['INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
    ['MUSICAL SYMBOL BEGIN BEAM', 0x1d173], ['private use U+E000', 0xe000], ['unassigned U+0378', 0x0378],
    ['NEXT LINE (C1)', 0x0085], ['ARABIC NUMBER SIGN', 0x0600],
  ];
  for (const [label, codePoint] of invisible) {
    test(`refused: ${label}`, () => {
      const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
      const parsed = parse('1-a.md', `- **Lead.** a${String.fromCodePoint(codePoint)}b\n`);
      assert.equal(parsed.fragment, null);
      assert.match(parsed.problems.join('\n'), new RegExp(`U\\+${hex} on line 1`));
    });
  }
  test('accepted: letters, marks, numbers, punctuation, symbols and spaces of any script', () => {
    const text = '- **Lead.** Éé é «guillemets»  espace insécable — 3½ € ✓ \u{1f642} 日本語 ١٢٣.\n';
    assert.deepEqual(parse('1-a.md', text).problems, []);
  });
  test('accepted: wrapped prose with a hyphen or a number inside a line', () => {
    assert.deepEqual(parse('1-a.md', '- **Lead.** Text, not a list -\n  well-formed, 1.5 times faster.\n').problems, []);
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

// The bold leads of the bullets that were under "## Unreleased" in CHANGELOG.md when fragments were
// introduced. Every change since then is a fragment: a pull request that adds a bullet to that
// section by hand fails here. The list is never extended; after the next minor cut the section has none.
const FROZEN_UNRELEASED_LEADS = [
  'The sessions filter stays in sight while you type on a phone.',
  'The owner answers an agent\'s question from the task sheet.',
  'An agent records the owner\'s answer to its question.',
  'A new Projects view over the project tracker.',
  'A project configuration edit that meets another writer\'s lock reports `busy`, never `invalid-config`.',
  'The session list is computed with less repeated work.',
  'A message approval answered in one window closes in the others.',
  'A new Claude session starts with a conversation id the mesh chose.',
  'A session identity registry keeps the conversation of each session once it is known exactly.',
  'An idle Codex started as `codex resume <id>` gets its conversation id from its launch arguments.',
  'An idle Codex is no longer given the conversation of a Codex started later.',
  'The session list no longer falls minutes behind on a busy machine.',
  'The session list loads progressively.',
  'Copy on select.',
  'Copy as shell command.',
  'Releases ship `work-read` and `work-mcp`.',
  'Diff viewer.',
  'Agents get the project tracker.',
];
const POINTER_PREAMBLE = [
  'The entries of changes merged since the move to changelog fragments are the files of',
  '[changelog.d/](changelog.d/) until the next release is cut; see',
  '[docs/changelog-fragments.md](docs/changelog-fragments.md).',
];

// The bold lead of every bullet of an entries block, continuation lines joined.
function boldLeads(entries: string[]): string[] {
  const bullets = entries.join('\n').split(/\n(?=- )/).filter((bullet) => bullet.startsWith('- '));
  return bullets.map((bullet) => /^- \*\*([\s\S]+?)\*\*/.exec(bullet)?.[1].replace(/\n\s+/g, ' ') ?? bullet);
}

describe('this repository', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  test('every fragment of changelog.d/ is valid', () => {
    const report = readFragmentDir(path.join(ROOT, 'changelog.d'));
    assert.deepEqual(report.problems, []);
  });
  test('no bullet is added by hand under "## Unreleased": changes go to changelog.d/', () => {
    const unexpected = boldLeads(splitUnreleased(changelog).entries).filter((lead) => !FROZEN_UNRELEASED_LEADS.includes(lead));
    assert.deepEqual(unexpected, [], 'move these bullets of CHANGELOG.md into changelog.d/<number>-<slug>.md');
  });
  test('the "## Unreleased" preamble is the fixed pointer to changelog.d/', () => {
    assert.deepEqual(splitUnreleased(changelog).preamble, POINTER_PREAMBLE);
  });
  test('after a cut, "## Unreleased" holds its preamble alone', () => {
    const {fragments} = readFragmentDir(path.join(ROOT, 'changelog.d'));
    const marker: Fragment = {name: '1-marker.md', number: 1, kind: 'fixed', bullet: '- **Marker.**'};
    const section = splitUnreleased(cut(changelog, [...fragments, marker], {version: '99.0.0'}));
    assert.deepEqual(section.preamble, POINTER_PREAMBLE);
    assert.deepEqual(section.entries, []);
  });
});
