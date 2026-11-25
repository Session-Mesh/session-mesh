// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Behaviour of the release and bundle helper scripts, run on any Linux machine:
// - scripts/release-pins.sh: the opam repository commit the release builds read;
// - scripts/release-stamp-installer.sh: the stamp of install.sh (scripts/release-assets.sh is
//   tests/release-assets.test.ts, the native release scripts tests/release-native-scripts.test.ts);
// - scripts/build-bundle.sh and scripts/bundle-native-libs.sh: the pinned Node archive, the
//   licences of the libraries a Linux bundle copies (Debian, Arch and RPM build systems), and the
//   refusal of any non-system library in a macOS bundle.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

let scratch = '';

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-scripts-'));
});

after(() => {
  fs.rmSync(scratch, {recursive: true, force: true});
});

test('the pins file names a fixed opam repository commit', () => {
  const pins = fs.readFileSync(path.join(REPO, 'scripts', 'release-pins.sh'), 'utf8');
  assert.match(/^opam_repository="([^"]+)"$/m.exec(pins)?.[1] ?? '', /#[0-9a-f]{40}$/);
});

const STAMP = path.join(REPO, 'scripts', 'release-stamp-installer.sh');
const BLOCK = "# @release-stamp-begin\nMESH_RELEASE_TAG=''\nMESH_RELEASE_SUMS=''\n# @release-stamp-end\n";
const INSTALLER = `#!/usr/bin/env bash\nset -euo pipefail\n\n${BLOCK}\nprintf '%s|%s\\n' "$MESH_RELEASE_TAG" "$MESH_RELEASE_SUMS"\n`;

function stamp(name: string, installer: string, tag: string, sums: string) {
  const directory = fs.mkdtempSync(path.join(scratch, `stamp-${name}-`));
  fs.writeFileSync(path.join(directory, 'install.sh'), installer);
  fs.writeFileSync(path.join(directory, 'sums'), sums);
  const output = path.join(directory, 'stamped.sh');
  const result = spawnSync('bash', [STAMP, path.join(directory, 'install.sh'), tag, path.join(directory, 'sums'), output], {encoding: 'utf8'});
  return {status: result.status, output: result.stdout + result.stderr, file: output};
}

describe('release-stamp-installer.sh', () => {
  const sums = `${'a'.repeat(64)}  mesh-linux-arm64.tar.gz\n${'b'.repeat(64)}  mesh-linux-x86_64.tar.gz\n`;

  test('replaces the empty block by the tag and the checksums, and changes nothing else', () => {
    const result = stamp('ok', INSTALLER, 'v1.2.3', sums);
    assert.equal(result.status, 0, result.output);
    const stamped = fs.readFileSync(result.file, 'utf8');
    assert.equal(stamped, INSTALLER.replace(BLOCK, `# @release-stamp-begin\nMESH_RELEASE_TAG='v1.2.3'\nMESH_RELEASE_SUMS='${sums.trimEnd()}'\n# @release-stamp-end\n`));
    assert.equal(fs.statSync(result.file).mode & 0o777, 0o755);
    const ran = spawnSync('bash', [result.file], {encoding: 'utf8'});
    assert.equal(ran.stdout, `v1.2.3|${sums}`);
  });

  test("stamps the repository's own install.sh, whose block is the committed one", () => {
    const installer = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
    assert.equal(installer.split(BLOCK).length, 2, 'install.sh holds the stamp block exactly once');
    const result = stamp('repo', installer, 'v1.2.3', sums);
    assert.equal(result.status, 0, result.output);
    assert.equal(spawnSync('bash', ['-n', result.file]).status, 0);
  });

  const refusals: [string, string, string, string, RegExp][] = [
    ['a missing block', INSTALLER.replace(BLOCK, ''), 'v1.2.3', sums, /stamp block missing/],
    ['a duplicated block', INSTALLER + BLOCK, 'v1.2.3', sums, /stamp block duplicated/],
    ['an already stamped block', INSTALLER.replace("TAG=''", "TAG='v1.0.0'"), 'v1.2.3', sums, /not the committed empty block/],
    ['a block with an extra line', INSTALLER.replace("TAG=''\n", "TAG=''\nx=1\n"), 'v1.2.3', sums, /not the committed empty block/],
    ['a tag outside the pattern', INSTALLER, 'v1.2', sums, /not a release tag: v1\.2/],
    ['a tag with a quote', INSTALLER, "v1.2.3-a'b", sums, /not a release tag/],
    ['a short hash', INSTALLER, 'v1.2.3', `${'a'.repeat(63)}  x\n`, /not a '<sha256>  <asset>' line/],
    ['an asset name with a quote', INSTALLER, 'v1.2.3', `${'a'.repeat(64)}  x'y\n`, /not a '<sha256>  <asset>' line/],
    ['a sums file listing install.sh', INSTALLER, 'v1.2.3', `${'a'.repeat(64)}  install.sh\n`, /must not list install\.sh/],
    ['an empty sums file', INSTALLER, 'v1.2.3', '', /is empty/],
  ];
  for (const [label, installer, tag, list, pattern] of refusals) {
    test(`refuses ${label}, writing nothing`, () => {
      const result = stamp(label.replace(/\W/g, ''), installer, tag, list);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, pattern);
      assert.ok(!fs.existsSync(result.file));
    });
  }
});

describe('smoke-profile.sh: the release helper protocol', () => {
  const expected = '{"version":1,"ok":true,"data":{"configured":false,"registry_revision":null,"profiles":[]}}';
  function probe(output = expected, status = 0) {
    const dir = fs.mkdtempSync(path.join(scratch, 'profile-smoke-'));
    const helper = path.join(dir, 'mesh-profile');
    const request = path.join(dir, 'request');
    fs.writeFileSync(helper, `#!/bin/sh
test "$HOME" = '${dir}' || exit 95
test "$MESH_CONF_DIR" = '${dir}/profile-config' || exit 95
test -z "\${MESH_PROFILE_CMD:-}" || exit 95
cat > '${request}'
printf '%s\\n' '${output}'
exit ${status}
`, {mode: 0o755});
    const result = spawnSync('bash', [path.join(REPO, 'scripts/smoke-profile.sh'), helper, dir], {encoding: 'utf8',
      env: {...process.env, MESH_PROFILE_CMD: '/must-not-run', MESH_CONF_DIR: '/must-not-read'}});
    return {...result, dir, request};
  }

  test('reads the packaged helper protocol with only a fresh private configuration', () => {
    const result = probe();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(result.request, 'utf8'), '{"version":1,"op":"profiles.list"}\n');
    assert.equal(fs.statSync(path.join(result.dir, 'profile-config')).mode & 0o777, 0o700);
  });

  test('a missing helper, wrong protocol or failing helper refuses qualification', () => {
    for (const [output, status] of [['{}', 0], [expected, 1]] as const) {
      const result = probe(output, status);
      assert.notEqual(result.status, 0, result.stderr);
    }
    const dir = fs.mkdtempSync(path.join(scratch, 'profile-missing-'));
    const result = spawnSync('bash', [path.join(REPO, 'scripts/smoke-profile.sh'), path.join(dir, 'absent'), dir]);
    assert.notEqual(result.status, 0);
  });

  test('both native release and bundle qualification invoke the profile protocol check', () => {
    assert.match(fs.readFileSync(path.join(REPO, 'scripts/release-smoke.sh'), 'utf8'),
      /bash "\$\(dirname "\$0"\)\/smoke-profile\.sh" "\$bin\/mesh-profile" "\$runtime"/);
    assert.match(fs.readFileSync(path.join(REPO, 'scripts/smoke-bundle.sh'), 'utf8'),
      /bash "\$\(dirname "\$0"\)\/smoke-profile\.sh" "\$bundle\/bin\/mesh-profile" "\$scratch"/);
  });
});

// scripts/build-bundle.sh downloads Node, whose archive must match the SHA-256 pinned in the
// repository (scripts/bundle/node.sha256), never a checksum list from the same server. Run up to
// that check with stand-ins: uv and patchelf only need to exist, curl serves other bytes.
describe('build-bundle.sh: the Node archive', () => {
  const PINS = path.join(REPO, 'scripts', 'bundle', 'node.sha256');
  const version = /NODE_VERSION=\$\{MESH_BUNDLE_NODE_VERSION:-([0-9.]+)\}/.exec(fs.readFileSync(path.join(REPO, 'scripts', 'build-bundle.sh'), 'utf8'))?.[1];

  function build(nodeVersion: string, profile: 'present' | 'missing' | 'not-executable' = 'present', inspectCopy = false) {
    const dir = fs.mkdtempSync(path.join(scratch, 'build-'));
    const fakes = path.join(dir, 'fakes');
    const native = path.join(dir, 'native');
    fs.mkdirSync(fakes);
    fs.mkdirSync(native);
    const log = path.join(dir, 'curl.log');
    fs.writeFileSync(path.join(fakes, 'curl'), `#!/bin/bash\necho "$*" >> '${log}'\nwhile (($#)); do [[ $1 == -o ]] && printf other > "$2"; shift; done\n`, {mode: 0o755});
    for (const name of ['uv', 'patchelf', 'zstd']) fs.writeFileSync(path.join(fakes, name), '#!/bin/sh\nexit 97\n', {mode: 0o755});
    for (const name of ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-read', 'mesh-platform', 'mesh-history', 'mesh-logout-all', 'mesh-open', 'mesh-profile', 'work-read', 'work-mcp', 'work-write']) {
      if (name === 'mesh-profile' && profile === 'missing') continue;
      fs.writeFileSync(path.join(native, name), `fixture ${name}`, {mode: name === 'mesh-profile' && profile === 'not-executable' ? 0o644 : 0o755});
    }
    const copied = path.join(dir, 'copied-profile');
    // Stop at the first dependency installation, after the real bundle's copy phase.
    fs.writeFileSync(path.join(fakes, 'npm'), `#!/bin/bash
while (($#)); do [[ $1 == --prefix ]] && app=$2; shift; done
MESH_BUNDLE_ROOT=\${app%/app/demo-compiler}
source "$MESH_BUNDLE_ROOT/env.sh"
cp -p "$MESH_BIN_DIR/mesh-profile" '${copied}' || exit 96
exit 97
`, {mode: 0o755});
    const args = inspectCopy ? ['--node', process.execPath, '--skip-compiler-test'] : [];
    const result = spawnSync('bash', [path.join(REPO, 'scripts', 'build-bundle.sh'), '--output', path.join(dir, 'out'), '--native-bin', native, ...args],
      {env: {...process.env, PATH: `${fakes}:/usr/bin:/bin`, TMPDIR: dir, MESH_BUNDLE_NODE_VERSION: nodeVersion}, encoding: 'utf8', timeout: 60000});
    return {...result, dir, native, copied, curl: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''};
  }

  for (const profile of ['missing', 'not-executable'] as const) {
    test(`a ${profile} mesh-profile refuses the bundle before downloads or output`, () => {
      const result = build(version ?? '', profile);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /bundle: missing executable mesh-profile/);
      assert.equal(result.curl, '');
      assert.ok(!fs.existsSync(path.join(result.dir, 'out')));
    });
  }

  test('the real copy phase places mesh-profile in bin/, found through bundled MESH_BIN_DIR', () => {
    const result = build(version ?? '', 'present', true);
    assert.equal(result.status, 97, result.stderr);
    assert.deepEqual(fs.readFileSync(result.copied), fs.readFileSync(path.join(result.native, 'mesh-profile')));
    fs.accessSync(result.copied, fs.constants.X_OK);
    assert.equal(result.curl, '', 'no download or runtime dependency installation was attempted');
  });

  test('bundle.json records the profile helper hash along with every native program', () => {
    const source = fs.readFileSync(path.join(REPO, 'scripts/build-bundle.sh'), 'utf8');
    const script = /<<'JS'\n([\s\S]*?)\nJS/.exec(source)?.[1];
    assert.ok(script, 'the production bundle manifest writer');
    const root = fs.mkdtempSync(path.join(scratch, 'manifest-'));
    const native = ['libexec/mesh-ptyhost', 'bin/mesh-board-mcp', 'bin/mesh-read', 'bin/mesh-platform', 'bin/mesh-history',
      'bin/mesh-logout-all', 'bin/mesh-open', 'bin/mesh-profile', 'bin/work-read', 'bin/work-mcp', 'bin/work-write'];
    for (const file of [...native, 'runtime/python/bin/python3']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), file.endsWith('python3') ? '#!/bin/sh\necho Python-fixture\n' : file, {mode: 0o755});
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8',
      env: {...process.env, MESH_BUNDLE_ROOT: root, MESH_BUNDLE_SOURCE_REV: 'fixture'}});
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bundle.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.native).sort(), native.sort());
    for (const file of native) {
      assert.equal(manifest.native[file], createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'));
    }
  });

  test('the pins list the default version for every platform a bundle is built on', () => {
    const pinned = fs.readFileSync(PINS, 'utf8').trim().split('\n').map((line) => line.split('  ')[1]);
    for (const platform of ['linux-x64', 'linux-arm64', 'darwin-arm64']) assert.ok(pinned.includes(`node-v${version}-${platform}.tar.gz`), platform);
    for (const line of fs.readFileSync(PINS, 'utf8').trim().split('\n')) assert.match(line, /^[0-9a-f]{64} {2}node-v[0-9.]+-[a-z0-9]+-[a-z0-9]+\.tar\.gz$/);
  });

  test('an archive that differs from its pin stops the build', {skip: process.platform !== 'linux' && 'Linux only'}, () => {
    const result = build(version ?? '');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bundle: node-v[0-9.]+-linux-[a-z0-9]+\.tar\.gz does not match its pinned SHA-256/);
    assert.doesNotMatch(result.curl, /SHASUMS256/);
  });

  test('a version without a pin stops the build before any download', {skip: process.platform !== 'linux' && 'Linux only'}, () => {
    const result = build('99.0.0');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bundle: no pinned SHA-256 for node-v99\.0\.0-linux-[a-z0-9]+\.tar\.gz in scripts\/bundle\/node\.sha256/);
    assert.equal(result.curl, '');
  });
});

// scripts/bundle-native-libs.sh copies the system libraries a native program needs into lib/: each
// travels with the licence of the package that installed it, or the build stops. Stand-ins for
// file, ldd, patchelf and dpkg-query; the package documentation is a scratch directory.
describe('bundle-native-libs.sh: the licences of copied libraries', {skip: process.platform !== 'linux' && 'Linux only'}, () => {
  const COPYRIGHT = 'libfoo licence\nOn Debian systems, see /usr/share/common-licenses/LGPL-2.1.\nAlso /usr/share/common-licenses/GPL-2\n';
  function closure(withLicence: boolean, copyright = COPYRIGHT, arch = false, rpm = '') {
    const dir = fs.mkdtempSync(path.join(scratch, 'libs-'));
    const [fakes, system, share, bundle] = ['fakes', 'system', 'share', 'bundle'].map((name) => path.join(dir, name));
    for (const sub of [fakes, system, share, path.join(bundle, 'bin'), path.join(bundle, 'libexec'), path.join(bundle, 'runtime/node/bin')]) {
      fs.mkdirSync(sub, {recursive: true});
    }
    fs.writeFileSync(path.join(system, 'libfoo.so.1'), 'library');
    fs.writeFileSync(path.join(bundle, 'bin/tool'), 'program', {mode: 0o755});
    const fake = (name: string, body: string) => fs.writeFileSync(path.join(fakes, name), `#!/bin/bash\n${body}\n`, {mode: 0o755});
    fake('file', 'echo "$1: ELF 64-bit LSB executable"');
    fake('ldd', `echo "  libfoo.so.1 => ${system}/libfoo.so.1 (0x1)"`);
    fake('patchelf', 'exit 0');
    fake('pacman', arch ? `case $1 in -Qqo) [[ $2 == ${system}/libfoo.so.1 ]] && echo libfoo ;; -Qi) [[ $2 == libfoo ]] || exit 1
  printf 'Name            : libfoo\\nLicenses        : GPL-3.0-or-later WITH GCC-exception-3.1  (MIT OR Unknown-1.0)\\n' ;; *) exit 1 ;; esac` : 'exit 1');
    if (arch) {
      for (const [file, text] of [['licenses/libfoo/RUNTIME.LIBRARY.EXCEPTION', 'exception text'], ['licenses/spdx/GPL-3.0-or-later.txt', 'GPL text'],
        ['licenses/spdx/MIT.txt', 'MIT text']]) {
        fs.mkdirSync(path.dirname(path.join(share, file)), {recursive: true});
        fs.writeFileSync(path.join(share, file), text);
      }
    }
    fake('rpm', rpm.replaceAll('SYSTEM', system).replaceAll('SHARE', share) || 'exit 1');
    if (rpm) {
      fs.mkdirSync(path.join(share, 'licenses/libbar'), {recursive: true});
      for (const name of ['COPYING3', 'COPYING.RUNTIME']) fs.writeFileSync(path.join(share, 'licenses/libbar', name), `${name} text`);
    }
    fake('dpkg-query', arch || rpm ? 'exit 1' : `if [[ $1 == -W ]]; then [[ $3 == libfoo1 ]] || exit 1; f=\${2#-f=}; f=\${f//'\${Package}'/libfoo1}; f=\${f//'\${Version}'/1.2-3}
f=\${f//'\${source:Package}'/foo}; f=\${f//'\${source:Version}'/1.2-3}; printf "$f"; exit 0; fi
[[ $2 == ${system}/libfoo.so.1 ]] || exit 1; echo "libfoo1:amd64: $2"`);
    if (withLicence) {
      fs.mkdirSync(path.join(share, 'doc/libfoo1'), {recursive: true});
      fs.mkdirSync(path.join(share, 'common-licenses'), {recursive: true});
      fs.writeFileSync(path.join(share, 'doc/libfoo1/copyright'), copyright);
      fs.writeFileSync(path.join(share, 'common-licenses/LGPL-2.1'), 'LGPL text');
      fs.writeFileSync(path.join(share, 'common-licenses/GPL-2'), 'GPL text');
    }
    const result = spawnSync('bash', [path.join(REPO, 'scripts', 'bundle-native-libs.sh'), bundle],
      {env: {...process.env, PATH: `${fakes}:/usr/bin:/bin`, MESH_BUNDLE_SHARE_ROOT: share}, encoding: 'utf8', timeout: 30000});
    return {...result, bundle};
  }

  test('a copied library ships its package\'s copyright file, the common licences it names, the package and its source', () => {
    const result = closure(true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(result.bundle, 'lib/libfoo.so.1'), 'utf8'), 'library');
    const licences = path.join(result.bundle, 'licenses/lib/libfoo.so.1');
    assert.equal(fs.readFileSync(path.join(licences, 'copyright'), 'utf8'), COPYRIGHT);
    assert.equal(fs.readFileSync(path.join(licences, 'PACKAGE'), 'utf8'), 'libfoo1 1.2-3\n');
    assert.equal(fs.readFileSync(path.join(licences, 'common-licenses/LGPL-2.1'), 'utf8'), 'LGPL text');
    assert.equal(fs.readFileSync(path.join(licences, 'common-licenses/GPL-2'), 'utf8'), 'GPL text');
    assert.match(fs.readFileSync(path.join(licences, 'SOURCE'), 'utf8'), /source package foo, version 1\.2-3, .*\(apt-get source foo=1\.2-3\)/);
  });

  test('on Arch, a copied library ships its package\'s licences and the SPDX texts its metadata names', () => {
    const result = closure(true, COPYRIGHT, true);
    assert.equal(result.status, 0, result.stderr);
    const licences = path.join(result.bundle, 'licenses/lib/libfoo.so.1');
    assert.deepEqual(fs.readdirSync(licences, {recursive: true}).map(String).sort(),
      ['PACKAGE', 'RUNTIME.LIBRARY.EXCEPTION', 'spdx', 'spdx/GPL-3.0-or-later.txt', 'spdx/MIT.txt']);
    assert.equal(fs.readFileSync(path.join(licences, 'spdx/GPL-3.0-or-later.txt'), 'utf8'), 'GPL text');
  });

  // libfoo declares no licence file; libbar, built from the same source package, does (as libstdc++
  // and libgcc on AlmaLinux, the release's Linux bundle build image).
  const RPM = `case "$*" in
  "-qf --qf %{NAME}\\n SYSTEM/libfoo.so.1") echo libfoo ;;
  "-q --qf %{SOURCERPM} libfoo") printf foo-1.2-3.el8.src.rpm ;;
  "-qL libfoo") echo "(contains no files)" ;;
  "-qa --qf %{NAME} %{SOURCERPM}\\n") printf 'glibc glibc-2.28.src.rpm\\nlibfoo foo-1.2-3.el8.src.rpm\\nlibbar foo-1.2-3.el8.src.rpm\\n' ;;
  "-qL libbar") printf 'SHARE/licenses/libbar/COPYING.RUNTIME\\nSHARE/licenses/libbar/COPYING3\\n' ;;
  "-q --qf %{NAME} %{VERSION}-%{RELEASE}\\n libfoo") echo "libfoo 1.2-3.el8" ;;
  *) exit 1 ;;
esac`;

  test('on an RPM system, a copied library ships the licence files of its package, or of a package of the same source', () => {
    const result = closure(false, COPYRIGHT, false, RPM);
    assert.equal(result.status, 0, result.stderr);
    const licences = path.join(result.bundle, 'licenses/lib/libfoo.so.1');
    assert.deepEqual(fs.readdirSync(licences).sort(), ['COPYING.RUNTIME', 'COPYING3', 'PACKAGE', 'SOURCE']);
    assert.equal(fs.readFileSync(path.join(licences, 'COPYING3'), 'utf8'), 'COPYING3 text');
    assert.equal(fs.readFileSync(path.join(licences, 'PACKAGE'), 'utf8'), 'libfoo 1.2-3.el8\n');
    assert.match(fs.readFileSync(path.join(licences, 'SOURCE'), 'utf8'), /source package foo-1\.2-3\.el8\.src\.rpm .*\(dnf download --source libfoo\)/);
  });

  test('on an RPM system, a library whose source package has no licence file stops the build', () => {
    const result = closure(false, COPYRIGHT, false, RPM.replace(/"-qL libbar"\) printf [^\n]*/, '"-qL libbar") echo "(contains no files)" ;;'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle: no licence file in the RPM package libfoo nor in any installed package of its source foo-1\.2-3\.el8\.src\.rpm/);
  });

  test('a copyright file that names a common licence the system lacks stops the build', () => {
    const result = closure(true, 'see /usr/share/common-licenses/MPL-2.0\n');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle: libfoo1's copyright names \/usr\/share\/common-licenses\/MPL-2\.0, which the build system does not have/);
  });

  test('a copied library without a licence stops the build', () => {
    const result = closure(false);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle: no licence found for the copied library .*libfoo\.so\.1/);
  });
});

// The macOS branch of scripts/bundle-native-libs.sh, with stand-ins for uname, file and otool: the
// programs of a macOS bundle may load system libraries only; any other library stops the build,
// named with the file it resolves to, and nothing is copied or rewritten.
describe('bundle-native-libs.sh on macOS: system libraries only', () => {
  function check(dependency: string | null) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'mac-')));
    const [fakes, prefix, bundle] = ['fakes', 'homebrew', 'bundle'].map((name) => path.join(dir, name));
    const keg = path.join(prefix, 'Cellar/libfoo/1.2_1');
    for (const sub of [fakes, path.join(keg, 'lib'), path.join(prefix, 'opt'), path.join(bundle, 'bin'), path.join(bundle, 'libexec'),
      path.join(bundle, 'runtime/node/bin')]) fs.mkdirSync(sub, {recursive: true});
    fs.symlinkSync('../Cellar/libfoo/1.2_1', path.join(prefix, 'opt/libfoo'));
    fs.writeFileSync(path.join(keg, 'lib/libfoo.1.dylib'), 'library');
    fs.writeFileSync(path.join(bundle, 'bin/tool'), 'program', {mode: 0o755});
    fs.writeFileSync(path.join(bundle, 'runtime/node/bin/node'), 'node', {mode: 0o755});
    const linked = (dependency ? [dependency] : []).map((name) => `'${name.replace('PREFIX', prefix)}'`).join(' ');
    const fake = (name: string, body: string) => fs.writeFileSync(path.join(fakes, name), `#!/bin/bash\n${body}\n`, {mode: 0o755});
    fake('uname', 'echo Darwin');
    fake('file', 'echo "$1: Mach-O 64-bit executable arm64"');
    fake('otool', `echo "$2:"; [[ $2 == */bin/tool ]] && printf '\\t%s (compatibility version 1.0.0)\\n' ${linked} /usr/lib/libSystem.B.dylib
[[ $2 == */node ]] && printf '\\t%s (compatibility version 1.0.0)\\n' /System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation /usr/lib/libc++.1.dylib
exit 0`);
    for (const tool of ['install_name_tool', 'codesign']) fake(tool, `echo "${tool} must not run" >&2; exit 1`);
    const result = spawnSync('bash', [path.join(REPO, 'scripts', 'bundle-native-libs.sh'), bundle],
      {env: {...process.env, PATH: `${fakes}:/usr/bin:/bin`}, encoding: 'utf8', timeout: 30000});
    return {...result, bundle, keg};
  }

  test('programs that load system libraries only pass, and nothing is copied or rewritten', () => {
    const result = check(null);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(result.bundle, 'lib')));
    assert.ok(!fs.existsSync(path.join(result.bundle, 'licenses')));
  });

  test('a Homebrew library stops the build, named with the file it resolves to, and is not copied', () => {
    const result = check('PREFIX/opt/libfoo/lib/libfoo.1.dylib');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bundle: .*\/bin\/tool loads .*\/opt\/libfoo\/lib\/libfoo\.1\.dylib \(.*\/Cellar\/libfoo\/1\.2_1\/lib\/libfoo\.1\.dylib\), which is not a library of the system: the macOS bundle ships no library of its own/);
    assert.ok(!fs.existsSync(path.join(result.bundle, 'lib')));
  });

  test('a library missing from the build machine and an @rpath library stop the build too', () => {
    const missing = check('/opt/local/lib/libbar.2.dylib');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /loads \/opt\/local\/lib\/libbar\.2\.dylib \(not found\), which is not a library of the system/);
    const relative = check('@rpath/libbaz.dylib');
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /loads @rpath\/libbaz\.dylib, a relative or @-path library: the macOS bundle ships no library of its own/);
  });

  test('a system prefix that climbs out of itself, or a dot component, stops the build', () => {
    for (const dependency of ['/usr/lib/../../opt/local/lib/libqux.dylib', '/System/Library/./../../opt/libqux.dylib', '/usr/lib/..']) {
      const result = check(dependency);
      assert.equal(result.status, 1, dependency);
      assert.match(result.stderr, /a path with a \. or \.\. component: the macOS bundle ships no library of its own/);
    }
    const bare = check('libquux.dylib');
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /a relative or @-path library/);
  });
});

// The optional --dirty flag of build-bundle.sh and the optional --roster-dir of the Linux release
// build are arrays that are empty on a clean tree: under `set -u`, bash before 4.4 (the macOS
// system bash is 3.2) fails on "${array[@]}" of an empty array. The lines are run alone, under
// MESH_BASH32 when it names a bash 3.2.
describe('empty optional argument arrays under set -u', () => {
  const BASH = process.env.MESH_BASH32 || 'bash';
  const source = (name: string) => fs.readFileSync(path.join(REPO, 'scripts', name), 'utf8');

  function expanded(dirtyTree: boolean): {status: number | null; out: string; err: string} {
    const text = source('build-bundle.sh');
    const lines = /^DIRTY=\(\)\n.*\n/m.exec(text)?.[0] ?? '';
    const token = /\$\{DIRTY\[@\]\+"\$\{DIRTY\[@\]\}"\}/.exec(text)?.[0] ?? '';
    assert.ok(lines && token, 'build-bundle.sh builds DIRTY and expands it guarded');
    const stub = `git() { printf '%s' '${dirtyTree ? ' M file' : ''}'; }\nROOT=.\n`;
    const script = `set -euo pipefail\n${stub}${lines}printf '[%s]' ${token}\n`;
    const run = spawnSync(BASH, ['-c', script], {encoding: 'utf8'});
    return {status: run.status, out: run.stdout, err: run.stderr};
  }

  test('build-bundle.sh passes no --dirty on a clean tree and --dirty on a modified one', () => {
    const clean = expanded(false);
    assert.equal(clean.status, 0, clean.err);
    assert.equal(clean.out, '[]');
    const dirty = expanded(true);
    assert.equal(dirty.status, 0, dirty.err);
    assert.equal(dirty.out, '[--dirty]');
  });

  test('no script expands an array that may be empty without the guard', () => {
    assert.match(source('build-bundle.sh'), /\$\{DIRTY\[@\]\+"\$\{DIRTY\[@\]\}"\}/);
    assert.doesNotMatch(source('build-bundle.sh'), /(?<!\+)"\$\{DIRTY\[@\]\}"/);
    assert.match(source('release-build-bundle-linux.sh'), /\$\{roster_args\[@\]\+"\$\{roster_args\[@\]\}"\}/);
    assert.doesNotMatch(source('release-build-bundle-linux.sh'), /(?<!\+)"\$\{roster_args\[@\]\}"/);
  });
});
