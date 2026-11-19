// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A release install from the native programs: a release publishes, beside the bundle of each
// platform it qualified, the native programs <program>-<os>-<arch> and the code archive
// session-mesh-<tag>.tar.gz. install.sh installs the bundle of this platform when the release has
// one, otherwise the native programs and the code, which then run with this machine's Python.
// The fixture (fake GitHub, fake systemctl, fake python3) is tests/install-release-lib.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, test} from 'node:test';
import {current, downloaded, DOWNLOAD, escape, fixture, installed, mode, PLATFORMS, previous, PROGRAM_PLATFORMS, PROGRAMS, publish, releases,
  run, running, setLatest, SOURCE, unit} from './install-release-lib.ts';

const fetched = (calls: string) =>
  calls.split('\n').filter((line) => line.startsWith('curl ') && line.includes(DOWNLOAD)).map((line) => line.split('/').pop()).sort();

describe('a release without a bundle for this platform', () => {
  test('installs the native programs and the code of its tag, checked, and runs the web server with this machine\'s Python', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: ['linux-arm64', 'macos-arm64'], programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(fetched(result.calls), ['session-mesh-v1.0.0.tar.gz', ...PROGRAMS.map((program) => `${program}-linux-x86_64`)].sort());
    const release = path.join(fx.share, 'releases/v1.0.0');
    assert.deepEqual(fs.readdirSync(release).sort(), ['app', 'app.manifest', 'bin', 'install.sh']);
    for (const program of PROGRAMS) {
      assert.equal(fs.readFileSync(path.join(release, 'bin', program), 'utf8'), `v1.0.0 ${program}`);
      assert.equal(mode(path.join(release, 'bin', program)), 0o755);
    }
    assert.equal(fs.readFileSync(path.join(release, 'app/server.py'), 'utf8'), '# server of v1.0.0\n');
    assert.equal(fs.readlinkSync(path.join(release, 'app/bin/mesh-board-mcp')), '../../bin/mesh-board-mcp', 'agents find the release\'s board');
    assert.equal(fs.readlinkSync(path.join(release, 'app/bin/work-read')), '../../bin/work-read', 'the web server finds the release\'s work-read');
    assert.equal(fs.readFileSync(path.join(release, 'app/bin/work-read'), 'utf8'), 'v1.0.0 work-read');
    assert.equal(fs.readlinkSync(path.join(release, 'app/bin/work-mcp')), '../../bin/work-mcp', 'agents find the release\'s tracker');
    assert.equal(fs.readFileSync(path.join(release, 'app/bin/work-mcp'), 'utf8'), 'v1.0.0 work-mcp');
    assert.equal(mode(release) & 0o022, 0);
    assert.deepEqual(releases(fx), ['v1.0.0'], 'no staging directory is left');
    const share = escape(fx.share);
    assert.match(unit(fx, 'session-mesh.service'), new RegExp(`^ExecStart=:"${escape(fx.fakes)}/python3" "${share}/current/app/server.py"$`, 'm'));
    assert.match(unit(fx, 'session-mesh-pty.service'), new RegExp(`^ExecStart=:"${share}/current/bin/mesh-ptyhost"$`, 'm'));
    assert.doesNotMatch(unit(fx, 'session-mesh.service'), /MESH_OPAM_SWITCH/);
    assert.match(result.calls, /^python3 -c import aiohttp/m, 'the Python of the machine is checked');
    assert.match(result.stdout, /native programs and code; no bundle for this platform/);
  });

  test('an aarch64 machine installs the linux-aarch64 programs when the release has no linux-arm64 bundle', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: ['linux-x86_64'], programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_ARCH: 'aarch64'});
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(fetched(result.calls), ['session-mesh-v1.0.0.tar.gz', ...PROGRAMS.map((program) => `${program}-linux-aarch64`)].sort());
  });

  test('the bundle wins when the release has both', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(fetched(result.calls), ['mesh-linux-x86_64.tar.gz']);
    assert.ok(fs.existsSync(path.join(fx.share, 'releases/v1.0.0/libexec/mesh-ptyhost')));
  });

  test('a tampered program refuses the whole release: nothing installed, no unit', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: [], programs: PROGRAM_PLATFORMS, tamper: 'mesh-read-linux-x86_64'});
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /the SHA-256 of mesh-read-linux-x86_64 is [0-9a-f]{64}, not the [0-9a-f]{64} this installer records for v1\.0\.0.*Nothing was installed/);
    assert.deepEqual(releases(fx), []);
    assert.ok(!fs.existsSync(fx.units));
  });

  // A release installed from its native programs, then changed by `change` (its app/ directory and
  // the release directory); the result of installing it again.
  const reinstallAfter = (change: (app: string, release: string) => void) => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: [], programs: PROGRAM_PLATFORMS});
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    const release = path.join(fx.share, 'releases/v1.0.0');
    change(path.join(release, 'app'), release);
    return run(fx, downloaded(fx, 'v1.0.0'));
  };

  test('a release on disk is reused when its code matches the manifest recorded at install, the bytecode caches aside', () => {
    const result = reinstallAfter((app) => {
      fs.mkdirSync(path.join(app, '__pycache__'));
      fs.writeFileSync(path.join(app, '__pycache__/agentmcp.cpython-312.pyc'), 'bytecode');
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /already on disk, programs and code checked/);
  });

  const codeChanges: [string, (app: string, release: string) => void][] = [
    ['a changed file', (app) => fs.writeFileSync(path.join(app, 'server.py'), '# changed\n')],
    ['an added file', (app) => fs.writeFileSync(path.join(app, 'json.py'), 'import os\n')],
    ['a removed file', (app) => fs.unlinkSync(path.join(app, 'agentmcp.py'))],
    ['a changed link', (app) => { fs.unlinkSync(path.join(app, 'bin/mesh-board-mcp')); fs.symlinkSync('/bin/sh', path.join(app, 'bin/mesh-board-mcp')); }],
    ['no manifest', (_app, release) => fs.unlinkSync(path.join(release, 'app.manifest'))],
  ];
  for (const [label, change] of codeChanges) {
    test(`a release on disk with ${label} in its code is refused, not reused`, () => {
      const result = reinstallAfter(change);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /releases\/v1\.0\.0 is incomplete or was modified \(its code, app\/, differs from app\.manifest\)/);
    });
  }

  test('a release on disk whose program was modified is refused, not reused', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: [], programs: PROGRAM_PLATFORMS});
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    fs.chmodSync(path.join(fx.share, 'releases/v1.0.0/bin'), 0o755);
    fs.chmodSync(path.join(fx.share, 'releases/v1.0.0/bin/mesh-ptyhost'), 0o755);
    fs.writeFileSync(path.join(fx.share, 'releases/v1.0.0/bin/mesh-ptyhost'), 'modified');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /releases\/v1\.0\.0 is incomplete or was modified \(mesh-ptyhost\)/);
  });

  test('--upgrade moves from the native programs to a release with a bundle, and reports the changed PTY host', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: [], programs: PROGRAM_PLATFORMS});
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    running(fx, 'session-mesh-pty.service');
    publish(fx, 'v1.1.0', {programs: PROGRAM_PLATFORMS});
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade']);
    assert.equal(result.status, 0, result.output);
    assert.equal(current(fx), 'releases/v1.1.0');
    assert.equal(previous(fx), 'releases/v1.0.0');
    assert.match(unit(fx, 'session-mesh.service'), /current\/bin\/mesh-python" ".*current\/app\/server\.py"$/m);
    assert.match(result.output, /mesh-ptyhost changed \(v1\.0\.0 -> v1\.1\.0\)/);
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    assert.equal(current(fx), 'releases/v1.0.0');
  });
});

// release_kind of install.sh, alone (with the functions it calls), under MESH_BASH32 when it names a
// bash 3.2: what each platform installs from each kind of release.
describe('the choice between the bundle and the native programs, per platform', () => {
  const installer = fs.readFileSync(path.join(SOURCE, 'install.sh'), 'utf8');
  const fn = (name: string) => {
    const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$|^${name}\\(\\) \\{[^\\n]*\\}$`, 'm').exec(installer);
    assert.ok(match, `install.sh defines ${name}`);
    return match[0];
  };
  const sums = (names: string[]) => names.map((name, index) => `${String(index).padStart(64, 'a')}  ${name}`).join('\n');
  const allPrograms = (platforms: string[]) => platforms.flatMap((platform) => PROGRAMS.map((program) => `${program}-${platform}`));
  const RELEASES: Record<string, string[]> = {
    full: [...PLATFORMS.map((platform) => `mesh-${platform}.tar.gz`), 'session-mesh-v1.0.0.tar.gz', ...allPrograms(PROGRAM_PLATFORMS)],
    'programs only': ['session-mesh-v1.0.0.tar.gz', ...allPrograms(PROGRAM_PLATFORMS)],
    'Linux bundles, all programs': ['mesh-linux-x86_64.tar.gz', 'mesh-linux-arm64.tar.gz', 'session-mesh-v1.0.0.tar.gz', ...allPrograms(PROGRAM_PLATFORMS)],
    'programs without the code archive': allPrograms(PROGRAM_PLATFORMS),
  };
  // The floors as install.sh defines them, and stand-ins for sw_vers and getconf: `version` is the
  // macOS (Darwin) or glibc (Linux) version they report; 'none' makes getconf fail, as on musl.
  const floors = installer.split('\n').filter((line) => /^(BUNDLE_GLIBC|BUNDLE_MACOS|PROGRAMS_MACOS)_FLOOR=/.test(line));
  const choose = (system: string, machine: string, assets: string[], version = system === 'Darwin' ? '15.6.1' : '2.39') => {
    const facts = version === 'none' ? 'getconf() { return 1; }' : `getconf() { echo 'glibc ${version}'; }`;
    const script = ['set -euo pipefail', 'refuse() { echo "REFUSED: $*"; exit 0; }', 'warn() { echo "WARNED: $*"; }',
      `uname() { echo '${machine}'; }`, `sw_vers() { echo '${version}'; }`, facts,
      `SYSTEM='${system}' MESH_RELEASE_TAG=v1.0.0`, "RELEASE_SUM_PATTERN='^[0-9a-f]{64}  [A-Za-z0-9._-]+$'", ...floors,
      `MESH_RELEASE_SUMS='${sums(assets)}'`, `RELEASE_PROGRAMS=(${PROGRAMS.join(' ')})`,
      ...['sums_hash', 'bundle_asset', 'code_asset', 'release_platforms', 'release_has_programs', 'stamped_platforms', 'version_key',
        'version_at_least', 'machine_floors', 'release_kind'].map(fn),
      'release_kind', 'echo "$RELEASE_KIND $RELEASE_PLATFORM"'].join('\n');
    const result = spawnSync(process.env.MESH_BASH32 || 'bash', ['-c', script], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cases: [string, string, string, string][] = [
    ['Linux', 'x86_64', 'full', 'bundle linux-x86_64'],
    ['Linux', 'aarch64', 'full', 'bundle linux-arm64'],
    ['Linux', 'arm64', 'full', 'bundle linux-arm64'],
    ['Darwin', 'arm64', 'full', 'bundle macos-arm64'],
    ['Darwin', 'arm64', 'Linux bundles, all programs', 'programs macos-arm64'],
    ['Linux', 'x86_64', 'programs only', 'programs linux-x86_64'],
    ['Linux', 'aarch64', 'programs only', 'programs linux-aarch64'],
    ['Darwin', 'arm64', 'programs only', 'programs macos-arm64'],
    ['Darwin', 'x86_64', 'programs only', 'REFUSED: release v1.0.0 has neither a bundle for macos-x86_64 nor native programs for this machine'],
    ['Linux', 'x86_64', 'programs without the code archive', 'REFUSED: release v1.0.0 has neither a bundle for linux-x86_64 nor native programs for linux-x86_64'],
    ['Linux', 'riscv64', 'full', 'REFUSED: there is no prebuilt bundle or native program for Linux riscv64'],
  ];
  for (const [system, machine, release, expected] of cases) {
    test(`${system} ${machine}, ${release}: ${expected.split(':')[0]}`, () => {
      const chosen = choose(system, machine, RELEASES[release]);
      assert.ok(chosen.startsWith(expected), chosen);
    });
  }

  // The bundle only on a machine that meets its floor (install.sh: BUNDLE_GLIBC_FLOOR 2.28,
  // BUNDLE_MACOS_FLOOR 13.5, PROGRAMS_MACOS_FLOOR 13.0), else the native programs with a notice,
  // else a refusal naming the floors.
  const FALLBACK = /^WARNED: not the bundle mesh-[\w-]+\.tar\.gz: /;
  const floorCases: [string, string, string, string, string, RegExp | null][] = [
    ['Darwin', 'arm64', '13.2', 'full', 'programs macos-arm64', /this Mac runs macOS 13\.2; the bundle needs macOS 13\.5 or later/],
    ['Darwin', 'arm64', '13.4.1', 'full', 'programs macos-arm64', /the bundle needs macOS 13\.5 or later/],
    ['Darwin', 'arm64', '13.5', 'full', 'bundle macos-arm64', null],
    ['Darwin', 'arm64', '14', 'full', 'bundle macos-arm64', null],
    ['Linux', 'x86_64', '2.27', 'full', 'programs linux-x86_64', /this machine has glibc 2\.27; the bundle needs glibc 2\.28 or later/],
    ['Linux', 'x86_64', '2.28', 'full', 'bundle linux-x86_64', null],
    ['Linux', 'aarch64', '2.39', 'full', 'bundle linux-arm64', null],
    ['Linux', 'x86_64', 'none', 'full', 'programs linux-x86_64', /no glibc \(the C library could not be identified: getconf GNU_LIBC_VERSION failed\)/],
    ['Linux', 'aarch64', 'none', 'full', 'programs linux-aarch64', /the C library could not be identified/],
  ];
  for (const [system, machine, version, release, expected, notice] of floorCases) {
    test(`${system} ${machine} at ${version === 'none' ? 'no glibc' : version}, ${release}: ${expected}`, () => {
      const lines = choose(system, machine, RELEASES[release], version).split('\n');
      assert.equal(lines.at(-1), expected);
      if (notice) {
        assert.match(lines[0], FALLBACK);
        assert.match(lines[0], notice);
        assert.match(lines[0], /Installing the native programs and the code instead, run with this machine's Python/);
      } else {
        assert.equal(lines.length, 1, lines.join('\n'));
      }
    });
  }

  test('a Mac older than the native programs\' floor is refused, naming the floors', () => {
    for (const release of ['full', 'programs only']) {
      const chosen = choose('Darwin', 'arm64', RELEASES[release], '12.7.6');
      assert.match(chosen, /^REFUSED: release v1\.0\.0 does not run on this machine \(macOS 12\.7\.6\): its bundles need glibc 2\.28 or later \(Linux\) or macOS 13\.5 or later, its native programs macOS 13\.0 or later on a Mac/);
    }
  });

  test('a Linux machine below the bundle floor, with a release that has no programs, is refused, naming the floors', () => {
    const chosen = choose('Linux', 'x86_64', RELEASES['Linux bundles, all programs'].filter((name) => !name.endsWith('-linux-x86_64')), '2.17');
    assert.match(chosen, /^REFUSED: release v1\.0\.0 does not run on this machine \(glibc 2\.17\): its bundles need glibc 2\.28 or later/);
  });

  test('versions compare by number, not as text', () => {
    const script = [fn('version_key'), fn('version_at_least'),
      'for pair in "13.10 13.5" "13.5 13.5" "13.5.1 13.5" "2.28 2.28" "2.100 2.28" "10.0 9.9"; do version_at_least $pair || exit 1; done',
      'for pair in "13.4.9 13.5" "2.27 2.28" "9.9 10.0" "x 2.28" " 2.28"; do ! version_at_least $pair || exit 1; done'].join('\n');
    const result = spawnSync(process.env.MESH_BASH32 || 'bash', ['-c', script], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  });
});
