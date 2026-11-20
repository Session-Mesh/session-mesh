// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const source = readFileSync('static/app.js', 'utf8');
function body(name: string): string {
  const marker = `function ${name}(`;
  assert.ok(source.includes(marker), `the ${name} lifecycle entry exists`);
  return source.slice(source.indexOf(marker)).split('\n}')[0]!;
}

test('page disposal and suspension retire both Projects presentations', () => {
  for (const name of ['disposeLocalPage', 'suspendLocalPage']) {
    const entry = body(name);
    assert.match(entry, /projectsGeneration\+\+; workGeneration\+\+;/);
    assert.match(entry, /projectsController\?\.close\(\); workController\?\.close\(\);/);
  }
});

test('page-cache resume selects the current Projects presentation', () => {
  assert.match(body('resumeLocalPage'), /if \(projecting\) openProjectsPresentation\(\);/);
});
