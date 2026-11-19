// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "Copy as shell command" on synthetic rows, without a browser: each acceptance criterion of the
// feature, and the cases where the text must come back unchanged.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';
import vm from 'node:vm';
import {MAX_CHARS, shellCommandOfSelection, toShellCommand} from '../static/shell-copy.ts';
import {shellCommandOfSelection as exportedSelection, toShellCommand as exported} from '../static/terminal-links.ts';

const run = (text: string, wrapped: number[] = []): string => {
  const rows = text.split('\n');
  return toShellCommand(rows, rows.map((_, index) => wrapped.includes(index)));
};
const unchanged = (text: string): void => assert.equal(run(text), text);

describe('line breaks inside one command', () => {
  test('the example of the request: a missing backslash is added, an existing one kept', () => {
    assert.equal(run('octez-client transfer 1 from alice to bob \\\n  --burn-cap 0.1\n  --fee 0.001'),
      'octez-client transfer 1 from alice to bob \\\n  --burn-cap 0.1 \\\n  --fee 0.001');
  });
  test('a command that already has every backslash is returned as is', () => {
    unchanged('octez-client transfer 1 from alice to bob \\\n  --burn-cap 0.1 \\\n  --fee 0.001');
  });
  test('a chain of indented option rows gets the backslashes', () => {
    assert.equal(run('docker run\n  -v a:b\n  --rm'), 'docker run \\\n  -v a:b \\\n  --rm');
    assert.equal(run('curl x\n\t-o out\n\t--silent'), 'curl x \\\n\t-o out \\\n\t--silent');
  });
  test('a continuation row that does not start with an option is never joined', () => {
    unchanged('docker run\n  -v a:b\n  image');
    unchanged('make\n\tall');
    unchanged('ls\n  pwd');
  });
  test('nothing is guessed from indentation', () => {
    unchanged('cd x\n  ls\n  pwd');
    unchanged('ls\n  pwd');
    unchanged('case $x in\n  a) echo a ;;\n  *) echo b ;;\nesac');
  });
  test('an option row that is not indented is not joined', () => {
    unchanged('echo hi\n-n x');
    unchanged('total 4\n-rw-r--r-- 1 u g 0 a\n-rw-r--r-- 1 u g 0 b');
  });
  test('a block with one other row is left alone, even if option rows follow the first', () => {
    unchanged('ls\n  -l\nrm file');
    unchanged('ls\n  -l\n  pwd\n  --all');
  });
  test('rows after a backslash row count as continuations', () => {
    assert.equal(run('a \\\n  b\n  --c'), 'a \\\n  b \\\n  --c');
  });
  test('a dash alone, a bullet or a rule is not an option', () => {
    unchanged('ls\n  - item');
    unchanged('ls\n  ---');
    unchanged('ls\n  -');
  });
  test('trailing blanks before the added backslash are replaced by one space', () => {
    assert.equal(run('ls   \n  -l'), 'ls \\\n  -l');
  });
  test('a backslash written without a space is kept as written', () => {
    unchanged('ls\\\n  -l');
  });
  test('an escaped backslash at the end is not a continuation', () => {
    assert.equal(run('echo a\\\\\n  -b'), 'echo a\\\\ \\\n  -b');
  });
  test('a backslash followed by a space is an escaped space and stays as written', () => {
    unchanged('echo a \\ \n  -b');
    unchanged('echo a \\ \n  b');
    unchanged('echo a \\\t\n  --b');
  });
});

describe('soft wraps', () => {
  test('wrapped rows are joined with no break and no backslash', () => {
    assert.equal(run('aaaa bbbb cccc\ndddd eeee\nffff', [1, 2]), 'aaaa bbbb cccc' + 'dddd eeee' + 'ffff');
  });
  test('a soft-wrapped long command next to an indented row is one logical line', () => {
    assert.equal(run('docker run --flag-one --flag-two\n --flag-three\n  --image x', [1]),
      'docker run --flag-one --flag-two --flag-three \\\n  --image x');
  });
  test('a wrap in the middle of a word is rejoined exactly', () => {
    assert.equal(run('curl https://exam\nple.invalid/path', [1]), 'curl https://example.invalid/path');
  });
  test('a missing or short wrap list means hard breaks', () => {
    assert.equal(toShellCommand(['a', 'b']), 'a\nb');
    assert.equal(toShellCommand(['a', 'b', 'c'], [false, true]), 'ab\nc');
  });
  test('a first row flagged as wrapped has nothing to join to', () => {
    assert.equal(toShellCommand(['a', 'b'], [true, false]), 'a\nb');
  });
});

describe('independent commands', () => {
  test('commands on separate rows stay on separate rows', () => {
    unchanged('cd /tmp\nls -l\npwd');
  });
  test('a command followed by an unindented command is untouched', () => {
    unchanged('git status\ngit diff');
  });
  test('blank rows separate commands', () => {
    unchanged('ls\n\n  -l');
    unchanged('echo a\n\necho b\n');
  });
  test('a command body at one indentation is not chained to its siblings', () => {
    unchanged('f() {\n  echo a\n  echo b\n}');
    unchanged('if true; then\n  echo a\n  echo b\nfi');
  });
  test('rows that end an operator already continue or end in the shell', () => {
    unchanged('a |\n  b');
    unchanged('a &&\n  b');
    unchanged('a ||\n  b');
    unchanged('a;\n  b');
    unchanged('a &\n  b');
    unchanged('for x in 1 2; do\n  echo $x\ndone');
  });
  test('a row ending in a colon or comma belongs to another language', () => {
    unchanged('def f():\n    return 1');
    unchanged('a,\n  b');
  });
  test('a blank row ends the block: a continued command, then an independent one', () => {
    assert.equal(run('ls\n  -l\n\nrm file'), 'ls \\\n  -l\n\nrm file');
  });
  test('a continued command followed by an independent one', () => {
    assert.equal(run('ls \\\n  -l\npwd'), 'ls \\\n  -l\npwd');
  });
});

describe('text that must not change', () => {
  test('a heredoc and its body', () => {
    unchanged('cat <<EOF\n  body one\n    body two\nEOF\n');
    unchanged('cat > f <<EOF\n  x\nEOF\nls');
  });
  test('a quoted heredoc tag, a dash tag, and tab-stripped terminator', () => {
    unchanged("cat <<'EOF'\n  $x\nEOF");
    unchanged('cat <<"EOF"\n  $x\nEOF');
    unchanged('cat <<-EOF\n\t\tx\n\tEOF');
  });
  test('the command after a heredoc is still handled', () => {
    assert.equal(run('cat <<EOF\n  x\nEOF\n\nls\n  -l'), 'cat <<EOF\n  x\nEOF\n\nls \\\n  -l');
  });
  test('an unterminated heredoc leaves the whole selection alone', () => {
    unchanged('ls\n  -l\ncat <<EOF\n  x');
  });
  test('a here-string is not a heredoc', () => {
    assert.equal(run('cat <<<word\n  -n'), 'cat <<<word \\\n  -n');
    unchanged('cat <<<word\n  n');
  });
  test('a double-quoted string over several rows', () => {
    unchanged('echo "line one\n  line two\n  line three"');
  });
  test('a single-quoted string over several rows', () => {
    unchanged("echo 'line one\n  line two'");
  });
  test('the command goes on after the quote closes', () => {
    assert.equal(run('echo "a\n  -b" \n  -c'), 'echo "a\n  -b" \\\n  -c');
  });
  test('a quote in a quote and an escaped quote do not close it', () => {
    unchanged('echo "it\'s\n  \\"fine\\""');
    unchanged("echo 'a\n  \"b'");
    unchanged("echo $'a\\'b\n  c'");
  });
  test('an unterminated quote leaves the whole selection alone', () => {
    unchanged('ls\n  -l\necho "never closed\n  more');
  });
  test('comments are not touched, and a comment hides nothing from a quote', () => {
    unchanged('# step one\n  # step two\nls');
    unchanged('ls # list it\n  -l');
    assert.equal(run('echo a#b\n  -c'), 'echo a#b \\\n  -c');
    unchanged('echo "# not a comment\n  inside"');
  });
  test('a comment row between commands', () => {
    unchanged('ls\n# then\n  -l');
  });
  test('rows that already end in a backslash', () => {
    unchanged('a \\\n  b \\\n  c');
  });
  test('prompt lines mean the selection mixes commands and output', () => {
    unchanged('$ ls\n  output');
    unchanged('user@host:~$ ls\n  one');
    unchanged('> continued\n  more');
    unchanged('➜ project git status\n  -s');
  });
});

describe('input handling', () => {
  test('empty input', () => {
    assert.equal(toShellCommand([]), '');
    assert.equal(toShellCommand(['']), '');
    assert.equal(run('\n\n'), '\n\n');
  });
  test('CRLF row ends are dropped', () => {
    assert.equal(toShellCommand(['ls\r', '  -l\r'], [false, false]), 'ls \\\n  -l');
  });
  test('a single row', () => {
    assert.equal(run('ls -l'), 'ls -l');
  });
  test('no newline is added at the end', () => {
    assert.equal(run('ls\n  -l'), 'ls \\\n  -l');
    assert.ok(!run('ls\n  -l').endsWith('\n'));
  });
  test('a very long selection is linear and a huge one is returned unchanged', () => {
    const rows = Array.from({length: 24000}, (_, index) => ['cmd' + index, '  --opt' + index, ''][index % 3] as string);
    const started = Date.now();
    const out = toShellCommand(rows).split('\n');
    assert.ok(Date.now() - started < 10_000, 'generous bound: the real cost is tens of milliseconds');
    assert.equal(out.length, rows.length);
    assert.equal(out[0], 'cmd0 \\');
    assert.equal(out[1], '  --opt1');
    assert.equal(out[23997], 'cmd23997 \\');
    const giant = ['x'.repeat(MAX_CHARS + 1), '  -l'];
    assert.equal(toShellCommand(giant), `${giant[0]}\n  -l`);
  });
  test('both functions are exported by the terminal-links bundle source', () => {
    assert.equal(exported, toShellCommand);
    assert.equal(exportedSelection, shellCommandOfSelection);
  });
});

describe('the built bundle that app.js loads', () => {
  const root = new URL('..', import.meta.url);
  const bundle = readFileSync(new URL('static/terminal-links.js', root), 'utf8');
  const sandbox: {MeshTerminalLinks?: Record<string, unknown>} = {};
  vm.runInNewContext(`${bundle}\nglobalThis.MeshTerminalLinks = MeshTerminalLinks;`, sandbox);
  const used = [...new Set([...readFileSync(new URL('static/app.js', root), 'utf8')
    .matchAll(/MeshTerminalLinks\.(\w+)/g)].map(match => match[1] as string))];

  test('app.js uses the feature names', () => {
    assert.ok(used.includes('shellCommandOfSelection'));
  });
  test('every MeshTerminalLinks name app.js calls is a function in the bundle (tree shaking drops unexported ones)', () => {
    for (const name of used) assert.equal(typeof sandbox.MeshTerminalLinks?.[name], 'function', `MeshTerminalLinks.${name}`);
    assert.equal(typeof sandbox.MeshTerminalLinks?.['toShellCommand'], 'function');
  });
  test('the built functions transform text', () => {
    const built = sandbox.MeshTerminalLinks?.['toShellCommand'] as typeof toShellCommand;
    assert.equal(built(['ls', '  -l']), 'ls \\\n  -l');
  });
});

describe('the selection of a terminal', () => {
  type Row = {text: string; wrapped?: boolean};
  /** A terminal of `rows`, whose selection runs from (x0, y0) to (x1, y1), end column exclusive. */
  const fake = (rows: Row[], from: [number, number], to: [number, number], selection: string) => ({
    getSelection: () => selection,
    getSelectionPosition: () => ({start: {x: from[0], y: from[1]}, end: {x: to[0], y: to[1]}}) as
      {start: {x: number; y: number}; end: {x: number; y: number}} | undefined,
    buffer: {active: {getLine: (y: number) => {
      const row = rows[y];
      if (!row) return undefined;
      return {isWrapped: row.wrapped === true,
        translateToString: (trim?: boolean, start = 0, end?: number) => {
          const text = row.text.slice(start, end);
          return trim === true ? text.trimEnd() : text;
        }};
    }}},
  });

  test('rows and wrap flags are read from the buffer between the two positions', () => {
    const rows = [{text: 'top'}, {text: 'octez-client transfer 1 from alice '}, {text: 'to bob', wrapped: true}, {text: '  --fee 0.001'}];
    const term = fake(rows, [0, 1], [13, 3], 'octez-client transfer 1 from alice to bob\n  --fee 0.001');
    assert.equal(shellCommandOfSelection(term), 'octez-client transfer 1 from alice to bob \\\n  --fee 0.001');
  });
  test('a partial first and last row are cut at the selected columns', () => {
    const rows = [{text: 'xx ls'}, {text: '  -l yy'}];
    assert.equal(shellCommandOfSelection(fake(rows, [3, 0], [4, 1], 'ls\n  -l')), 'ls \\\n  -l');
  });
  test('a selection starting mid-indent does not turn indented siblings into one command', () => {
    const rows = [{text: '    cd x'}, {text: '    ls'}, {text: '    pwd'}];
    assert.equal(shellCommandOfSelection(fake(rows, [4, 0], [7, 2], 'cd x\n    ls\n    pwd')), 'cd x\n    ls\n    pwd');
  });
  test('wide characters: the rows are compared with the terminal selection', () => {
    const rows = [{text: 'echo 日本語 '}, {text: '  --fee 1'}];
    assert.equal(shellCommandOfSelection(fake(rows, [0, 0], [9, 1], 'echo 日本語\n  --fee 1')), 'echo 日本語 \\\n  --fee 1');
  });
  test('a first row flagged as wrapped is read as the start of the selection', () => {
    const rows = [{text: 'aaa bbb'}, {text: 'ccc ', wrapped: true}, {text: '  --x'}];
    assert.equal(shellCommandOfSelection(fake(rows, [0, 1], [5, 2], 'ccc\n  --x')), 'ccc \\\n  --x');
  });
  test('a selection ending at column 0 of its last row keeps that empty row', () => {
    const rows = [{text: 'ls'}, {text: '  -l'}, {text: 'next'}];
    assert.equal(shellCommandOfSelection(fake(rows, [0, 0], [0, 2], 'ls\n  -l\n')), 'ls \\\n  -l\n');
  });
  test('the active (alternate) buffer is the one that is read', () => {
    const term = fake([{text: 'normal'}], [0, 0], [6, 0], 'alt');
    const alt = [{text: 'alt'}];
    term.buffer.active.getLine = (y: number) => (alt[y] ? {isWrapped: false, translateToString: () => alt[y]!.text} : undefined);
    assert.equal(shellCommandOfSelection(term), 'alt');
  });
  test('no selection position gives null', () => {
    const term = fake([], [0, 0], [0, 0], '');
    term.getSelectionPosition = () => undefined;
    assert.equal(shellCommandOfSelection(term), null);
  });
  test('rows that disagree with the terminal selection give null', () => {
    assert.equal(shellCommandOfSelection(fake([{text: 'ls'}, {text: '  -l'}], [0, 0], [4, 1], 'something else')), null);
  });
  test('a row missing from the buffer gives null', () => {
    assert.equal(shellCommandOfSelection(fake([{text: 'ls'}], [0, 0], [4, 1], 'ls')), null);
  });
});
