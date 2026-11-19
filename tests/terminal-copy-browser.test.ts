// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What copying a terminal selection puts on the clipboard. The pane's copySelection() writes
// term.getSelection() unchanged: a hard line break stays a plain newline (no `\` is added), a
// trailing `\` the program printed is kept, and the rows of one soft-wrapped line are joined
// without a newline. The text is written into the terminal buffer directly, so the test depends
// on xterm's selection and on copySelection() only, not on a shell.
// Needs MESH_CHROMIUM and MESH_PTYHOST_CMD (skipped without the browser).
import assert from 'node:assert/strict';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {type PaneView, TerminalMesh, skip} from './terminal-browser-lib.ts';

declare global {
  // eslint-disable-next-line no-var
  var __clipboard: string[];
}
declare const active: PaneView & {
  copySelection(): Promise<void>;
  term: {buffer: {active: {length: number; getLine(y: number): {translateToString(trim?: boolean): string} | undefined}};
    reset(): void; write(data: string, done: () => void): void; selectLines(start: number, end: number): void;
    getSelection(): string; hasSelection(): boolean};
};

/** The page's clipboard is a list of what was written to it: nothing reaches the machine's clipboard. */
function recordClipboard(): void {
  window.__clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    writeText: async (text: string) => { window.__clipboard.push(text); },
    readText: async () => '',
  }});
}

describe('copying a terminal selection', {skip}, () => {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  async function open(name: string): Promise<Page> {
    await mesh.newShell(name);
    const page = await mesh.openPage(name, {width: 1280, height: 800}, recordClipboard);
    pages.push(page);
    return page;
  }

  /** Print `text` on a cleared screen, select every row that has text, copy; returns what was written to the clipboard. */
  async function copyRows(page: Page, text: string): Promise<string[]> {
    await page.evaluate(async text => {
      active.term.reset();
      await new Promise<void>(done => active.term.write(text, done));
      const buffer = active.term.buffer.active;
      let last = buffer.length - 1;
      while (last > 0 && buffer.getLine(last)!.translateToString(true) === '') last -= 1;
      active.term.selectLines(0, last);
      await active.copySelection();
    }, text);
    return page.evaluate(() => window.__clipboard.slice());
  }

  test('hard line breaks stay plain newlines and an existing trailing backslash is kept', async () => {
    const page = await open('hard');
    const clipboard = await copyRows(page,
      'curl -s https://example.invalid/api \\\r\n  -H "Accept: application/json" \\\r\n  --data @body.json\r\nnext command\r\n');
    assert.deepEqual(clipboard, [
      'curl -s https://example.invalid/api \\\n  -H "Accept: application/json" \\\n  --data @body.json\nnext command']);
  });

  test('no backslash is added to a hard line break that had none', async () => {
    const page = await open('no-added');
    const clipboard = await copyRows(page, 'first part\r\nsecond part\r\n');
    assert.deepEqual(clipboard, ['first part\nsecond part']);
  });

  test('the rows of one soft-wrapped line are joined without a newline', async () => {
    const page = await open('soft');
    const cols = await page.evaluate(() => active.term.cols);
    const long = Array.from({length: Math.ceil(cols * 2.5 / 6)}, (_, index) => `w${String(index).padStart(3, '0')} `).join('').trim();
    assert.ok(long.length > cols * 2, 'the line is longer than two rows');
    const clipboard = await copyRows(page, `${long}\r\nafter\r\n`);
    const wrapped = await page.evaluate(() => {
      const buffer = active.term.buffer.active;
      return [0, 1, 2, 3].map(y => buffer.getLine(y)?.isWrapped ?? false);
    });
    assert.deepEqual(wrapped.slice(0, 3), [false, true, true], 'the terminal wrapped the line over three rows');
    assert.deepEqual(clipboard, [`${long}\nafter`]);
  });

  test('a long soft-wrapped line that ends in a backslash keeps it, and the next hard line follows after one newline', async () => {
    const page = await open('soft-backslash');
    const cols = await page.evaluate(() => active.term.cols);
    const long = `docker run ${'--flag-with-a-long-name '.repeat(Math.ceil(cols / 22) + 1)}\\`;
    const clipboard = await copyRows(page, `${long}\r\n  image:tag\r\n`);
    assert.deepEqual(clipboard, [`${long}\n  image:tag`]);
  });

  test('Ctrl+Shift+X copies the selection as a shell command', async () => {
    const page = await open('as-shell');
    const cols = await page.evaluate(() => active.term.cols);
    const long = `docker run ${'--flag-with-a-long-name '.repeat(Math.ceil(cols / 22) + 1)}`.trim();
    const clipboard = await page.evaluate(async text => {
      active.term.reset();
      await new Promise<void>(done => active.term.write(text, done));
      const buffer = active.term.buffer.active;
      let last = buffer.length - 1;
      while (last > 0 && buffer.getLine(last)!.translateToString(true) === '') last -= 1;
      active.term.selectLines(0, last);
      (active.term as unknown as {textarea: HTMLElement}).textarea.dispatchEvent(
        new KeyboardEvent('keydown', {key: 'X', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true}));
      await new Promise(done => setTimeout(done, 200));
      return window.__clipboard.slice();
    }, `${long}\r\n  --image-tag x\r\n\r\nnext command\r\n`);
    assert.deepEqual(clipboard, [`${long} \\\n  --image-tag x\n\nnext command`]);
  });
});
