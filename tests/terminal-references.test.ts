// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tracker references of the terminal (T-, P- and N- ids) on plain text and on a synthetic buffer, without a
// browser: word boundaries, punctuation, case, ids inside paths and URLs, very long lines, hostile Unicode, wrapped
// rows, and the known-id check that keeps ordinary text such as "T-12" plain. The click and the cache are in
// tests/terminal-references-browser.test.ts and tests/work-references.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { referenceMatches } from '../static/terminal-references.ts';
import { referencesOnRow, type TerminalBuffer } from '../static/terminal-links.ts';

const ids = (text: string): string[] => referenceMatches(text).map(m => m.id);
const spans = (text: string): string[] => referenceMatches(text).map(m => text.slice(m.index, m.index + m.length));

describe('referenceMatches', () => {
  test('a whole word T-, P- or N- with two to thirty-two hex digits', () => {
    assert.deepEqual(ids('see T-1a2b and P-5e6f, then N-0000abcd'), ['T-1a2b', 'P-5e6f', 'N-0000abcd']);
    assert.deepEqual(ids('T-ab'), ['T-ab']);
    assert.deepEqual(ids(`T-${'a'.repeat(32)}`), [`T-${'a'.repeat(32)}`]);
    assert.deepEqual(ids(`T-${'a'.repeat(33)}`), [], 'more than 32 digits');
    assert.deepEqual(ids('T-1 T-a T- T-xyz12 T-12g'), [], 'one digit, no digit, not hex');
    assert.deepEqual(ids('B-1234 Q-1234 X-1234 t-1234 p-abcd n-0000abcd'), [], 'other letters and a lowercase prefix');
  });

  test('sentence punctuation and brackets around it are not part of it', () => {
    assert.deepEqual(spans('(T-1a2b), [P-5e6f]. "N-0000abcd"; `T-3c4d`: **T-4f5a**! T-6b7c? <T-7a8b>'),
      ['T-1a2b', 'P-5e6f', 'N-0000abcd', 'T-3c4d', 'T-4f5a', 'T-6b7c', 'T-7a8b']);
  });

  test('uppercase hex digits name the same lowercase id; the index and length are those of the text shown', () => {
    const [match] = referenceMatches('task T-1A2B done');
    assert.deepEqual(match, { id: 'T-1a2b', index: 5, length: 6 });
  });

  test('glued to other text, inside a path, a URL, a file name or an assignment: nothing', () => {
    for (const text of ['xT-1a2b', 'T-1a2bx', 'T-1a2b-slug', 'tasks/gateway/T-1a2b-ship.md', '/srv/T-1a2b',
      'T-1a2b/', 'https://example.invalid/T-1a2b', 'https://example.invalid/?id=T-1a2b', 'T-1a2b.md', 'T-1a2b.bak',
      'id=T-1a2b', 'T-1a2b:42', '#T-1a2b', '@T-1a2b', 'T-1a2b_x', 'T-1a2b’s']) {
      assert.deepEqual(ids(text), [], text);
    }
  });

  test('hostile Unicode never makes an id: look-alike letters and dashes, invisible and bidirectional characters', () => {
    for (const text of ['Т-1a2b', 'T‐1a2b', 'T–1a2b', 'T－1a2b', 'Ｔ-1a2b', 'T-１a2b', 'T-1a2b​', '​T-1a2b',
      'T-1a‍2b', '‮T-1a2b', 'T-1a2b́', 'T-1a2b‬']) {
      assert.deepEqual(ids(text), [], JSON.stringify(text));
    }
    assert.deepEqual(ids(' T-1a2b　P-5e6f'), ['T-1a2b', 'P-5e6f'], 'Unicode spaces still separate words');
  });

  test('a very long line is scanned in linear time', () => {
    const started = performance.now();
    assert.deepEqual(ids(`${'.'.repeat(200_000)}x`), []);
    assert.deepEqual(ids(`T-1a2b${')'.repeat(200_000)}`), ['T-1a2b']);
    assert.equal(ids(`${'T-1a2b '.repeat(50_000)}`).length, 50_000);
    assert.deepEqual(ids(`(${'('.repeat(200_000)}`), []);
    assert.ok(performance.now() - started < 2_000, `took ${performance.now() - started} ms`);
  });
});

/** A buffer of one-cell characters (a CJK character takes two cells, the second of width 0). */
function buffer(rows: string[], cols: number, wrapped: number[] = []): TerminalBuffer {
  const wide = (ch: string): boolean => /[　-鿿]/u.test(ch);
  const cells = rows.map(text => {
    const out: { width: number; chars: string }[] = [];
    for (const ch of text) { out.push({ width: wide(ch) ? 2 : 1, chars: ch }); if (wide(ch)) out.push({ width: 0, chars: '' }); }
    while (out.length < cols) out.push({ width: 1, chars: '' });
    return out;
  });
  return {
    getLine: y => {
      const row = cells[y];
      return row && { length: cols, isWrapped: wrapped.includes(y),
        getCell: x => { const cell = row[x]; return cell && { getWidth: () => cell.width, getChars: () => cell.chars }; } };
    },
  };
}

describe('referencesOnRow', () => {
  const known = (id: string): boolean => ['T-1a2b', 'P-5e6f', 'N-0000abcd', 'T-1a2b3c4d'].includes(id);

  test('only a known id is a link, with its cells; an unknown one stays text', () => {
    const links = referencesOnRow(buffer(['T-1a2b T-9999 P-5e6f T-12'], 40), 0, known);
    assert.deepEqual(links, [
      { text: 'T-1a2b', start: [0, 0], end: [0, 5], kind: 'ref' },
      { text: 'P-5e6f', start: [0, 14], end: [0, 19], kind: 'ref' },
    ]);
  });

  test('after a wide character the cells are the terminal columns, not string indices', () => {
    const [link] = referencesOnRow(buffer(['完了 T-1a2b'], 40), 0, known);
    assert.deepEqual(link, { text: 'T-1a2b', start: [0, 5], end: [0, 10], kind: 'ref' });
  });

  test('an id cut by a soft wrap is not offered as the shorter id it starts with', () => {
    const rows = ['xxxxxxxx T-1a2b', '3c4d done'];
    assert.deepEqual(referencesOnRow(buffer(rows, 15, [1]), 0, known), [], 'the end of the row continues on the next');
    assert.deepEqual(referencesOnRow(buffer(['3c4d', 'T-1a2b done'], 15, [1]), 1, known), [], 'the row continues the one above');
    assert.equal(referencesOnRow(buffer(rows, 15), 0, known).length, 1, 'without a wrap it is a link');
  });

  test('no row, no link; the check is asked once per candidate', () => {
    assert.deepEqual(referencesOnRow(buffer([], 10), 3, known), []);
    const asked: string[] = [];
    referencesOnRow(buffer(['a T-1a2b b T-12 c'], 40), 0, id => { asked.push(id); return false; });
    assert.deepEqual(asked, ['T-1a2b', 'T-12']);
  });
});
