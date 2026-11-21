// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Two browsers of different widths on one session. The PTY has one size; the program
// (tests/fixtures/footer-tui.mjs, a main-screen renderer with a footer, as Claude Code's) draws
// for that width. Before the size owner rule, each pane sent its own size when focused: the
// narrower one received rows drawn for a wider PTY, wrapped them, and kept a copy of the
// footer in its scrollback at every redraw (31 on a phone beside a desktop). Now the first
// pane owns the size, the other shows the PTY at that size. In the manual mode (the browser
// preference sizeTakeover, set here) it shows a banner, and only the banner's button moves the
// size; the automatic mode, the default, is in tests/terminal-size-takeover-browser.test.ts.
import assert from 'node:assert/strict';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {type PaneView, recordControlMessages, recordControlMessagesManual, REPO, rows, skip, TerminalMesh, typeLine, waitForRow} from './terminal-browser-lib.ts';

declare const active: PaneView & {el: HTMLElement};
const TUI = path.join(REPO, 'tests', 'fixtures', 'footer-tui.mjs');
const PHONE = {width: 390, height: 844};
const DESKTOP = {width: 1440, height: 900};

const footers = async (page: Page): Promise<number> =>
  (await rows(page)).filter(row => row.includes('auto mode on')).length;
const size = (page: Page): Promise<string> => page.evaluate(() => `${active.term.cols}x${active.term.rows}`);
const banner = (page: Page): Promise<boolean> => page.evaluate(() => {
  const element = active.el.querySelector<HTMLElement>('.size-banner');
  return !!element && !element.hidden && element.getClientRects().length > 0;
});
const sentSizes = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__sent.filter(m => m.t === 'r').map(m => `${m.cols}x${m.rows}:${(m as {size?: string}).size ?? '-'}`));

/** Focus the page's terminal the way a person returning to it does. */
async function use(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(() => {
    active.term.focus();
    (document.activeElement as HTMLElement | null)?.blur();
    active.term.focus();
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function run(page: Page, tag: string): Promise<void> {
  await typeLine(page, `clear; node ${TUI} ${tag} 60`);
}

describe('two browsers of different widths on one session', {skip}, () => {
  const mesh = new TerminalMesh();
  before(() => mesh.start());
  after(() => mesh.stop());

  test('manual mode: the phone follows the desktop: one footer, a banner, and the size taken back on request', async () => {
    await mesh.newShell('shared');
    const desk = await mesh.openPage('shared', DESKTOP, recordControlMessagesManual);
    const deskSize = await size(desk);
    const phone = await mesh.openPage('shared', PHONE, recordControlMessagesManual, undefined, {phone: true});

    await run(phone, 'D');
    for (let i = 0; i < 4; i += 1) {
      await phone.waitForTimeout(400);
      await use(desk);
      await phone.waitForTimeout(400);
      await use(phone);
    }
    await waitForRow(phone, 'DONE-D', 30000);
    await phone.waitForTimeout(800);
    assert.equal(await footers(phone), 1, (await rows(phone)).join('\n'));
    assert.equal(await footers(desk), 1, (await rows(desk)).join('\n'));
    assert.equal(await size(phone), deskSize, 'the phone shows the PTY at the desktop size, focused or not');
    assert.equal(await banner(phone), true, 'the phone offers to take the size back');
    assert.equal(await banner(desk), false, 'the owner has no banner');
    assert.ok(!(await sentSizes(phone)).some(sent => sent.endsWith(':take')), 'no take-over without the button');

    await phone.locator('.size-banner button').click();
    await phone.waitForFunction(() => active.el.querySelector<HTMLElement>('.size-banner')?.hidden === true,
      undefined, {timeout: 10000});
    const phoneSize = await size(phone);
    assert.notEqual(phoneSize, deskSize, 'the phone fits its own size again');
    await desk.waitForFunction(own => `${active.term.cols}x${active.term.rows}` === own, phoneSize, {timeout: 10000});
    assert.equal(await banner(desk), true, 'the desktop now follows, with the banner');
    assert.ok((await sentSizes(phone)).some(sent => sent === `${phoneSize}:take`), (await sentSizes(phone)).join(' '));

    await phone.evaluate(() => active.send('\x03'));   // the witness keeps its footer until stopped
    await phone.waitForTimeout(300);
    await run(phone, 'E');
    for (let i = 0; i < 3; i += 1) {
      await phone.waitForTimeout(400);
      await use(desk);
      await phone.waitForTimeout(400);
      await use(phone);
    }
    await waitForRow(phone, 'DONE-E', 30000).catch(async error => {
      throw new Error(`${error}\n${(await rows(phone)).join('\n')}`);
    });
    await phone.waitForTimeout(800);
    assert.equal(await footers(phone), 1, (await rows(phone)).join('\n'));
    assert.equal(await footers(desk), 1, (await rows(desk)).join('\n'));

    await phone.context().close();
    await desk.waitForFunction(() => active.el.querySelector<HTMLElement>('.size-banner')?.hidden === true,
      undefined, {timeout: 10000});
    await desk.waitForFunction(own => `${active.term.cols}x${active.term.rows}` === own, deskSize, {timeout: 10000});
    await desk.context().close();
  });

  for (const [label, viewport, phone] of [['a phone', PHONE, true], ['a desktop', DESKTOP, false]] as const) {
    test(`${label} alone: its own size, no banner, as before`, async () => {
      const name = phone ? 'alone-phone' : 'alone-desk';
      await mesh.newShell(name);
      const page = await mesh.openPage(name, viewport, recordControlMessages, undefined, {phone});
      const own = await page.evaluate(() => {
        const fit = (active as unknown as {fit: {proposeDimensions(): {cols: number; rows: number}}}).fit.proposeDimensions();
        return `${fit.cols}x${fit.rows}`;
      });
      assert.equal(await size(page), own);
      assert.equal(await banner(page), false);
      await run(page, 'S');
      await waitForRow(page, 'DONE-S', 30000);
      await page.waitForTimeout(500);
      assert.equal(await footers(page), 1, (await rows(page)).join('\n'));
      assert.ok((await sentSizes(page)).every(sent => !sent.endsWith(':take')), 'only automatic sizes');
      await page.context().close();
    });
  }
});
