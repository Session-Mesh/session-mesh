// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Session search shortcuts in a real page: Ctrl+K (Cmd+K on macOS) outside a terminal and a text
// field, Ctrl+Shift+K (Cmd+Shift+K) from anywhere, terminal included. The shell of the test
// session proves what reaches the program: `cat -v` echoes a Ctrl+K it receives as ^K.
// Two mutants of the served app.js show the guards are what the cases measure: one that no longer
// tells a terminal from the page, one that no longer keeps Ctrl+Shift+K from the terminal.
// Playwright dispatches key events to the page; browser-level shortcuts (the address bar's
// Ctrl+K) are not exercised. Needs MESH_CHROMIUM (skipped without it).
import assert from 'node:assert/strict';
import {after, afterEach, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {recordInputFrames, frames, forget, PHONE, DESKTOP} from './phone-direct-line-lib.ts';
import {TerminalMesh, rows, skip, typeLine, waitForRow} from './terminal-browser-lib.ts';

type Mutant = {from: string; to: string}[];

const MAC = (): void => {
  window.__input = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (data instanceof Uint8Array) window.__input.push(new TextDecoder().decode(data));
    return send.call(this, data);
  };
  Object.defineProperty(navigator, 'platform', {get: () => 'MacIntel'});
};

// The two guards of app.js, by the text that implements them (a case fails loudly if it moves).
const TERMINAL_CLASSIFICATION: Mutant = [{from: 'return "terminal"; // shortcut focus: terminal', to: 'return "page";'}];
const TERMINAL_INTERCEPTION: Mutant = [
  {from: 'e.stopPropagation(); // shortcut: the program never sees it', to: ''},
  {from: '/* shortcut veto */ MeshShortcuts.resolve(MeshShortcuts.SHORTCUTS, e, "terminal", shortcutPlatform)', to: 'false'},
];

describe('session search shortcuts', {skip}, () => {
  const mesh = new TerminalMesh();
  const pages: Page[] = [];
  let counter = 0;
  before(() => mesh.start());
  after(() => mesh.stop());
  afterEach(async () => { for (const page of pages.splice(0)) await page.context().close(); });

  async function open(options: {phone?: boolean; mac?: boolean; mutant?: Mutant} = {}): Promise<Page> {
    const name = `search-${counter += 1}`;
    await mesh.newShell(name);
    const {phone = false, mac = false, mutant} = options;
    const routes = async (page: Page): Promise<void> => {
      if (!mutant) return;
      await page.route('**/static/app.js**', async route => {
        const response = await route.fetch();
        let body = await response.text();
        for (const {from, to} of mutant) {
          assert.ok(body.includes(from), `the mutant's target moved: ${from}`);
          body = body.replace(from, to);
        }
        await route.fulfill({response, body});
      });
    };
    const page = await mesh.openPage(name, phone ? PHONE : DESKTOP, mac ? MAC : recordInputFrames, undefined, {phone, routes});
    pages.push(page);
    await page.waitForFunction(() => typeof MeshShortcuts === 'object');
    await forget(page);
    return page;
  }

  const filterFocused = (page: Page): Promise<boolean> =>
    page.evaluate(() => document.activeElement === document.querySelector('#filter'));
  const inTerminal = (page: Page): Promise<boolean> =>
    page.evaluate(() => document.activeElement?.closest('.xterm') != null);
  const focusTerminal = async (page: Page): Promise<void> => {
    await page.evaluate(() => active.term.focus());
    assert.equal(await inTerminal(page), true, 'the terminal has the focus');
  };
  const focusNothing = (page: Page): Promise<void> =>
    page.evaluate(() => (document.activeElement as HTMLElement).blur());
  const waitFilterFocused = (page: Page, timeout = 5000): Promise<unknown> =>
    page.waitForFunction(() => document.activeElement === document.querySelector('#filter'), undefined, {timeout});
  /** The terminal runs `cat -v`: a Ctrl+K it receives comes back as ^K. */
  const runCat = async (page: Page): Promise<void> => {
    await typeLine(page, 'cat -v');
    await page.waitForTimeout(400);
    await focusTerminal(page);
    await forget(page);
  };
  const catSawCtrlK = (page: Page, timeout: number): Promise<unknown> => page.waitForFunction(() => {
    const buffer = active.term.buffer.active;
    for (let y = 0; y < buffer.length; y++) if (buffer.getLine(y)!.translateToString(true).includes('^K')) return true;
    return false;
  }, undefined, {timeout});

  /** Ctrl+K in a terminal: the program gets 0x0b and the search keeps its hands off. */
  async function ctrlKInTerminalReachesTheShell(page: Page): Promise<void> {
    await runCat(page);
    await page.keyboard.press('Control+K');
    await catSawCtrlK(page, 5000);
    assert.ok((await frames(page)).join('').includes('\x0b'), 'the page sent 0x0b');
    assert.equal(await filterFocused(page), false);
    assert.equal(await inTerminal(page), true);
  }

  /** Ctrl+Shift+K in a terminal: the search opens, the terminal never sees the key, the program receives nothing.
   * (xterm.js encodes no byte for Ctrl+Shift+K itself; that the key does not reach it is the guarantee.) */
  async function ctrlShiftKFromTerminalOpensSearch(page: Page): Promise<void> {
    await runCat(page);
    await page.evaluate(() => {
      window.__seenByTerminal = [];
      active.term.textarea!.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'k') window.__seenByTerminal.push(e.key); });
    });
    await page.keyboard.press('Control+Shift+K');
    await waitFilterFocused(page, 5000);
    await page.evaluate(() => active.send('zz\r'));
    await waitForRow(page, 'zz');
    assert.deepEqual(await page.evaluate(() => window.__seenByTerminal), [], 'the terminal did not see the key');
    assert.equal((await frames(page)).join('').includes('\x0b'), false, 'no 0x0b left the page');
    assert.deepEqual((await rows(page)).filter(row => row.includes('^K')), [], 'the shell saw no ^K');
  }

  describe('desktop', () => {
    test('Ctrl+K outside a terminal focuses the search and selects its text', async () => {
      const page = await open();
      await page.locator('#filter').fill('previous query');
      await focusNothing(page);
      await page.evaluate(() => { window.__defaultPrevented = []; document.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'k') window.__defaultPrevented.push(e.defaultPrevented); }, true); });
      await page.keyboard.press('Control+K');
      await waitFilterFocused(page);
      const selection = await page.evaluate(() => {
        const box = document.querySelector<HTMLInputElement>('#filter')!;
        return [box.selectionStart, box.selectionEnd];
      });
      assert.deepEqual(selection, [0, 'previous query'.length]);
      // the shortcut stops the event at the document: no later listener sees it, and it was prevented
      assert.deepEqual(await page.evaluate(() => window.__defaultPrevented), [true], 'the browser\'s own Ctrl+K is overridden');
    });

    test('Ctrl+K from a button works too', async () => {
      const page = await open();
      await page.locator('#btn-new').focus();
      await page.keyboard.press('Control+K');
      await waitFilterFocused(page);
    });

    test('Escape gives the focus back to the terminal it came from', async () => {
      const page = await open();
      await focusTerminal(page);
      await page.keyboard.press('Control+Shift+K');
      await waitFilterFocused(page);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.closest('.xterm') != null, undefined, {timeout: 5000});
      assert.equal(await filterFocused(page), false);
    });

    test('Escape with nothing focused before returns to the active session', async () => {
      const page = await open();
      await focusNothing(page);
      await page.keyboard.press('Control+K');
      await waitFilterFocused(page);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.closest('.xterm') != null, undefined, {timeout: 5000});
    });

    test('Ctrl+K in a terminal reaches the shell as 0x0b and the search stays closed', async () => {
      await ctrlKInTerminalReachesTheShell(await open());
    });

    test('Ctrl+Shift+K in a terminal opens the search and the shell receives nothing', async () => {
      await ctrlShiftKFromTerminalOpensSearch(await open());
    });

    test('Ctrl+Shift+K outside a terminal also works', async () => {
      const page = await open();
      await focusNothing(page);
      await page.keyboard.press('Control+Shift+K');
      await waitFilterFocused(page);
    });

    test('Ctrl+K in a text field or an editable element is left alone', async () => {
      const page = await open();
      await page.evaluate(() => { document.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'k') window.__defaultPrevented.push(e.defaultPrevented); }, true); });
      for (const markup of ['<input id="probe">', '<textarea id="probe"></textarea>', '<div id="probe" contenteditable="true" tabindex="0"></div>']) {
        await page.evaluate(html => { document.querySelector('#probe')?.remove(); document.body.insertAdjacentHTML('beforeend', html); document.querySelector<HTMLElement>('#probe')!.focus(); }, markup);
        await page.evaluate(() => { window.__defaultPrevented = []; });
        await page.keyboard.press('Control+K');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'probe', markup);
        assert.deepEqual(await page.evaluate(() => window.__defaultPrevented), [false], `${markup}: the key was not taken`);
      }
    });

    test('Ctrl+Shift+K in a text field opens the search', async () => {
      const page = await open();
      await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<input id="probe">'); document.querySelector<HTMLElement>('#probe')!.focus(); });
      await page.keyboard.press('Control+Shift+K');
      await waitFilterFocused(page);
    });

    test('neither shortcut acts while a dialog is open', async () => {
      const page = await open();
      await page.evaluate(() => document.querySelector<HTMLDialogElement>('#dlg-web')!.showModal());
      for (const combination of ['Control+K', 'Control+Shift+K']) {
        await page.keyboard.press(combination);
        await page.waitForTimeout(300);
        assert.equal(await filterFocused(page), false, combination);
      }
    });

    test('Alt, a missing Shift or the wrong modifier do not trigger it', async () => {
      const page = await open();
      await focusNothing(page);
      for (const combination of ['Control+Alt+K', 'Meta+K', 'Control+J', 'K']) {
        await page.keyboard.press(combination);
        await page.waitForTimeout(150);
        assert.equal(await filterFocused(page), false, combination);
      }
    });

    test('with the explorer open the shortcut focuses the explorer search', async () => {
      const page = await open();
      await page.evaluate(() => setExplorer(true));
      await focusNothing(page);
      await page.keyboard.press('Control+K');
      await page.waitForFunction(() => document.activeElement === document.querySelector('#ex-q'), undefined, {timeout: 5000});
    });

    test('the sidebar search names the shortcuts', async () => {
      const page = await open();
      const title = await page.locator('#filter').getAttribute('title');
      assert.match(title ?? '', /Ctrl\+K/);
      assert.match(title ?? '', /Ctrl\+(Shift|Maj)\+K/);
    });
  });

  describe('macOS keys', () => {
    test('Cmd+K opens the search, Ctrl+K stays the terminal\'s', async () => {
      const page = await open({mac: true});
      await focusNothing(page);
      await page.keyboard.press('Control+K');
      await page.waitForTimeout(200);
      assert.equal(await filterFocused(page), false, 'Ctrl+K is not the shortcut on macOS');
      await page.keyboard.press('Meta+K');
      await waitFilterFocused(page);
      await ctrlKInTerminalReachesTheShell(await open({mac: true}));
    });

    test('Cmd+Shift+K from a terminal is captured, and its program receives nothing', async () => {
      const page = await open({mac: true});
      await runCat(page);
      await page.keyboard.press('Meta+Shift+K');
      await waitFilterFocused(page);
      assert.equal((await frames(page)).join('').includes('\x0b'), false);
    });
  });

  describe('phone layout', () => {
    test('Ctrl+K with the focus on the page opens the sidebar and focuses the search; Escape closes it', async () => {
      const page = await open({phone: true});
      await focusNothing(page);
      assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), false);
      await page.keyboard.press('Control+K');
      await waitFilterFocused(page);
      assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('drawer'), undefined, {timeout: 5000});
      assert.equal(await filterFocused(page), false);
    });

    test('Ctrl+K in the phone input line is left alone', async () => {
      const page = await open({phone: true});
      await page.locator('#line-text').focus();
      await page.keyboard.press('Control+K');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'line-text');
      assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), false);
    });

    test('Ctrl+Shift+K in the phone input line opens the search', async () => {
      const page = await open({phone: true});
      await page.locator('#line-text').focus();
      await page.keyboard.press('Control+Shift+K');
      await waitFilterFocused(page);
      assert.equal(await page.evaluate(() => document.body.classList.contains('drawer')), true);
    });

    test('the help is listed from the table and fits 390 px', async () => {
      const page = await open({phone: true});
      await focusNothing(page);
      await page.keyboard.press('?');
      await page.locator('#dlg-shortcuts[open]').waitFor({timeout: 5000});
      const listed = await page.locator('#shortcuts-list [data-shortcut]').evaluateAll(items => items.map(item => item.getAttribute('data-shortcut')));
      const expected = await page.evaluate(() => MeshShortcuts.SHORTCUTS.map((binding: {id: string}) => binding.id));
      assert.deepEqual(listed, expected);
      const overflow = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('#dlg-shortcuts')!;
        return {dialog: dialog.scrollWidth - dialog.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth};
      });
      assert.deepEqual(overflow, {dialog: 0, page: 0});
      const text = await page.locator('#shortcuts-list').innerText();
      assert.match(text, /Ctrl\+Shift\+K/);
    });
  });

  describe('the guards are what the terminal cases measure', () => {
    test('a page that no longer tells a terminal from the page breaks Ctrl+K in the terminal', async () => {
      const page = await open({mutant: TERMINAL_CLASSIFICATION});
      await assert.rejects(ctrlKInTerminalReachesTheShell(page), /Timeout/);
    });

    test('a page that no longer intercepts in the terminal lets Ctrl+Shift+K reach the program', async () => {
      const page = await open({mutant: TERMINAL_INTERCEPTION});
      await assert.rejects(ctrlShiftKFromTerminalOpensSearch(page), /the terminal did not see the key/);
    });
  });
});

declare global {
  // eslint-disable-next-line no-var
  var __defaultPrevented: boolean[];
  // eslint-disable-next-line no-var
  var __seenByTerminal: string[];
  // eslint-disable-next-line no-var
  var MeshShortcuts: {SHORTCUTS: {id: string}[]};
}
