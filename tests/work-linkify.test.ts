// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The pure parts of the links of the Projects view: the strict reference finder that turns tracker text (written by
// agents, so untrusted) into web links and document references (static/work-linkify.ts), and the choice of viewer and
// sandbox for a document shown in the side panel (static/work-doc-panel.ts). The DOM and the panel run in
// tests/work-doc-links-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { documentPath, findReferences, webUrl } from '../static/work-linkify.ts';
import { viewerFor, viewUrlOf } from '../static/work-doc-panel.ts';

const found = (text: string) => findReferences(text).map(ref => [ref.kind, ref.value]);

describe('web links', () => {
  test('https and http links are found, with the surrounding text left alone', () => {
    assert.deepEqual(found('see https://example.test/a?b=1#c then http://example.test/x'),
      [['url', 'https://example.test/a?b=1#c'], ['url', 'http://example.test/x']]);
    const [ref] = findReferences('read https://example.test/a now');
    assert.equal(ref?.start, 5);
    assert.equal(ref?.end, 5 + 'https://example.test/a'.length);
  });

  test('trailing punctuation and closing brackets end a link', () => {
    assert.deepEqual(found('(see https://example.test/a).'), [['url', 'https://example.test/a']]);
    assert.deepEqual(found('https://example.test/a, https://example.test/b; https://example.test/c!'),
      [['url', 'https://example.test/a'], ['url', 'https://example.test/b'], ['url', 'https://example.test/c']]);
    assert.deepEqual(found('"https://example.test/q?"'), [['url', 'https://example.test/q']]);
    assert.deepEqual(found('<https://example.test/z>'), [['url', 'https://example.test/z']]);
    assert.deepEqual(found('[[[https://example.test/n]]]...'), [['url', 'https://example.test/n']]);
  });

  test('a Markdown link gives its target, never its label', () => {
    assert.deepEqual(found('[the spec](https://example.test/spec)'), [['url', 'https://example.test/spec']]);
    assert.deepEqual(found('[https://good.example](https://evil.example/x)'),
      [['url', 'https://good.example'], ['url', 'https://evil.example/x']]);
  });

  test('other schemes never become links', () => {
    for (const text of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd', 'vbscript:msgbox', 'ftp://example.test/x', 'blob:https://example.test/x', '//example.test/x',
      'javascript://example.test/%0aalert(1)', 'java\tscript:alert(1)', 'mailto:someone@example.test']) {
      assert.deepEqual(findReferences(text).filter(ref => ref.kind === 'url' && !ref.value.startsWith('https://example.test')), [],
        text);
    }
    assert.deepEqual(found('javascript:alert(1)'), []);
    assert.deepEqual(found('data:text/html;base64,PHNjcmlwdD4='), []);
    assert.deepEqual(found('file:///srv/notes/a.html'), []);
  });

  test('a scheme glued to a word, credentials, confusables and controls stay text', () => {
    assert.deepEqual(found('xhttps://example.test/a'), []);
    assert.deepEqual(found('https://bank.example@evil.example/login'), []);
    assert.deepEqual(found('https://user:pw@example.test/'), []);
    assert.deepEqual(found('https://exаmple.test/a'), [], 'a Cyrillic a in the host');
    assert.deepEqual(found('https://example.test/\u202Eexe.txt'), [], 'a bidi override');
    assert.deepEqual(found('https://example.test/\u200Ba'), [], 'a zero-width space');
    assert.deepEqual(found('https://ｅxample.test/'), [], 'a fullwidth letter');
    assert.deepEqual(found('https://'), []);
    assert.deepEqual(found('https:///path'), []);
  });

  test('webUrl re-checks a value on its own', () => {
    assert.equal(webUrl('https://example.test/a'), 'https://example.test/a');
    assert.equal(webUrl('javascript:alert(1)'), null);
    assert.equal(webUrl(' https://example.test/a'), null);
    assert.equal(webUrl('https://example.test/a b'), null);
  });
});

describe('document references', () => {
  test('absolute and home paths to the document types are found', () => {
    assert.deepEqual(found('voir ~/notes/2026-11-19-projects-v0-mockup/relecture-pr120.md pour le détail'),
      [['doc', '~/notes/2026-11-19-projects-v0-mockup/relecture-pr120.md']]);
    assert.deepEqual(found('/tmp/r/report.html ~/n/a.HTM ~/n/b.svg ~/n/c.pdf ~/n/d.png ~/n/e.jpeg ~/n/f.webp ~/n/g.gif ~/n/h.txt ~/n/i.diff ~/n/j.patch ~/n/k.markdown'),
      [['doc', '/tmp/r/report.html'], ['doc', '~/n/a.HTM'], ['doc', '~/n/b.svg'], ['doc', '~/n/c.pdf'], ['doc', '~/n/d.png'],
        ['doc', '~/n/e.jpeg'], ['doc', '~/n/f.webp'], ['doc', '~/n/g.gif'], ['doc', '~/n/h.txt'], ['doc', '~/n/i.diff'],
        ['doc', '~/n/j.patch'], ['doc', '~/n/k.markdown']]);
    const [ref] = findReferences('see ~/notes/x/plan.html.');
    assert.equal(ref?.name, 'plan.html');
    assert.equal(ref?.value, '~/notes/x/plan.html');
  });

  test('wrapped in quotes, brackets, backticks or a Markdown link', () => {
    assert.deepEqual(found('("~/notes/a.html"), `~/notes/b.md`, [plan](~/notes/c.svg)'),
      [['doc', '~/notes/a.html'], ['doc', '~/notes/b.md'], ['doc', '~/notes/c.svg']]);
  });

  test('relative, hidden, traversing or doubled paths stay text', () => {
    for (const text of ['notes/a.html', './a.html', '../a.html', '~/notes/../.ssh/id.md', '~/.ssh/key.txt', '/tmp/a/./b.md',
      '/tmp//a.md', '~//a.md', '~/notes/.hidden/a.md', '~user/a.md', '/a.html/', '~/notes/a.exe', '~/notes/a.html.bak',
      '~/notes/a.mdx', '~/notes/a', 'C:\\notes\\a.html', '\\\\server\\share\\a.html', '~/notes/a\u202Emd.html']) {
      assert.deepEqual(found(text), [], text);
    }
  });

  test('a scheme in front of a path is not a document', () => {
    assert.deepEqual(found('file:///tmp/a.html'), []);
    assert.deepEqual(found('javascript:/tmp/a.html'), []);
    assert.deepEqual(found('x/tmp/a.html'), []);
  });

  test('a path with non-ASCII or control characters stays text', () => {
    assert.deepEqual(found('~/notes/réunion.md'), []);
    assert.deepEqual(found('~/notes/ａ.md'), []);
    assert.deepEqual(found('~/notes/a\u0000b.md'), []);
  });

  test('documentPath re-checks a value on its own', () => {
    assert.equal(documentPath('~/notes/a.html'), '~/notes/a.html');
    assert.equal(documentPath('~/notes/../a.html'), null);
    assert.equal(documentPath('https://example.test/a.html'), null);
    assert.equal(documentPath('~/notes/a.html '), null);
  });
});

describe('bounds and mixtures', () => {
  test('very long input is scanned in linear time and over-long references stay text', () => {
    const long = 'https://example.test/' + 'a'.repeat(5000);
    assert.deepEqual(found(long), []);
    const path = '~/' + 'd/'.repeat(3000) + 'x.md';
    assert.deepEqual(found(path), []);
    const noise = ('(([[x/~/.:' + 'https:/'.repeat(20)).repeat(5000);
    const started = Date.now();
    findReferences(noise);
    findReferences('~/'.repeat(100_000) + 'a.md');
    findReferences('/'.repeat(200_000));
    assert.ok(Date.now() - started < 2000, 'hostile noise takes too long');
  });

  test('references are ordered and never overlap', () => {
    const text = 'a https://example.test/x.html b ~/n/y.md c /tmp/z.pdf';
    const refs = findReferences(text);
    assert.deepEqual(refs.map(ref => ref.kind), ['url', 'doc', 'doc']);
    for (const ref of refs) assert.equal(text.slice(ref.start, ref.end), ref.value);
    for (let i = 1; i < refs.length; i++) assert.ok(refs[i]!.start >= refs[i - 1]!.end);
  });

  test('HTML in the text is never a reference', () => {
    assert.deepEqual(found('<a href="javascript:alert(1)">x</a>'), []);
    assert.deepEqual(found('<img src=x onerror=alert(1)>'), []);
    assert.deepEqual(found('<a href="https://example.test/x">y</a>'), [['url', 'https://example.test/x']]);
  });
});

describe('the viewer of a document', () => {
  test('HTML and SVG: a frame with an empty sandbox (no scripts, opaque origin), served as a static page', () => {
    for (const ext of ['.html', '.htm', '.svg']) assert.deepEqual(viewerFor(ext, false), { kind: 'frame', sandbox: '', static: true });
  });

  test('rendered Markdown, diffs and text: the server renderer runs alone, by nonce', () => {
    for (const ext of ['.md', '.markdown', '.diff', '.patch', '.txt']) {
      assert.deepEqual(viewerFor(ext, false), { kind: 'frame', sandbox: 'allow-scripts', static: false });
    }
  });

  test('images are images; a PDF is framed without a sandbox only when the server says it is inert', () => {
    assert.deepEqual(viewerFor('.png', true), { kind: 'image' });
    assert.equal(viewerFor('.png', false), null);
    assert.deepEqual(viewerFor('.pdf', true), { kind: 'frame', sandbox: null, static: false });
    assert.equal(viewerFor('.pdf', false), null);
    assert.equal(viewerFor('.exe', false), null);
    assert.equal(viewerFor('.html', true), null, 'an HTML page is never framed without a sandbox');
  });

  test('only a signed view URL of this origin is used', () => {
    const origin = 'http://127.0.0.1:7777';
    assert.equal(viewUrlOf('/view/v2.d.9999999999.0123456789abcdef0123456789abcdef/tmp/a.html', origin),
      `${origin}/view/v2.d.9999999999.0123456789abcdef0123456789abcdef/tmp/a.html`);
    assert.equal(viewUrlOf('https://evil.example/view/v2.f.1.x/tmp/a.html', origin), null);
    assert.equal(viewUrlOf('/api/config', origin), null);
    assert.equal(viewUrlOf('/view/v2.f.1.x/a.html?x=1', origin), null);
    assert.equal(viewUrlOf('//evil.example/view/v2.f.1.x/a.html', origin), null);
    assert.equal(viewUrlOf('javascript:alert(1)', origin), null);
    assert.equal(viewUrlOf(42, origin), null);
  });
});
