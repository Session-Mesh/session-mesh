// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Wrapped-link scenarios that run in both terminal input modes (normal and mouse tracking).
// Each function registers the scenarios of one topic through the scenario runner in `ctx`.
import assert from 'node:assert/strict';
import {clickCell, clickCells, COLS, first, hasUrlOnRow, isWrapped, linksOnRow, opened, writeLink, type Mode} from './wrapped-links-lib.ts';

const edgePrefix = 'z'.repeat(COLS);

// The rows of each URL layout (a URL that is cut at the right margin and goes on, indented).
function urlLayout(kind: string): string[] {
  const queryHead = 'https://example.test/?q=';
  switch (kind) {
    case 'soft': return [first, 'b'.repeat(COLS), 'end?item=1&other=2'];
    case 'hard-two': return [first, 'child/path?item=1'];
    case 'hard-three': return [first, 'b'.repeat(46), 'last/path?item=1'];
    case 'hard-four': return [first, 'b'.repeat(46), 'c'.repeat(46), 'last/path?item=1'];
    case 'query-value': return [queryHead + 'a'.repeat(47 - queryHead.length) + '=', 'alphabetic&next=2'];
    case 'query-start': return [first.slice(0, -1) + '?', 'alphabetic/value'];
    case 'fragment': return [first.slice(0, -1) + '#', 'alphabetic/value'];
    default: return [queryHead + 'a'.repeat(47 - queryHead.length) + '&', 'other=2#section'];
  }
}

export async function wrappedUrlScenarios({scenario, mouse, mode}: Mode) {
  for (const kind of ['soft', 'hard-two', 'hard-three', 'hard-four', 'query', 'query-value', 'query-start', 'fragment']) {
    await scenario(`${kind} URL on each row (${mode})`, async (page) => {
      const parts = urlLayout(kind);
      await writeLink(page, kind === 'soft' ? parts.join('') : parts.join('\r\n  '), mouse);
      for (let row = 0; row < parts.length; row++) await clickCell(page, row, 5);
      await opened(page, Array(parts.length).fill(parts.join('')));
    });
  }
}

export async function wrappedDocumentScenarios({scenario, mouse, mode}: Mode) {
  for (const [count, parts] of [
    [3, ['/tmp/' + 'a'.repeat(43), 'b'.repeat(46), 'report.md:42']],
    [4, ['/tmp/' + 'a'.repeat(43), 'b'.repeat(46), 'c'.repeat(46), 'report.md:42:7']],
  ] as const) {
    await scenario(`${count}-row document (${mode})`, async (page) => {
      await writeLink(page, parts.join('\r\n  '), mouse);
      for (let row = 0; row < count; row++) await clickCell(page, row, 5);
      await opened(page, Array(count).fill(parts.join('')));
    });
  }
}

export async function ambiguousSuffixScenarios({scenario, mouse, mode}: Mode) {
  for (const suffix of ['abcdef', 'and more text here']) {
    await scenario(`standalone URL before ambiguous ${suffix} (${mode})`, async (page) => {
      await writeLink(page, first + '\r\n  ' + suffix, mouse);
      await clickCells(page, [[0, 5], [1, 5]]);
      await opened(page, [first]);
    });
  }
}

export async function proseTailScenarios({scenario, mouse, mode}: Mode) {
  for (const filename of ['src/app.js', 'app.js']) {
    await scenario(`prose tail cannot forge ${filename} (${mode})`, async (page) => {
      await writeLink(page, 'x'.repeat(COLS - 4) + ' the\r\n  ' + filename + ' was changed', mouse);
      await clickCells(page, [[0, 5], [1, 5]]);
      await opened(page, [filename]);
    });
  }
  await scenario(`near-edge URL before prose remains standalone (${mode})`, async (page) => {
    const target = 'https://ex.test/';
    await writeLink(page, 'x'.repeat(COLS - target.length - 1) + ' ' + target + '\r\n  and more text here', mouse);
    await clickCells(page, [[0, COLS - target.length + 2], [1, 5]]);
    await opened(page, [target]);
  });
}

// The URL's authority (host, user information, port) is never extended by the next row,
// whatever precedes the scheme and whatever case the scheme is written in.
export async function authorityScenarios({scenario, mouse, mode}: Mode) {
  for (const delimiter of ['', '(', '"', '[t](', 'url=', 'URL=']) {
    for (const scheme of ['https://', 'HTTPS://', 'Https://']) {
      for (const head of ['.attacker.test/login', '@attacker.test/login']) {
        await scenario(`authority behind ${JSON.stringify(delimiter)}${scheme} is never extended by ${head[0]} (${mode})`, async (page) => {
          const target = scheme + 'bank.example', token = delimiter + target;
          await writeLink(page, 'x'.repeat(COLS - token.length - 1) + ' ' + token + '\r\n  ' + head, mouse);
          await clickCells(page, [[0, COLS - target.length + 2], [1, 5]]);
          await opened(page, [target]);
          assert.equal(await hasUrlOnRow(page, 1), false);
        });
      }
    }
  }
}

// A URL that starts an independent row stays its own link, in any case, and a full URL or a
// bare host inside the next row is never glued to the URL above.
export async function independentRowScenarios({scenario, mouse, mode}: Mode) {
  for (const target of ['https://other.test/next', 'HTTPS://other.test/next', 'src/app.js']) {
    await scenario(`adjacent independent ${target} (${mode})`, async (page) => {
      await writeLink(page, first + '\r\n  ' + target, mouse);
      await clickCells(page, [[0, 5], [1, 5]]);
      await opened(page, [first, target]);
    });
  }
  for (const [above, below, own] of [
    ['https://evil.test/r/', 'HTTPS://bank.example/login', 'HTTPS://bank.example/login'],
    ['https://evil.test/a?b&', 'url=https://bank.example/login', 'https://bank.example/login'],
    ['https://evil.test/a?u', '=https://bank.example/login', 'https://bank.example/login'],
    ['https://evil.test/r/', 'bank.example/login', ''],
  ]) {
    await scenario(`${below} is not glued to ${above} (${mode})`, async (page) => {
      await writeLink(page, 'x'.repeat(COLS - above.length - 1) + ' ' + above + '\r\n  ' + below, mouse);
      await clickCell(page, 0, COLS - 3);
      await clickCell(page, 1, 9);
      await opened(page, own ? [above, own] : [above]);
    });
  }
}

export async function overLimitDocumentScenarios({scenario, mouse, mode}: Mode) {
  for (const count of [5, 6, 7]) {
    await scenario(`${count + 2}-row hard document has no relative suffix (${mode})`, async (page) => {
      const head = '/tmp/' + 'a'.repeat(43);
      await writeLink(page, [head, ...Array(count).fill('b'.repeat(46)), 'report.md:42'].join('\r\n  '), mouse);
      for (let row = 0; row < count + 2; row++) {
        assert.deepEqual(await linksOnRow(page, row), []);
        await clickCell(page, row, 5);
      }
      await opened(page, []);
    });
  }
}

export async function hardChainEndScenarios({scenario, mouse, mode}: Mode) {
  await scenario(`later document after six hard-shaped prose rows (${mode})`, async (page) => {
    await writeLink(page, [edgePrefix, ...Array(5).fill('  ' + 'z'.repeat(46)), '  prose src/app.js'].join('\r\n'), mouse);
    await clickCells(page, [[6, 5], [6, 11]]);
    await opened(page, ['src/app.js']);
  });
  await scenario(`independent document after over-limit hard suffix (${mode})`, async (page) => {
    const suffix = 'report.md:42', second = 'src/other.md:7';
    await writeLink(page, ['/tmp/' + 'a'.repeat(43), ...Array(5).fill('  ' + 'b'.repeat(46)), '  ' + suffix + ' ' + second].join('\r\n'), mouse);
    await clickCells(page, [[6, 5], [6, 2 + suffix.length + 1 + 5]]);
    await opened(page, [second]);
  });
  await scenario(`8-row hard URL has no prefix or suffix (${mode})`, async (page) => {
    await writeLink(page, [first, ...Array(6).fill('b'.repeat(46)), 'last/path?item=1'].join('\r\n  '), mouse);
    for (let row = 0; row < 8; row++) {
      assert.deepEqual(await linksOnRow(page, row), []);
      await clickCell(page, row, 5);
    }
    await opened(page, []);
  });
}

export async function hardSuffixScenarios({scenario, mouse, mode}: Mode) {
  for (const second of ['https://b.test/a', 'src/other.md:7']) {
    await scenario(`independent ${second} after hard suffix (${mode})`, async (page) => {
      const suffix = 'child/path?item=2';
      await writeLink(page, first + '\r\n  ' + suffix + ' ' + second, mouse);
      await clickCells(page, [[0, 5], [1, 5], [1, 2 + suffix.length + 1 + 5]]);
      await opened(page, [first + suffix, first + suffix, second]);
    });
  }
  await scenario(`prose soft-wrap after hard suffix (${mode})`, async (page) => {
    const suffix = 'child/path?item=2';
    await writeLink(page, first + '\r\n  ' + suffix + ' ' + 'x'.repeat(COLS - 2 - suffix.length - 1) + 'tail', mouse);
    assert.equal(await isWrapped(page, 2), true);
    await clickCells(page, [[0, 5], [1, 5], [1, 25], [2, 1]]);
    await opened(page, [first + suffix, first + suffix]);
  });
}

export async function softWrapAfterHardSuffixScenarios({scenario, mouse, mode}: Mode) {
  for (const kind of ['url', 'document']) {
    await scenario(`independent ${kind} soft-wraps after hard suffix (${mode})`, async (page) => {
      const suffix = 'child/path?item=2', prefix = '  ' + suffix + ' ';
      const start = kind === 'url' ? 'https://b.test/' : 'src/';
      const second = start + 'x'.repeat(COLS - prefix.length - start.length) + (kind === 'url' ? 'tail' : 'report.md:42');
      await writeLink(page, first + '\r\n' + prefix + second, mouse);
      assert.equal(await isWrapped(page, 2), true);
      await clickCells(page, [[0, 5], [1, 5], [1, prefix.length + 5], [2, 2]]);
      await opened(page, [first + suffix, first + suffix, second, second]);
    });
  }
  await scenario(`space between independent soft-wrapped URLs (${mode})`, async (page) => {
    const a = 'https://a.test/x', prefix = 'https://b.test/';
    const b = prefix + 'x'.repeat(COLS - a.length - 1 - prefix.length) + 'tail';
    await writeLink(page, a + ' ' + b, mouse);
    assert.equal(await isWrapped(page, 1), true);
    await clickCells(page, [[0, 5], [0, a.length + 1 + 5], [1, 2]]);
    await opened(page, [a, b, b]);
  });
}

export async function longSoftProseScenarios({scenario, mouse, mode}: Mode) {
  for (const target of ['https://a.test/x', 'src/app.js:42']) {
    for (const place of ['first', 'middle', 'last']) {
      await scenario(`${target} ${place} in long soft prose (${mode})`, async (page) => {
        const prefix = 'z'.repeat(COLS * 7);
        const output = place === 'first' ? target + ' ' + prefix
          : place === 'middle' ? 'z'.repeat(COLS * 3) + ' ' + target + ' ' + 'z'.repeat(COLS * 4)
            : prefix + ' ' + target;
        await writeLink(page, output, mouse);
        await clickCell(page, place === 'first' ? 0 : place === 'middle' ? 3 : 7, 5);
        await opened(page, [target]);
      });
    }
  }
}

export async function overLimitScenarios({scenario, mouse, mode}: Mode) {
  for (const kind of ['url', 'document']) {
    await scenario(`over-limit unbroken ${kind} refuses every fragment (${mode})`, async (page) => {
      const output = (kind === 'url' ? 'https://example.test/' : '/tmp/') + 'a'.repeat(COLS * 7) + (kind === 'url' ? 'tail' : 'report.md:42');
      await writeLink(page, output, mouse);
      for (let row = 0; row < 8; row++) {
        assert.deepEqual(await linksOnRow(page, row), []);
        await clickCell(page, row, 5);
      }
      await opened(page, []);
    });
  }
  for (const place of ['before', 'after']) {
    await scenario(`six-row URL ${place} long prose (${mode})`, async (page) => {
      const prefix = 'https://a.test/', target = prefix + 'x'.repeat(COLS * 6 - prefix.length);
      const output = place === 'before' ? target + ' ' + 'z'.repeat(COLS * 7) : 'z'.repeat(COLS * 6 - 1) + ' ' + target;
      await writeLink(page, output, mouse);
      for (const row of place === 'before' ? [0, 5] : [6, 11]) await clickCell(page, row, 5);
      await opened(page, [target, target]);
    });
  }
  await scenario(`short URL after over-limit URL (${mode})`, async (page) => {
    const long = 'https://example.test/' + 'a'.repeat(COLS * 7) + 'tail', second = 'https://b.test/child/path';
    await writeLink(page, long + ' ' + second, mouse);
    await clickCells(page, [[0, 5], [7, 35], [8, 2]]);
    await opened(page, [second, second]);
  });
}

export async function failedJoinScenarios({scenario, mouse, mode}: Mode) {
  for (const second of ['https://b.test/a', 'src/app.js']) {
    await scenario(`failed hard join keeps ${second} (${mode})`, async (page) => {
      const fragment = 'child/path';
      await writeLink(page, 'x'.repeat(47) + '/' + '\r\n  ' + fragment + ' ' + second, mouse);
      await clickCell(page, 1, 2 + fragment.length + 1 + 5);
      await opened(page, [second]);
    });
  }
}

export const allModeScenarios = [
  wrappedUrlScenarios, wrappedDocumentScenarios, ambiguousSuffixScenarios, proseTailScenarios, authorityScenarios,
  independentRowScenarios, overLimitDocumentScenarios, hardChainEndScenarios, hardSuffixScenarios,
  softWrapAfterHardSuffixScenarios, longSoftProseScenarios, overLimitScenarios, failedJoinScenarios,
];
