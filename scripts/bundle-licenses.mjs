// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The third-party notices of a bundle (scripts/build-bundle.sh): finds every component the bundle
// embeds, copies the licence texts that are not already in the bundle into licenses/, writes
// licenses/SOURCE (where the corresponding source is) and the index licenses/THIRD-PARTY.md, and
// fails when a component has no licence text or a licence that scripts/bundle/licence-policy.mjs does
// not allow. Run on the build system with the bundle's Node:
//   node bundle-licenses.mjs --bundle DIR --revision REV --source-url URL --source-root DIR --python DIR
//     --python-release TAG --openssl-version VERSION --ocaml-root DIR [--opam-switch SWITCH] [--dirty]
// --python names the extracted python/ directory of the python-build-standalone "full" archive
// matching the bundled CPython (its PYTHON.json and licenses/); --openssl-version is the OpenSSL
// version that CPython reports (ssl.OPENSSL_VERSION).
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {copyInto, filesUnder, licenceFiles, rel, run} from './bundle/licence-files.mjs';
import {applyLicencePolicy} from './bundle/licence-policy.mjs';
import {wheelComponents} from './bundle/wheel-licences.mjs';

// OCaml packages whose source tree vendors C code with its own licence, shipped beside theirs.
const VENDORED = {uring: ['vendor/liburing/LICENSE', 'vendor/liburing/COPYING', 'vendor/liburing/COPYING.GPL']};
// The native programs, as dune targets under ocaml/, and their names in the bundle.
export const NATIVE_TARGETS = {
  'bin/mesh_ptyhost_main.exe': 'mesh-ptyhost', 'bin/mesh_board_mcp_main.exe': 'mesh-board-mcp',
  'bin/mesh_read_main.exe': 'mesh-read', 'platform/cli/mesh_platform_main.exe': 'mesh-platform',
  'bin/mesh_history_main.exe': 'mesh-history', 'bin/mesh_logout_all_main.exe': 'mesh-logout-all',
  'work_read/bin/work_read_main.exe': 'work-read', 'work_mcp/bin/work_mcp_main.exe': 'work-mcp',
};

// ---- OCaml: the opam packages linked into each native program, from dune's link rules.

function opamLinked(options) {
  const switchArgs = options.opamSwitch ? ['--switch', options.opamSwitch] : [];
  // Plain output whatever the caller's colour settings (the macOS release job sets OPAMCOLOR=always):
  // a coloured `opam list` wraps package names in escape sequences that match nothing below.
  const plain = {env: {...process.env, OPAMCOLOR: 'never', CLICOLOR_FORCE: '', FORCE_COLOR: '0'}};
  const opam = (...args) => run('opam', [...args.slice(0, 1), ...switchArgs, ...args.slice(1)], plain).trim();
  const lib = opam('var', 'lib');
  const linked = new Map([['ocaml', new Set(Object.values(NATIVE_TARGETS))]]);
  const archive = new RegExp(`${lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/\\s()"]+)/[^\\s()"]*\\.(cmxa|a)\\b`, 'g');
  for (const [target, program] of Object.entries(NATIVE_TARGETS)) {
    const rules = run('opam', ['exec', ...switchArgs, '--', 'dune', 'rules', '--root', options.ocamlRoot, '-r', target], plain);
    for (const match of rules.matchAll(archive)) {
      if (!linked.has(match[1])) linked.set(match[1], new Set());
      linked.get(match[1]).add(program);
    }
  }
  if (linked.size === 1) throw new Error('bundle: dune names no opam library linked into the native programs');
  return {opam, linked, doc: opam('var', 'doc')};
}

function opamMetadata(opam, packages) {
  const rows = new Map();
  for (const line of opam('list', '--installed', '--columns=name,version,license:', '--short', ...packages).split('\n')) {
    const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (match) rows.set(match[1], {version: match[2], licence: [...match[3].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(', ')});
  }
  return rows;
}

// The opam package's source tree, by opam (checked against the opam repository's checksum).
function opamSource(opam, name, version, scratch) {
  const dir = path.join(scratch, `${name}.${version}`);
  if (!fs.existsSync(dir)) opam('source', `${name}.${version}`, `--dir=${dir}`);
  return dir;
}

export function ocamlComponents(bundle, options) {
  const {opam, linked, doc} = opamLinked(options);
  const metadata = opamMetadata(opam, [...linked.keys()]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-opam-source-'));
  try {
    return [...linked].sort(([a], [b]) => a.localeCompare(b)).map(([name, programs]) => {
      const meta = metadata.get(name);
      if (!meta) throw new Error(`bundle: opam does not list the installed package ${name}`);
      const target = path.join(bundle, 'licenses', 'ocaml', name);
      let dir = path.join(doc, name);
      if (!licenceFiles(dir).length) dir = opamSource(opam, name, meta.version, scratch);
      const files = licenceFiles(dir).map((file) => copyInto(bundle, path.join(dir, file), path.join(target, file)));
      if (!files.length) throw new Error(`bundle: no licence text for the OCaml package ${name} ${meta.version}`);
      const vendored = (VENDORED[name] ?? []).map((file) => {
        const from = path.join(opamSource(opam, name, meta.version, scratch), file);
        if (!fs.existsSync(from)) throw new Error(`bundle: ${name} ${meta.version} has no ${file}`);
        return copyInto(bundle, from, path.join(target, file));
      });
      return {component: `OCaml package ${name}`, version: meta.version, licence: meta.licence || 'see the text',
        files: [...files, ...vendored], note: `linked into ${[...programs].sort().join(', ')}`};
    });
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
}

// ---- CPython: python-build-standalone's own licence metadata for the bundled build (PYTHON.json and
// licenses/), with the reviewed catalogue of that release (scripts/bundle/python-build-standalone.json):
// the component, version and licence of each text and the source archives of each component, as
// pythonbuild/downloads.py names them at that release.

const CATALOGUE = path.join(import.meta.dirname, 'bundle/python-build-standalone.json');

export function pythonCatalogue(release, file = CATALOGUE) {
  const catalogue = JSON.parse(fs.readFileSync(file, 'utf8'))[release];
  if (!catalogue) throw new Error(`bundle: no reviewed catalogue for python-build-standalone ${release} in scripts/bundle/python-build-standalone.json`);
  return catalogue;
}

// The extensions linking each text (python-build-standalone builds them all into libpython). Every
// path PYTHON.json names must be one of its licenses/.
function linkedTexts(info, pythonDir) {
  const uses = new Map();
  for (const [extension, variants] of Object.entries(info.build_info.extensions)) {
    for (const variant of variants) for (const file of variant.license_paths ?? []) {
      if (!fs.existsSync(path.join(pythonDir, file))) throw new Error(`bundle: PYTHON.json names ${file}, which is not in its licenses/`);
      uses.set(path.basename(file), (uses.get(path.basename(file)) ?? new Set()).add(extension));
    }
  }
  return uses;
}

// Whether a text applies to the bundled runtime: linked by an extension (of the two OpenSSL texts, only
// the linked OpenSSL's), or covering files that runtime/python/lib still ships (Tix's scripts).
function textApplies(bundle, entry, extensions, opensslVersion) {
  if (entry.openssl) return Boolean(extensions) && opensslVersion.startsWith(`${entry.openssl}.`);
  if (extensions) return true;
  return (entry.dirs ?? []).some((dir) => fs.existsSync(path.join(bundle, 'runtime/python/lib', dir)));
}

function checkedInfo(bundle, pythonDir) {
  const info = JSON.parse(fs.readFileSync(path.join(pythonDir, 'PYTHON.json'), 'utf8'));
  const bundled = fs.readdirSync(path.join(bundle, 'runtime/python/bin')).find((name) => /^python3\.\d+$/.test(name));
  if (!bundled || !info.python_version.startsWith(bundled.slice('python'.length) + '.')) {
    throw new Error(`bundle: the licence metadata is for CPython ${info.python_version}, not the bundled ${bundled}`);
  }
  if (!fs.existsSync(path.join(pythonDir, info.license_path))) throw new Error(`bundle: PYTHON.json names ${info.license_path}, which is not in its licenses/`);
  return info;
}

// The changes made to the CPython distribution (scripts/build-bundle.sh), stated as the PSF licence
// (clause 3) asks of a derivative work.
export const CPYTHON_CHANGES = 'this bundle removes pip, ensurepip, idlelib, tkinter, turtledemo, the Tcl/Tk scripts ' +
  '(tcl8*, tk8*, Tix*, itcl*, thread2*) and the pip and idle3 commands from the python-build-standalone distribution; ' +
  'nothing else is changed';

const archivesNote = (archives) => archives.map((archive) => `${archive.url} (SHA-256 ${archive.sha256})`).join(', ');

// opensslVersion: the OpenSSL version the bundled runtime reports (ssl.OPENSSL_VERSION, without "OpenSSL ").
export function pythonComponents(bundle, pythonDir, release, {opensslVersion, catalogue = pythonCatalogue(release)}) {
  const info = checkedInfo(bundle, pythonDir);
  const cpython = catalogue.cpython[info.python_version];
  if (!cpython) throw new Error(`bundle: the catalogue of python-build-standalone ${release} names no source for CPython ${info.python_version}`);
  if (!/^\d+\.\d+/.test(opensslVersion ?? '')) throw new Error(`bundle: unknown OpenSSL version of the bundled CPython: ${opensslVersion}`);
  const copy = (name) => copyInto(bundle, path.join(pythonDir, 'licenses', name), path.join(bundle, 'licenses/python', name));
  const uses = linkedTexts(info, pythonDir);
  const records = [{component: 'CPython', version: `${info.python_version} (python-build-standalone ${release})`,
    licence: info.licenses.join(', '), files: [copy(path.basename(info.license_path))],
    note: `runtime/python; ${CPYTHON_CHANGES}; source: ${archivesNote([cpython])} and licenses/SOURCE`, sources: [{name: `CPython ${info.python_version}`, ...cpython}]}];
  const texts = fs.readdirSync(path.join(pythonDir, 'licenses')).filter((name) => name.endsWith('.txt') && name !== path.basename(info.license_path));
  for (const name of texts.sort()) {
    const entry = catalogue.texts[name];
    if (!entry) throw new Error(`bundle: no reviewed licence for ${name} of python-build-standalone ${release} (scripts/bundle/python-build-standalone.json)`);
    const extensions = uses.get(name);
    if (!textApplies(bundle, entry, extensions, opensslVersion)) continue;
    const where = extensions ? `linked into CPython for ${[...extensions].sort().join(', ')}` : 'its scripts are in runtime/python/lib';
    records.push({component: `${entry.name} (in CPython)`, version: entry.version, licence: entry.licence, files: [copy(name)],
      note: `${where}; source: ${archivesNote(entry.archives)}`,
      sources: entry.archives.map((archive) => ({name: `${entry.name} ${entry.version}`, ...archive}))});
  }
  return records;
}

export async function downloadArchive(url) {
  const response = await fetch(url);
  if (!response.ok || !response.url.startsWith('https://')) throw new Error(`bundle: cannot download ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

// The python-build-standalone recipe itself (MPL-2.0): its patches to CPython and its libraries are
// compiled into libpython. Its LICENSE comes from the recipe archive, checked against the catalogue's SHA-256.
export async function recipeComponent(bundle, release, recipe, {fetchArchive = downloadArchive} = {}) {
  const bytes = await fetchArchive(recipe.url);
  if (createHash('sha256').update(bytes).digest('hex') !== recipe.sha256) throw new Error(`bundle: ${recipe.url} does not match its pinned SHA-256`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-recipe-'));
  try {
    fs.writeFileSync(path.join(scratch, 'recipe.tar.gz'), bytes);
    const top = run('tar', ['-tzf', path.join(scratch, 'recipe.tar.gz')]).split('\n')[0].split('/')[0];
    run('tar', ['-xzf', path.join(scratch, 'recipe.tar.gz'), '-C', scratch, `${top}/LICENSE`]);
    const file = copyInto(bundle, path.join(scratch, top, 'LICENSE'), path.join(bundle, 'licenses/python-build-standalone/LICENSE'));
    return {component: 'python-build-standalone (the build recipe)', version: release, licence: 'MPL-2.0', files: [file],
      note: `its patches are compiled into the CPython runtime; source: ${archivesNote([recipe])}, git commit ${recipe.commit}`};
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
}

// ---- Node: the runtime, the npm packages of the TSX compiler and the Go runtime of esbuild.

function goVersion(binary) {
  return /go1\.\d+(\.\d+)?/.exec(fs.readFileSync(binary).toString('latin1'))?.[0] ?? 'unknown';
}

function npmPackage(bundle, dir, sourceRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let files = licenceFiles(dir).map((file) => rel(bundle, path.join(dir, file)));
  let note = 'app/demo-compiler/node_modules';
  // esbuild's platform packages hold only its binary; the licence is the esbuild package's.
  if (!files.length && manifest.name.startsWith('@esbuild/')) {
    files = licenceFiles(path.join(dir, '../../esbuild')).map((file) => rel(bundle, path.join(dir, '../../esbuild', file)));
    note = 'the esbuild binary for this platform; its licence is the esbuild package\'s';
  }
  if (!files.length) throw new Error(`bundle: the npm package ${manifest.name} ships no licence file`);
  const records = [{component: `npm package ${manifest.name}`, version: manifest.version, licence: manifest.license ?? 'see the text', files, note}];
  const binary = path.join(dir, 'bin/esbuild');
  if (manifest.name.startsWith('@esbuild/') && fs.existsSync(binary)) {
    records.push({component: 'Go runtime and standard library (in esbuild)', version: goVersion(binary), licence: 'BSD-3-Clause',
      files: [copyInto(bundle, path.join(sourceRoot, 'scripts/bundle/notices/go.LICENSE'), path.join(bundle, 'licenses/go/LICENSE'))],
      note: 'statically linked into the esbuild binary'});
  }
  return records;
}

export function nodeComponents(bundle, sourceRoot) {
  const licence = path.join(bundle, 'runtime/node/LICENSE');
  if (!fs.existsSync(licence)) throw new Error('bundle: runtime/node/LICENSE is missing');
  const records = [{component: 'Node.js', version: process.version, licence: 'MIT, and the licences of its dependencies listed in the text',
    files: [rel(bundle, licence)], note: 'runtime/node'}];
  const modules = path.join(bundle, 'app/demo-compiler/node_modules');
  const dirs = fs.existsSync(modules) ? fs.readdirSync(modules).filter((name) => !name.startsWith('.')).flatMap((name) => name.startsWith('@')
    ? fs.readdirSync(path.join(modules, name)).map((sub) => path.join(modules, name, sub)) : [path.join(modules, name)]) : [];
  return [...records, ...dirs.sort().flatMap((dir) => npmPackage(bundle, dir, sourceRoot))];
}

// ---- The rest: the optional Roster, the vendored web libraries, the copied system libraries.

// The vendored web libraries pass the same check as the repository's (tools/check-third-party.mjs), on app/.
function checkVendored(bundle, sourceRoot) {
  try {
    run(process.execPath, [path.join(sourceRoot, 'tools/check-third-party.mjs'), path.join(bundle, 'app')], {stdio: 'pipe'});
  } catch (error) {
    throw new Error(`bundle: the vendored web libraries of app/ fail tools/check-third-party.mjs:\n${error.stdout ?? ''}${error.stderr ?? error.message}`);
  }
  return 'tools/check-third-party.mjs';
}

// The SQLite compiled into mesh-history (scripts/build-sqlite.sh): the amalgamation of
// scripts/bundle/sqlite.sha256, whose file name carries the version as XXYYZZ00 (3540100 is 3.54.1).
export function sqliteComponent(bundle, sourceRoot) {
  const pin = fs.readFileSync(path.join(sourceRoot, 'scripts/bundle/sqlite.sha256'), 'utf8');
  const digits = /sqlite-amalgamation-(\d)(\d\d)(\d\d)00\.zip/.exec(pin);
  if (!digits) throw new Error('bundle: scripts/bundle/sqlite.sha256 names no SQLite amalgamation');
  return {component: 'SQLite (in mesh-history)', version: `${digits[1]}.${Number(digits[2])}.${Number(digits[3])}`,
    licence: 'public domain',
    files: [copyInto(bundle, path.join(sourceRoot, 'scripts/bundle/notices/sqlite.LICENSE'), path.join(bundle, 'licenses/sqlite/LICENSE'))],
    note: 'the pinned amalgamation (scripts/bundle/sqlite.sha256), statically linked into bin/mesh-history'};
}

export function otherComponents(bundle, sourceRoot) {
  const records = [];
  const roster = path.join(bundle, 'optional/roster');
  if (fs.existsSync(roster)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(roster, 'package.json'), 'utf8'));
    records.push({component: 'Roster CLIs', version: manifest.version, licence: manifest.license ?? 'see the text',
      files: licenceFiles(roster).map((file) => rel(bundle, path.join(roster, file))), note: 'optional/roster'});
  }
  records.push({component: 'Web libraries vendored in static/vendor', version: 'per file', licence: 'per file, see THIRD_PARTY.md',
    files: ['app/static/vendor/THIRD_PARTY.md'], note: 'their licence texts are in app/LICENSES/', checked: checkVendored(bundle, sourceRoot)});
  records.push(sqliteComponent(bundle, sourceRoot));
  const libs = path.join(bundle, 'licenses/lib');
  for (const name of fs.existsSync(libs) ? fs.readdirSync(libs).sort() : []) {
    const dir = path.join(libs, name);
    const [packageName, version] = fs.readFileSync(path.join(dir, 'PACKAGE'), 'utf8').trim().split(' ');
    const source = path.join(dir, 'SOURCE');
    records.push({component: `system library ${name}`, version: version ?? 'see the package', licence: 'see the text',
      files: filesUnder(dir).filter((file) => !['PACKAGE', 'SOURCE'].includes(path.basename(file))).map((file) => rel(bundle, file)),
      note: `lib/${name}, from the package ${packageName}${fs.existsSync(source) ? `; ${rel(bundle, source)} names its source` : ''}`});
  }
  return records;
}

// ---- The index and the source statement.

// The complete source of the CPython runtime and of what its build links: the build recipe and the
// upstream archives (options.runtime: {release, recipe, provenance, archives}).
function runtimeSourceStatement(runtime) {
  const archives = [runtime.recipe, ...runtime.archives].map((archive) => `  ${archive.name}${archive.commit ? `, git commit ${archive.commit}` : ''}
    ${archive.url}
    SHA-256 ${archive.sha256}`).join('\n');
  return `
runtime/python is the python-build-standalone ${runtime.release} build of CPython. That build statically
links the libraries THIRD-PARTY.md lists "(in CPython)", among them Berkeley DB (Sleepycat licence),
Tcl/Tk and X11, which session-mesh does not use. The complete corresponding source of that runtime
is the build recipe and the upstream archives it builds from. The recipe is under the Mozilla Public
License 2.0 (python-build-standalone/LICENSE); its patches are compiled into the runtime.

${archives}

${runtime.provenance}

Changes to that distribution: ${CPYTHON_CHANGES}.
`;
}

export function sourceStatement(options) {
  const local = options.dirty ? ' This build also included local changes that are not part of that revision.' : '';
  return `session-mesh is free software under the GNU Affero General Public License, version 3 or later
(licenses/LICENSE, licenses/NOTICE). This bundle was built from

  ${options.sourceUrl}
  revision ${options.revision}
${local ? `\n${local.trim()}\n` : ''}
app/ holds the files of that revision except tests/, .github/ and ocaml/. The native programs
libexec/mesh-ptyhost, bin/mesh-board-mcp, bin/mesh-read, bin/mesh-platform, bin/mesh-history,
bin/mesh-logout-all, bin/work-read and bin/work-mcp are built from ocaml/
at that revision, with the opam packages listed in THIRD-PARTY.md, and bin/mesh-history contains the
SQLite amalgamation whose URL and SHA-256 are in scripts/bundle/sqlite.sha256 of the repository
(built by scripts/build-sqlite.sh). The corresponding source is the repository at that revision:

  git clone ${options.sourceUrl}
  git -C ${path.basename(options.sourceUrl).replace(/\.git$/, '')} checkout ${options.revision}
${options.runtime ? runtimeSourceStatement(options.runtime) : ''}`;
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function isJson(text) {
  try { return typeof JSON.parse(text) === 'object'; } catch { return false; }
}

// The problem of one licence file of a component: missing, empty, outside the bundle, or a JSON
// document (a bill of materials names a licence, it does not carry its text).
function fileProblem(bundle, file) {
  const full = path.resolve(bundle, file);
  const inside = full.startsWith(path.resolve(bundle) + path.sep);
  const stat = inside && fs.existsSync(full) ? fs.lstatSync(full) : null;
  if (!stat?.isFile() || stat.size === 0) return `${file} is not a non-empty file of the bundle`;
  if (/\.json$/i.test(file) || isJson(fs.readFileSync(full, 'utf8'))) return `${file} is a JSON document, not a licence text`;
  return null;
}

// Every component must name at least one file, and each file must be a non-empty regular file of
// the bundle that is not JSON: the problems, one line each (none when the index is complete).
export function indexProblems(bundle, records) {
  const problems = [];
  for (const record of records) {
    if (!record.files?.length) problems.push(`${record.component}: no licence file`);
    for (const file of record.files ?? []) {
      const problem = fileProblem(bundle, file);
      if (problem) problems.push(`${record.component}: ${problem}`);
    }
  }
  return problems;
}

export function renderIndex(records) {
  const rows = records.map((r) => `| ${cell(r.component)} | ${cell(r.version)} | ${cell(r.licence)} | ${r.files.map((f) => `\`${cell(f)}\``).join('<br>')} | ${cell(r.note ?? '')} |`);
  return `# Third-party components of this bundle

Each component the bundle embeds, its version, its licence and the files of the bundle that hold
its licence text (paths from the bundle's root). licenses/SOURCE says where the corresponding
source of session-mesh, its native programs and its CPython runtime is.

| Component | Version | Licence | Licence text | Notes |
|---|---|---|---|---|
${rows.join('\n')}
`;
}

// Writes licenses/SOURCE and licenses/THIRD-PARTY.md, or fails when a component has no licence text
// or a licence outside scripts/bundle/licence-policy.mjs.
export function writeNotices(bundle, records, options) {
  const read = (file) => { try { return fs.readFileSync(path.resolve(bundle, file)); } catch { return Buffer.alloc(0); } };
  const policy = applyLicencePolicy(records, read);
  const problems = [...indexProblems(bundle, records), ...policy.problems];
  if (problems.length) throw new Error(`bundle: incomplete or refused third-party notices:\n${problems.join('\n')}`);
  fs.writeFileSync(path.join(bundle, 'licenses/SOURCE'), sourceStatement(options));
  fs.writeFileSync(path.join(bundle, 'licenses/THIRD-PARTY.md'), renderIndex(policy.records));
}

function parseArguments(argv) {
  const options = {dirty: false};
  const names = {'--bundle': 'bundle', '--revision': 'revision', '--source-url': 'sourceUrl', '--python': 'python',
    '--python-release': 'pythonRelease', '--ocaml-root': 'ocamlRoot', '--opam-switch': 'opamSwitch', '--source-root': 'sourceRoot',
    '--openssl-version': 'opensslVersion'};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--dirty') { options.dirty = true; continue; }
    const name = names[argv[index]];
    if (!name || argv[index + 1] === undefined) throw new Error(`bundle-licenses: unexpected argument ${argv[index]}`);
    options[name] = argv[++index];
  }
  for (const name of ['bundle', 'revision', 'sourceUrl', 'python', 'pythonRelease', 'ocamlRoot', 'sourceRoot', 'opensslVersion']) {
    if (!options[name]) throw new Error(`bundle-licenses: --${name} is required`);
  }
  return options;
}

export async function main(argv) {
  const options = parseArguments(argv);
  const bundle = path.resolve(options.bundle);
  const catalogue = pythonCatalogue(options.pythonRelease);
  const python = pythonComponents(bundle, options.python, options.pythonRelease, {opensslVersion: options.opensslVersion, catalogue});
  const records = [
    {component: 'session-mesh', version: options.revision, licence: 'AGPL-3.0-or-later', files: ['licenses/LICENSE', 'licenses/NOTICE'],
      note: 'app/ and the native programs; licenses/SOURCE names the source'},
    ...ocamlComponents(bundle, options), ...python,
    await recipeComponent(bundle, options.pythonRelease, catalogue.recipe),
    ...await wheelComponents(bundle), ...nodeComponents(bundle, options.sourceRoot), ...otherComponents(bundle, options.sourceRoot),
  ];
  const runtime = {release: options.pythonRelease, recipe: catalogue.recipe, provenance: catalogue.provenance,
    archives: python.flatMap((record) => record.sources ?? [])};
  writeNotices(bundle, records, {...options, runtime});
  return records.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(`bundle: ${await main(process.argv.slice(2))} components in licenses/THIRD-PARTY.md`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
