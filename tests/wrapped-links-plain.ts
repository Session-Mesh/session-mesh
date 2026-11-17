// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Wrapped-link scenarios that do not depend on the terminal input mode, plus the scenarios that
// pick the mode themselves (they loop over it).
import assert from 'node:assert/strict';
import {clickCell, clickCells, COLS, first, linksOnRow, opened, writeLink, type Scenario} from './wrapped-links-lib.ts';
import type {Page} from 'playwright-core';

async function urlKinds(page: Page, row: number) {
  return (await linksOnRow(page, row)).filter((link) => (link as {kind: string}).kind === 'url');
}

export async function singleUrlScenarios(scenario: Scenario) {
  await scenario('ordinary URL', async (page) => {
    await writeLink(page, 'https://a.test/x');
    await clickCell(page, 0, 5);
    await opened(page, ['https://a.test/x']);
  });
  for (const mouse of [false, true]) {
    const mode = mouse ? 'mouse-tracking' : 'normal';
    await scenario(`a click opens an external URL with noopener,noreferrer (${mode})`, async (page) => {
      await writeLink(page, 'see https://a.test/x?q=1 now', mouse);
      await clickCell(page, 0, 10);
      await opened(page, ['https://a.test/x?q=1']);
      assert.deepEqual(await page.evaluate(() => globalThis.__openedFeatures), [['_blank', 'noopener,noreferrer']]);
    });
    await scenario(`a non-http scheme in the terminal never reaches window.open (${mode})`, async (page) => {
      const lines = ['javascript:alert(document.domain)', 'file:///etc/shadow', 'data:text/html;base64,PGI+eDwvYj4=',
        'ftp://a.test/x', 'vbscript:msgbox(1)'];
      await writeLink(page, lines.join('\r\n'), mouse);
      for (let row = 0; row < lines.length; row++) {
        assert.deepEqual(await urlKinds(page, row), []);
        for (const col of [0, 4, 9, 14]) await clickCell(page, row, col);
      }
      await opened(page, []);
      assert.deepEqual(await page.evaluate(() => globalThis.__openedFeatures), []);
    });
  }
  await scenario('a URL with a wide character keeps its text and cells', async (page) => {
    await writeLink(page, 'https://a.test/界x and more');
    await clickCells(page, [[0, 5], [0, 17]]);
    await opened(page, ['https://a.test/界x', 'https://a.test/界x']);
  });
}

export async function adjacentTargetScenarios(scenario: Scenario) {
  await scenario('adjacent URLs stay separate', async (page) => {
    const second = 'https://other.test/next';
    await writeLink(page, first + '\r\n  ' + second);
    await clickCells(page, [[0, 5], [1, 5]]);
    await opened(page, [first, second]);
  });
  await scenario('adjacent documents stay separate', async (page) => {
    const a = '/tmp/' + 'a'.repeat(COLS - '/tmp/'.length - '/report.md'.length) + '/report.md', b = '/tmp/next.md:7';
    await writeLink(page, a + '\r\n  ' + b);
    await clickCells(page, [[0, 5], [1, 5]]);
    await opened(page, [a, b]);
  });
  for (const second of ['/tmp/report.md', 'src/app.js']) {
    await scenario(`adjacent URL and ${second} stay separate`, async (page) => {
      await writeLink(page, first + '\r\n  ' + second);
      await clickCells(page, [[0, 5], [1, 5]]);
      await opened(page, [first, second]);
    });
  }
  await scenario('prose after full-width URL does not hide first row', async (page) => {
    await writeLink(page, first + '\r\n  which file should be used?');
    assert.deepEqual(await linksOnRow(page, 1), []);
    await clickCells(page, [[0, 5], [1, 5]]);
    await opened(page, [first]);
  });
  // A relative document after a URL is its own target (a directory is checked on click, so it is only in the unit test).
  for (const [above, below] of [['https://a.test/x/', './x.md'], ['https://a.test/x/', 'x.md']]) {
    await scenario(`${below} after ${above} is its own target`, async (page) => {
      await writeLink(page, 'x'.repeat(COLS - above.length - 1) + ' ' + above + '\r\n  ' + below);
      await clickCell(page, 1, 5);
      await opened(page, [below]);
    });
  }
}

export async function proseEndsLinkScenarios(scenario: Scenario) {
  await scenario('suffix before prose ends first URL', async (page) => {
    const suffix = 'child/path?item=2';
    await writeLink(page, first + '\r\n  ' + suffix + ' is the destination');
    await clickCells(page, [[0, 5], [1, 5], [1, 25]]);
    await opened(page, [first + suffix, first + suffix]);
  });
  await scenario('document suffix before prose ends first path', async (page) => {
    const a = '/tmp/' + 'a'.repeat(43), suffix = 'report.md:42';
    await writeLink(page, a + '\r\n  ' + suffix + ' was saved');
    await clickCells(page, [[0, 5], [1, 5]]);
    await opened(page, [a + suffix, a + suffix]);
  });
  await scenario('unindented next line is not a hard wrap', async (page) => {
    await writeLink(page, first + '\r\nchild/path');
    await clickCell(page, 0, 5);
    await opened(page, [first]);
  });
}

export async function wideCellScenarios(scenario: Scenario) {
  await scenario('wide cell before URL maps both rows', async (page) => {
    const a = 'https://example.test/' + 'a'.repeat(45 - 'https://example.test/'.length), tail = 'child/path.md?item=2';
    await writeLink(page, '界 ' + a + '\r\n  ' + tail);
    await clickCells(page, [[0, 8], [1, 5]]);
    await opened(page, [a + tail, a + tail]);
  });
  await scenario('nine wide cells reach near edge in terminal columns', async (page) => {
    const a = 'https://example.test/' + 'a'.repeat(29 - 'https://example.test/'.length), tail = 'child/path?item=2';
    assert.equal(9 * 2 + 1 + a.length, COLS);
    await writeLink(page, '界'.repeat(9) + ' ' + a + '\r\n  ' + tail);
    await clickCells(page, [[0, 24], [1, 5]]);
    await opened(page, [a + tail, a + tail]);
  });
}

export async function overLimitRefusalScenarios(scenario: Scenario) {
  await scenario('over-limit soft URL never opens a prefix', async (page) => {
    await writeLink(page, first + 'b'.repeat(COLS * 6) + 'tail');
    for (let row = 0; row < 7; row++) {
      assert.deepEqual(await linksOnRow(page, row), []);
      await clickCell(page, row, 5);
    }
    await opened(page, []);
  });
  await scenario('over-limit hard URL never opens a prefix', async (page) => {
    await writeLink(page, [first, ...Array(5).fill('b'.repeat(46)), 'last/path?item=1'].join('\r\n  '));
    for (let row = 0; row < 7; row++) {
      assert.deepEqual(await linksOnRow(page, row), []);
      await clickCell(page, row, 5);
    }
    await opened(page, []);
  });
}

export async function softUrlAndOsc8Scenarios(scenario: Scenario) {
  await scenario('six-row soft URL opens from each row', async (page) => {
    const target = first + 'b'.repeat(COLS * 4) + 'tail';
    await writeLink(page, target);
    for (let row = 0; row < 6; row++) await clickCell(page, row, row === 5 ? 1 : 5);
    await opened(page, Array(6).fill(target));
  });
  await scenario('OSC 8 target wins over two-row label', async (page) => {
    const target = 'https://example.test/the-real-osc8-target';
    await writeLink(page, '\x1b]8;;' + target + '\x1b\\' + 'https://label.test/' + 'x'.repeat(55) + '\x1b]8;;\x1b\\');
    await clickCells(page, [[0, 5], [1, 5]]);
    await opened(page, [target, target]);
  });
}

export const allPlainScenarios = [
  singleUrlScenarios, adjacentTargetScenarios, proseEndsLinkScenarios, wideCellScenarios,
  overLimitRefusalScenarios, softUrlAndOsc8Scenarios,
];
