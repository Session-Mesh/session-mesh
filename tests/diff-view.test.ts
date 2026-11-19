// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The diff viewer of the side panel (static/diff-view.ts): reading unified diffs, pairing the
// changed lines and cutting them into changed words.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {displayPath, hunkRows, parseUnifiedDiff, tokenize, wordDiff, WORD_DIFF_LIMIT} from '../static/diff-view.ts';

const GIT = `commit 0123456789abcdef
Author: Someone <someone@example.invalid>

    Rename and tweak

diff --git a/lib/a.ml b/lib/a.ml
index 1111111..2222222 100644
--- a/lib/a.ml
+++ b/lib/a.ml
@@ -1,4 +1,4 @@ let header
 let x = 1
-let y = 2
+let y = 3
 let z = 4
-- not a header
+-- still not a header
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-hello
\\ No newline at end of file
+hello world
diff --git a/added.md b/added.md
new file mode 100644
--- /dev/null
+++ b/added.md
@@ -0,0 +1,2 @@
+# Title
+text
diff --git a/gone.c b/gone.c
deleted file mode 100644
--- a/gone.c
+++ /dev/null
@@ -1 +0,0 @@
-int main;
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

describe('parseUnifiedDiff', () => {
  const parsed = parseUnifiedDiff(GIT);

  test('keeps the commit message as a preamble and finds every file', () => {
    assert.equal(parsed.preamble[0], 'commit 0123456789abcdef');
    assert.deepEqual(parsed.files.map(file => [file.status, displayPath(file)]), [
      ['modified', 'lib/a.ml'],
      ['renamed', 'old.txt → new.txt'],
      ['added', 'added.md'],
      ['deleted', 'gone.c'],
      ['binary', 'logo.png'],
    ]);
  });

  test('numbers the lines from the hunk header', () => {
    const [hunk] = parsed.files[0]?.hunks ?? [];
    assert.ok(hunk);
    assert.equal(hunk.header, '@@ -1,4 +1,4 @@ let header');
    assert.deepEqual(hunk.lines.map(line => [line.kind, line.oldNo, line.newNo, line.text]), [
      ['context', 1, 1, 'let x = 1'],
      ['del', 2, null, 'let y = 2'],
      ['add', null, 2, 'let y = 3'],
      ['context', 3, 3, 'let z = 4'],
      ['del', 4, null, '- not a header'],
      ['add', null, 4, '-- still not a header'],
    ]);
    assert.equal(parsed.files[0]?.added, 2);
    assert.equal(parsed.files[0]?.deleted, 2);
  });

  test('a deleted line reading "-- " is not taken for a file header', () => {
    assert.equal(parsed.files.length, 5);
  });

  test('records a missing final newline on the line it follows', () => {
    const lines = parsed.files[1]?.hunks[0]?.lines ?? [];
    assert.deepEqual(lines.map(line => [line.kind, line.noNewline]), [['del', true], ['add', false]]);
  });

  test('reads a plain diff -u with timestamps and several files', () => {
    const plain = parseUnifiedDiff([
      '--- before/x.txt\t2026-01-01 10:00:00',
      '+++ after/x.txt\t2026-01-02 10:00:00',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '--- before/y.txt',
      '+++ after/y.txt',
      '@@ -1 +1,2 @@',
      ' c',
      '+d',
    ].join('\n'));
    assert.deepEqual(plain.files.map(file => [file.oldPath, file.newPath, file.added, file.deleted]), [
      ['before/x.txt', 'after/x.txt', 1, 1],
      ['before/y.txt', 'after/y.txt', 1, 0],
    ]);
  });

  test('accepts CRLF line endings and a context line whose space was stripped', () => {
    const crlf = parseUnifiedDiff('--- a/x\r\n+++ b/x\r\n@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n');
    const lines = crlf.files[0]?.hunks[0]?.lines ?? [];
    assert.deepEqual(lines.map(line => [line.kind, line.text]), [['context', 'a'], ['context', ''], ['del', 'b'], ['add', 'c']]);
  });

  test('stops at a malformed hunk instead of swallowing what follows', () => {
    const broken = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n a\n?garbage\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-1\n+2\n');
    assert.deepEqual(broken.files.map(file => file.newPath), ['x', 'y']);
    assert.equal(broken.files[1]?.added, 1);
  });

  test('finds nothing in a text that is not a diff', () => {
    const none = parseUnifiedDiff('just some notes\n');
    assert.equal(none.files.length, 0);
    assert.deepEqual(none.preamble, ['just some notes']);
  });
});

describe('hunkRows', () => {
  test('pairs each deleted line with the added line in the same position of its run', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n-a\n-b\n+A\n c\n');
    const hunk = parsed.files[0]?.hunks[0];
    assert.ok(hunk);
    assert.deepEqual(hunkRows(hunk).map(row => [row.kind, row.left?.text ?? null, row.right?.text ?? null]), [
      ['change', 'a', 'A'],
      ['change', 'b', null],
      ['context', 'c', 'c'],
    ]);
  });
});

describe('wordDiff', () => {
  test('marks only the words that changed', () => {
    const [left, right] = wordDiff('let y = 2 in f y', 'let y = 3 in g y');
    assert.deepEqual(left, [
      {text: 'let y = ', changed: false}, {text: '2', changed: true}, {text: ' in ', changed: false},
      {text: 'f', changed: true}, {text: ' y', changed: false},
    ]);
    assert.deepEqual(right.filter(segment => segment.changed).map(segment => segment.text), ['3', 'g']);
  });

  test('keeps accented words whole', () => {
    assert.deepEqual(tokenize('déjà vu'), ['déjà', ' ', 'vu']);
  });

  test('gives up on very long lines and marks them whole', () => {
    const long = 'x '.repeat(Math.ceil(Math.sqrt(WORD_DIFF_LIMIT)) + 10);
    const [left, right] = wordDiff(long, long + 'y');
    assert.deepEqual(left, [{text: long, changed: true}]);
    assert.deepEqual(right, [{text: long + 'y', changed: true}]);
  });
});
