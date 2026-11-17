// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The third-party notices cover every vendored file, and the repository declares one license.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const CHECKER = path.join(REPO, 'tools', 'check-third-party.mjs');
const LICENSE_ID = 'AGPL-3.0-or-later';
// SHA-256 of https://www.gnu.org/licenses/agpl-3.0.txt (same bytes at ftp.gnu.org/gnu/Licenses/).
const AGPL_SHA256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';

function check(root: string, ...flags: string[]) {
  return spawnSync('node', [CHECKER, ...flags, root], {encoding: 'utf8'});
}

// Every temporary tree made by a test, removed when the file ends.
const temporaryRoots: string[] = [];
after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, {recursive: true, force: true});
});

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

// A small repository: one vendored file, one section, one license text.
function miniRepo(manifest: string, extraFile?: string): string {
  const root = temporaryRoot('third-party-');
  fs.mkdirSync(path.join(root, 'static', 'vendor'), {recursive: true});
  fs.mkdirSync(path.join(root, 'LICENSES'));
  fs.writeFileSync(path.join(root, 'static', 'vendor', 'lib.js'), '// lib\n');
  fs.writeFileSync(path.join(root, 'static', 'vendor', 'THIRD_PARTY.md'), manifest);
  fs.writeFileSync(path.join(root, 'LICENSES', 'MIT-lib.txt'), 'MIT text\n');
  if (extraFile) fs.writeFileSync(path.join(root, 'static', 'vendor', extraFile), 'x\n');
  return root;
}

const COVERING = '# Vendored\n\n## lib\n\nFiles: lib.js\nLicense: MIT\nLicense-File: LICENSES/MIT-lib.txt\n';

describe('check-third-party.mjs', () => {
  test('accepts the repository tree', () => {
    const result = check(REPO);
    assert.equal(result.status, 0, result.stderr);
  });

  test('exits 1 when a license text of the repository tree is removed', () => {
    const root = temporaryRoot('third-party-copy-');
    fs.cpSync(path.join(REPO, 'static', 'vendor'), path.join(root, 'static', 'vendor'), {recursive: true});
    fs.cpSync(path.join(REPO, 'LICENSES'), path.join(root, 'LICENSES'), {recursive: true});
    assert.equal(check(root).status, 0);
    fs.rmSync(path.join(root, 'LICENSES', 'Apache-2.0.txt'));
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Apache-2\.0\.txt is missing or empty/);
  });

  test('accepts a covered file with its license text', () => {
    assert.equal(check(miniRepo(COVERING)).status, 0);
  });

  test('exits 1 when the license text is removed', () => {
    const root = miniRepo(COVERING);
    fs.rmSync(path.join(root, 'LICENSES', 'MIT-lib.txt'));
    assert.equal(check(root).status, 1);
  });

  test('exits 1 when the section is removed', () => {
    assert.equal(check(miniRepo('# Vendored\n')).status, 1);
  });

  test('exits 1 for a vendored file no section covers', () => {
    const result = check(miniRepo(COVERING, 'other.js'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /other\.js: not covered/);
  });

  test('exits 1 for a section with neither license text nor an unresolved mark', () => {
    assert.equal(check(miniRepo('## lib\n\nFiles: lib.js\n')).status, 1);
  });

  test('exits 1, by default, for a section marked unresolved', () => {
    for (const flags of [[], ['--strict']]) {
      const result = check(miniRepo('## lib\n\nFiles: lib.js\nLicense-Status: unresolved\n'), ...flags);
      assert.equal(result.status, 1, flags.join(' '));
      assert.match(result.stderr, /license not established/);
    }
  });

  test('--strict is still accepted and passes an allowed tree', () => {
    assert.equal(check(miniRepo(COVERING), '--strict').status, 0);
  });

  test('exits 1 for a License-File outside the repository, even when it exists', () => {
    const outside = temporaryRoot('third-party-outside-');
    fs.writeFileSync(path.join(outside, 'MIT.txt'), 'MIT text\n');
    const root = miniRepo('');
    const escaping = path.relative(root, path.join(outside, 'MIT.txt'));
    for (const licenseFile of [escaping, path.join(outside, 'MIT.txt')]) {
      fs.writeFileSync(path.join(root, 'static', 'vendor', 'THIRD_PARTY.md'),
        `## lib\n\nFiles: lib.js\nLicense: MIT\nLicense-File: ${licenseFile}\n`);
      const result = check(root);
      assert.equal(result.status, 1, licenseFile);
      assert.match(result.stderr, /outside the repository/, licenseFile);
    }
  });

  test('exits 1 for a License-File that is a symbolic link leading out of the repository', () => {
    const outside = temporaryRoot('third-party-outside-');
    fs.writeFileSync(path.join(outside, 'MIT.txt'), 'MIT text\n');
    const root = miniRepo(COVERING);
    fs.rmSync(path.join(root, 'LICENSES', 'MIT-lib.txt'));
    fs.symlinkSync(path.join(outside, 'MIT.txt'), path.join(root, 'LICENSES', 'MIT-lib.txt'));
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the repository/);
  });

  test('exits 1 for a License-File that names a directory', () => {
    const root = miniRepo('## lib\n\nFiles: lib.js\nLicense: MIT\nLicense-File: LICENSES\n');
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /license text LICENSES is not a regular file/);
  });

  test('the files the license rule removed are not shipped', () => {
    const vendor = path.join(REPO, 'static', 'vendor');
    for (const file of ['monaco/vs/language/css/cssWorker.js', 'monaco/vs/language/html/htmlWorker.js',
      'excalidraw-assets/Virgil.woff2', 'excalidraw-assets/Cascadia.woff2']) {
      assert.equal(fs.existsSync(path.join(vendor, file)), false, file);
    }
    const chunks = fs.readdirSync(path.join(vendor, 'excalidraw-assets')).filter(name => name.startsWith('vendor-'));
    assert.deepEqual(chunks, []);
  });
});

describe('license declarations', () => {
  const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8');

  test('LICENSE is the exact text of the GNU AGPL version 3', () => {
    assert.match(read('LICENSE'), /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'LICENSE'))).digest('hex');
    assert.equal(digest, AGPL_SHA256);
  });

  test('NOTICE names the AGPL and keeps the MIT notice of history.py', () => {
    const notice = read('NOTICE');
    assert.match(notice, /GNU Affero General Public License, version 3/);
    assert.match(notice, /AGPL-3\.0-or-later/);
    assert.doesNotMatch(notice, /section 7|elkjs|Eclipse Public License/);
    assert.match(notice, /history\.py[\s\S]*MIT License[\s\S]*Copyright \(c\) 2026 Ritwik Gopi/);
  });

  test('the packages declare the same license', () => {
    for (const file of ['package.json', 'demo-compiler/package.json']) {
      assert.equal(JSON.parse(read(file)).license, LICENSE_ID, file);
    }
    for (const file of ['package-lock.json', 'demo-compiler/package-lock.json']) {
      assert.equal(JSON.parse(read(file)).packages[''].license, LICENSE_ID, file);
    }
    assert.match(read('ocaml/dune-project'), new RegExp(`\\(license ${LICENSE_ID}\\)`));
    assert.match(read('ocaml/session_mesh.opam'), new RegExp(`license: "${LICENSE_ID}"`));
  });

  // Packages mermaid.min.js bundles without printing their notice: each notice is reproduced in a
  // License-File of the mermaid section (chevrotain's is LICENSES/Apache-2.0.txt, the same text).
  test('the mermaid section reproduces the notice of every package its bundle embeds', () => {
    const notes = read('static/vendor/THIRD_PARTY.md');
    const start = notes.indexOf('## mermaid');
    const section = notes.slice(start, notes.indexOf('\n## ', start + 1));
    assert.doesNotMatch(section, /not reproduced|known limit/);
    const files = [...section.matchAll(/^License-File: (\S+)$/gm)].map(match => match[1]);
    assert.ok(files.includes('LICENSES/Apache-2.0.txt'));
    const texts = files.map(file => read(file)).join('\n');
    for (const name of ['d3-sankey', 'd3-array', 'internmap', 'delaunator', 'robust-predicates', 'uuid', 'dayjs', 'katex',
      'stylis', 'ts-dedent', 'dagre-d3-es', '@iconify/utils', 'cytoscape-fcose', 'cytoscape-cose-bilkent', 'cose-base',
      'layout-base', '@braintree/sanitize-url', 'langium', 'chevrotain-allstar', 'vscode-uri', 'vscode-languageserver-types', 'vscode-languageserver-protocol',
      'es-toolkit', 'fastdom', '@upsetjs/venn.js', 'path-browserify']) {
      assert.match(texts, new RegExp(`^==> ${name.replace(/[/.]/g, '\\$&')} \\d`, 'm'), name);
    }
  });

  test('the DOMPurify section keeps the hash line read by tests/test_view_markdown.py', () => {
    const notes = read('static/vendor/THIRD_PARTY.md');
    const section = notes.slice(notes.indexOf('## DOMPurify'));
    assert.match(section, /sha256 `[0-9a-f]{64}`/);
  });
});
