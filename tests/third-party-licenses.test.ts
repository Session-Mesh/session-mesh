// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The license rule is checked mechanically: every section of THIRD_PARTY.md states an
// SPDX expression whose licenses are all in the allowed list, and the npm packages of
// the whiteboard bundle are exactly those its `Package:` lines declare.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {ALLOWED_LICENSES, licenseExpressionProblems} from '../tools/third-party/licenses.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const CHECKER = path.join(REPO, 'tools', 'check-third-party.mjs');
const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, {recursive: true, force: true}); });

function repo(section: string, inventory?: object): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-licenses-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'static', 'vendor'), {recursive: true});
  fs.mkdirSync(path.join(root, 'LICENSES'));
  fs.writeFileSync(path.join(root, 'static', 'vendor', 'lib.js'), '// lib\n');
  fs.writeFileSync(path.join(root, 'LICENSES', 'lib.txt'), 'text\n');
  const files = inventory ? 'lib.js, packages.json' : 'lib.js';
  if (inventory) fs.writeFileSync(path.join(root, 'static', 'vendor', 'packages.json'), JSON.stringify(inventory));
  fs.writeFileSync(path.join(root, 'static', 'vendor', 'THIRD_PARTY.md'),
    `# Vendored\n\n## lib\n\nFiles: ${files}\nLicense-File: LICENSES/lib.txt\n${section}`);
  return root;
}
const check = (root: string) => spawnSync('node', [CHECKER, root], {encoding: 'utf8'});

describe('allowed license expressions', () => {
  for (const expression of ['MIT', 'MIT AND Apache-2.0 AND Zlib', 'Apache-2.0 OR MPL-2.0', '(MPL-2.0 OR Apache-2.0)', 'MIT AND (EPL-2.0 OR Apache-2.0)',
    'OFL-1.1', 'CC-BY-4.0', 'BSD-3-Clause AND ISC AND Unlicense']) {
    test(`accepts ${expression}`, () => assert.deepEqual(licenseExpressionProblems(expression), []));
  }
  for (const [expression, culprit] of [['EPL-2.0', 'EPL-2.0'], ['MIT AND EPL-2.0', 'EPL-2.0'], ['CC-BY-SA-2.5', 'CC-BY-SA-2.5'],
    ['LicenseRef-Cascadia-Code', 'LicenseRef-Cascadia-Code'], ['GPL-2.0-only OR EPL-1.0', 'GPL-2.0-only'], ['UNKNOWN', 'UNKNOWN'],
    // MPL-2.0 is accepted only as an alternative to an allowed license, never alone or in an AND.
    ['MPL-2.0', 'MPL-2.0'], ['MIT AND MPL-2.0', 'MPL-2.0'], ['MPL-2.0 OR EPL-2.0', 'MPL-2.0']]) {
    test(`refuses ${expression}`, () => assert.match(licenseExpressionProblems(expression).join('\n'), new RegExp(culprit)));
  }
  for (const malformed of ['', 'MIT AND', '(MIT', 'MIT)', 'MIT WITH Classpath-exception-2.0', 'MIT and ISC']) {
    test(`refuses the malformed expression "${malformed}"`, () => assert.notDeepEqual(licenseExpressionProblems(malformed), []));
  }
  test('every allowed license gives its reason', () => {
    for (const [id, reason] of Object.entries(ALLOWED_LICENSES)) assert.ok(reason.length > 20, id);
  });
  test('the reasons describe the license they justify', () => {
    assert.doesNotMatch(ALLOWED_LICENSES['CC-BY-4.0'], /one-way/);
    assert.match(ALLOWED_LICENSES['OFL-1.1'], /aggregat/);
  });
  test('the copyleft and non-free licenses met in this tree are not allowed', () => {
    for (const id of ['EPL-1.0', 'EPL-2.0', 'CC-BY-SA-2.5', 'GPL-2.0-only', 'LicenseRef-Cascadia-Code']) assert.ok(!(id in ALLOWED_LICENSES), id);
  });
});

describe('check-third-party.mjs and the license rule', () => {
  test('accepts an allowed section', () => assert.equal(check(repo('License: MIT\n')).status, 0));
  test('refuses a section without License:', () => {
    const result = check(repo(''));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs exactly one License: line/);
  });
  test('refuses a section whose license is not allowed', () => {
    const result = check(repo('License: MIT AND EPL-2.0\n'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"EPL-2\.0" is not in the allowed list/);
  });
});

describe('check-third-party.mjs and the bundle inventory', () => {
  const lines = 'License: MIT\nInventory: packages.json\nPackage: @scope/a 1.0.0 MIT\nPackage: b 2.0.0 ISC\n';
  const packages = [{name: '@scope/a', version: '1.0.0', license: 'MIT'}, {name: 'b', version: '2.0.0', license: 'ISC'}];
  test('accepts an inventory equal to the Package: lines', () => assert.equal(check(repo(lines, {packages})).status, 0));
  test('refuses a bundled package without its Package: line', () => {
    const result = check(repo(lines, {packages: [...packages, {name: 'c', version: '1.0.0', license: 'MIT'}]}));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundled package c 1\.0\.0 MIT has no matching Package: line/);
  });
  test('refuses a Package: line the bundle does not hold, or with another version', () => {
    const result = check(repo(lines, {packages: [packages[0], {...packages[1], version: '2.0.1'}]}));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Package: b 2\.0\.0 ISC is not in the bundle inventory/);
  });
  test('refuses a bundled package whose declared license is not allowed', () => {
    const bad = [packages[0], {...packages[1], license: 'EPL-2.0'}];
    const result = check(repo('License: MIT\nInventory: packages.json\nPackage: @scope/a 1.0.0 MIT\nPackage: b 2.0.0 EPL-2.0\n', {packages: bad}));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundled package b: license "EPL-2\.0"/);
  });
  test('refuses Package: lines without an inventory file', () => {
    assert.equal(check(repo('License: MIT\nPackage: b 2.0.0 ISC\n')).status, 1);
  });
});

describe('the committed whiteboard inventory', () => {
  const haveModules = fs.existsSync(path.join(REPO, 'node_modules', '@excalidraw', 'excalidraw', 'package.json'));
  test('equals the packages of a fresh esbuild build of static/board-src.mjs', {skip: !haveModules && 'node_modules absent'}, async () => {
    const {build} = await import('esbuild');
    const {boardBuildOptions} = await import('../tools/board-build-options.mjs');
    const {packagesFromMetafile} = await import('../tools/third-party/board-inventory.mjs');
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-inventory-'));
    roots.push(outdir);
    const result = await build({...boardBuildOptions(REPO, outdir), write: false, logLevel: 'silent'});
    const committed = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'vendor', 'board-packages.json'), 'utf8'));
    assert.deepEqual(packagesFromMetafile(result.metafile, REPO), committed.packages);
  });
});
