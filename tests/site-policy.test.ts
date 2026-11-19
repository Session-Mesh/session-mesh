// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Content-Security-Policy of the showcase site's home page (site/index.html): it closes
// base-uri and form-action, which default-src does not cover, and the page and its scripts use
// neither a <base> nor a <form> element (site/tools/check-page.mjs, check 6, runs the same rules).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, test} from 'node:test';

const SITE = path.resolve(import.meta.dirname, '..', 'site');
const PAGE = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

function policy(): string[] {
  const tag = PAGE.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/i);
  assert.ok(tag, 'site/index.html has no Content-Security-Policy meta tag');
  return tag[1].split(';').map((part) => part.trim());
}

describe('the policy of site/index.html', () => {
  test("closes base-uri and form-action with 'none'", () => {
    assert.ok(policy().includes("base-uri 'none'"), 'base-uri is not none');
    assert.ok(policy().includes("form-action 'none'"), 'form-action is not none');
  });

  test('keeps the directives it already had', () => {
    for (const directive of ["default-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'"]) {
      assert.ok(policy().includes(directive), `${directive} is missing`);
    }
  });

  test('the page and its scripts use no <base> or <form>', () => {
    assert.doesNotMatch(PAGE, /<(?:base|form)[\s>/]/i);
    for (const name of fs.readdirSync(SITE).filter((file) => file.endsWith('.js'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(SITE, name), 'utf8'), /createElement\(\s*["'](?:base|form)["']\s*\)/, name);
    }
  });

  test('the page checker passes and reports the policy', () => {
    const run = spawnSync(process.execPath, [path.join(SITE, 'tools', 'check-page.mjs')], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Policy closes base-uri and form-action/m);
  });
});
