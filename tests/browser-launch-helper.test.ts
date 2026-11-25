// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// tests/helpers/browser-launch.ts: the browsers of the Node tests run in English whatever the locale
// of the machine (the interface language follows the browser's), and the readiness budget is one
// shared constant, not a number repeated in each test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {BROWSER_LOCALE, READY_TIMEOUT_MS, browserEnv, chromiumLaunchOptions} from './helpers/browser-launch.ts';

const TESTS = import.meta.dirname;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
    return /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test('the browser environment overrides the locale of the caller', () => {
  const env = browserEnv({LC_ALL: 'fr_FR.UTF-8', LANG: 'fr_FR.UTF-8', LANGUAGE: 'fr', LC_MESSAGES: 'fr_FR.UTF-8', HOME: '/h', GONE: undefined});
  assert.equal(env.LC_ALL, 'C.UTF-8');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.LANGUAGE, 'en_US:en');
  assert.equal(env.HOME, '/h');
  assert.equal('GONE' in env, false);
});

test('the launch options pin the interface language and keep the caller arguments', () => {
  const options = chromiumLaunchOptions('/chrome', ['--no-sandbox']);
  assert.equal(options.executablePath, '/chrome');
  assert.deepEqual(options.args, ['--no-sandbox', `--lang=${BROWSER_LOCALE}`]);
  assert.equal(BROWSER_LOCALE, 'en-US');
});

test('the readiness budget is at least 30 seconds', () => {
  assert.ok(READY_TIMEOUT_MS >= 30_000);
});

test('explicit headless and sandbox settings survive the shared launch helper', () => {
  const options = chromiumLaunchOptions('/chrome', ['--use-fake-device-for-media-stream'],
    {headless: true, chromiumSandbox: true});
  assert.equal(options.headless, true);
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(options.args, ['--use-fake-device-for-media-stream', `--lang=${BROWSER_LOCALE}`]);
});

test('every test that launches Chromium goes through chromiumLaunchOptions', () => {
  const offenders = [...sources(TESTS), ...sources(path.resolve(TESTS, '..', 'checks'))]
    .filter(file => !file.endsWith('browser-launch-helper.test.ts'))
    .filter(file => /chromium\.launch\(/.test(fs.readFileSync(file, 'utf8')))
    .filter(file => /chromium\.launch\((?!chromiumLaunchOptions\()/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(TESTS, file));
  assert.deepEqual(offenders, []);
});

test('the initial readiness wait of the mailbox panel uses the shared budget', () => {
  const source = fs.readFileSync(path.join(TESTS, 'mailbox-panel-browser.test.ts'), 'utf8');
  assert.match(source, /!restoringWorkspace, undefined, \{timeout: READY_TIMEOUT_MS\}/);
  assert.doesNotMatch(source, /timeout: 15000/);
});
