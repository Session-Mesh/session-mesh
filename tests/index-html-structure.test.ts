// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// static/index.html is the one page of the app: an id must be unique in it (a duplicated
// #management-rows once shipped, visible and outside its section) and its container elements
// must be balanced (an orphan </section> once closed #main early).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'static', 'index.html'), 'utf8');
// Comments and the bodies of script and style elements are not markup.
const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '<$1></$1>');
const CONTAINERS = new Set(['div', 'section', 'main', 'header', 'footer', 'dialog', 'form', 'aside', 'nav', 'ul', 'ol',
  'table', 'thead', 'tbody', 'tr', 'fieldset', 'details', 'select']);

describe('static/index.html', () => {
  test('every id is unique', () => {
    const seen = new Map<string, number>();
    for (const match of markup.matchAll(/<[a-z][^>]*?\sid="([^"]+)"/gi)) seen.set(match[1]!, (seen.get(match[1]!) ?? 0) + 1);
    assert.ok(seen.size > 50, 'the page has ids');
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([id]) => id), []);
  });

  test('container elements are balanced', () => {
    const stack: string[] = [];
    for (const match of markup.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi)) {
      const [, closing, rawName, selfClosing] = match;
      const name = rawName!.toLowerCase();
      if (!CONTAINERS.has(name) || selfClosing) continue;
      if (!closing) { stack.push(name); continue; }
      const line = markup.slice(0, match.index).split('\n').length;
      assert.equal(stack.pop(), name, `unbalanced </${name}> near line ${line} of the comment-free markup`);
    }
    assert.deepEqual(stack, []);
  });

  test('#management-rows exists once, inside #management', () => {
    assert.equal(markup.match(/id="management-rows"/g)?.length, 1);
    const management = markup.slice(markup.indexOf('id="management"'));
    assert.ok(management.indexOf('id="management-rows"') > 0);
  });
});
