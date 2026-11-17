// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The terminal link matcher on a synthetic buffer, without a browser: authority safety at hard
// row joins, single-row URLs as the removed WebLinksAddon matched them, the cost of one lookup,
// and the layout rules that keep a join from fabricating a path. The real xterm cells and the
// click behaviour are in tests/wrapped-links.test.ts.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {linksOnRow, type TerminalBuffer, type TerminalLink} from '../static/terminal-links.ts';

const COLS = 48;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/u;

// A buffer of text rows. A wide character takes two cells, the second one of width 0 with no
// characters, as in xterm; an empty cell has no characters and width 1.
function makeBuffer(rows: string[], cols = COLS, wrapped: number[] = [],
                    calls = {getLine: 0, wrappedReads: 0}): TerminalBuffer {
  const cellRows = rows.map((text) => {
    const cells: {width: number; chars: string}[] = [];
    for (const ch of text) {
      cells.push({width: WIDE.test(ch) ? 2 : 1, chars: ch});
      if (WIDE.test(ch)) cells.push({width: 0, chars: ''});
    }
    while (cells.length < cols) cells.push({width: 1, chars: ''});
    return cells;
  });
  return {
    getLine(y) {
      calls.getLine++;
      const cells = cellRows[y];
      if (!cells) return undefined;
      return {
        length: cols,
        get isWrapped() { calls.wrappedReads++; return wrapped.includes(y); },
        getCell: (x) => {
          const cell = cells[x];
          return cell && {getWidth: () => cell.width, getChars: () => cell.chars};
        },
      };
    },
  };
}

const hard = (...parts: string[]) => parts.map((part, i) => (i ? '  ' : '') + part);
const at = (rows: string[], y: number, cols = COLS): TerminalLink[] => linksOnRow(makeBuffer(rows, cols), y, cols);
const texts = (rows: string[], y: number, cols = COLS) => at(rows, y, cols).map((link) => link.text);
const padTo = (token: string) => 'x'.repeat(COLS - token.length - 1) + ' ' + token;
const full = (prefix: string, fill = 'a') => prefix + fill.repeat(COLS - prefix.length);

describe('an authority is never extended by a hard row join', () => {
  const delimiters = ['', '(', '"', "'", '[t](', 'url=', '<', 'see:', '`', 'URL=', '[T]('];
  const schemes = ['https://', 'HTTPS://', 'Https://', 'hTTp://'];
  const continuations = ['.attacker.test/login', '@attacker.test/login', ':8080/login', '-evil.test/x', 'evil.test/x'];
  for (const delimiter of delimiters) {
    for (const scheme of schemes) {
      for (const head of continuations) {
        test(`${JSON.stringify(delimiter)}${scheme}bank.example + ${head}`, () => {
          const rows = hard(padTo(delimiter + scheme + 'bank.example'), head);
          for (let y = 0; y < 2; y++) {
            for (const link of at(rows, y)) assert.equal(link.text.includes('attacker') || link.text.includes('evil'), false, link.text);
          }
          assert.deepEqual(texts(rows, 0).filter((text) => /^https?:/i.test(text)), [scheme + 'bank.example']);
          assert.deepEqual(at(rows, 1).filter((link) => link.kind === 'url'), []);
        });
      }
    }
  }

  test('user information and a port are authority too', () => {
    const rows = hard(padTo('(https://user:pw@bank.example:8443'), '.attacker.test/login');
    assert.deepEqual(texts(rows, 0).filter((text) => text.startsWith('http')), ['https://user:pw@bank.example:8443']);
    assert.deepEqual(at(rows, 1).filter((link) => link.kind === 'url'), []);
  });

  test('a join after the authority, past its slash, still works behind a delimiter', () => {
    const token = '(https://bank.example/';
    const rows = hard(padTo(token), 'login/x?y=1');
    assert.deepEqual(texts(rows, 1), ['https://bank.example/login/x?y=1']);
  });

  test('a scheme cut in two by the join does not make a URL', () => {
    const rows = hard(padTo('x/https:'), '//bank.example/login');
    for (let y = 0; y < 2; y++) assert.deepEqual(at(rows, y).filter((link) => link.kind === 'url'), [], `row ${y}`);
  });
  test('a URL whose query holds another URL joins once past the inner slash', () => {
    const token = 'https://a.test/x?u=https://b.test/';
    const rows = hard(padTo(token), 'next/z?w=1');
    assert.deepEqual(texts(rows, 1), [token + 'next/z?w=1']);
  });
  test('the authority of an inner URL is not extended either', () => {
    const rows = hard(padTo('https://a.test/x?u=https://b.test'), '.attacker.test/z');
    assert.deepEqual(texts(rows, 1).filter((text) => text.startsWith('http')), []);
  });
});

describe('a URL at the start of an independent row stays its own link', () => {
  const previous = padTo('https://evil.test/r/');
  for (const scheme of ['https://', 'HTTPS://', 'Https://']) {
    test(`${scheme} after a URL that ends in a slash`, () => {
      const rows = hard(previous, scheme + 'bank.example/login');
      assert.deepEqual(texts(rows, 1), [scheme + 'bank.example/login']);
      assert.deepEqual(texts(rows, 0).filter((text) => /^https?:/i.test(text)), ['https://evil.test/r/']);
    });
  }
});

describe('a full URL inside the next row is never glued to the URL above', () => {
  const cases: [string, string, string][] = [
    ['https://evil.test/a?b&', 'url=https://bank.example/login', 'https://bank.example/login'],
    ['https://evil.test/a?u=', 'https://bank.example/login', 'https://bank.example/login'],
    ['https://evil.test/a?u', '=https://bank.example/login', 'https://bank.example/login'],
    ['https://evil.test/#', 'x=https://bank.example/login', 'https://bank.example/login'],
    ['https://evil.test/r/', 'URL=HTTPS://bank.example/login', 'HTTPS://bank.example/login'],
    ['https://evil.test/r/', 'bank.example/login', ''],
    ['https://evil.test/r?to=', 'bank.example:8443/login', ''],
    ['https://evil.test/a/', 'www.bank.example/login', ''],
  ];
  for (const [above, below, own] of cases) {
    test(`${above} + ${below}`, () => {
      const rows = hard(padTo(above), below);
      assert.deepEqual(texts(rows, 1).filter((text) => /^https?:/i.test(text)), own ? [own] : []);
      assert.deepEqual(texts(rows, 0).filter((text) => /^https?:/i.test(text)), [above]);
    });
  }
  test('a dotted directory name inside a long path still joins', () => {
    const rows = hard(padTo('https://a.test/x/'), 'v1.2/page?y=1');
    assert.deepEqual(texts(rows, 1), ['https://a.test/x/v1.2/page?y=1']);
  });
  const independentAfterUrl: [string, string][] = [
    ['https://a.test/x/', './x.md'], ['https://a.test/x/', 'x.md'], ['https://a.test/x', 'x.md'],
    ['https://a.test/x#', 'x.md'], ['https://a.test/x/', './dir/'], ['https://a.test/x?q=', './dir/'],
  ];
  for (const [above, below] of independentAfterUrl) {
    test(`${below} after ${above} is its own target, not part of the URL`, () => {
      assert.deepEqual(texts(hard(padTo(above), below), 1), [below]);
    });
  }
  test('an uppercase URL after a full-width alphabetic row is not a suffix proof', () => {
    for (const scheme of ['https://', 'HTTPS://']) {
      const rows = hard(full('https://example.test/'), 'b'.repeat(COLS - 2), scheme + 'bank.example/login');
      assert.deepEqual(texts(rows, 1), [], scheme);
      assert.deepEqual(texts(rows, 2), [scheme + 'bank.example/login'], scheme);
    }
  });
});

describe('single-row URLs match as the WebLinksAddon did', () => {
  const cases: [string, string][] = [
    ['curl https://a.test/x|grep y', 'https://a.test/x'],
    ['https://a.test/x{y}', 'https://a.test/x'],
    ['https://a.test/a*b', 'https://a.test/a*'],
    ['https://a.test/a\\b', 'https://a.test/a'],
    ['https://a.test/a^b', 'https://a.test/a'],
    ['(https://a.test/x)', 'https://a.test/x'],
    ['https://a.test/x!', 'https://a.test/x'],
    ['https://a.test/x!!', 'https://a.test/x'],
    ['https://a.test/x~', 'https://a.test/x'],
    ['https://a.test/a~b', 'https://a.test/a~b'],
    ['https://a.test/x.', 'https://a.test/x'],
    ['https://a.test/x?q=1&r=2#f', 'https://a.test/x?q=1&r=2#f'],
    ['https://a.test/a,b;c', 'https://a.test/a,b;c'],
    ['see https://a.test/x: done', 'https://a.test/x'],
    ['HTTPS://A.TEST/X', 'HTTPS://A.TEST/X'],
    ['Https://a.test/X and more', 'Https://a.test/X'],
  ];
  for (const [line, expected] of cases) {
    test(line, () => assert.deepEqual(texts([line], 0).filter((text) => /^https?:/i.test(text)), [expected]));
  }
});

describe('only http and https are links', () => {
  for (const text of ['javascript:alert(1)', 'javascript://x.test/%0aalert(1)', 'file:///etc/shadow',
    'data:text/html;base64,PGI+eDwvYj4=', 'ftp://a.test/x', 'ws://a.test/x', 'vbscript:x', 'mailto:a@b.test',
    'ttps://a.test/x']) {
    test(text, () => assert.deepEqual(at([text], 0).filter((link) => link.kind === 'url'), []));
  }
  test('a scheme glued to a prefix word is not offered under a different scheme', () => {
    assert.deepEqual(texts(['abchttps://a.test/x'], 0).filter((value) => /^[a-z]*:/i.test(value)), ['https://a.test/x']);
  });
});

describe('the lookup stays cheap on a hard chain', () => {
  const chain = (cols: number) => {
    const first = full('https://a.test/', 'a').slice(0, cols).padEnd(cols, 'a');
    const middle = '  ' + 'b'.repeat(cols - 2);
    return [first, middle, middle, middle, middle, '  last/path?x=1'];
  };
  // Every evaluation of whether row y joins row y+1 reads that row's isWrapped flag, so the
  // reads count the evaluations. With the answers remembered a six-row chain needs 15 (about
  // three per row); without them the same lookup needs 31 to 62 and doubles with every row.
  test('join evaluations per lookup are bounded, not exponential in the row limit', () => {
    for (const cols of [48, 300]) {
      const rows = chain(cols);
      for (let y = 0; y < rows.length; y++) {
        const calls = {getLine: 0, wrappedReads: 0};
        linksOnRow(makeBuffer(rows, cols, [], calls), y, cols);
        assert.ok(calls.wrappedReads <= 24, `row ${y} at ${cols} columns: ${calls.wrappedReads} join evaluations`);
      }
    }
  });
  test('a lookup does not rescan buffer rows it has read', () => {
    const rows = chain(300), calls = {getLine: 0, wrappedReads: 0};
    linksOnRow(makeBuffer(rows, 300, [], calls), 3, 300);
    assert.ok(calls.getLine <= 16, `${calls.getLine} getLine calls`);
  });
  test('the result is the same however a row is reached', () => {
    const rows = hard(full('https://a.test/'), 'b'.repeat(46), 'last/path?item=1');
    const target = rows.map((row) => row.trim()).join('');
    for (let y = 0; y < 3; y++) assert.deepEqual(texts(rows, y), [target]);
  });
});

describe('layout rules that refuse a fabricated join', () => {
  const edge = full('https://example.test/');

  test('a row that stops short of the right edge is not joined', () => {
    for (const length of [30, 40]) {
      const url = 'https://example.test/' + 'a'.repeat(length - 21);
      assert.deepEqual(texts(hard(url, 'child/path'), 0), [url]);
      assert.deepEqual(texts(hard(url, 'child/path'), 1).filter((text) => text.startsWith('http')), []);
    }
  });
  test('a row ending within eight cells of the edge is joined', () => {
    const url = 'https://example.test/' + 'a'.repeat(41 - 21);
    assert.equal(url.length, 41);
    assert.deepEqual(texts(hard(url, 'child/path'), 1), [url + 'child/path']);
  });

  test('a prose word does not start a directory with the next row', () => {
    const rows = hard('x'.repeat(COLS - 4) + ' the', 'docs/');
    assert.deepEqual(texts(rows, 1), ['docs/']);
  });
  test('a path without a slash before the cut does not absorb a directory', () => {
    const rows = hard('x'.repeat(COLS), 'docs/');
    assert.deepEqual(texts(rows, 1), ['docs/']);
  });

  test('a directory is never extended across a hard join', () => {
    const rows = hard('/tmp/' + 'a'.repeat(COLS - 5), 'bbb/');
    assert.deepEqual(at(rows, 1).filter((link) => link.kind === 'dir'), []);
    assert.deepEqual(at(rows, 0).filter((link) => link.kind === 'dir'), []);
  });

  test('a URL ends at an unconfirmed cut: no prefix link', () => {
    for (const head of ['?', '~', '.']) {
      assert.deepEqual(texts(hard(edge, head), 0).filter((text) => text.startsWith('http')), [], head);
    }
  });

  test('a host-like next word without query or path proof is not appended to a URL', () => {
    const rows = hard(edge, 'child.test');
    assert.deepEqual(texts(rows, 0).filter((text) => text.startsWith('http')), []);
    assert.deepEqual(texts(rows, 1).filter((text) => text.startsWith('http')), []);
  });

  test('two complete documents are not fused into one path', () => {
    const first = '/tmp/' + 'a'.repeat(COLS - '/tmp/'.length - '/report.md'.length) + '/report.md';
    const rows = hard(first, 'other.md');
    assert.deepEqual(texts(rows, 0), [first]);
    assert.deepEqual(texts(rows, 1), ['other.md']);
  });

  test('a full-width alphabetic row with no later suffix is prose, not a URL continuation', () => {
    const rows = hard(edge, 'b'.repeat(COLS - 2), 'and more');
    assert.deepEqual(texts(rows, 0), [edge]);
    assert.deepEqual(texts(rows, 1), []);
  });
  test('a full-width alphabetic row followed by a path suffix is part of the URL', () => {
    const rows = hard(edge, 'b'.repeat(COLS - 2), 'last/path?item=1');
    const target = rows.map((row) => row.trim()).join('');
    assert.deepEqual(texts(rows, 1), [target]);
  });
  test('an unbroken alphabetic chain that never reaches a suffix is not a URL', () => {
    const rows = hard(edge, ...Array(6).fill('b'.repeat(COLS - 2)));
    for (let y = 0; y < rows.length; y++) assert.deepEqual(texts(rows, y), [], `row ${y}`);
  });

  test('wide characters: the second cell adds no phantom character', () => {
    const rows = ['https://a.test/界x and more'];
    assert.deepEqual(texts(rows, 0), ['https://a.test/界x']);
    const first = at(rows, 0)[0];
    assert.deepEqual(first?.end, [0, 15 + 2]);
  });
});
