// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The SHA-256 lines of static/vendor/THIRD_PARTY.md (indented `sha256sum -c` lines) must match the
// vendored files, and every Monaco file must have one: a replaced or added vendored file then
// fails here until its provenance is checked and its line updated.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

const VENDOR = path.resolve(import.meta.dirname, '..', 'static', 'vendor');
const manifest = fs.readFileSync(path.join(VENDOR, 'THIRD_PARTY.md'), 'utf8');
const recorded = new Map<string, string>();
for (const match of manifest.matchAll(/^ {4}([0-9a-f]{64}) {2}(\S+)$/gm)) {
  assert.ok(!recorded.has(match[2]), `${match[2]} has two SHA-256 lines`);
  recorded.set(match[2], match[1]);
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR, file))).digest('hex');

describe('vendored file checksums', () => {
  test('xterm, marked, highlight.js and Monaco are recorded', () => {
    for (const file of ['xterm.min.js', 'xterm.css', 'addon-fit.min.js', 'marked.min.js',
      'highlight.min.js', 'hljs-github.min.css', 'hljs-github-dark.min.css', 'monaco/vs/editor/editor.main.js']) {
      assert.ok(recorded.has(file), `no SHA-256 line for ${file}`);
    }
  });

  test('every recorded SHA-256 matches its file', () => {
    for (const [file, digest] of recorded) {
      assert.ok(fs.existsSync(path.join(VENDOR, file)), `${file} is recorded but absent`);
      assert.equal(sha256(file), digest, `${file}: SHA-256 differs from THIRD_PARTY.md`);
    }
  });

  test('every Monaco file has a SHA-256 line', () => {
    const files = (fs.readdirSync(path.join(VENDOR, 'monaco'), {recursive: true}) as string[])
      .map((name) => `monaco/${name.split(path.sep).join('/')}`)
      .filter((file) => fs.statSync(path.join(VENDOR, file)).isFile());
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(recorded.has(file), `${file} has no SHA-256 line`);
  });
});
