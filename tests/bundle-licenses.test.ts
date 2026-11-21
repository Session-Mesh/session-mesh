// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/bundle-licenses.mjs: the third-party notices of a bundle. Every component the build lists
// must name a licence text that is a file of the bundle, or the build stops. The OCaml packages come
// from dune's link rules and opam (stand-ins here), the CPython components from
// python-build-standalone's PYTHON.json (a fixture).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {CPYTHON_CHANGES, NATIVE_TARGETS, indexProblems, ocamlComponents, otherComponents, sqliteComponent, pythonCatalogue, pythonComponents, recipeComponent, renderIndex, sourceStatement,
  writeNotices} from '../scripts/bundle-licenses.mjs';
import {applyLicencePolicy, BUNDLE_LICENCES, labelProblems, REVIEWED_EXCEPTIONS} from '../scripts/bundle/licence-policy.mjs';
import {wheelComponents} from '../scripts/bundle/wheel-licences.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true}); });
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-licences-'));
  roots.push(root);
  return root;
}
const write = (file: string, text: string, mode = 0o644) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text, {mode}); };

describe('the index of third-party components', () => {
  test('every component names a non-empty file of the bundle, or the notices are refused', () => {
    const bundle = scratch();
    write(path.join(bundle, 'licenses/a/LICENSE'), 'text');
    write(path.join(bundle, 'licenses/empty'), '');
    const records = [
      {component: 'a', version: '1', licence: 'MIT', files: ['licenses/a/LICENSE']},
      {component: 'b', version: '2', licence: 'ISC', files: []},
      {component: 'c', version: '3', licence: 'ISC', files: ['licenses/missing']},
      {component: 'd', version: '4', licence: 'ISC', files: ['licenses/empty']},
      {component: 'e', version: '5', licence: 'ISC', files: ['../outside']},
      {component: 'f', version: '6', licence: 'MIT', files: ['licenses/sbom.cdx']},
    ];
    write(path.join(bundle, 'licenses/sbom.cdx'), '{"bomFormat": "CycloneDX", "components": []}');
    assert.deepEqual(indexProblems(bundle, records), ['b: no licence file', 'c: licenses/missing is not a non-empty file of the bundle',
      'd: licenses/empty is not a non-empty file of the bundle', 'e: ../outside is not a non-empty file of the bundle',
      'f: licenses/sbom.cdx is a JSON document, not a licence text']);
    assert.throws(() => writeNotices(bundle, records, {sourceUrl: 'https://example.invalid/x', revision: 'abc'}), /incomplete or refused third-party notices/);
    assert.ok(!fs.existsSync(path.join(bundle, 'licenses/THIRD-PARTY.md')));
    writeNotices(bundle, records.slice(0, 1), {sourceUrl: 'https://example.invalid/x', revision: 'abc'});
    assert.match(fs.readFileSync(path.join(bundle, 'licenses/THIRD-PARTY.md'), 'utf8'), /\| a \| 1 \| MIT \| `licenses\/a\/LICENSE` \|/);
  });

  test('the source statement names the repository, the revision and the native programs\' source', () => {
    const text = sourceStatement({sourceUrl: 'https://example.invalid/session-mesh', revision: 'f00d', dirty: true});
    assert.match(text, /https:\/\/example\.invalid\/session-mesh\n {2}revision f00d/);
    assert.match(text, /built from ocaml\/\nat that revision/);
    assert.match(text, /bin\/mesh-profile/);
    assert.match(text, /local changes that are not part of that revision/);
    const runtime = sourceStatement({sourceUrl: 'https://example.invalid/session-mesh', revision: 'f00d', runtime: {release: '20250317',
      provenance: 'From downloads.py.', recipe: {name: 'python-build-standalone 20250317', commit: 'c0ffee', url: 'https://example.invalid/r.tar.gz', sha256: 'aa'},
      archives: [{name: 'Berkeley DB 6.0.19', url: 'https://example.invalid/db-6.0.19.tar.gz', sha256: 'bb'}]}});
    assert.match(runtime, /python-build-standalone 20250317, git commit c0ffee\n {4}https:\/\/example\.invalid\/r\.tar\.gz\n {4}SHA-256 aa/);
    assert.match(runtime, /Berkeley DB 6\.0\.19\n {4}https:\/\/example\.invalid\/db-6\.0\.19\.tar\.gz\n {4}SHA-256 bb\n\nFrom downloads\.py\./);
    assert.match(runtime, /Mozilla Public\nLicense 2\.0 \(python-build-standalone\/LICENSE\)/);
    assert.ok(runtime.includes(`Changes to that distribution: ${CPYTHON_CHANGES}.`));
    assert.match(CPYTHON_CHANGES, /pip, ensurepip, idlelib, tkinter, turtledemo, the Tcl\/Tk scripts/);
    assert.match(renderIndex([{component: 'x|y', version: '1', licence: 'MIT', files: ['f']}]), /\| x\\\|y \|/);
  });
});

// Stand-ins: dune names one archive of each package per program; opam answers var, list and source.
function opamFixture(packages: Record<string, {doc?: Record<string, string>; source?: Record<string, string>}>) {
  const root = scratch();
  const [fakes, lib, doc, sources] = ['fakes', 'lib', 'doc', 'sources'].map((name) => path.join(root, name));
  for (const [name, spec] of Object.entries(packages)) {
    for (const [file, text] of Object.entries(spec.doc ?? {})) write(path.join(doc, name, file), text);
    for (const [file, text] of Object.entries(spec.source ?? {})) write(path.join(sources, name, file), text);
  }
  const archives = Object.keys(packages).map((name) => `${lib}/${name}/${name}.cmxa`).join(' ');
  const rows = Object.keys(packages).map((name) => `${name} 1.0 "ISC"`).join('\\n');
  write(path.join(fakes, 'opam'), `#!/bin/bash
args=("$@"); [[ $2 == --switch ]] && args=("$1" "\${@:4}")
case \${args[0]} in
  var) [[ \${args[1]} == lib ]] && echo '${lib}' || echo '${doc}' ;;
  list) printf '${rows}\\n' ;;
  source) name=\${args[1]%%.*}; dir=\${args[2]#--dir=}; [[ -d '${sources}'/$name ]] || exit 5; cp -R '${sources}'/$name "$dir" ;;
  exec) echo "(rule (deps ${archives}))" ;;
  *) exit 97 ;;
esac`, 0o755);
  return {fakes, options: {ocamlRoot: root, opamSwitch: 'sw'}};
}

describe('the OCaml packages of the native programs', () => {
  test('the profile helper is included in native dependency and licence discovery', () => {
    assert.equal(NATIVE_TARGETS['bin/mesh_profile_main.exe'], 'mesh-profile');
  });
  const withPath = <T>(fakes: string, body: () => T): T => {
    const saved = process.env.PATH;
    process.env.PATH = `${fakes}:${saved}`;
    try { return body(); } finally { process.env.PATH = saved; }
  };

  test('each linked package ships its licence: from opam\'s doc, else its source, and the vendored liburing\'s', () => {
    const {fakes, options} = opamFixture({ocaml: {doc: {LICENSE: 'LGPL'}}, plain: {source: {'COPYING.txt': 'LGPL'}},
      uring: {doc: {'LICENSE.md': 'ISC'}, source: {'vendor/liburing/LICENSE': 'MIT', 'vendor/liburing/COPYING': 'LGPL', 'vendor/liburing/COPYING.GPL': 'GPL'}}});
    const bundle = scratch();
    const records = withPath(fakes, () => ocamlComponents(bundle, options));
    const files = Object.fromEntries(records.map((r: {component: string; files: string[]}) => [r.component, r.files]));
    assert.deepEqual(files, {
      'OCaml package ocaml': ['licenses/ocaml/ocaml/LICENSE'],
      'OCaml package plain': ['licenses/ocaml/plain/COPYING.txt'],
      'OCaml package uring': ['licenses/ocaml/uring/LICENSE.md', 'licenses/ocaml/uring/vendor/liburing/LICENSE',
        'licenses/ocaml/uring/vendor/liburing/COPYING', 'licenses/ocaml/uring/vendor/liburing/COPYING.GPL'],
    });
    assert.deepEqual(indexProblems(bundle, records), []);
  });

  test('a linked package without any licence text stops the build', () => {
    const {fakes, options} = opamFixture({ocaml: {doc: {LICENSE: 'LGPL'}}, bare: {source: {'README.md': 'no licence'}}});
    assert.throws(() => withPath(fakes, () => ocamlComponents(scratch(), options)), /no licence text for the OCaml package bare 1\.0/);
  });
});

describe('the SQLite of mesh-history', () => {
  test('is a public-domain component with its version from the pin, its text copied into the bundle and the policy satisfied', () => {
    const bundle = scratch();
    const record = sqliteComponent(bundle, path.resolve(import.meta.dirname, '..'));
    assert.deepEqual([record.component, record.version, record.licence], ['SQLite (in mesh-history)', '3.54.1', 'public domain']);
    assert.deepEqual(record.files, ['licenses/sqlite/LICENSE']);
    assert.deepEqual(indexProblems(bundle, [record]), []);
    const read = (file: string) => fs.readFileSync(path.join(bundle, file));
    assert.deepEqual(applyLicencePolicy([record], read).problems, []);
  });
});

describe('the CPython components', () => {
  // A python-build-standalone layout: _ssl names both OpenSSL texts, _tkinter the Tcl/Tk one, Tix none.
  function standalone(extensions: Record<string, string[]> = {_ssl: ['openssl-1.1', 'openssl-3'], _dbm: ['bdb'], _tkinter: ['tcl']},
    texts = ['cpython', 'openssl-1.1', 'openssl-3', 'bdb', 'tcl', 'tix']) {
    const python = path.join(scratch(), 'python');
    write(path.join(python, 'PYTHON.json'), JSON.stringify({python_version: '3.12.9', license_path: 'licenses/LICENSE.cpython.txt',
      licenses: ['Python-2.0', 'CNRI-Python'], build_info: {extensions: Object.fromEntries(Object.entries(extensions)
        .map(([name, used]) => [name, [{licenses: ['X'], license_paths: used.map((text) => `licenses/LICENSE.${text}.txt`)}]]))}}));
    for (const name of texts) write(path.join(python, `licenses/LICENSE.${name}.txt`), name);
    const bundle = scratch();
    write(path.join(bundle, 'runtime/python/bin/python3.12'), '');
    return {python, bundle};
  }
  const components = (records: Array<{component: string}>) => Object.fromEntries(records.map((r) => [r.component, r]));

  test('each text the runtime links is shipped with its own licence, version and source archives', () => {
    const {python, bundle} = standalone();
    const records = pythonComponents(bundle, python, '20250317', {opensslVersion: '3.0.16'});
    const byName = components(records);
    assert.deepEqual(Object.keys(byName), ['CPython', 'Berkeley DB (in CPython)', 'OpenSSL (in CPython)', 'Tcl/Tk (in CPython)']);
    assert.equal(byName.CPython.licence, 'Python-2.0, CNRI-Python');
    assert.equal(byName['OpenSSL (in CPython)'].licence, 'Apache-2.0');
    assert.equal(byName['OpenSSL (in CPython)'].version, '3.0.16');
    assert.deepEqual(byName['OpenSSL (in CPython)'].files, ['licenses/python/LICENSE.openssl-3.txt']);
    assert.equal(byName['Berkeley DB (in CPython)'].licence, 'Sleepycat');
    assert.match(byName['Berkeley DB (in CPython)'].note, /linked into CPython for _dbm; source: https:\/\/ftp\.osuosl\.org\/pub\/blfs\/conglomeration\/db\/db-6\.0\.19\.tar\.gz \(SHA-256 2917c28f60903908c2ca4587ded1363b812c4e830a5326aaa77c9879d13ae18e\)/);
    assert.deepEqual(byName['Tcl/Tk (in CPython)'].sources.map((s: {url: string}) => path.basename(s.url)), ['tcl8.6.14-src.tar.gz', 'tk8.6.14-src.tar.gz']);
    assert.match(byName.CPython.sources[0].url, /Python-3\.12\.9\.tar\.xz$/);
    assert.ok(byName.CPython.note.includes(CPYTHON_CHANGES));
    assert.ok(!fs.existsSync(path.join(bundle, 'licenses/python/LICENSE.tix.txt')));
    assert.deepEqual(indexProblems(bundle, records), []);
  });

  test('the OpenSSL 1.1 text is the one shipped when the runtime links OpenSSL 1.1, and Tix\'s when its scripts are shipped', () => {
    const {python, bundle} = standalone();
    fs.mkdirSync(path.join(bundle, 'runtime/python/lib/Tix8.4.3'), {recursive: true});
    const byName = components(pythonComponents(bundle, python, '20250317', {opensslVersion: '1.1.1w'}));
    assert.equal(byName['OpenSSL (in CPython)'].licence, 'OpenSSL');
    assert.match(byName['Tix (in CPython)'].note, /^its scripts are in runtime\/python\/lib/);
  });

  test('a path PYTHON.json names outside its licenses/, a text without a reviewed licence, another CPython or OpenSSL stop the build', () => {
    const missing = standalone({_dbm: ['bdb', 'absent']});
    assert.throws(() => pythonComponents(missing.bundle, missing.python, '20250317', {opensslVersion: '3.0.16'}),
      /PYTHON\.json names licenses\/LICENSE\.absent\.txt, which is not in its licenses\//);
    const unknown = standalone({_dbm: ['bdb']}, ['cpython', 'bdb', 'novel']);
    assert.throws(() => pythonComponents(unknown.bundle, unknown.python, '20250317', {opensslVersion: '3.0.16'}),
      /no reviewed licence for LICENSE\.novel\.txt of python-build-standalone 20250317/);
    const {python, bundle} = standalone();
    assert.throws(() => pythonComponents(bundle, python, '20250317', {opensslVersion: undefined}), /unknown OpenSSL version/);
    assert.throws(() => pythonCatalogue('20990101'), /no reviewed catalogue for python-build-standalone 20990101/);
    write(path.join(bundle, 'runtime/python/bin/python3.13'), '');
    fs.rmSync(path.join(bundle, 'runtime/python/bin/python3.12'));
    assert.throws(() => pythonComponents(bundle, python, '20250317', {opensslVersion: '3.0.16'}), /for CPython 3\.12\.9, not the bundled python3\.13/);
  });

  test('the catalogue gives each text an allowed or reviewed licence and pinned source archives', () => {
    const catalogue = pythonCatalogue('20250317');
    assert.match(catalogue.recipe.commit, /^[0-9a-f]{40}$/);
    for (const archive of [catalogue.recipe, ...Object.values(catalogue.cpython) as Array<{url: string; sha256: string}>]) {
      assert.match(archive.url, /^https:\/\//);
      assert.match(archive.sha256, /^[0-9a-f]{64}$/);
    }
    for (const [name, entry] of Object.entries(catalogue.texts) as Array<[string, {name: string; licence: string; archives: Array<{url: string; sha256: string}>}]>) {
      const reviewed = REVIEWED_EXCEPTIONS[`${entry.name} (in CPython)` as keyof typeof REVIEWED_EXCEPTIONS];
      assert.ok(reviewed || labelProblems(entry.licence).length === 0 || name === 'LICENSE.openssl-1.1.txt', name);
      for (const archive of entry.archives) { assert.match(archive.url, /^https:\/\//, name); assert.match(archive.sha256, /^[0-9a-f]{64}$/, name); }
    }
    assert.equal(catalogue.texts['LICENSE.bdb.txt'].version, '6.0.19');
  });
});

describe('the python-build-standalone recipe', () => {
  function recipeArchive(licence: string) {
    const source = scratch();
    write(path.join(source, 'python-build-standalone-20250317/LICENSE'), licence);
    write(path.join(source, 'python-build-standalone-20250317/build-linux.py'), '');
    spawnSync('tar', ['-czf', path.join(source, 'recipe.tar.gz'), '-C', source, 'python-build-standalone-20250317']);
    const bytes = fs.readFileSync(path.join(source, 'recipe.tar.gz'));
    return {bytes, recipe: {url: 'https://example.invalid/20250317.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), commit: 'c0ffee'}};
  }

  test('ships the recipe\'s LICENSE (MPL-2.0) from the archive whose SHA-256 is pinned', async () => {
    const {bytes, recipe} = recipeArchive('Mozilla Public License Version 2.0\n');
    const bundle = scratch();
    const record = await recipeComponent(bundle, '20250317', recipe, {fetchArchive: async () => bytes});
    assert.equal(record.licence, 'MPL-2.0');
    assert.deepEqual(record.files, ['licenses/python-build-standalone/LICENSE']);
    assert.equal(fs.readFileSync(path.join(bundle, record.files[0]), 'utf8'), 'Mozilla Public License Version 2.0\n');
    assert.notDeepEqual(labelProblems(record.licence), [], 'a generic MPL-2.0 component is refused');
    assert.deepEqual(indexProblems(bundle, [record]), []);
  });

  describe('the reviewed exception', () => {
    const name = 'python-build-standalone (the build recipe)';
    const template = 'Exhibit B\n  This Source Code Form is "Incompatible With Secondary Licenses", as\n  defined by the Mozilla Public License, v. 2.0.\n';
    const check = (files: Record<string, string>, text = template, pinned = true) => {
      const exception = {...REVIEWED_EXCEPTIONS[name], sha256: pinned ? [createHash('sha256').update(text).digest('hex')] : REVIEWED_EXCEPTIONS[name].sha256};
      const records = [{component: name, version: '20250317', licence: 'MPL-2.0', files: ['recipe/LICENSE']},
        ...Object.keys(files).map((file) => ({component: file, version: '1', licence: 'MIT', files: [file]}))];
      return applyLicencePolicy(records, (file: string) => Buffer.from(file === 'recipe/LICENSE' ? text : files[file]), {[name]: exception}).problems;
    };
    test('pins the label MPL-2.0 and the SHA-256 of the recipe\'s LICENSE', () => {
      assert.equal(REVIEWED_EXCEPTIONS[name].label, 'MPL-2.0');
      assert.match(REVIEWED_EXCEPTIONS[name].sha256[0], /^[0-9a-f]{64}$/);
      assert.equal(BUNDLE_LICENCES['MPL-2.0'], undefined);
    });
    test('passes when the text is the pinned one and no other notice carries the Exhibit B sentence', () => {
      assert.deepEqual(check({'a/LICENSE': 'MIT text'}), []);
    });
    test('refuses another text, a text without the Exhibit B template, and a shipped notice that carries the sentence', () => {
      assert.match(check({}, template, false).join('\n'), /licence text is not the reviewed one \(SHA-256\)/);
      assert.match(check({}, 'MPL text without it').join('\n'), /Exhibit B template exactly once/);
      assert.match(check({}, template + template).join('\n'), /Exhibit B template exactly once/);
      assert.match(check({'a/NOTICE': 'This Source Code Form is \u201cIncompatible With Secondary Licenses\u201d, as defined'}).join('\n'),
        /shipped notice carries the "Incompatible With Secondary Licenses" notice/);
    });
    test('does not apply to a generic MPL-2.0 component', () => {
      const result = applyLicencePolicy([{component: 'other', version: '1', licence: 'MPL-2.0', files: ['f']}], () => Buffer.from('x'));
      assert.match(result.problems.join('\n'), /licence "mpl-2\.0" is not allowed/);
    });
  });

  test('an archive that does not match the pinned SHA-256 stops the build', async () => {
    const {bytes, recipe} = recipeArchive('MPL');
    await assert.rejects(recipeComponent(scratch(), '20250317', {...recipe, sha256: '0'.repeat(64)}, {fetchArchive: async () => bytes}),
      /20250317\.tar\.gz does not match its pinned SHA-256/);
  });

  test('the catalogue pins the recipe archive', () => {
    const {recipe} = pythonCatalogue('20250317');
    assert.match(recipe.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/archive\/refs\/tags\/20250317\.tar\.gz$/);
    assert.match(recipe.sha256, /^[0-9a-f]{64}$/);
  });
});

describe('the pinned CPython licence metadata', () => {
  test('pins the full archive of the default CPython for every platform a bundle is built on', () => {
    const repo = path.resolve(import.meta.dirname, '..');
    const version = /PYTHON_VERSION=\$\{MESH_BUNDLE_PYTHON_VERSION:-([0-9.]+)\}/.exec(fs.readFileSync(path.join(repo, 'scripts/build-bundle.sh'), 'utf8'))?.[1];
    const lines = fs.readFileSync(path.join(repo, 'scripts/bundle/python-licenses.sha256'), 'utf8').trim().split('\n');
    for (const line of lines) assert.match(line, /^[0-9a-f]{64} {2}cpython-[0-9.]+\+[0-9]{8}-[a-z0-9_]+-[a-z0-9_+-]+-full\.tar\.zst$/);
    for (const triple of ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'aarch64-apple-darwin', 'x86_64-apple-darwin']) {
      assert.equal(lines.filter((line) => line.includes(`cpython-${version}+`) && line.includes(`-${triple}-`)).length, 1, triple);
    }
  });
});

describe('the licence allow-list of a bundle', () => {
  for (const label of ['Python-2.0, CNRI-Python', 'BSD-3-clause', 'Apache 2.0', 'Apache License 2.0', 'ISC, MIT', 'MIT-0', 'PSF-2.0',
    '(MIT OR Apache-2.0) AND Unicode-3.0', 'Apache-2.0 OR GPL-2.0-only', 'LGPL-2.1-or-later WITH OCaml-LGPL-linking-exception', 'LGPL-3.0-or-later WITH LGPL-3.0-linking-exception',
    'Sleepycat', 'MIT, TCL, X11', 'bzip2-1.0.6', 'Zlib', 'BSD-2-Clause', 'AGPL-3.0-or-later',
    '(MIT OR (ISC AND Zlib)), BSD-2-Clause', '((MIT)), ((ISC OR Zlib))', 'Apache-2.0 OR MPL-2.0',
    'MIT OR Apache-2.0, Unicode-3.0', 'ISC, MIT OR Apache-2.0', 'Apache 2.0, BSD-3-Clause OR GPL-2.0-only', 'GPL-2.0-only OR MIT, ISC']) {
    test(`allows ${label}`, () => assert.deepEqual(labelProblems(label), []));
  }
  for (const label of ['see the text', 'not stated', 'OpenSSL', 'Apache-2.0, OpenSSL', 'GPL-3.0-only', 'EPL-2.0', 'LGPL-2.1-or-later', 'LGPL-3.0-or-later',
    'Apache-2.0 WITH LLVM-exception', 'GPL-2.0-only OR EPL-2.0', 'public domain',
    // A comma joins whole parts: AND must not bind the first part to the first alternative of the next.
    'GPL-2.0-only, MIT OR Apache-2.0', 'SSPL-1.0, MIT OR Apache-2.0', 'AGPL-1.0-only, ISC OR MIT', 'MIT OR Apache-2.0, GPL-3.0-only',
    // A parenthesis cannot span two comma parts: each part is parsed on its own.
    'GPL-2.0-only, MIT) OR (Apache-2.0', 'GPL-3.0-only) OR (MIT', 'MIT, (GPL-3.0-only', 'GPL-3.0-only), MIT',
    // MPL-2.0 is alternative-only, never on its own: only the reviewed recipe exception may carry it.
    'MPL-2.0', 'MIT, MPL-2.0', 'MPL-2.0 OR GPL-3.0-only']) {
    test(`refuses ${label}`, () => assert.notDeepEqual(labelProblems(label), []));
  }
  test('every allowed licence and every reviewed exception gives its reason', () => {
    for (const [id, reason] of Object.entries(BUNDLE_LICENCES)) assert.ok(reason.length > 10, id);
    for (const [component, exception] of Object.entries(REVIEWED_EXCEPTIONS)) {
      assert.ok(exception.reason.length > 20, component);
      if ('licence' in exception) assert.deepEqual(labelProblems(exception.licence as string), [], component);
    }
  });

  test('every reviewed exception pins its label and its texts (by SHA-256, by content for the GCC libraries, or by a check)', () => {
    for (const [component, exception] of Object.entries(REVIEWED_EXCEPTIONS) as Array<[string, {label?: string; sha256?: string[]; text?: RegExp[]; checked?: string}]>) {
      assert.equal(typeof exception.label, 'string', component);
      assert.ok(exception.sha256?.length || exception.text?.length || exception.checked, component);
      for (const hash of exception.sha256 ?? []) assert.match(hash, /^[0-9a-f]{64}$/, component);
    }
  });

  test('a component outside the list stops the notices unless an exception that still matches reviewed it', () => {
    const bundle = scratch();
    for (const [file, text] of [['roster/LICENSE', 'MIT License\n...'], ['other/LICENSE', 'BSD'], ['gcc/RUNTIME.LIBRARY.EXCEPTION', 'GCC RUNTIME LIBRARY EXCEPTION'],
      ['gcc/GPL-3', 'GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007']]) write(path.join(bundle, file), text);
    const read = (file: string) => fs.readFileSync(path.join(bundle, file));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const exceptions = {...REVIEWED_EXCEPTIONS,
      'Roster CLIs': {...REVIEWED_EXCEPTIONS['Roster CLIs'], sha256: [hash('MIT License\n...')]},
      'openssl (C library in the cryptography wheel)': {...REVIEWED_EXCEPTIONS['openssl (C library in the cryptography wheel)'], sha256: [hash('BSD')]}};
    const ok = applyLicencePolicy([
      {component: 'Roster CLIs', version: '1', licence: 'see the text', files: ['roster/LICENSE']},
      {component: 'system library libgcc_s.so.1', version: '14', licence: 'see the text', files: ['gcc/RUNTIME.LIBRARY.EXCEPTION', 'gcc/GPL-3']},
      {component: 'openssl (C library in the cryptography wheel)', version: '4.0.3', licence: 'not stated', files: ['other/LICENSE']},
    ], read, exceptions);
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.records.map((r: {licence: string}) => r.licence), ['MIT', 'GPL-3.0-or-later WITH GCC-exception-3.1', 'Apache-2.0']);
    assert.match(ok.records[0].note, /licence reviewed: optional\/roster\/LICENSE is the MIT licence/);
    const refused = applyLicencePolicy([
      {component: 'Python package x', version: '1', licence: 'see the text', files: ['other/LICENSE']},
      {component: 'Roster CLIs', version: '1', licence: 'see the text', files: ['other/LICENSE']},
      {component: 'system library libgcc_s.so.1', version: '14', licence: 'see the text', files: ['gcc/RUNTIME.LIBRARY.EXCEPTION']},
      {component: 'openssl (C library in the cryptography wheel)', version: '1.1.1w', licence: 'not stated', files: ['other/LICENSE']},
    ], read, exceptions);
    assert.equal(refused.problems.length, 4, refused.problems.join('\n'));
    assert.match(refused.problems[0], /^Python package x: licence "see the text" is not an SPDX expression/);
    assert.match(refused.problems[1], /^Roster CLIs: reviewed exception: licence text is not the reviewed one \(SHA-256\)/);
    assert.match(refused.problems[2], /GNU GENERAL PUBLIC LICENSE/);
    assert.match(refused.problems[3], /version 1\.1\.1w is not the reviewed one/);
    assert.throws(() => writeNotices(bundle, [{component: 'c', version: '1', licence: 'GPL-3.0-only', files: ['other/LICENSE']}],
      {sourceUrl: 'https://example.invalid/x', revision: 'abc'}), /c: licence "gpl-3\.0-only" is not allowed/);
  });

  test('a reviewed exception stops applying to another label, version or text, or without its check', () => {
    const bundle = scratch();
    write(path.join(bundle, 'sqlite.txt'), 'The author disclaims copyright to this source code. In place of a legal notice... public domain');
    write(path.join(bundle, 'node.txt'), 'Node.js is licensed for use as follows:\n\n"""\nCopyright Node.js contributors.');
    const read = (file: string) => fs.readFileSync(path.join(bundle, file));
    const problems = (record: object) => applyLicencePolicy([record], read).problems;
    const sqlite = {component: 'SQLite (in CPython)', version: '3.47.1', licence: 'public domain', files: ['sqlite.txt']};
    assert.match(problems(sqlite).join('\n'), /^SQLite \(in CPython\): reviewed exception: licence text is not the reviewed one \(SHA-256\)$/);
    assert.match(problems({...sqlite, licence: 'GPL-2.0-only'}).join('\n'), /label "GPL-2\.0-only" is not the reviewed "public domain"/);
    assert.match(problems({...sqlite, version: '3.48.0'}).join('\n'), /version 3\.48\.0 is not the reviewed one/);
    const lzma = {component: 'liblzma (XZ Utils) (in CPython)', version: '5.6.1', licence: 'public domain', files: ['sqlite.txt']};
    assert.match(problems(lzma).join('\n'), /version 5\.6\.1 is not the reviewed one/);
    const node = {component: 'Node.js', version: 'v24.11.1', licence: 'SSPL-1.0', files: ['node.txt']};
    assert.match(problems(node).join('\n'), /label "SSPL-1\.0" is not the reviewed "MIT, and the licences/);
    assert.match(problems(node).join('\n'), /licence text is not the reviewed one/);
    const vendored = {component: 'Web libraries vendored in static/vendor', version: 'per file', licence: 'per file, see THIRD_PARTY.md', files: ['node.txt']};
    assert.deepEqual(problems({...vendored, checked: 'tools/check-third-party.mjs'}), []);
    assert.match(problems(vendored).join('\n'), /tools\/check-third-party\.mjs did not check it/);
  });
});

describe('the vendored web libraries of a bundle', () => {
  function app(section: string) {
    const bundle = scratch();
    write(path.join(bundle, 'app/static/vendor/lib.js'), '// lib\n');
    write(path.join(bundle, 'app/LICENSES/lib.txt'), 'MIT text\n');
    write(path.join(bundle, 'app/static/vendor/THIRD_PARTY.md'), `# Vendored\n\n## lib\n\nFiles: lib.js\nLicense-File: LICENSES/lib.txt\n${section}`);
    return bundle;
  }
  const repo = path.resolve(import.meta.dirname, '..');

  test('pass tools/check-third-party.mjs in app/, which the record states', () => {
    const vendored = otherComponents(app('License: MIT\n'), repo).find((r: {component: string}) => r.component.startsWith('Web libraries'));
    assert.equal(vendored.checked, 'tools/check-third-party.mjs');
  });

  test('a library outside the allowed licences stops the build', () => {
    assert.throws(() => otherComponents(app('License: SSPL-1.0\n'), repo), /vendored web libraries of app\/ fail tools\/check-third-party\.mjs/);
  });
});

describe('the components of a wheel\'s bills of materials', () => {
  const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n';
  // A cryptography-like wheel and a crate archive built here; pins name its SHA-256.
  function wheel(components: object[]) {
    const bundle = scratch();
    const distInfo = path.join(bundle, 'runtime/python/lib/python3.12/site-packages/cryptography-1.0.dist-info');
    write(path.join(distInfo, 'METADATA'), 'Name: cryptography\nVersion: 1.0\nLicense-Expression: Apache-2.0 OR BSD-3-Clause\n');
    write(path.join(distInfo, 'licenses/LICENSE.APACHE'), APACHE);
    write(path.join(distInfo, 'licenses/LICENSE.BSD'), 'BSD');
    write(path.join(distInfo, 'sboms/rust.cyclonedx.json'), JSON.stringify({bomFormat: 'CycloneDX', components}));
    const source = scratch();
    write(path.join(source, 'pem-4.0.0/LICENSE.md'), 'MIT pem');
    write(path.join(source, 'pem-4.0.0/src/lib.rs'), '');
    spawnSync('tar', ['-czf', path.join(source, 'pem.crate'), '-C', source, 'pem-4.0.0']);
    const crate = fs.readFileSync(path.join(source, 'pem.crate'));
    return {bundle, crate, sha: createHash('sha256').update(crate).digest('hex')};
  }
  const cargo = (name: string, licence: string, scope = 'required') => ({name, version: name === 'pem' ? '4.0.0' : '1.0', scope,
    purl: `pkg:cargo/${name}@1.0`, licenses: [{expression: licence}]});

  test('a component covered by Apache-2.0 points to the wheel\'s Apache text, a crate under other terms ships its archive\'s texts', async () => {
    const {bundle, crate, sha} = wheel([cargo('libc', 'MIT OR Apache-2.0'), cargo('pem', 'MIT'), cargo('cc', 'MIT', 'excluded'),
      {name: 'openssl', version: '4.0.3', purl: 'pkg:generic/openssl@4.0.3'}]);
    const fetched: string[] = [];
    const records = await wheelComponents(bundle, {pins: new Map([['pem-4.0.0.crate', sha]]),
      fetchCrate: async (name: string, version: string) => { fetched.push(`${name}@${version}`); return crate; }});
    const files = Object.fromEntries(records.map((r: {component: string; files: string[]}) => [r.component, r.files]));
    const apache = 'runtime/python/lib/python3.12/site-packages/cryptography-1.0.dist-info/licenses/LICENSE.APACHE';
    assert.deepEqual(files, {'Python package cryptography': [apache, 'runtime/python/lib/python3.12/site-packages/cryptography-1.0.dist-info/licenses/LICENSE.BSD'],
      'Rust crate libc (in the cryptography wheel)': [apache], 'Rust crate pem (in the cryptography wheel)': ['licenses/crates/pem/LICENSE.md'],
      'openssl (C library in the cryptography wheel)': [apache]});
    assert.deepEqual(fetched, ['pem@4.0.0']);
    assert.equal(fs.readFileSync(path.join(bundle, 'licenses/crates/pem/LICENSE.md'), 'utf8'), 'MIT pem');
    assert.deepEqual(indexProblems(bundle, records), []);
  });

  test('a crate archive without a pin, or that does not match it, stops the build', async () => {
    const {bundle, crate} = wheel([cargo('pem', 'MIT')]);
    await assert.rejects(wheelComponents(bundle, {pins: new Map(), fetchCrate: async () => crate}),
      /no pinned SHA-256 for pem-4\.0\.0\.crate in scripts\/bundle\/crates\.sha256/);
    await assert.rejects(wheelComponents(bundle, {pins: new Map([['pem-4.0.0.crate', '0'.repeat(64)]]), fetchCrate: async () => crate}),
      /pem-4\.0\.0\.crate does not match its pinned SHA-256/);
  });

  test('a component whose comma-separated licences are not all covered by Apache-2.0 does not get the Apache text', async () => {
    const {bundle} = wheel([{name: 'mixed', version: '1.0', purl: 'pkg:cargo/mixed@1.0', licenses: [{expression: 'GPL-2.0-only'}, {expression: 'MIT OR Apache-2.0'}]}]);
    await assert.rejects(wheelComponents(bundle, {pins: new Map(), fetchCrate: async () => Buffer.alloc(0)}),
      /no pinned SHA-256 for mixed-1\.0\.crate/);
  });

  test('the pinned crate archives are SHA-256 lines', () => {
    const lines = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/bundle/crates.sha256'), 'utf8').trim().split('\n');
    for (const line of lines) assert.match(line, /^[0-9a-f]{64} {2}[a-z0-9_-]+-[0-9][0-9A-Za-z.+-]*\.crate$/);
  });
});
