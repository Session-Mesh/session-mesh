// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The scripts of the native programs of a release, with the platform tools replaced by stand-ins,
// so that they run on any Linux machine:
// - scripts/release-check-macos.sh: which `otool` outputs pass the link and deployment-target
//   checks of the macOS programs, and which bundles pass the checks of the macOS bundle;
// - scripts/release-build-static.sh: which opam commands it issues on a fresh and on a restored
//   opam root (the repository is moved to the pinned commit on every run);
// - scripts/release-smoke.sh: a clear refusal when `nc` is missing.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(REPO, 'scripts', 'release-check-macos.sh');
const SYSTEM_ONLY = 'out/mesh-ptyhost:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)\n';

let scratch = '';

function writeExecutable(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text, {mode: 0o700});
  return file;
}

// A `otool` that prints $FAKE_OTOOL_L for -L and $FAKE_OTOOL_LOAD for -l.
function fakeTools(name: string, otoolL: string, otoolLoad: string): {bin: string; env: NodeJS.ProcessEnv} {
  const bin = path.join(scratch, name, 'bin');
  const stdlib = path.join(scratch, name, 'stdlib');
  fs.mkdirSync(stdlib, {recursive: true});
  fs.writeFileSync(path.join(stdlib, 'libasmrun.a'), '');
  fs.writeFileSync(path.join(scratch, name, 'L'), otoolL);
  fs.writeFileSync(path.join(scratch, name, 'l'), otoolLoad);
  writeExecutable(path.join(bin, 'otool'),
    `#!/bin/sh\ncase "$1" in -L) cat "${scratch}/${name}/L" ;; -l) cat "${scratch}/${name}/l" ;; *) exit 9 ;; esac\n`);
  writeExecutable(path.join(bin, 'ocamlfind'), `#!/bin/sh\necho "${stdlib}"\n`);
  return {bin, env: {...process.env, PATH: `${bin}:${process.env.PATH}`}};
}

function check(env: NodeJS.ProcessEnv, args: string[]): {status: number | null; output: string} {
  const result = spawnSync('bash', [CHECK, ...args], {env, encoding: 'utf8'});
  return {status: result.status, output: result.stdout + result.stderr};
}

function buildVersion(minos: string): string {
  return `Load command 1\n      cmd LC_BUILD_VERSION\n  cmdsize 24\n platform 1\n    minos ${minos}\n      sdk 14.2\n`;
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-scripts-'));
});

after(() => {
  fs.rmSync(scratch, {recursive: true, force: true});
});

describe('release-check-macos.sh links', () => {
  test('accepts an executable that links libSystem only', () => {
    const {env} = fakeTools('links-ok', SYSTEM_ONLY, '');
    assert.equal(check(env, ['links', 'out/mesh-ptyhost']).status, 0);
  });

  for (const [label, extra] of [
    ['libc++', '\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n'],
    ['libobjc', '\t/usr/lib/libobjc.A.dylib (compatibility version 1.0.0)\n'],
    ['a Homebrew library', '\t/opt/homebrew/lib/libgmp.10.dylib (compatibility version 16.0.0)\n'],
  ]) {
    test(`refuses an executable that also links ${label}`, () => {
      const {env} = fakeTools(`links-${label.replace(/\W/g, '')}`, SYSTEM_ONLY + extra, '');
      const result = check(env, ['links', 'out/mesh-ptyhost']);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /must link \/usr\/lib\/libSystem\.B\.dylib only/);
    });
  }

  test('refuses an executable that links nothing it can name', () => {
    const {env} = fakeTools('links-none', 'out/mesh-ptyhost:\n', '');
    assert.equal(check(env, ['links', 'out/mesh-ptyhost']).status, 1);
  });
});

describe('release-check-macos.sh linker-log', () => {
  test('refuses a build log with a newer-macOS linker warning, accepts a clean one', () => {
    const {env} = fakeTools('log', '', '');
    const bad = path.join(scratch, 'bad.log');
    fs.writeFileSync(bad, 'ld: warning: object file (libasmrun.a[2](x.o)) was built for newer macOS version (14.0) than being linked (13.0)\n');
    const good = path.join(scratch, 'good.log');
    fs.writeFileSync(good, 'Done: 120/120\n');
    const refused = check(env, ['linker-log', bad]);
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, /built for a newer macOS version than the deployment target/);
    assert.equal(check(env, ['linker-log', good]).status, 0);
    assert.equal(check(env, ['linker-log', path.join(scratch, 'missing.log')]).status, 2);
  });
});

describe('release-check-macos.sh runtime-minos', () => {
  test('accepts a runtime built for the deployment target or older', () => {
    const {env} = fakeTools('minos-ok', '', buildVersion('13.0') + buildVersion('12.3')
      + 'Load command 2\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 11.0\n      sdk 14.2\n');
    const result = check(env, ['runtime-minos', '13.0']);
    assert.equal(result.status, 0, result.output);
  });

  test('refuses a runtime with an object built for a newer macOS', () => {
    const {env} = fakeTools('minos-new', '', buildVersion('13.0') + buildVersion('14.0'));
    const result = check(env, ['runtime-minos', '13.0']);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /built for macOS 14\.0, newer than the deployment target 13\.0/);
  });

  test('compares versions numerically (13.10 is newer than 13.2)', () => {
    const {env} = fakeTools('minos-numeric', '', buildVersion('13.10'));
    assert.equal(check(env, ['runtime-minos', '13.2']).status, 1);
    assert.equal(check(env, ['runtime-minos', '13.10.0']).status, 0);
  });

  test('refuses a runtime that records no macOS version', () => {
    const {env} = fakeTools('minos-none', '', 'Load command 0\n      cmd LC_SEGMENT_64\n');
    const result = check(env, ['runtime-minos', '13.0']);
    assert.equal(result.status, 1);
    assert.match(result.output, /no macOS version recorded/);
  });
});

// opam, apk and strip are recorders; `opam exec ... dune build` creates the eight programs. The
// switch reads only the default repository, which the script has set to the pin; the repository
// listing has the layout of opam 2.6.
const FAKE_OPAM = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPAM_CALLS"
case "$*" in
  'switch list --short'*) echo static ;;
  'repository list --switch=static --short'*) echo default ;;
  'repository list --all'*) printf '# Repository # Url # Switches(rank)\\ndefault      %s <default>\\n' "$PINNED_REPOSITORY" ;;
  *'ocamlc -version') echo 5.3.0 ;;
  *'dune build'*) mkdir -p _build/install/default/bin
    for program in mesh-ptyhost mesh-board-mcp mesh-read mesh-platform mesh-history mesh-logout-all work-read work-mcp; do : > "_build/install/default/bin/$program"; done ;;
esac
`;

function buildStatic(name: string, prepareRoot: (root: string) => void): string[] {
  const bin = path.join(scratch, name, 'bin');
  writeExecutable(path.join(bin, 'opam'), FAKE_OPAM);
  writeExecutable(path.join(bin, 'apk'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(bin, 'strip'), '#!/bin/sh\nexit 0\n');
  // scripts/build-sqlite.sh downloads, checks, unpacks and compiles the pinned amalgamation: stand-ins for
  // curl, sha256sum, unzip, cc, ar and ranlib make it run without the network or a 9 MB compilation.
  writeExecutable(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done\n');
  writeExecutable(path.join(bin, 'sha256sum'), '#!/bin/sh\necho "$SQLITE_PIN  -"\n');
  writeExecutable(path.join(bin, 'unzip'), `#!/bin/sh
while [ "$#" -gt 0 ]; do [ "$1" = -d ] && dest="$2"; shift; done
mkdir -p "$dest/sqlite-amalgamation-3540100"
: > "$dest/sqlite-amalgamation-3540100/sqlite3.c"
printf '#define SQLITE_VERSION  "3.54.1"\\n' > "$dest/sqlite-amalgamation-3540100/sqlite3.h"
`);
  for (const tool of ['cc', 'ar', 'ranlib']) writeExecutable(path.join(bin, tool), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do { [ "$1" = -o ] || [ "$1" = rcs ]; } && : > "$2"; shift; done\n');
  writeExecutable(path.join(bin, 'chown'), '#!/bin/sh\nprintf \'chown %s\\n\' "$*" >> "$OPAM_CALLS"\n');
  const root = path.join(scratch, name, 'opam');
  fs.mkdirSync(root, {recursive: true});
  prepareRoot(root);
  const calls = path.join(scratch, name, 'calls');
  fs.writeFileSync(calls, '');
  const tmp = path.join(scratch, name, 'tmp');
  fs.mkdirSync(tmp);
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, OPAM_CALLS: calls, RELEASE_OPAM_ROOT: root, TMPDIR: tmp,
    SQLITE_PIN: fs.readFileSync(path.join(REPO, 'scripts', 'bundle', 'sqlite.sha256'), 'utf8').split(' ')[0],
    PINNED_REPOSITORY: /^opam_repository="([^"]+)"$/m.exec(fs.readFileSync(path.join(REPO, 'scripts', 'release-pins.sh'), 'utf8'))?.[1] ?? ''};
  const result = spawnSync('bash', ['scripts/release-build-static.sh', REPO, path.join(scratch, name, 'out')],
    {cwd: REPO, env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(scratch, name, 'out')).sort(),
    ['mesh-board-mcp', 'mesh-history', 'mesh-logout-all', 'mesh-platform', 'mesh-ptyhost', 'mesh-read', 'work-mcp', 'work-read'],
    'the eight programs are copied out');
  assert.deepEqual(fs.readdirSync(tmp), [], 'the copy of the repository it builds in is removed');
  return fs.readFileSync(calls, 'utf8').split('\n').filter((line) => !line.includes('--switch=static'));
}

describe('release-build-static.sh opam repository', () => {
  const pins = fs.readFileSync(path.join(REPO, 'scripts', 'release-pins.sh'), 'utf8');
  const pinned = /^opam_repository="([^"]+)"$/m.exec(pins)?.[1] ?? '';

  test('the pins file names a fixed opam repository commit', () => {
    assert.match(pinned, /#[0-9a-f]{40}$/);
  });

  test('a fresh root is initialised at the pin, then set to it and updated', () => {
    const calls = buildStatic('fresh', () => {});
    assert.deepEqual(calls.filter((line) => /^(init|repository (?!list )|update|switch create)/.test(line)), [
      `init --bare --disable-sandboxing --no-setup default ${pinned}`,
      `repository set-url default ${pinned}`,
      'update default',
      'switch create static ocaml-variants.5.3.0+options ocaml-option-static',
    ]);
  });

  test('a restored root keeps its switch but is moved to the pin and updated', () => {
    const calls = buildStatic('restored', (root) => {
      fs.writeFileSync(path.join(root, 'config'), 'opam-version: "2.0"\n');
      fs.mkdirSync(path.join(root, 'static'));
    });
    assert.deepEqual(calls.filter((line) => /^(init|repository (?!list )|update|switch create)/.test(line)), [
      `repository set-url default ${pinned}`,
      'update default',
    ]);
  });

  // A root restored from a cache belongs to the runner user; git refuses the sources opam
  // checked out in it unless the container's root user owns it, before any opam command.
  test('the container takes ownership of a restored root before the first opam command', () => {
    const calls = buildStatic('ownership', (root) => {
      fs.writeFileSync(path.join(root, 'config'), 'opam-version: "2.0"\n');
    });
    assert.match(calls[0] ?? '', /^chown -R 0:0 .+\/ownership\/opam$/, calls.join('\n'));
  });

  // The release executables carry SQLite: the pinned amalgamation is built inside the opam root (so a
  // cached root keeps the path the binding recorded) and bootstrap.sh points the binding at it.
  test('builds the pinned SQLite inside the opam root, with its pkg-config file', () => {
    buildStatic('sqlite', () => {});
    const prefix = path.join(scratch, 'sqlite', 'opam', 'mesh-sqlite');
    const pc = fs.readFileSync(path.join(prefix, 'lib', 'pkgconfig', 'sqlite3.pc'), 'utf8');
    assert.match(pc, /^Version: 3\.54\.1$/m);
    assert.match(pc, /^Libs: -L\$\{libdir\} -lsqlite3 -lm -lpthread$/m);
    assert.ok(fs.existsSync(path.join(prefix, 'lib', 'libsqlite3.a')));
    assert.ok(fs.existsSync(path.join(prefix, 'include', 'sqlite3.h')));
  });

  test('the SQLite pin is one https URL of an amalgamation with its SHA-256', () => {
    const pin = fs.readFileSync(path.join(REPO, 'scripts', 'bundle', 'sqlite.sha256'), 'utf8');
    assert.match(pin, /^[0-9a-f]{64}  https:\/\/sqlite\.org\/\d{4}\/sqlite-amalgamation-\d{5}00\.zip\n$/);
  });

  test('installs the system package of the gmp dependency (libgmp.a) with the toolchain', () => {
    assert.match(fs.readFileSync(path.join(REPO, 'scripts', 'release-build-static.sh'), 'utf8'), /apk add [^>]*\bgmp-dev\b/);
  });
});

describe('release-smoke.sh', () => {
  test('refuses with a clear message when nc is missing', () => {
    const empty = fs.mkdtempSync(path.join(scratch, 'empty-path-'));
    const directory = fs.mkdtempSync(path.join(scratch, 'binaries-'));
    const result = spawnSync('/bin/bash', [path.join(REPO, 'scripts', 'release-smoke.sh'), directory],
      {env: {PATH: empty}, encoding: 'utf8'});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nc \(netcat with -U, e\.g\. netcat-openbsd\) is required/);
  });

  // GNU netcat 0.7.1 has no -U; OpenBSD netcat and the macOS one list U in their usage line.
  const probe = (usage: string) => {
    const fakes = fs.mkdtempSync(path.join(scratch, 'fake-nc-'));
    writeExecutable(path.join(fakes, 'nc'), `#!/bin/sh\ncat <<'EOF'\n${usage}\nEOF\nexit 1\n`);
    const directory = fs.mkdtempSync(path.join(scratch, 'binaries-'));
    return spawnSync('/bin/bash', [path.join(REPO, 'scripts', 'release-smoke.sh'), directory],
      {env: {PATH: `${fakes}:/usr/bin:/bin`}, encoding: 'utf8'});
  };

  test('refuses at once, naming OpenBSD netcat, when nc has no -U (GNU netcat)', () => {
    const result = probe('GNU netcat 0.7.1, a rewrite of the famous networking tool.\nBasic usages:\nconnect to somewhere:  nc [options] hostname port [port] ...');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no -U option; OpenBSD netcat is required/);
  });

  test('accepts the usage lines of OpenBSD netcat and of the macOS one', () => {
    for (const usage of ['usage: nc [-46bCDdFhIklNnrStUuvZz] [-I length] [-i interval]', 'usage: nc [-46AacCDdFhklnrtUuvz] [-b boundif] [-i interval]']) {
      assert.doesNotMatch(probe(usage).stderr, /no -U option/, usage);
    }
  });
});

// The bundle check: each "Mach-O" file of the archive is a text that the stand-in otool reads:
// `minos X` (LC_BUILD_VERSION), `dep PATH` (a library it loads), `id PATH` (its own install name).
describe('release-check-macos.sh bundle', () => {
  function bundleCheck(name: string, files: Record<string, string>, target = '13.5') {
    const dir = path.join(scratch, `bundle-${name}`);
    const tree = path.join(dir, 'tree', 'mesh-macos-arm64');
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tree, file)), {recursive: true});
      fs.writeFileSync(path.join(tree, file), text);
    }
    const archive = path.join(dir, 'mesh-macos-arm64.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.join(dir, 'tree'), 'mesh-macos-arm64']).status, 0);
    const bin = path.join(dir, 'bin');
    writeExecutable(path.join(bin, 'file'), '#!/bin/sh\ncase "$1" in *.txt) echo "$1: ASCII text" ;; *) echo "$1: Mach-O 64-bit executable arm64" ;; esac\n');
    writeExecutable(path.join(bin, 'otool'), `#!/bin/sh
case "$1" in
  -l) sed -n 's/^minos \\(.*\\)/Load command 1\\n      cmd LC_BUILD_VERSION\\n    minos \\1/p' "$2" ;;
  -L) echo "$2:"; sed -n 's/^\\(dep\\|id\\) \\(.*\\)/\\t\\2 (compatibility version 1.0.0)/p' "$2" ;;
  -D) echo "$2:"; sed -n 's/^id //p' "$2" ;;
esac
`);
    return check({...process.env, PATH: `${bin}:${process.env.PATH}`}, ['bundle', archive, target]);
  }
  const SYSTEM = 'minos 13.0\ndep /usr/lib/libSystem.B.dylib\n';

  test('accepts programs, a library with its own install name and relative dependencies, built for the target or older', () => {
    const result = bundleCheck('ok', {'runtime/node/bin/node': 'minos 13.5\ndep /usr/lib/libc++.1.dylib\n', 'libexec/mesh-ptyhost': SYSTEM,
      'lib/libfoo.dylib': 'minos 11.0\nid /opt/homebrew/opt/foo/lib/libfoo.dylib\ndep /System/Library/Frameworks/CoreFoundation.framework/CoreFoundation\n',
      'runtime/python/bin/python3.12': 'minos 11.0\ndep @executable_path/../lib/libpython3.12.dylib\n', 'notes.txt': 'not a program'});
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /bundle: 4 Mach-O files, each built for macOS 13\.5 or older/);
  });

  test('refuses a file built for a newer macOS than the target', () => {
    const result = bundleCheck('new', {'libexec/mesh-ptyhost': SYSTEM, 'runtime/node/bin/node': 'minos 14.0\n'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /runtime\/node\/bin\/node was built for macOS 14\.0, newer than the deployment target 13\.5/);
  });

  test('refuses a file that loads a library from outside the bundle and the system', () => {
    const result = bundleCheck('foreign', {'bin/mesh-read': 'minos 13.0\ndep /opt/homebrew/lib/libgmp.10.dylib\ndep /usr/lib/libSystem.B.dylib\n'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /bin\/mesh-read loads \/opt\/homebrew\/lib\/libgmp\.10\.dylib from outside the bundle and the system/);
  });

  test('refuses a system prefix that climbs out of itself, a dot component, and a path that is neither absolute nor an @-form', () => {
    for (const dependency of ['/usr/lib/../../opt/homebrew/lib/libgmp.dylib', '/System/Library/./x.dylib', 'libgmp.dylib', 'lib/libgmp.dylib']) {
      const result = bundleCheck('dots', {'bin/mesh-read': `minos 13.0\ndep ${dependency}\ndep /usr/lib/libSystem.B.dylib\n`});
      assert.equal(result.status, 1, `${dependency}: ${result.output}`);
      assert.match(result.output, new RegExp(`bin/mesh-read loads ${dependency.replace(/[.\\/]/g, '\\$&')} from outside`));
    }
  });

  test('refuses an archive without any Mach-O file, and a missing archive', () => {
    assert.equal(bundleCheck('empty', {'notes.txt': 'text'}).status, 1);
    assert.equal(check(process.env, ['bundle', path.join(scratch, 'missing.tar.gz'), '13.5']).status, 2);
  });
});
