// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The release install (install.sh stamped by the release workflow, installing this platform's
// bundle archive): a first install, the
// all-or-nothing checks (SHA-256 and, with gh, the build attestation), --upgrade with its
// installer checks, the automatic and manual rollback, the pruning and the PTY host that is never
// restarted without --restart-pty.
// The fixture (fake GitHub, fake systemctl, throwaway signing keys) is tests/install-release-lib.ts;
// custom units, migration and source installs are in tests/install-release-units.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {describe, test} from 'node:test';
import {bundleAsset, current, downloaded, DOWNLOAD, escape, fixture, GH, installed, installedV1, LATEST, mode, NATIVE, previous, PROGRAMS,
  linkedHome, publish, releases, run, running, setLatest, sha, SOURCE, systemctl, unit, withPythonLogoutAll} from './install-release-lib.ts';

const WEB_RESTART = 'systemctl --user restart session-mesh.service';
const PTY_RESTART = 'systemctl --user restart session-mesh-pty.service';

describe('a first release install', () => {
  test('installs the bundle of its tag and platform, verified, and runs everything from current/ with the bundled Python', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    const urls = result.calls.split('\n').filter((line) => line.startsWith('curl ') && line.includes(DOWNLOAD)).map((line) => line.split(' ').pop());
    assert.deepEqual(urls, [`${DOWNLOAD}/v1.0.0/mesh-linux-x86_64.tar.gz`], 'only the bundle of its own tag and platform');
    assert.equal(current(fx), 'releases/v1.0.0');
    const release = path.join(fx.share, 'releases/v1.0.0');
    for (const program of PROGRAMS) {
      assert.equal(fs.readFileSync(path.join(release, NATIVE[program]), 'utf8'), `v1.0.0 ${program}`);
      assert.equal(mode(path.join(release, NATIVE[program])), 0o755);
    }
    assert.equal(fs.readFileSync(path.join(release, 'app/server.py'), 'utf8'), '# server of v1.0.0\n');
    assert.equal(fs.readFileSync(path.join(release, 'install.sh'), 'utf8'), fs.readFileSync(downloaded(fx, 'v1.0.0'), 'utf8'),
      'the stamped installer is kept for --upgrade and --rollback');
    const archive = fs.readFileSync(path.join(fx.served, 'v1.0.0', bundleAsset('linux-x86_64')));
    assert.equal(fs.readFileSync(path.join(release, 'release.sha256'), 'utf8'), `${sha(archive)}  mesh-linux-x86_64.tar.gz\n`);
    for (const dir of ['.local', '.local/share', '.local/share/session-mesh', '.local/share/session-mesh/releases', '.local/share/session-mesh/releases/v1.0.0']) {
      assert.equal(mode(path.join(fx.home, dir)) & 0o022, 0, dir);
    }
    assert.deepEqual(fs.readdirSync(path.join(fx.share, 'releases')), ['v1.0.0'], 'no staging directory or archive is left');
    const share = escape(fx.share);
    assert.match(unit(fx, 'session-mesh.service'), new RegExp(`^ExecStart=:"${share}/current/bin/mesh-python" "${share}/current/app/server.py"$`, 'm'));
    assert.match(unit(fx, 'session-mesh-pty.service'), new RegExp(`^ExecStart=:"${share}/current/bin/mesh-ptyhost"$`, 'm'));
    assert.doesNotMatch(unit(fx, 'session-mesh.service'), /MESH_OPAM_SWITCH/);
    assert.doesNotMatch(result.calls, /^python3 /m, 'no Python of the machine is used');
    assert.equal(fs.readlinkSync(path.join(fx.home, '.local/bin/mesh-open')), `${fx.share}/current/bin/mesh-open`);
    assert.equal(fs.readlinkSync(path.join(fx.home, '.local/bin/mesh-logout-all')), `${fx.share}/current/bin/mesh-logout-all`);
    assert.equal(fs.readFileSync(path.join(release, NATIVE['mesh-logout-all']), 'utf8'), 'v1.0.0 mesh-logout-all',
      'the native program of the bundle, not a wrapper');
    assert.ok(systemctl(result.calls).includes('systemctl --user start session-mesh-pty.service'));
    assert.match(result.stdout, /release  : v1\.0\.0 \(upgrade: .*current\/install\.sh --upgrade/);
    assert.ok(!fs.existsSync(path.join(fx.home, '.config/session-mesh')), 'no configuration is written into or for the release');
  });

  test('a tampered bundle archive refuses the whole release: nothing installed, no unit, no link', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {tamper: 'mesh-linux-x86_64.tar.gz'});
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, new RegExp(`the SHA-256 of mesh-linux-x86_64\\.tar\\.gz is ${sha('tampered')}, not the [0-9a-f]{64} this installer records for v1\\.0\\.0.*Nothing was installed`));
    assert.deepEqual(releases(fx), [], 'neither the release nor its staging directory remains');
    assert.ok(!fs.existsSync(path.join(fx.share, 'current')));
    assert.ok(!fs.existsSync(fx.units));
  });

  test('a bundle whose native program does not match its bundle.json is refused, nothing installed', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {manifestWrong: 'mesh-read'});
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /mesh-linux-x86_64\.tar\.gz does not hold one complete bundle mesh-linux-x86_64\/ whose native programs match its bundle\.json\. Nothing was installed/);
    assert.deepEqual(releases(fx), []);
    assert.ok(!fs.existsSync(fx.units));
  });

  test('a release on disk whose native program was modified is refused, not reused', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    fs.writeFileSync(path.join(fx.share, 'releases/v1.0.0/libexec/mesh-ptyhost'), 'modified');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /releases\/v1\.0\.0 is incomplete or was modified; if no service runs from it, remove it/);
  });

  test('--assets-dir installs offline from a directory of assets, checked the same way', () => {
    const fx = fixture();
    const assets = publish(fx, 'v1.0.0');
    const offline = path.join(fx.root, 'offline');
    fs.cpSync(assets, offline, {recursive: true});
    fs.rmSync(path.join(fx.served, 'v1.0.0'), {recursive: true});
    const result = run(fx, path.join(offline, 'install.sh'), ['--assets-dir', offline]);
    assert.equal(result.status, 0, result.output);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.doesNotMatch(result.calls, /curl .*https:/);
    fs.writeFileSync(path.join(offline, 'mesh-linux-x86_64.tar.gz'), 'tampered');
    fs.rmSync(path.join(fx.share, 'releases'), {recursive: true});
    const refused = run(fx, path.join(offline, 'install.sh'), ['--assets-dir', offline]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /SHA-256 of mesh-linux-x86_64\.tar\.gz .*Nothing was installed/);
  });

  test('a release has no bundle or program for an unsupported machine and says to use a clone', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_ARCH: 'riscv64'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no prebuilt bundle or native program for Linux riscv64: install from a git clone/);
    assert.doesNotMatch(result.calls, /curl /);
  });

  test('a release that publishes neither a bundle nor native programs for this platform names what it has', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: ['linux-x86_64']});
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_ARCH: 'aarch64'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release v1\.0\.0 has neither a bundle for linux-arm64 nor native programs for linux-aarch64 \(it has bundles: linux-x86_64; native programs: none\): install from a git clone/);
    assert.doesNotMatch(result.calls, /curl /);
  });

  test('an aarch64 machine installs the linux-arm64 bundle', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_ARCH: 'aarch64'});
    assert.equal(result.status, 0, result.output);
    assert.match(result.calls, /curl .*\/v1\.0\.0\/mesh-linux-arm64\.tar\.gz/);
  });

  test('--ptyhost and --from-source belong to a source install', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    for (const args of [['--from-source'], ['--ptyhost', '/opt/mesh-ptyhost']]) {
      const result = run(fx, downloaded(fx, 'v1.0.0'), args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /belong to a source install/);
    }
  });
});

describe('install.sh --upgrade', () => {
  test('installs the latest release beside, swaps current, restarts the web server only and reports the PTY host', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade']);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.calls.includes(`curl -fsSL --proto =https --tlsv1.2 --connect-timeout 20 --max-time 60 -H Accept: application/vnd.github+json -- ${LATEST}`));
    assert.match(result.stdout, /install\.sh of v1\.1\.0: SHA-256 matches its SHA256SUMS/);
    assert.equal(current(fx), 'releases/v1.1.0');
    assert.equal(previous(fx), 'releases/v1.0.0');
    assert.deepEqual(releases(fx), ['v1.0.0', 'v1.1.0'], 'the upgrade directory is gone, both releases kept');
    const calls = systemctl(result.calls);
    assert.ok(calls.includes(WEB_RESTART), calls.join('\n'));
    assert.ok(!calls.some((line) => /session-mesh-pty\.service$/.test(line) && /restart|start|stop/.test(line)), calls.join('\n'));
    assert.match(result.output, /mesh-ptyhost changed \(v1\.0\.0 -> v1\.1\.0\)\. .*restarting it ends every mesh session.*systemctl --user restart session-mesh-pty\.service \(or rerun the installer with --restart-pty\)/);
  });

  // A 0.1.x release ran mesh-logout-all as a Python command (withPythonLogoutAll). The installer of
  // the new release (the second stage of an upgrade, which the 0.1.x installer downloads and runs)
  // links the command to the new release's native program, whatever the link named before.
  test('update from 0.1.x re-links mesh-logout-all to the native binary', () => {
    const fx = installedV1();
    const link = withPythonLogoutAll(fx);
    const elf = '\x7fELF';
    publish(fx, 'v1.1.0', {program: (program: string) => `${program === 'mesh-logout-all' ? elf : ''}v1.1.0 ${program}`});
    const result = run(fx, downloaded(fx, 'v1.1.0'));
    assert.equal(result.status, 0, result.output);
    assert.equal(fs.readlinkSync(link), `${fx.share}/current/bin/mesh-logout-all`);
    const target = fs.realpathSync(link);
    assert.equal(target, fs.realpathSync(path.join(fx.share, 'releases/v1.1.0/bin/mesh-logout-all')));
    assert.equal(fs.readFileSync(target).subarray(0, 4).toString('hex'), '7f454c46', 'an ELF executable, not a Python file');
  });

  test('an unchanged mesh-ptyhost is reported as such; --restart-pty restarts a changed one', () => {
    const same = installedV1(fixture(), {program: (program: string) => `same ${program}`});
    publish(same, 'v1.1.0', {program: (program: string) => `same ${program}`});
    setLatest(same, 'v1.1.0');
    const quiet = run(same, installed(same), ['--upgrade']);
    assert.equal(quiet.status, 0, quiet.output);
    assert.match(quiet.stdout, /mesh-ptyhost is unchanged \(v1\.0\.0 -> v1\.1\.0\)/);
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const restarted = run(fx, installed(fx), ['--upgrade', '--restart-pty']);
    assert.equal(restarted.status, 0, restarted.output);
    assert.ok(systemctl(restarted.calls).includes(PTY_RESTART));
  });

  test('--to names the release; the same release is nothing to do', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    publish(fx, 'v1.2.0');
    setLatest(fx, 'v1.2.0');
    const result = run(fx, installed(fx), ['--upgrade', '--to', 'v1.1.0']);
    assert.equal(result.status, 0, result.output);
    assert.equal(current(fx), 'releases/v1.1.0');
    assert.doesNotMatch(result.calls, /releases\/latest/);
    const again = run(fx, installed(fx), ['--upgrade', '--to', 'v1.1.0']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Already at v1\.1\.0/);
    assert.deepEqual(systemctl(again.calls), []);
  });

  const refusals: [string, (fx: ReturnType<typeof fixture>) => void, RegExp][] = [
    ['an install.sh that differs from its SHA256SUMS', (fx) => publish(fx, 'v1.1.0', {installerSums: sha('another installer')}),
      /install\.sh of v1\.1\.0 has the SHA-256 [0-9a-f]{64}, not the [0-9a-f]{64} of its SHA256SUMS: nothing was changed/],
    ['a release without SHA256SUMS', (fx) => fs.rmSync(path.join(publish(fx, 'v1.1.0'), 'SHA256SUMS')),
      /cannot obtain the SHA256SUMS of v1\.1\.0; nothing was changed/],
  ];
  for (const [name, prepare, message] of refusals) {
    test(`${name} is refused before anything changes`, () => {
      const fx = installedV1();
      prepare(fx);
      setLatest(fx, 'v1.1.0');
      const result = run(fx, installed(fx), ['--upgrade']);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, message);
      assert.equal(current(fx), 'releases/v1.0.0');
      assert.deepEqual(releases(fx), ['v1.0.0']);
      assert.deepEqual(systemctl(result.calls), []);
    });
  }

  test('a stamp that the release\'s SHA256SUMS does not list is refused by the new installer', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0', {listedWrong: 'mesh-linux-x86_64.tar.gz'});
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade']);
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /this installer records '[0-9a-f]{64}  mesh-linux-x86_64\.tar\.gz', which the SHA256SUMS of v1\.1\.0 does not list: nothing was installed/);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.deepEqual(releases(fx).filter((name) => !name.startsWith('.')), ['v1.0.0']);
    assert.deepEqual(systemctl(result.calls), []);
  });

  test('a downgrade is refused unless --to names it', () => {
    const fx = installedV1();
    publish(fx, 'v0.9.0');
    setLatest(fx, 'v0.9.0');
    const refused = run(fx, installed(fx), ['--upgrade']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /latest published release v0\.9\.0 is older than the installed v1\.0\.0: nothing was changed \(to go back, name it: --upgrade --to v0\.9\.0\)/);
    assert.equal(current(fx), 'releases/v1.0.0');
    const named = run(fx, installed(fx), ['--upgrade', '--to', 'v0.9.0']);
    assert.equal(named.status, 0, named.output);
    assert.equal(current(fx), 'releases/v0.9.0');
    // The second stage run by hand, with the SHA256SUMS the first stage would have put next to it.
    fs.copyFileSync(path.join(fx.served, 'v0.9.0/SHA256SUMS'), path.join(fx.share, 'releases/v0.9.0/SHA256SUMS'));
    const direct = run(fx, path.join(fx.share, 'releases/v0.9.0/install.sh'), ['--upgrade', '--from', 'v1.0.0']);
    assert.equal(direct.status, 1, 'the second stage checks the rule again');
    assert.match(direct.stderr, /v0\.9\.0 is older than the installed v1\.0\.0: a downgrade needs --upgrade --to v0\.9\.0/);
  });

  test('a web server that does not answer on the new release is rolled back to the previous one', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const before = unit(fx, 'session-mesh.service');
    const result = run(fx, installed(fx), ['--upgrade'], {FAKE_BAD_TAG: 'v1.1.0'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /v1\.1\.0 was not kept: its web server did not answer on 127\.0\.0\.1:7690, and v1\.0\.0 runs again/);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.ok(!fs.existsSync(path.join(fx.share, 'previous')), 'previous is as it was: absent');
    assert.equal(unit(fx, 'session-mesh.service'), before);
    assert.equal(systemctl(result.calls).filter((line) => line === WEB_RESTART).length, 2);
    assert.ok(!systemctl(result.calls).includes(PTY_RESTART));
  });
});

describe('install.sh --rollback and the pruning', () => {
  test('--rollback swaps back to the previous release and restarts the web server only', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    assert.equal(run(fx, installed(fx), ['--upgrade']).status, 0);
    const result = run(fx, installed(fx), ['--rollback']);
    assert.equal(result.status, 0, result.output);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.equal(previous(fx), 'releases/v1.1.0');
    assert.deepEqual(systemctl(result.calls), [WEB_RESTART]);
    assert.match(result.output, /mesh-ptyhost changed \(v1\.1\.0 -> v1\.0\.0\)/);
    assert.doesNotMatch(result.calls, /curl .*https:/, 'nothing is downloaded');
  });

  test('a --rollback whose web server does not answer goes back to the release it was on and restarts it', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    assert.equal(run(fx, installed(fx), ['--upgrade']).status, 0);
    const result = run(fx, installed(fx), ['--rollback'], {FAKE_BAD_TAG: 'v1.0.0'});
    assert.equal(result.status, 1, result.output);
    assert.doesNotMatch(result.output, /unbound variable/);
    assert.match(result.output, /the web server does not answer with v1\.0\.0: going back to v1\.1\.0/);
    assert.match(result.stderr, /v1\.0\.0 was not kept: its web server did not answer on 127\.0\.0\.1:\d+, and v1\.1\.0 runs again/);
    assert.equal(current(fx), 'releases/v1.1.0');
    const calls = systemctl(result.calls);
    assert.deepEqual(calls.filter((line) => /^systemctl --user (stop|start)/.test(line)), [], 'the PTY host is not stopped');
    assert.equal(calls.filter((line) => line === WEB_RESTART).length, 2, 'restarted on v1.0.0, then again on v1.1.0');
  });

  test('--rollback without a previous release is refused', () => {
    const fx = installedV1();
    const result = run(fx, installed(fx), ['--rollback']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no previous release to go back to/);
    assert.deepEqual(systemctl(result.calls), []);
  });

  test('two releases are kept: current and previous', () => {
    const fx = installedV1();
    for (const tag of ['v1.1.0', 'v1.2.0']) {
      publish(fx, tag);
      setLatest(fx, tag);
      const result = run(fx, installed(fx), ['--upgrade']);
      assert.equal(result.status, 0, result.output);
    }
    assert.deepEqual(releases(fx), ['v1.1.0', 'v1.2.0']);
    assert.equal(current(fx), 'releases/v1.2.0');
    assert.equal(previous(fx), 'releases/v1.1.0');
  });

  // The PTY host is a real process (a copy of sleep installed as v1.0.0's native mesh-ptyhost,
  // started through the bundle's wrapper current/bin/mesh-ptyhost, which executes it), whose
  // /proc/<pid>/exe names the release by its physical path; the fake systemctl gives its pid. Also
  // with HOME reached through a symbolic link.
  for (const linked of [false, true]) test(`the release the running PTY host was started from is kept, beside current and previous${
    linked ? ', with a symbolic link to HOME' : ''}`, {skip: process.platform !== 'linux' && 'needs /proc'}, () => {
    const sleep = fs.readFileSync('/usr/bin/sleep');
    const fx = installedV1(linked ? linkedHome(fixture()) : fixture(), {program: (program: string) => program === 'mesh-ptyhost' ? sleep : `v1.0.0 ${program}`});
    const host = spawn(path.join(fx.share, 'current/bin/mesh-ptyhost'), ['60'], {stdio: 'ignore'});
    try {
      for (const tag of ['v1.1.0', 'v1.2.0']) {
        publish(fx, tag);
        setLatest(fx, tag);
        const result = run(fx, installed(fx), ['--upgrade'], {FAKE_PTY_PID: String(host.pid)});
        assert.equal(result.status, 0, result.output);
        if (tag === 'v1.2.0') assert.match(result.output, /kept the older release v1\.0\.0: the running PTY host was started from it/);
      }
      assert.deepEqual(releases(fx), ['v1.0.0', 'v1.1.0', 'v1.2.0']);
      const later = run(fx, installed(fx), [], {FAKE_PTY_PID: '0'});
      assert.equal(later.status, 0, later.output);
      assert.deepEqual(releases(fx), ['v1.1.0', 'v1.2.0'], 'once no host runs from it, it goes');
    } finally {
      host.kill();
    }
  });
});

// version_older of scripts/install-release.sh, alone, under MESH_BASH32 when it names a bash 3.2:
// each [older, newer] pair is also checked in reverse and against itself.
test('version_older compares tags as semver, pre-release identifiers one by one', () => {
  const pairs = [['v1.2.3', 'v1.2.4'], ['v1.9.0', 'v1.10.0'], ['v1.2.3-rc.9', 'v1.2.3-rc.10'], ['v1.2.3-rc.1', 'v1.2.3'],
    ['v1.2.3-alpha', 'v1.2.3-alpha.1'], ['v1.2.3-alpha.1', 'v1.2.3-alpha.beta'], ['v1.2.3-1', 'v1.2.3-alpha'],
    ['v1.2.3-beta.11', 'v1.2.3-rc.1'], ['v2.0.0-rc.1', 'v10.0.0'], ['v1.2.3-Z', 'v1.2.3-a'], ['v1.2.3-RC.1', 'v1.2.3-beta.1']];
  const probe = pairs.map(([a, b]) => `for p in "${a} ${b}" "${b} ${a}" "${a} ${a}"; do version_older $p && echo yes || echo no; done`).join('\n');
  const script = `set -euo pipefail\nsource '${path.join(SOURCE, 'scripts/install-release.sh')}'\n${probe}\n`;
  // Under a collating locale, bash 4.1 and later would order a before Z: the comparison must stay ASCII.
  const result = spawnSync(process.env.MESH_BASH32 || 'bash', ['-c', script], {encoding: 'utf8', env: {...process.env, LC_ALL: 'en_US.UTF-8'}});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), pairs.flatMap(() => ['yes', 'no', 'no']));
});

test('a latest release older than the installed one by its pre-release number is a downgrade', () => {
  const fx = fixture();
  publish(fx, 'v1.0.0-rc.10');
  assert.equal(run(fx, downloaded(fx, 'v1.0.0-rc.10')).status, 0);
  publish(fx, 'v1.0.0-rc.9');
  setLatest(fx, 'v1.0.0-rc.9');
  const result = run(fx, installed(fx), ['--upgrade']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the latest published release v1\.0\.0-rc\.9 is older than the installed v1\.0\.0-rc\.10/);
  assert.equal(current(fx), 'releases/v1.0.0-rc.10');
});

describe('the build attestation (gh attestation verify)', () => {
  const ATTEST = '--repo Session-Mesh/session-mesh --signer-workflow Session-Mesh/session-mesh/.github/workflows/release.yml';
  const attest = (tag: string) => `${ATTEST} --source-ref refs/tags/${tag}`;
  const verified = (calls: string) => calls.split('\n').filter((line) => line.startsWith('gh attestation verify '));

  test('with gh on PATH every downloaded file is checked, the upgrade\'s install.sh included', () => {
    const fx = installedV1(fixture({gh: GH}));
    const first = verified(fs.readFileSync(fx.log, 'utf8'));
    assert.equal(first.length, 1, 'the first install checks its bundle archive');
    for (const line of first) assert.ok(line.endsWith(attest('v1.0.0')), line);
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade']);
    assert.equal(result.status, 0, result.output);
    const files = verified(result.calls).map((line) => line.split(' ')[3].split('/').pop());
    assert.deepEqual(files, ['install.sh', 'mesh-linux-x86_64.tar.gz']);
    for (const line of verified(result.calls)) assert.ok(line.endsWith(attest('v1.1.0')), line);
    assert.doesNotMatch(result.output, /was not checked/);
  });

  test('an asset whose attestation fails refuses the whole release, nothing installed', () => {
    const fx = fixture({gh: GH});
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_GH_FAIL: 'mesh-linux-x86_64.tar.gz'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /no matching attestation/);
    assert.match(result.stderr, /the build attestation of mesh-linux-x86_64\.tar\.gz does not verify .*Nothing was installed/);
    assert.deepEqual(releases(fx), []);
    assert.ok(!fs.existsSync(fx.units));
  });

  test('an upgrade whose install.sh fails its attestation changes nothing', () => {
    const fx = installedV1(fixture({gh: GH}));
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade'], {FAKE_GH_FAIL: 'install.sh'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the build attestation of the install\.sh of v1\.1\.0 does not verify .*nothing was changed/);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.deepEqual(systemctl(result.calls), []);
  });

  test('without gh the installer says once that the attestation was not checked, and how to check it', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.split('was not checked').length, 2);
    assert.ok(result.output.includes(`To check a file by hand, install gh (https://cli.github.com/), run gh auth login, then: gh attestation verify FILE ${attest('v1.0.0')}`));
  });

  test('with gh not logged in (exit 4) the installer says once that the attestation was not checked, and installs', () => {
    const fx = fixture({gh: GH});
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_GH_LOGGED_OUT: '1'});
    assert.equal(result.status, 0, result.output);
    assert.equal(verified(result.calls).length, 1, 'the bundle is still tried');
    assert.equal(result.output.split('was not checked').length, 2);
    assert.ok(result.output.includes(`gh is not logged in: the build attestation of the downloaded files was not checked (their SHA-256 was). To check a file by hand, run gh auth login, then: gh attestation verify FILE ${attest('v1.0.0')}`));
    assert.equal(current(fx), 'releases/v1.0.0');
  });

  for (const [label, fakes, env] of [
    ['gh is not logged in', {gh: GH}, {FAKE_GH_LOGGED_OUT: '1'}],
    ['gh is not on PATH', {}, {}],
  ] as [string, Record<string, string>, Record<string, string>][]) {
    test(`MESH_REQUIRE_ATTESTATION=1 refuses the release when ${label}, nothing installed`, () => {
      const fx = fixture(fakes);
      publish(fx, 'v1.0.0');
      const result = run(fx, downloaded(fx, 'v1.0.0'), [], {...env, MESH_REQUIRE_ATTESTATION: '1'});
      assert.equal(result.status, 1, result.output);
      assert.ok(result.stderr.includes(`${label}, and MESH_REQUIRE_ATTESTATION=1 requires the build attestation to be checked`), result.stderr);
      assert.match(result.stderr, /Nothing was installed/);
      assert.deepEqual(releases(fx), []);
      assert.ok(!fs.existsSync(fx.units));
    });
  }

  test('MESH_REQUIRE_ATTESTATION=1 with gh logged in installs as usual', () => {
    const fx = fixture({gh: GH});
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {MESH_REQUIRE_ATTESTATION: '1'});
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /was not checked/);
  });

  test('MESH_REQUIRE_ATTESTATION=1 refuses an upgrade whose install.sh cannot be checked, nothing changed', () => {
    const fx = installedV1(fixture({gh: GH}));
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade'], {FAKE_GH_LOGGED_OUT: '1', MESH_REQUIRE_ATTESTATION: '1'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gh is not logged in, and MESH_REQUIRE_ATTESTATION=1/);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.deepEqual(systemctl(result.calls), []);
  });
});
