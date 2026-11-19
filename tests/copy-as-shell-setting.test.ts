// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The per-device "copyAsShell" preference: off by default; when on, the usual copy paths (copy
// keys, right-click, copy on select) write the "copy as shell command" form of the terminal
// selection, and fall back to the text as it is whenever that form cannot be rebuilt.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';
import vm from 'node:vm';
import {COPY_AS_SHELL_KEY, copiedText, copyAsShellEnabled} from '../static/shell-copy.ts';
import * as links from '../static/terminal-links.ts';

type Row = {text: string; wrapped?: boolean};

/** A terminal whose whole selection is `rows`, from column 0 of the first to the end of the last. */
function terminal(rows: Row[], selection = rows.map(row => row.text).join('\n')) {
  const last = rows.length - 1;
  return {
    hasSelection: () => selection !== '',
    getSelection: () => selection,
    getSelectionPosition: () => ({start: {x: 0, y: 0}, end: {x: rows[last]?.text.length ?? 0, y: last}}),
    buffer: {active: {getLine: (y: number) => {
      const row = rows[y];
      if (!row) return undefined;
      return {isWrapped: row.wrapped === true,
        translateToString: (trim?: boolean, start = 0, end?: number) => {
          const text = row.text.slice(start, end);
          return trim === true ? text.trimEnd() : text;
        }};
    }}},
  };
}

const command = [{text: 'octez-client transfer 1 from alice to bob'}, {text: '  --burn-cap 0.1'}, {text: '  --fee 0.001'}];
const asShell = 'octez-client transfer 1 from alice to bob \\\n  --burn-cap 0.1 \\\n  --fee 0.001';
const plain = 'octez-client transfer 1 from alice to bob\n  --burn-cap 0.1\n  --fee 0.001';

describe('the copyAsShell preference', () => {
  test('is stored under its own key and is off unless explicitly true', () => {
    assert.equal(COPY_AS_SHELL_KEY, 'copyAsShell');
    for (const stored of [undefined, null, false, 'true', 1, {}]) assert.equal(copyAsShellEnabled(stored), false);
    assert.equal(copyAsShellEnabled(true), true);
  });
  test('the names are exported by the terminal-links bundle source', () => {
    assert.equal(links.copiedText, copiedText);
    assert.equal(links.copyAsShellEnabled, copyAsShellEnabled);
    assert.equal(links.COPY_AS_SHELL_KEY, COPY_AS_SHELL_KEY);
  });
  test('the built bundle that app.js loads has them, and app.js reads them', () => {
    const root = new URL('..', import.meta.url);
    const sandbox: {MeshTerminalLinks?: Record<string, unknown>} = {};
    vm.runInNewContext(`${readFileSync(new URL('static/terminal-links.js', root), 'utf8')}\nglobalThis.MeshTerminalLinks = MeshTerminalLinks;`, sandbox);
    assert.equal(typeof sandbox.MeshTerminalLinks?.['copiedText'], 'function');
    assert.equal(typeof sandbox.MeshTerminalLinks?.['copyAsShellEnabled'], 'function');
    assert.equal(sandbox.MeshTerminalLinks?.['COPY_AS_SHELL_KEY'], 'copyAsShell');
    const app = readFileSync(new URL('static/app.js', root), 'utf8');
    assert.match(app, /const \{ copiedText, copyAsShellEnabled, COPY_AS_SHELL_KEY \} = MeshTerminalLinks;/);
  });
});

describe('the text a usual copy writes', () => {
  test('off: the selection as it is', () => {
    assert.equal(copiedText(terminal(command), plain, false), plain);
  });
  test('on: the shell-command form of the selection', () => {
    assert.equal(copiedText(terminal(command), plain, true), asShell);
  });
  test('on, soft-wrapped rows: joined with no break and no backslash', () => {
    const rows = [{text: 'docker run --name a-very-long-'}, {text: 'name image', wrapped: true}];
    assert.equal(copiedText(terminal(rows, 'docker run --name a-very-long-name image'), 'docker run --name a-very-long-name image', true),
      'docker run --name a-very-long-name image');
  });
  test('on, separate commands, heredocs and quotes: unchanged', () => {
    for (const text of ['ls\npwd', 'cat <<EOF\n  -x\nEOF', 'echo "a\n  -b"']) {
      const rows = text.split('\n').map(row => ({text: row}));
      assert.equal(copiedText(terminal(rows), text, true), text);
    }
  });
  test('on, but the text is not the terminal selection (a phone selection kept after it was cleared): as it is', () => {
    assert.equal(copiedText(terminal(command, ''), plain, true), plain);
    assert.equal(copiedText(terminal(command, 'other'), plain, true), plain);
  });
  test('on, but the rows cannot be rebuilt: as it is', () => {
    const term = terminal(command);
    term.getSelectionPosition = () => ({start: {x: 0, y: 0}, end: {x: 4, y: 9}});
    assert.equal(copiedText(term, plain, true), plain);
  });
});
