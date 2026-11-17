// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The floors of the prebuilt files (install.sh: BUNDLE_GLIBC_FLOOR, BUNDLE_MACOS_FLOOR,
// PROGRAMS_MACOS_FLOOR), end to end: a release install uses the bundle only on a machine that meets
// its floor, otherwise the native programs and the code archive with this machine's Python, with a
// notice saying why; a Mac older than the native programs' floor is refused, naming the floors; an
// extracted bundle refuses a Mac older than its floor; a source install keeps its own floor
// (macOS 12.3). The fixture is tests/install-release-lib.ts, with tests/install-macos-lib.ts's
// stand-ins for macOS (sw_vers answers FAKE_MACOS).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES as MAC_FAKES} from './install-macos-lib.ts';
import {bundleTree, CURL, current, downloaded, type Fixture, fixture, PROGRAM_PLATFORMS, publish, releases, run, unit,
  writeExecutable} from './install-release-lib.ts';
import {parsePlist} from './plist-lib.ts';

const NOTICE = /not the bundle mesh-[\w-]+\.tar\.gz: (.*)\. Installing the native programs and the code instead, run with this machine's Python/;

describe('Linux: the glibc floor of the bundles', () => {
  for (const [label, glibc, why] of [['glibc 2.27', '2.27', /this machine has glibc 2\.27; the bundle needs glibc 2\.28 or later/],
    ['musl (getconf names no glibc)', 'none', /no glibc \(the C library could not be identified: getconf GNU_LIBC_VERSION failed\)/]] as [string, string, RegExp][]) {
    test(`${label}: the native programs and the code, with a notice, never the bundle`, () => {
      const fx = fixture();
      publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
      const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_GLIBC: glibc});
      assert.equal(result.status, 0, result.output);
      assert.match(result.stdout, NOTICE);
      assert.match(result.stdout, why);
      assert.ok(!result.calls.includes('mesh-linux-x86_64.tar.gz'), 'the bundle is not downloaded');
      assert.ok(fs.existsSync(path.join(fx.share, 'releases/v1.0.0/app.manifest')));
      assert.match(unit(fx, 'session-mesh.service'), /^ExecStart=:".*\/python3" ".*\/current\/app\/server\.py"$/m);
    });
  }

  test('glibc 2.28: the bundle', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_GLIBC: '2.28'});
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, NOTICE);
    assert.ok(fs.existsSync(path.join(fx.share, 'releases/v1.0.0/bundle.json')));
  });
});

describe('macOS: the floors of the bundle (13.5) and of the native programs (13.0)', () => {
  function macFixture(): Fixture {
    const fx = fixture({...MAC_FAKES, curl: CURL});
    writeExecutable(path.join(fx.fakes, 'plutil'), `exec "${process.execPath}" --experimental-strip-types "${path.join(import.meta.dirname, 'fixtures/fake-plutil.ts')}" "$@"`);
    fs.mkdirSync(path.join(fx.home, 'Library/Application Support'), {recursive: true, mode: 0o700});
    return fx;
  }
  const webJob = (fx: Fixture) =>
    parsePlist(fs.readFileSync(path.join(fx.home, 'Library/LaunchAgents/io.session-mesh.web.plist'), 'utf8')) as {ProgramArguments: string[]};

  test('macOS 13.2: the native programs and the code, with a notice, never the bundle', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_MACOS: '13.2'});
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, NOTICE);
    assert.match(result.stdout, /this Mac runs macOS 13\.2; the bundle needs macOS 13\.5 or later/);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.ok(!fs.existsSync(path.join(fx.share, 'releases/v1.0.0/bundle.json')));
    assert.match(webJob(fx).ProgramArguments[0], /\/python3$/);
  });

  test('macOS 13.5: the bundle', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_MACOS: '13.5'});
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, NOTICE);
    assert.deepEqual(webJob(fx).ProgramArguments, [`${fx.share}/current/bin/mesh-python`, `${fx.share}/current/app/server.py`]);
  });

  test('macOS 12.7: a release is refused before any download, naming the floors', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_MACOS: '12.7.6'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /release v1\.0\.0 does not run on this machine \(macOS 12\.7\.6\): its bundles need glibc 2\.28 or later \(Linux\) or macOS 13\.5 or later, its native programs macOS 13\.0 or later on a Mac: install from a git clone instead/);
    assert.ok(!fs.existsSync(path.join(fx.share, 'releases')) || releases(fx).length === 0);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });

  test('an extracted bundle refuses a Mac older than its floor', () => {
    const fx = macFixture();
    const bundle = bundleTree(path.join(fx.root, 'mesh-macos-arm64'), 'extracted');
    const result = run(fx, path.join(bundle, 'mesh'), ['install'], {FAKE_MACOS: '13.4'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /the bundle needs macOS 13\.5 or later; this Mac runs macOS 13\.4/);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });
});
