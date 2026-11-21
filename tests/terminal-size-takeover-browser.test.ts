// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Two browsers on one session, in the automatic size mode (the default, static/size-takeover.ts):
// the device the person uses takes the PTY size when they act on it, with no banner. A device
// that only stays open and visible, or whose window is resized, takes nothing, so two devices do
// not fight; activations in quick succession settle on the last one, and a device takes at most
// once per gap. The Configuration dialog switches this browser to the manual mode (the banner and
// its button, tests/terminal-shared-size-browser.test.ts) at once, and the choice is kept.
import assert from 'node:assert/strict';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {showSection} from './helpers/config-sections.ts';
import {findTheme} from '../static/themes.ts';
import {type PaneView, recordControlMessages, REPO, rows, skip, TerminalMesh, typeLine, waitForRow} from './terminal-browser-lib.ts';

declare const active: PaneView & {el: HTMLElement; focus(): void; fit: {proposeDimensions(): {cols: number; rows: number}}};
declare const configPanel: {open(): boolean};
const TUI = path.join(REPO, 'tests', 'fixtures', 'footer-tui.mjs');
const PHONE = {width: 390, height: 844};
const DESKTOP = {width: 1440, height: 900};
const GAP_MS = 2000;   // TAKEOVER_GAP_MS

const size = (page: Page): Promise<string> => page.evaluate(() => `${active.term.cols}x${active.term.rows}`);
const ownSize = (page: Page): Promise<string> => page.evaluate(() => {
  const fit = active.fit.proposeDimensions();
  return `${fit.cols}x${fit.rows}`;
});
const banner = (page: Page): Promise<boolean> => page.evaluate(() => {
  const element = active.el.querySelector<HTMLElement>('.size-banner');
  return !!element && !element.hidden && element.getClientRects().length > 0;
});
const takes = (page: Page): Promise<number> =>
  page.evaluate(() => window.__sent.filter(m => m.t === 'r' && (m as {size?: string}).size === 'take').length);
const footers = async (page: Page): Promise<number> =>
  (await rows(page)).filter(row => row.includes('auto mode on')).length;

/** A person acting on the device: a click on a desktop, a tap on a phone, inside the terminal. */
async function act(page: Page, phone: boolean): Promise<void> {
  const term = page.locator('.pane-body .term').first();
  if (phone) await term.tap({position: {x: 40, y: 200}});
  else await term.click({position: {x: 40, y: 200}});
}

/** The page focuses its terminal by itself, as when an agent opens a panel beside it: from a
 * timer, once the user activation of the test's own calls has expired (5 s in Chromium). Waits
 * for it; true when the focus reached the terminal or the phone input line. */
async function selfFocus(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    (window as unknown as {selfFocused: boolean}).selfFocused = false;
    setTimeout(() => {
      active.focus();
      const at = document.activeElement;
      (window as unknown as {selfFocused: boolean}).selfFocused = !!at && (active.el.contains(at) || at.id === 'line-text');
    }, 6000);
  });
  await page.waitForTimeout(7000);
  return page.evaluate(() => (window as unknown as {selfFocused: boolean}).selfFocused);
}

/** The page shows the PTY at its own size: it owns the size, the other one follows it. */
async function owns(owner: Page, follower: Page): Promise<void> {
  const own = await ownSize(owner);
  await owner.waitForFunction(want => `${active.term.cols}x${active.term.rows}` === want, own, {timeout: 10000});
  await follower.waitForFunction(want => `${active.term.cols}x${active.term.rows}` === want, own, {timeout: 10000});
}

describe('automatic size take-over between two browsers', {skip}, () => {
  const mesh = new TerminalMesh();
  before(() => mesh.start());
  after(() => mesh.stop());

  test('the device in use takes the size, without a banner, and two open devices do not fight', async () => {
    await mesh.newShell('auto');
    const desk = await mesh.openPage('auto', DESKTOP, recordControlMessages);
    const phone = await mesh.openPage('auto', PHONE, recordControlMessages, undefined, {phone: true});
    await desk.waitForTimeout(GAP_MS);
    await act(desk, false);
    await owns(desk, phone);
    assert.notEqual(await ownSize(desk), await ownSize(phone), 'the two devices fit different sizes');

    // Both open and visible, nobody acting: nothing moves, and the follower shows no banner, even
    // when the page focuses its terminal by itself.
    const before = [await takes(desk), await takes(phone)];
    assert.equal(await selfFocus(phone), true, 'the phone page focused its input line by itself');
    assert.deepEqual([await takes(desk), await takes(phone)], before, 'no take-over without an activation');
    assert.equal(await size(phone), await ownSize(desk), 'the phone still follows the desktop');
    assert.equal(await banner(phone), false, 'no banner in the automatic mode');
    assert.equal(await banner(desk), false);

    // A window resized is not a person using that device.
    await phone.setViewportSize({width: 390, height: 700});
    await phone.waitForTimeout(1500);
    assert.equal(await takes(phone), before[1], 'a resize takes nothing');
    await phone.setViewportSize(PHONE);
    await phone.waitForTimeout(500);
    assert.equal(await size(desk), await ownSize(desk), 'the desktop keeps the size');

    // The person picks the phone up: one take-over, the desktop follows, no banner on either.
    await act(phone, true);
    await owns(phone, desk);
    assert.equal(await takes(phone), before[1] + 1, 'exactly one take-over for one tap');
    assert.equal(await banner(desk), false, 'the desktop follows without a banner');
    assert.equal(await banner(phone), false);
    const deskTakes = await takes(desk);
    assert.equal(await selfFocus(desk), true, 'the desktop page focused its terminal by itself');
    assert.equal(await takes(desk), deskTakes, 'a focus the page made by itself takes nothing');
    await phone.context().close();
    await desk.context().close();
  });

  test('two activations in quick succession settle on the last one; at most one take-over per gap', async () => {
    await mesh.newShell('quick');
    const desk = await mesh.openPage('quick', DESKTOP, recordControlMessages);
    const phone = await mesh.openPage('quick', PHONE, recordControlMessages, undefined, {phone: true});
    await desk.waitForTimeout(GAP_MS);
    await act(desk, false);
    await act(phone, true);
    await owns(phone, desk);
    const settled = [await takes(desk), await takes(phone)];
    await desk.waitForTimeout(2 * GAP_MS);
    assert.deepEqual([await takes(desk), await takes(phone)], settled, 'nothing moves once settled');
    await owns(phone, desk);

    // Desktop, phone, desktop again within the desktop's gap: its second activation takes nothing.
    await act(desk, false);
    await act(phone, true);
    await desk.waitForTimeout(300);
    await act(desk, false);
    await owns(phone, desk);
    await desk.waitForTimeout(800);
    assert.equal(await takes(desk), settled[0] + 1, 'one take-over per gap on the desktop');
    assert.equal(await takes(phone), settled[1] + 1);
    await owns(phone, desk);
    // After the gap, an activation takes again.
    await desk.waitForTimeout(GAP_MS);
    await act(desk, false);
    await owns(desk, phone);
    assert.equal(await takes(desk), settled[0] + 2);
    await phone.context().close();
    await desk.context().close();
  });

  test('switching devices while a footer program runs: one footer on each', async () => {
    await mesh.newShell('switch');
    const desk = await mesh.openPage('switch', DESKTOP, recordControlMessages);
    const phone = await mesh.openPage('switch', PHONE, recordControlMessages, undefined, {phone: true});
    await typeLine(phone, `clear; node ${TUI} W 100`);
    for (let i = 0; i < 2; i += 1) {
      await desk.waitForTimeout(GAP_MS + 300);
      await act(desk, false);
      await owns(desk, phone);
      await phone.waitForTimeout(GAP_MS + 300);
      await act(phone, true);
      await owns(phone, desk);
    }
    await waitForRow(phone, 'DONE-W', 30000);
    await phone.waitForTimeout(800);
    assert.equal(await footers(phone), 1, (await rows(phone)).join('\n'));
    assert.equal(await footers(desk), 1, (await rows(desk)).join('\n'));
    assert.equal(await banner(phone), false);
    assert.equal(await banner(desk), false);
    await phone.context().close();
    await desk.context().close();
  });

  for (const [label, viewport, phone] of [['a desktop', DESKTOP, false], ['a phone', PHONE, true]] as const) {
    test(`the Configuration control switches ${label} to the manual mode at once, and keeps it`, async () => {
      const name = phone ? 'pref-phone' : 'pref-desk';
      await mesh.newShell(name);
      const owner = await mesh.openPage(name, phone ? DESKTOP : PHONE, recordControlMessages, undefined, {phone: !phone});
      const page = await mesh.openPage(name, viewport, recordControlMessages, undefined, {phone});
      await owner.waitForTimeout(GAP_MS);
      await act(owner, !phone);
      await owns(owner, page);
      assert.equal(await banner(page), false, 'automatic by default: no banner');

      await openTerminalSettings(page);
      const choice = (mode: string) => page.locator(`#dlg-config input[name="size-takeover"][value="${mode}"]`);
      assert.equal(await choice('auto').isChecked(), true);
      await choice('manual').check();
      await assertNoOverflow(page);
      await page.locator('#dlg-config [data-close-dialog]').first().click();
      assert.equal(await banner(page), true, 'manual: the banner at once');
      assert.equal(await page.evaluate(() => localStorage.getItem('mesh.sizeTakeover')), '"manual"');

      await act(page, phone);
      await page.waitForTimeout(800);
      assert.equal(await takes(page), 0, 'manual: an activation takes nothing');
      await page.locator('.size-banner button').click();
      await owns(page, owner);
      assert.equal(await takes(page), 1, 'the button takes the size');

      await page.reload();
      await page.waitForFunction(() => document.querySelector('#list .item[data-id]') !== null, undefined, {timeout: 30000});
      await openTerminalSettings(page);
      assert.equal(await choice('manual').isChecked(), true, 'the choice is kept by this browser');
      await choice('auto').check();
      assert.equal(await page.evaluate(() => localStorage.getItem('mesh.sizeTakeover')), '"auto"');
      await page.context().close();
      await owner.context().close();
    });
  }
});

async function openTerminalSettings(page: Page): Promise<void> {
  await page.evaluate(() => { configPanel.open(); });
  await page.locator('#dlg-config .config-shell').waitFor({timeout: 15000});
  await showSection(page, 'terminal');
  await page.locator('#dlg-config .config-size-takeover').waitFor();
}

async function assertNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const wide = (element: Element | null) => !!element && element.scrollWidth > element.clientWidth + 1;
    const card = document.querySelector('#dlg-config .config-size-takeover');
    return {page: wide(document.documentElement), dialog: wide(document.querySelector('#dlg-config')), card: wide(card),
      cardRight: card ? card.getBoundingClientRect().right <= window.innerWidth + 1 : false};
  });
  assert.deepEqual(overflow, {page: false, dialog: false, card: false, cardRight: true});
}

const themeColours = (id: 'light'): Record<string, string> => ({...findTheme(id)!.colours});

type RingStyle = {outline: string; width: number; offset: number; ring: string; background: string; boxShadow: string};

/** The focus indicator of the radio button `mode`, and the colour it is drawn on (the first
 * ancestor with a background). `palette` replaces the theme's colours first, as a theme does. */
function ringOf(page: Page, mode: string, palette: Record<string, string> = {}): Promise<RingStyle> {
  return page.evaluate(([value, colours]) => {
    for (const [name, colour] of Object.entries(colours)) document.documentElement.style.setProperty(name, colour);
    const input = document.querySelector<HTMLInputElement>(`#dlg-config input[name="size-takeover"][value="${value}"]`)!;
    const style = getComputedStyle(input);
    let behind: Element | null = input;
    while (behind && /rgba\(.*, 0\)|transparent/.test(getComputedStyle(behind).backgroundColor)) behind = behind.parentElement;
    return {outline: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
      ring: style.outlineColor, background: behind ? getComputedStyle(behind).backgroundColor : 'rgb(0, 0, 0)',
      boxShadow: style.boxShadow};
  }, [mode, palette] as const);
}

const channels = (colour: string): number[] => (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
function luminance(colour: string): number {
  const [r, g, b] = channels(colour).map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};
const visibleRing = (style: RingStyle): boolean => style.outline !== 'none' && style.width >= 2;

describe('keyboard focus ring of the Configuration size radios', {skip}, () => {
  const mesh = new TerminalMesh();
  before(() => mesh.start());
  after(() => mesh.stop());

  test('Tab shows a ring on the radio, in the dark and light themes; a mouse click shows none', async () => {
    await mesh.newShell('ring');
    const page = await mesh.openPage('ring', DESKTOP, recordControlMessages);
    await openTerminalSettings(page);
    const radio = page.locator('#dlg-config input[name="size-takeover"][value="auto"]');
    assert.equal(await page.evaluate(() => document.querySelector('#dlg-config input[name="size-takeover"][value="auto"]')!.matches(':focus-visible')), false);

    await radio.click();   // the pointer: the browser shows no ring for a mouse press on a radio
    assert.equal(visibleRing(await ringOf(page, 'auto')), false, 'a mouse click shows no ring');

    await page.locator('#dlg-config .config-nav-button[data-section-id="terminal"]').focus();
    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press('Tab');
      if (await radio.evaluate(element => element === document.activeElement)) break;
    }
    assert.equal(await radio.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true, 'Tab reached the radio');
    for (const [label, theme] of [['dark', {}], ['light', themeColours('light')]] as const) {
      const style = await ringOf(page, 'auto', theme);
      assert.equal(visibleRing(style), true, `${label}: a visible outline on keyboard focus (${JSON.stringify(style)})`);
      assert.ok(contrast(style.ring, style.background) >= 3, `${label}: ring ${style.ring} on ${style.background} reaches 3:1`);
    }
    await page.context().close();
  });
});
