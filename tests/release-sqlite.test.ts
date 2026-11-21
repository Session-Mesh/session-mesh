// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/build-sqlite.sh (the pinned SQLite of mesh-history), and what scripts/bootstrap.sh does
// with it when MESH_SQLITE_PREFIX is set. curl, sha256sum, unzip, cc, ar, ranlib and opam are
// stand-ins, so nothing is downloaded or compiled and no opam switch is touched.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PIN = fs.readFileSync(path.join(REPO, 'scripts', 'bundle', 'sqlite.sha256'), 'utf8').split(' ')[0] ?? '';

let scratch = '';
let counter = 0;

function fresh(name: string): string {
  const dir = path.join(scratch, `${name}-${counter++}`);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}

function tool(bin: string, name: string, text: string): void {
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(bin, name), text, {mode: 0o700});
}

// Stand-ins for what build-sqlite.sh calls. `cc --version` prints $FAKE_CC_VERSION; curl records its
// arguments in $CURL_ARGS; sha256sum prints $FAKE_SHA (default: the pin).
function sqliteTools(): string {
  const bin = fresh('bin');
  tool(bin, 'curl', '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_ARGS"\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done\n');
  tool(bin, 'sha256sum', `#!/bin/sh\necho "\${FAKE_SHA:-${PIN}}  -"\n`);
  tool(bin, 'unzip', `#!/bin/sh
while [ "$#" -gt 0 ]; do [ "$1" = -d ] && dest="$2"; shift; done
mkdir -p "$dest/sqlite-amalgamation-3540100"
: > "$dest/sqlite-amalgamation-3540100/sqlite3.c"
printf '#define SQLITE_VERSION  "3.54.1"\\n' > "$dest/sqlite-amalgamation-3540100/sqlite3.h"
`);
  tool(bin, 'cc', '#!/bin/sh\n[ "$1" = --version ] && { echo "${FAKE_CC_VERSION:-fakecc 1.0}"; echo second line; exit 0; }\nprintf \'cc %s\\n\' "$*" >> "$CC_CALLS"\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done\n');
  for (const name of ['ar', 'ranlib']) tool(bin, name, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do { [ "$1" = -o ] || [ "$1" = rcs ]; } && : > "$2"; shift; done\n');
  return bin;
}

interface Run {status: number | null; output: string; curl: string; cc: string}

function buildSqlite(bin: string, prefix: string, extra: NodeJS.ProcessEnv = {}, script = path.join(REPO, 'scripts', 'build-sqlite.sh')): Run {
  const log = fresh('log');
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_ARGS: path.join(log, 'curl'), CC_CALLS: path.join(log, 'cc'), ...extra};
  fs.writeFileSync(env.CURL_ARGS as string, '');
  fs.writeFileSync(env.CC_CALLS as string, '');
  const result = spawnSync('bash', [script, prefix], {env, encoding: 'utf8'});
  return {status: result.status, output: result.stdout + result.stderr,
    curl: fs.readFileSync(env.CURL_ARGS as string, 'utf8'), cc: fs.readFileSync(env.CC_CALLS as string, 'utf8')};
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sqlite-'));
});

after(() => {
  fs.rmSync(scratch, {recursive: true, force: true});
});

describe('build-sqlite.sh', () => {
  test('is executable', () => {
    fs.accessSync(path.join(REPO, 'scripts', 'build-sqlite.sh'), fs.constants.X_OK);
  });

  test('refuses a prefix containing whitespace', () => {
    const prefix = path.join(fresh('ws'), 'with space');
    const run = buildSqlite(sqliteTools(), prefix);
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /must not contain whitespace/);
    assert.equal(fs.existsSync(prefix), false);
    assert.equal(run.curl, '');
  });

  test('refuses an unreadable prefix instead of treating it as empty', {skip: process.getuid?.() === 0}, () => {
    const prefix = fresh('unreadable');
    fs.writeFileSync(path.join(prefix, 'keep'), 'x');
    fs.chmodSync(prefix, 0o300);
    try {
      const run = buildSqlite(sqliteTools(), prefix);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /not readable, writable and searchable/);
      assert.equal(run.curl, '');
    } finally {
      fs.chmodSync(prefix, 0o700);
    }
    assert.deepEqual(fs.readdirSync(prefix), ['keep']);
  });

  test('builds into a missing or empty directory and marks it as its own', () => {
    const bin = sqliteTools();
    const prefix = path.join(fresh('prefix'), 'mesh-sqlite');
    const run = buildSqlite(bin, prefix);
    assert.equal(run.status, 0, run.output);
    assert.ok(fs.existsSync(path.join(prefix, 'lib', 'libsqlite3.a')));
    assert.ok(fs.existsSync(path.join(prefix, '.mesh-sqlite-prefix')));
    assert.equal(buildSqlite(bin, fresh('empty')).status, 0);
  });

  test('refuses a non-empty directory it did not create and leaves every file of it alone', () => {
    const bin = sqliteTools();
    const prefix = fresh('foreign');
    fs.mkdirSync(path.join(prefix, 'lib', 'pkgconfig'), {recursive: true});
    fs.mkdirSync(path.join(prefix, 'include'));
    const files = ['lib/libfoo.so', 'lib/libsqlite3.a', 'lib/pkgconfig/sqlite3.pc', 'include/sqlite3.h', 'include/foo.h', 'notes.txt'];
    for (const file of files) fs.writeFileSync(path.join(prefix, file), `mine ${file}`);
    const run = buildSqlite(bin, prefix);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /is not empty and was not created by this script; use a dedicated directory/);
    assert.equal(run.curl, '', 'nothing is downloaded');
    for (const file of files) assert.equal(fs.readFileSync(path.join(prefix, file), 'utf8'), `mine ${file}`, file);
    assert.equal(fs.existsSync(path.join(prefix, '.mesh-sqlite-prefix')), false);
  });

  test('replaces only the files it installs in a directory it made', () => {
    const bin = sqliteTools();
    const prefix = fresh('own');
    assert.equal(buildSqlite(bin, prefix).status, 0);
    fs.writeFileSync(path.join(prefix, 'lib', 'keep.a'), 'kept');
    fs.writeFileSync(path.join(prefix, 'include', 'keep.h'), 'kept');
    const run = buildSqlite(bin, prefix, {FAKE_CC_VERSION: 'other cc 2.0'});
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /built in/);
    assert.equal(fs.readFileSync(path.join(prefix, 'lib', 'keep.a'), 'utf8'), 'kept');
    assert.equal(fs.readFileSync(path.join(prefix, 'include', 'keep.h'), 'utf8'), 'kept');
  });

  test('refuses an archive that does not match the pinned SHA-256, and installs nothing', () => {
    const prefix = fresh('mismatch');
    const run = buildSqlite(sqliteTools(), prefix, {FAKE_SHA: '0'.repeat(64)});
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /does not match its pinned SHA-256/);
    assert.deepEqual(fs.readdirSync(prefix), []);
    assert.equal(run.cc, '', 'nothing is compiled');
  });

  test('refuses a malformed pin', () => {
    for (const [name, line] of [['short-hash', `${'a'.repeat(63)}  https://sqlite.org/2026/sqlite-amalgamation-3540100.zip`],
      ['http', `${PIN}  http://sqlite.org/2026/sqlite-amalgamation-3540100.zip`], ['empty', '']] as const) {
      const copy = fresh(`pin-${name}`);
      fs.mkdirSync(path.join(copy, 'bundle'));
      fs.copyFileSync(path.join(REPO, 'scripts', 'build-sqlite.sh'), path.join(copy, 'build-sqlite.sh'));
      fs.writeFileSync(path.join(copy, 'bundle', 'sqlite.sha256'), `${line}\n`);
      const prefix = fresh('prefix');
      const run = buildSqlite(sqliteTools(), prefix, {}, path.join(copy, 'build-sqlite.sh'));
      assert.equal(run.status, 1, `${name}: ${run.output}`);
      assert.match(run.output, /bad pin in /, name);
      assert.equal(run.curl, '', name);
      assert.deepEqual(fs.readdirSync(prefix), [], name);
    }
  });

  test('downloads over https only, redirects included', () => {
    const run = buildSqlite(sqliteTools(), fresh('curl'));
    assert.equal(run.status, 0, run.output);
    assert.match(run.curl, /--proto =https --proto-redir =https /);
  });

  test('skips the build when the version, flags, compiler and target are unchanged, rebuilds when one changes', () => {
    const bin = sqliteTools();
    const prefix = fresh('stamp');
    assert.match(buildSqlite(bin, prefix).output, /built in/);
    assert.match(buildSqlite(bin, prefix).output, /already built/);
    assert.match(buildSqlite(bin, prefix, {FAKE_CC_VERSION: 'fakecc 2.0'}).output, /built in/, 'a new compiler version');
    assert.match(buildSqlite(bin, prefix, {FAKE_CC_VERSION: 'fakecc 2.0'}).output, /already built/);
    assert.match(buildSqlite(bin, prefix, {FAKE_CC_VERSION: 'fakecc 2.0', MACOSX_DEPLOYMENT_TARGET: '13.5'}).output, /built in/, 'a new deployment target');
    assert.match(buildSqlite(bin, prefix, {FAKE_CC_VERSION: 'fakecc 2.0', MACOSX_DEPLOYMENT_TARGET: '13.5'}).output, /already built/);
    const stamp = fs.readFileSync(path.join(prefix, 'stamp'), 'utf8');
    assert.match(stamp, /\[fakecc 2\.0\] target=13\.5$/);
    assert.match(stamp, /-DSQLITE_ENABLE_FTS5/);
  });
});

// bootstrap.sh with MESH_SQLITE_PREFIX: opam is a recorder. `opam var --switch=S lib` names $FAKE_LIB; the
// dependency step (--deps-only) writes $FAKE_CMXA there as the binding archive when it is set. The
// switch exists and already reads only the opam repository at the commit of scripts/release-pins.sh.
const PINNED_OPAM_REPOSITORY = /^opam_repository="([^"]+)"$/m.exec(fs.readFileSync(path.join(REPO, 'scripts', 'release-pins.sh'), 'utf8'))?.[1] ?? '';
const FAKE_OPAM = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPAM_CALLS"
case "$*" in
  'switch list --short'*) echo fake-switch ;;
  'repository list --switch=fake-switch --short'*) echo default ;;
  'repository list --all'*) echo '# Repository # Url # Switches(rank)'; echo 'default ${PINNED_OPAM_REPOSITORY} fake-switch' ;;
  *'ocamlc -version') echo 5.3.0 ;;
  'pin list --switch=fake-switch --short') ;;
  *'var --switch=fake-switch lib') echo "$FAKE_LIB" ;;
  *--deps-only*) if [ -n "\${FAKE_CMXA+x}" ]; then mkdir -p "$FAKE_LIB/sqlite3"; printf '%s' "$FAKE_CMXA" > "$FAKE_LIB/sqlite3/sqlite3.cmxa"; fi ;;
esac
`;

describe('bootstrap.sh with MESH_SQLITE_PREFIX', () => {
  function bootstrap(name: string, cmxaBefore: string | null, cmxaAfterDeps: string | null): {status: number | null; output: string; calls: string[]; prefix: string} {
    const bin = sqliteTools();
    tool(bin, 'opam', FAKE_OPAM);
    const root = fresh(name);
    const prefix = path.join(fs.realpathSync(root), 'mesh-sqlite');
    const lib = path.join(root, 'lib');
    fs.mkdirSync(path.join(lib, 'sqlite3'), {recursive: true});
    if (cmxaBefore !== null) fs.writeFileSync(path.join(lib, 'sqlite3', 'sqlite3.cmxa'), cmxaBefore.replaceAll('@PREFIX@', prefix));
    const calls = path.join(root, 'calls');
    fs.writeFileSync(calls, '');
    const extra: NodeJS.ProcessEnv = {OPAM_CALLS: calls, MESH_OPAM_SWITCH: 'fake-switch', MESH_SQLITE_PREFIX: prefix, FAKE_LIB: lib};
    if (cmxaAfterDeps !== null) extra.FAKE_CMXA = cmxaAfterDeps.replaceAll('@PREFIX@', prefix);
    const log = fresh('log');
    const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_ARGS: path.join(log, 'curl'), CC_CALLS: path.join(log, 'cc'), ...extra};
    fs.writeFileSync(env.CURL_ARGS as string, '');
    const result = spawnSync('bash', ['scripts/bootstrap.sh', '--deps-only'], {cwd: REPO, env, encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr, prefix,
      calls: fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)};
  }

  test('accepts a binding linked against the prefix, before and after the dependency step', () => {
    const run = bootstrap('linked', '-L@PREFIX@/lib -lsqlite3', '-L@PREFIX@/lib -lsqlite3');
    assert.equal(run.status, 0, run.output);
    assert.ok(run.calls.some((call) => call.includes('--deps-only')), run.calls.join('\n'));
    assert.ok(run.calls.every((call) => !/^(repository (add|set-url|set-repos)|switch create)/.test(call)), run.calls.join('\n'));
  });

  test('refuses, before the dependency step, a binding installed against another SQLite', () => {
    const run = bootstrap('before', '-lsqlite3', null);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /sqlite3 binding of 'fake-switch' is not linked against .*mesh-sqlite/);
    assert.ok(run.calls.every((call) => !call.includes('--deps-only')), run.calls.join('\n'));
  });

  test('refuses a binding that the dependency step linked against another SQLite', () => {
    const run = bootstrap('after', null, '-L/usr/lib -lsqlite3');
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /sqlite3 binding of 'fake-switch' is not linked against .*mesh-sqlite/);
    assert.ok(run.calls.some((call) => call.includes('--deps-only')), 'the guard ran after the dependency step');
    assert.doesNotMatch(run.output, /dependencies installed/);
  });

  test('refuses a foreign non-empty prefix before touching opam dependencies, and leaves it alone', () => {
    const bin = sqliteTools();
    tool(bin, 'opam', FAKE_OPAM);
    const root = fresh('foreign');
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'precious'), 'data');
    const calls = path.join(root, 'calls');
    fs.writeFileSync(calls, '');
    const log = fresh('log');
    const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, OPAM_CALLS: calls, MESH_OPAM_SWITCH: 'fake-switch', MESH_SQLITE_PREFIX: root,
      FAKE_LIB: path.join(root, 'x'), CURL_ARGS: path.join(log, 'curl'), CC_CALLS: path.join(log, 'cc')};
    const result = spawnSync('bash', ['scripts/bootstrap.sh', '--deps-only'], {cwd: REPO, env, encoding: 'utf8'});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /was not created by this script/);
    assert.equal(fs.readFileSync(path.join(root, 'lib', 'precious'), 'utf8'), 'data');
    assert.ok(!fs.readFileSync(calls, 'utf8').includes('--deps-only'));
  });
});

// The History probe, alone and inside smoke-bundle.sh. mesh-history is a stand-in that prints
// its reply; readelf is a stand-in too.
describe('smoke-history.sh and the bundle check of mesh-history', () => {
  const PINNED = (/amalgamation-(\d)(\d\d)(\d\d)00\.zip/.exec(fs.readFileSync(path.join(REPO, 'scripts', 'bundle', 'sqlite.sha256'), 'utf8')) ?? [])
    .slice(1).map(Number).join('.');
  const GOOD = `{"ok":true,"tokenizer":"unicode61 remove_diacritics 2","sqlite_version":"${PINNED}"}\n{"ok":true}\n{"ok":true,"hits":[{"id":"smoke"}]}`;
  const history = (reply: string): string => `#!/bin/sh\ncat >/dev/null\ncat <<'REPLY'\n${reply}\nREPLY\n`;

  function probe(reply: string): {status: number | null; output: string} {
    const dir = fresh('probe');
    tool(dir, 'mesh-history', history(reply));
    const result = spawnSync('bash', [path.join(REPO, 'scripts', 'smoke-history.sh'), path.join(dir, 'mesh-history'), dir], {encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr};
  }

  test('accepts the accent-folding tokenizer and a hit', () => {
    const run = probe(GOOD);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /indexes and searches/);
  });

  test('refuses the level 1 tokenizer and a search without the hit', () => {
    assert.match(probe(GOOD.replace('remove_diacritics 2', 'remove_diacritics 1')).output, /no remove_diacritics 2 tokenizer/);
    assert.match(probe(GOOD.replace('"id":"smoke"', '"id":"other"')).output, /did not find the ingested chunk/);
    // a build linked against another SQLite (or a helper that does not say which) is refused
    assert.match(probe(GOOD.replace(PINNED, '3.0.0')).output, new RegExp(`does not report the pinned SQLite ${PINNED.replaceAll('.', '\\.')}`));
    assert.match(probe(GOOD.replace(/,"sqlite_version":"[^"]*"/, '')).output, /does not report the pinned SQLite/);
    assert.equal(probe('{"ok":true}').status, 1);
  });

  function bundle(reply: string, readelf: string, readelfExit = 0): {status: number | null; output: string} {
    const dir = fresh('bundle');
    const tree = path.join(dir, 'tree', 'mesh-linux-x86_64');
    tool(tree, 'mesh', '#!/bin/sh\necho DOCTOR-REACHED >&2\nexit 1\n');
    tool(path.join(tree, 'bin'), 'mesh-history', history(reply));
    tool(path.join(tree, 'bin'), 'mesh-profile', `#!/bin/sh
read -r request
[ "$request" = '{"version":1,"op":"profiles.list"}' ] || exit 1
printf '%s\\n' '{"version":1,"ok":true,"data":{"configured":false,"registry_revision":null,"profiles":[]}}'
`);
    const archive = path.join(dir, 'mesh.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.join(dir, 'tree'), 'mesh-linux-x86_64']).status, 0);
    const bin = path.join(dir, 'bin');
    tool(bin, 'readelf', `#!/bin/sh\ncat <<'ELF'\n${readelf}\nELF\nexit ${readelfExit}\n`);
    const result = spawnSync('bash', [path.join(REPO, 'scripts', 'smoke-bundle.sh'), archive],
      {env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr};
  }

  const LINUX = process.platform === 'linux';
  test('refuses a bundle whose mesh-history needs a libsqlite3 shared library', {skip: !LINUX}, () => {
    const run = bundle(GOOD, ' 0x0000000000000001 (NEEDED)             Shared library: [libsqlite3.so.0]');
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /bin\/mesh-history needs a libsqlite3 shared library/);
    assert.doesNotMatch(run.output, /DOCTOR-REACHED/);
  });

  test('fails the bundle when readelf fails', {skip: !LINUX}, () => {
    const run = bundle(GOOD, 'readelf: Error: not an ELF file', 1);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /readelf -d failed/);
    assert.doesNotMatch(run.output, /DOCTOR-REACHED/);
  });

  test('runs the probe on the extracted mesh-history, then goes on', {skip: !LINUX}, () => {
    const run = bundle(GOOD, ' 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]');
    assert.match(run.output, /mesh-history indexes and searches/);
    assert.match(run.output, /DOCTOR-REACHED/);
  });

  test('fails the bundle when the probe fails', {skip: !LINUX}, () => {
    const run = bundle(GOOD.replace('remove_diacritics 2', 'remove_diacritics 1'), '');
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /no remove_diacritics 2 tokenizer/);
    assert.doesNotMatch(run.output, /DOCTOR-REACHED/);
  });
});
