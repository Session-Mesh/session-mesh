// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The installed app (the manifest's display "standalone") runs the same page as a browser tab.
// Chromium cannot emulate display-mode standalone for a page (Emulation.setEmulatedMedia leaves
// `(display-mode: standalone)` false), so tests/phone-keybar-keyboard-browser.test.ts drives a
// browser tab. That covers the installed app only while the terminal page has no branch of its
// own for it. This test keeps that true: a branch on the display mode, on navigator.standalone or
// on the VirtualKeyboard API needs a browser test of its own before it lands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PAGE_FILES = ['static/app.js', 'static/index.html', 'static/sw.js'];
const STANDALONE_BRANCHES = [/display-mode/, /navigator\.standalone/, /virtualKeyboard/, /overlaysContent/];

test('the installed app is the same page: its manifest asks for standalone', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'static/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
});

test('the terminal page has no code path of its own for the installed app', () => {
  for (const file of PAGE_FILES) {
    const source = fs.readFileSync(path.join(REPO, file), 'utf8');
    for (const branch of STANDALONE_BRANCHES) assert.doesNotMatch(source, branch, `${file} branches on ${branch}`);
  }
});

test('the page keeps one viewport rule for the soft keyboard in both modes', () => {
  const html = fs.readFileSync(path.join(REPO, 'static/index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content/);
});
