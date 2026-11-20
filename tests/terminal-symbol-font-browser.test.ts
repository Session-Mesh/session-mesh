// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The terminal's fallback font for symbols: Claude Code's footer starts with "⏵⏵" (U+23F5),
// which no Android system font has, so a phone showed two boxes. The page bundles Noto Sans
// Symbols 2 (static/vendor/fonts/, THIRD_PARTY.md) as the family "Mesh Symbols", last in the
// terminal's font list, with a unicode-range: it is fetched from the page's own origin when
// the terminal shows such a symbol, and not for a terminal of plain text.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {type PaneView, skip, TerminalMesh} from './terminal-browser-lib.ts';

declare const active: PaneView & {term: {write(data: string, done?: () => void): void; options: {fontFamily: string}}};
const PHONE = {width: 390, height: 844};
const DESKTOP = {width: 1440, height: 900};
const FONT = '/static/vendor/fonts/NotoSansSymbols2-Regular.ttf';

const faceStatus = (page: Page): Promise<string[]> => page.evaluate(() =>
  [...document.fonts].filter(face => face.family.replace(/"/g, '') === 'Mesh Symbols').map(face => face.status));

describe('the terminal draws U+23F5 from the bundled symbol font', {skip}, () => {
  const mesh = new TerminalMesh();
  before(() => mesh.start());
  after(() => mesh.stop());

  for (const [label, viewport, phone] of [['a phone', PHONE, true], ['a desktop', DESKTOP, false]] as const) {
    test(`${label}: loaded for the symbol only, from the page's origin`, async () => {
      const name = phone ? 'glyph-phone' : 'glyph-desk';
      await mesh.newShell(name);
      const requests: string[] = [];
      const page = await mesh.openPage(name, viewport, undefined, watched => watched.on('request', request => {
        requests.push(request.url());
      }), {phone});
      assert.match(await page.evaluate(() => active.term.options.fontFamily), /"Mesh Symbols"$/,
        'the symbol font comes last, after the terminal fonts');
      await page.evaluate(() => new Promise<void>(done => active.term.write('plain ASCII text only\r\n', done)));
      await page.waitForTimeout(500);
      assert.deepEqual(await faceStatus(page), ['unloaded'], 'plain text does not fetch it');
      // Outside its unicode-range: text the fonts before it lack does not fetch it either.
      await page.evaluate(() => new Promise<void>(done => active.term.write('漢字 \u{1f600} ก\r\n', done)));
      await page.waitForTimeout(500);
      assert.deepEqual(await faceStatus(page), ['unloaded'], 'a code point outside the range does not fetch it');

      await page.evaluate(() => new Promise<void>(done => active.term.write('⏵⏵ auto mode on\r\n', done)));
      await page.waitForFunction(() => [...document.fonts].some(face =>
        face.family.replace(/"/g, '') === 'Mesh Symbols' && face.status === 'loaded'), undefined, {timeout: 10000});
      assert.ok(await page.evaluate(() => document.fonts.check('16px "Mesh Symbols"', '⏵')), 'the face covers U+23F5');
      const fetched = requests.filter(url => url.endsWith(FONT));
      assert.equal(fetched.length, 1, requests.join('\n'));
      assert.equal(new URL(fetched[0]).origin, mesh.base, 'served by the mesh itself, no CDN');
      // Drawn with the bundled face alone (no system fallback for this probe: a code point it
      // lacks draws nothing), U+23F5 has ink.
      const ink = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 40; canvas.height = 40;
        const context = canvas.getContext('2d')!;
        context.font = '32px "Mesh Symbols"';
        context.fillText('⏵', 4, 32);
        return context.getImageData(0, 0, 40, 40).data.filter((value, index) => index % 4 === 3 && value > 0).length;
      });
      assert.ok(ink > 20, `ink pixels: ${ink}`);
      await page.context().close();
    });
  }
});
