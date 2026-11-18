// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Copy on select, in the real interface: dragging over terminal text writes it to the clipboard
// and keeps it selected; a plain click, the preference turned off, and a program that tracks the
// mouse (unless Shift forces the selection) write nothing. The clipboard is a list of what was
// written, and the text is written into the terminal buffer directly, so no shell is involved.
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
  term: {reset(): void; write(data: string, done: () => void): void; getSelection(): string; hasSelection(): boolean; cols: number; rows: number};
};
declare const store: {set(key: string, value: unknown): void};

function recordClipboard(): void {
  window.__clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    writeText: async (text: string) => { window.__clipboard.push(text); },
    readText: async () => '',
  }});
}

type Box = {x: number; y: number; cellWidth: number};

describe('copy on select', {skip}, () => {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  /** A pane whose first row reads "alpha beta gamma", with the program's mouse mode `mode` (`?1000h` or none). */
  async function open(name: string, mode = ''): Promise<{page: Page; box: Box}> {
    await mesh.newShell(name);
    const page = await mesh.openPage(name, {width: 1280, height: 800}, recordClipboard);
    pages.push(page);
    const box = await page.evaluate(async (mouse): Promise<Box> => {
      active.term.reset();
      await new Promise<void>(done => active.term.write(`${mouse}alpha beta gamma\r\n`, done));
      const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
      const cellWidth = screen.width / active.term.cols;
      return {x: screen.left, y: screen.top + screen.height / active.term.rows / 2, cellWidth};
    }, mode === '' ? '' : `\x1b[${mode}`);
    return {page, box};
  }

  /** Drag over the first word ("alpha"), with `shift` held when asked. */
  async function drag(page: Page, box: Box, shift = false): Promise<void> {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.cellWidth * 5 - 1, box.y, {steps: 4});
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  }

  const written = (page: Page) => page.evaluate(() => window.__clipboard.slice());
  const settled = (page: Page) => page.waitForTimeout(400);

  test('a drag copies the selected text and keeps the selection', async () => {
    const {page, box} = await open('drag');
    await drag(page, box);
    await page.waitForFunction(() => window.__clipboard.length > 0);
    assert.deepEqual(await written(page), ['alpha']);
    assert.equal(await page.evaluate(() => active.term.getSelection()), 'alpha');
  });

  test('a plain click writes nothing', async () => {
    const {page, box} = await open('click');
    await page.mouse.click(box.x + 1, box.y);
    await settled(page);
    assert.deepEqual(await written(page), []);
  });

  test('the preference turned off writes nothing', async () => {
    const {page, box} = await open('off');
    await page.evaluate(() => store.set('copyOnSelect', false));
    await drag(page, box);
    await settled(page);
    assert.deepEqual(await written(page), []);
    assert.equal(await page.evaluate(() => active.term.hasSelection()), true, 'the text is still selected');
  });

  test('a program that tracks the mouse gets the drag and nothing is copied; Shift forces a selection that is', async () => {
    const {page, box} = await open('tracking', '?1000h');
    await drag(page, box);
    await settled(page);
    assert.deepEqual(await written(page), []);
    await drag(page, box, true);
    await page.waitForFunction(() => window.__clipboard.length > 0);
    assert.deepEqual(await written(page), ['alpha']);
  });

  test('xterm\'s platform rule: Alt does not force a selection on Linux, so it does not rewrite the clipboard', async () => {
    const {page, box} = await open('alt', '?1000h');
    assert.equal(await page.evaluate(() => navigator.platform.startsWith('Mac')), false, 'the rule below is the non-Mac one');
    await drag(page, box, true);
    await page.waitForFunction(() => window.__clipboard.length > 0);
    await page.evaluate(() => { window.__clipboard.length = 0; });
    await page.keyboard.down('Alt');
    await page.mouse.move(box.x + 1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.cellWidth * 5 - 1, box.y, {steps: 4});
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await settled(page);
    assert.deepEqual(await written(page), []);
  });

  test('a release that never arrived does not stack a second copy on the next press', async () => {
    const {page, box} = await open('missed-release');
    await page.evaluate(() => {   // a press whose release is lost, then the window loses focus
      document.querySelector('.xterm-screen')!.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}));
      window.dispatchEvent(new Event('blur'));
    });
    await drag(page, box);
    await page.waitForFunction(() => window.__clipboard.length > 0);
    await settled(page);
    assert.deepEqual(await written(page), ['alpha']);
  });

  test('a triple click writes the clipboard once, with the line', async () => {
    const {page, box} = await open('triple');
    for (const clickCount of [1, 2, 3]) {
      await page.mouse.move(box.x + 1, box.y);
      await page.mouse.down({clickCount});
      await page.mouse.up({clickCount});
    }
    await page.waitForFunction(() => window.__clipboard.length > 0);
    await settled(page);
    assert.deepEqual(await written(page), ['alpha beta gamma']);
  });
});
