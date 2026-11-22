// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The diff viewer of the side panel (static/diff-view.ts): reading unified diffs, pairing the
// changed lines and cutting them into changed words.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {modeLabel} from '../static/diff-file-mode.ts';
import {countLines, displayPath, fileSegments, gitHeaderPaths, hunkRows, parseUnifiedDiff, readQuoted, tokenize, tokenizeUpTo, wordDiff, WORD_DIFF_LIMIT} from '../static/diff-view.ts';

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
    assert.deepEqual(broken.files.map(file => file.newPath), ['b/x', 'b/y']);
    assert.equal(broken.files[1]?.added, 1);
  });

  test('a hunk cut short gives back the header pair of the next file', () => {
    const cut = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-1\n+2\n');
    assert.deepEqual(cut.files.map(file => [file.newPath, file.added, file.deleted]), [['b/x', 0, 0], ['b/y', 1, 1]]);
    assert.deepEqual(cut.files[0]?.hunks[0]?.lines.map(line => line.text), ['a']);
  });

  test('a complete hunk keeps lines that look like file headers', () => {
    const kept = parseUnifiedDiff('--- x\n+++ x\n@@ -1,2 +1,2 @@\n a\n--- before/y\n+++ after/y\n');
    assert.equal(kept.files.length, 1);
    assert.deepEqual(kept.files[0]?.hunks[0]?.lines.map(line => [line.kind, line.text]),
      [['context', 'a'], ['del', '-- before/y'], ['add', '++ after/y']]);
  });

  test('finds nothing in a text that is not a diff', () => {
    const none = parseUnifiedDiff('just some notes\n');
    assert.equal(none.files.length, 0);
    assert.deepEqual(none.preamble, ['just some notes']);
  });
});

describe('path names', () => {
  test('a plain diff -u keeps its a/ and b/ directories; a Git diff drops them', () => {
    const plain = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n');
    assert.deepEqual([plain.files[0]?.oldPath, plain.files[0]?.newPath], ['a/x', 'b/x']);
    const git = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n');
    assert.deepEqual([git.files[0]?.oldPath, git.files[0]?.newPath], ['x', 'x']);
  });

  test('decodes the quoted names Git writes for non-ASCII bytes', () => {
    assert.deepEqual(readQuoted('"a/caf\\303\\251 \\"x\\".sh"'), ['a/café "x".sh', 24]);
    const text = [
      'diff --git "a/caf\\303\\251.sh" "b/caf\\303\\251.sh"', 'old mode 100644', 'new mode 100755',
      'diff --git "a/\\303\\251t\\303\\251.png" "b/\\303\\251t\\303\\251.png"', 'Binary files "a/\\303\\251t\\303\\251.png" and "b/\\303\\251t\\303\\251.png" differ',
      'diff --git "a/na\\303\\257ve.txt" "b/na\\303\\257ve.txt"', '--- "a/na\\303\\257ve.txt"', '+++ "b/na\\303\\257ve.txt"', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/plain name.txt b/plain name.txt', '--- a/plain name.txt', '+++ b/plain name.txt', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/old.txt b/new.txt', 'rename from "\\303\\240.txt"', 'rename to new.txt',
    ].join('\n');
    assert.deepEqual(parseUnifiedDiff(text).files.map(file => [file.status, displayPath(file)]), [
      ['modified', 'café.sh'],
      ['binary', 'été.png'],
      ['modified', 'naïve.txt'],
      ['modified', 'plain name.txt'],
      ['renamed', 'à.txt → new.txt'],
    ]);
  });

  test('shows a copy as a copy, with both names, even without hunks', () => {
    const copy = parseUnifiedDiff('diff --git a/src.c b/dst.c\nsimilarity index 100%\ncopy from src.c\ncopy to dst.c\n'
      + 'diff --git a/x b/y\nsimilarity index 90%\ncopy from x\ncopy to y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-1\n+2\n');
    assert.deepEqual(copy.files.map(file => [file.status, displayPath(file), file.hunks.length]),
      [['copied', 'src.c → dst.c', 0], ['copied', 'x → y', 1]]);
  });

  test('keeps the status of a copied or renamed file whose change is binary', () => {
    const parsed = parseUnifiedDiff('diff --git a/logo.png b/copy.png\nsimilarity index 90%\ncopy from logo.png\ncopy to copy.png\n'
      + 'Binary files a/logo.png and b/copy.png differ\ndiff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n');
    assert.deepEqual(parsed.files.map(file => [file.status, file.binary, displayPath(file)]),
      [['copied', true, 'logo.png → copy.png'], ['binary', true, 'x.bin']]);
  });

  test('reads the names of a header without prefixes (diff.noprefix) when they agree', () => {
    assert.deepEqual(gitHeaderPaths('diff --git run.sh run.sh'), ['run.sh', 'run.sh']);
    assert.deepEqual(gitHeaderPaths('diff --git my file my file'), ['my file', 'my file']);
    assert.equal(gitHeaderPaths('diff --git x y'), null);
    const mode = parseUnifiedDiff('diff --git run.sh run.sh\nold mode 100644\nnew mode 100755\n');
    const [file] = mode.files;
    assert.ok(file);
    assert.equal(displayPath(file), 'run.sh');
  });

  test('splits an unquoted header with spaces where both names agree', () => {
    assert.deepEqual(gitHeaderPaths('diff --git a/x y b/x y'), ['x y', 'x y']);
    assert.deepEqual(gitHeaderPaths('diff --git a/x "b/\\303\\251"'), ['x', 'é']);
    assert.equal(gitHeaderPaths('diff --git nonsense'), null);
  });
});

describe('file modes', () => {
  const modes = (text: string): [string, string | null, string | null, number][] =>
    parseUnifiedDiff(text).files.map(file => [file.status, file.oldMode, file.newMode, file.hunks.length]);
  const CHMOD_SERIES = 'From 1 Mon Sep 17 00:00:00 2001\nSubject: [PATCH 1/2] chmod\n\n---\n'
    + 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n-- \n2.47.0\n\n'
    + 'From 2 Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] notes\n\nold mode notes\nnew mode 100600 explained here\n---\n'
    + 'diff --git a/notes b/notes\nindex 1..2 100644\n--- a/notes\n+++ b/notes\n@@ -1 +1 @@\n-a\n+b\n';

  test('keeps a mode-only change (chmod) and a mode change beside a content change', () => {
    assert.deepEqual(modes('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
      + 'diff --git a/x b/x\nold mode 100755\nnew mode 100644\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'),
    [['modified', '100644', '100755', 0], ['modified', '100755', '100644', 1]]);
  });

  test('keeps the mode of a created or deleted file, and of a renamed one', () => {
    assert.deepEqual(modes('diff --git a/new.sh b/new.sh\nnew file mode 100755\nindex 0..1\n--- /dev/null\n+++ b/new.sh\n@@ -0,0 +1 @@\n+x\n'
      + 'diff --git a/gone.sh b/gone.sh\ndeleted file mode 100755\nindex 1..0\n'
      + 'diff --git a/a.sh b/b.sh\nold mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from a.sh\nrename to b.sh\n'),
    [['added', null, '100755', 1], ['deleted', '100755', null, 0], ['renamed', '100644', '100755', 0]]);
  });

  test('a line reading like a mode inside a hunk is content', () => {
    assert.deepEqual(modes('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old mode 1\n+new mode 2\n'), [['modified', null, null, 1]]);
  });

  // Git writes a mode as six octal digits: any other value after the prefix is not a mode.
  test('a value other than six octal digits is not a mode', () => {
    for (const value of ['1'.repeat(5000), '100648', '10064x', '<img src=x onerror=alert(1)>', '10064', '1006440', '']) {
      assert.deepEqual(modes(`diff --git a/x b/x\nold mode ${value}\nnew mode ${value}\n`), [['modified', null, null, 0]], value.slice(0, 20));
      assert.deepEqual(modes(`diff --git a/x b/x\nnew file mode ${value}\n`), [['modified', null, null, 0]], value.slice(0, 20));
    }
  });

  // In a format-patch series, the message of the next patch follows a chmod-only patch (which has
  // no hunk), before its own `diff --git` line.
  test('the message of the next patch in a series does not change the mode of a chmod-only file', () => {
    assert.deepEqual(modes(CHMOD_SERIES), [['modified', '100644', '100755', 0], ['modified', null, null, 1]]);
  });

  test('the next patch message cannot overwrite modes or mark a previous file deleted', () => {
    const text = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n-- \n2.47.0\n\n'
      + 'From next Mon Sep 17 00:00:00 2001\nSubject: next\n\nold mode 100600\nnew mode 100600\ndeleted file mode 100755\n'
      + 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    assert.deepEqual(modes(text), [['modified', '100644', '100755', 0], ['modified', null, null, 1]]);
  });

  test('any non-header line closes an extended header even without a patch separator', () => {
    assert.deepEqual(modes('diff --git a/x b/x\nold mode 100644\nunrelated\nnew mode 100755\ndeleted file mode 100644\n'),
      [['modified', '100644', null, 0]]);
  });

  test('an invalid mode closes the header before later mode or status lines', () => {
    for (const prefix of ['old mode ', 'new mode ', 'new file mode ', 'deleted file mode ']) {
      const patch = `diff --git a/x b/x\nold mode 100644\n${prefix}not-a-mode\ndeleted file mode 100644\nnew mode 100755\n`;
      assert.deepEqual(modes(patch), [['modified', '100644', null, 0]], prefix);
    }
  });

  test('two equal modes are no change of mode', () => {
    assert.equal(modeLabel({oldMode: '100644', newMode: '100644'}), null);
    assert.equal(modeLabel({oldMode: '100644', newMode: '100755'}), '100644 → 100755');
  });
});

describe('carriage returns', () => {
  test('in an LF patch, a CR that belongs to the file is kept: a CRLF to LF change shows', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-line\r\n+line\n');
    assert.deepEqual(parsed.files[0]?.hunks[0]?.lines.map(line => line.text), ['line\r', 'line']);
    const [left, right] = wordDiff('line\r', 'line');
    assert.deepEqual(left, [{text: 'line', changed: false}, {text: '\r', changed: true}]);
    assert.deepEqual(right, [{text: 'line', changed: false}]);
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

  test('does not align a line against an empty one', () => {
    assert.deepEqual(wordDiff('', 'a b c'), [[], [{text: 'a b c', changed: true}]]);
    assert.deepEqual(wordDiff('a b', ''), [[{text: 'a b', changed: true}], []]);
  });

  test('charges a document budget, and marks lines whole once it is spent', () => {
    const budget = {cells: 9};
    assert.deepEqual(wordDiff('a b', 'a c', budget)[1], [{text: 'a ', changed: false}, {text: 'c', changed: true}]);
    assert.equal(budget.cells, 0);
    assert.deepEqual(wordDiff('a b', 'a c', budget)[1], [{text: 'a c', changed: true}]);
  });

  test('aligns the paired lines of a file once', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a b\n-c\n+a d\n+e\n');
    const file = parsed.files[0];
    assert.ok(file);
    const budget = {cells: 100};
    const segments = fileSegments(file, budget);
    assert.equal(segments.size, 4);
    assert.equal(budget.cells, 100 - 9 - 1);
  });

  test('stops collecting tokens as soon as a pair cannot fit', () => {
    assert.deepEqual(tokenizeUpTo('a, b', 10), ['a', ',', ' ', 'b']);
    assert.equal(tokenizeUpTo(',,,,,', 4), null);
    // a long punctuation line against one word: marked whole, without aligning
    const budget = {cells: 1_000_000};
    const [left, right] = wordDiff(';'.repeat(WORD_DIFF_LIMIT + 1), 'word', budget);
    assert.deepEqual([left.length, right], [1, [{text: 'word', changed: true}]]);
    assert.equal(budget.cells, 1_000_000);
  });

  test('gives up on very long lines and marks them whole', () => {
    const long = 'x '.repeat(Math.ceil(Math.sqrt(WORD_DIFF_LIMIT)) + 10);
    const [left, right] = wordDiff(long, long + 'y');
    assert.deepEqual(left, [{text: long, changed: true}]);
    assert.deepEqual(right, [{text: long + 'y', changed: true}]);
  });
});

describe('countLines', () => {
  test('counts lines with or without a final newline', () => {
    assert.deepEqual(['', 'a', 'a\n', 'a\nb', 'a\nb\n'].map(countLines), [0, 1, 1, 2, 2]);
  });
});
