// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// ~/.local/bin/mesh-logout-all across releases (scripts/install-common.sh: place_native_command,
// relink_native_command). Two rules: after --rollback the link names the command of the release
// restored, which for a 0.1.x release of native programs is the Python command app/bin/mesh-logout-all
// (such a release has no bin/mesh-logout-all), so the link never dangles; and the installer replaces
// or removes at that path only a link an install of session-mesh made, never the user's own file or
// link. The fixture is tests/install-release-lib.ts, with tests/install-macos-lib.ts's stand-ins
// for macOS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES as MAC_FAKES} from './install-macos-lib.ts';
import {CURL, current, downloaded, type Fixture, fixture, installed, installedV1, PROGRAM_PLATFORMS, publish, run, running, setLatest,
  withPythonLogoutAll, writeExecutable} from './install-release-lib.ts';

const linkOf = (fx: Fixture) => path.join(fx.home, '.local/bin/mesh-logout-all');
const NATIVE_LINK = (fx: Fixture) => `${fx.share}/current/bin/mesh-logout-all`;
const PYTHON_LINK = (fx: Fixture) => `${fx.share}/current/app/bin/mesh-logout-all`;
const LEFT = /mesh-logout-all was not made by this installer: it is left as it is\. The mesh-logout-all of this install is \S+\/current\/bin\/mesh-logout-all/;

// Turns the installed release of native programs $tag into a 0.1.x one: no bin/mesh-logout-all, the
// Python command in app/bin, and the link naming that command.
function asPythonProgramsRelease(fx: Fixture, tag: string): void {
  const release = path.join(fx.share, 'releases', tag);
  for (const name of ['mesh-open', 'mesh-logout-all']) {
    fs.rmSync(path.join(release, 'bin', name));
    fs.rmSync(path.join(release, 'app/bin', name), {force: true});
    writeExecutable(path.join(release, 'app/bin', name), `echo "python ${name} of ${tag}"`);
    const link = path.join(fx.home, '.local/bin', name);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(fx.share, 'current/app/bin', name), link);
  }
}

// A link that resolves, and what it names.
function resolved(fx: Fixture): string {
  assert.ok(fs.existsSync(linkOf(fx)), `${fs.readlinkSync(linkOf(fx))} does not dangle`);
  return fs.readlinkSync(linkOf(fx));
}

describe('install.sh --rollback and the native command links (Linux)', () => {
  test('back to a 0.1.x release of native programs, the link names its Python command; the next upgrade names the native program again', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0', {platforms: [], programs: PROGRAM_PLATFORMS});
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    running(fx, 'session-mesh-pty.service');
    asPythonProgramsRelease(fx, 'v1.0.0');
    publish(fx, 'v1.1.0', {platforms: [], programs: PROGRAM_PLATFORMS});
    setLatest(fx, 'v1.1.0');
    const up = run(fx, downloaded(fx, 'v1.1.0'));
    assert.equal(up.status, 0, up.output);
    assert.equal(resolved(fx), NATIVE_LINK(fx));
    const openLink = path.join(fx.home, '.local/bin/mesh-open');
    assert.equal(fs.readlinkSync(openLink), path.join(fx.share, 'current/bin/mesh-open'));
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.equal(resolved(fx), PYTHON_LINK(fx));
    assert.equal(fs.readlinkSync(openLink), path.join(fx.share, 'current/app/bin/mesh-open'));
    assert.match(fs.readFileSync(openLink, 'utf8'), /python mesh-open of v1.0.0/);
    assert.equal(fs.realpathSync(linkOf(fx)), fs.realpathSync(path.join(fx.share, 'releases/v1.0.0/app/bin/mesh-logout-all')));
    const again = run(fx, downloaded(fx, 'v1.1.0'));
    assert.equal(again.status, 0, again.output);
    assert.equal(resolved(fx), NATIVE_LINK(fx));
    assert.equal(fs.readlinkSync(openLink), path.join(fx.share, 'current/bin/mesh-open'));
    assert.doesNotMatch(again.output, LEFT);
  });

  test('back to a 0.1.x bundle, the link names its bin/mesh-logout-all wrapper', () => {
    const fx = installedV1();
    withPythonLogoutAll(fx);
    publish(fx, 'v1.1.0');
    const up = run(fx, downloaded(fx, 'v1.1.0'));
    assert.equal(up.status, 0, up.output);
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.equal(resolved(fx), NATIVE_LINK(fx));
    assert.match(fs.readFileSync(linkOf(fx), 'utf8'), /^#!.*bash/, 'the wrapper of the 0.1.x bundle');
  });

  test('between two releases that hold the native program, the link stays on current/bin', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    assert.equal(run(fx, downloaded(fx, 'v1.1.0')).status, 0);
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    assert.equal(resolved(fx), NATIVE_LINK(fx));
    assert.equal(fs.readFileSync(linkOf(fx), 'utf8'), 'v1.0.0 mesh-logout-all');
  });

  test('a release restored without any mesh-logout-all leaves the link and says so', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    assert.equal(run(fx, downloaded(fx, 'v1.1.0')).status, 0);
    fs.rmSync(path.join(fx.share, 'releases/v1.0.0/bin/mesh-logout-all'));
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    assert.match(back.output, /the release restored holds no mesh-logout-all: \S+\/mesh-logout-all is left as it is/);
    assert.equal(fs.readlinkSync(linkOf(fx)), NATIVE_LINK(fx));
  });

  test('a link that cannot be replaced does not stop --rollback before the PTY host report', {skip: process.getuid?.() === 0 && 'root writes in a mode-555 directory'}, () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    assert.equal(run(fx, downloaded(fx, 'v1.1.0')).status, 0);
    const bin = path.dirname(linkOf(fx));
    fs.chmodSync(bin, 0o555);
    try {
      const back = run(fx, installed(fx), ['--rollback']);
      assert.equal(back.status, 0, back.output);
      assert.equal(current(fx), 'releases/v1.0.0');
      assert.match(back.output, /could not relink \S+\/mesh-logout-all to the release restored/);
      assert.match(back.output, /mesh-ptyhost (is unchanged|changed)/);
    } finally {
      fs.chmodSync(bin, 0o755);
    }
  });

  test('a link the user removed is not made again by --rollback', () => {
    const fx = installedV1();
    publish(fx, 'v1.1.0');
    assert.equal(run(fx, downloaded(fx, 'v1.1.0')).status, 0);
    fs.rmSync(linkOf(fx));
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    // lstat, not existsSync: a dangling link made again must fail too.
    assert.throws(() => fs.lstatSync(linkOf(fx)), {code: 'ENOENT'});
  });
});

describe('install.sh --rollback and the mesh-logout-all link (macOS)', () => {
  const MAC = {FAKE_MACOS: '13.2'};
  function macFixture(): Fixture {
    const fx = fixture({...MAC_FAKES, curl: CURL});
    writeExecutable(path.join(fx.fakes, 'plutil'), `exec "${process.execPath}" --experimental-strip-types "${path.join(import.meta.dirname, 'fixtures/fake-plutil.ts')}" "$@"`);
    fs.mkdirSync(path.join(fx.home, 'Library/Application Support'), {recursive: true, mode: 0o700});
    return fx;
  }

  test('back to a 0.1.x release of native programs, the link names its Python command', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0', {programs: PROGRAM_PLATFORMS});
    const first = run(fx, downloaded(fx, 'v1.0.0'), [], MAC);
    assert.equal(first.status, 0, first.output);
    asPythonProgramsRelease(fx, 'v1.0.0');
    publish(fx, 'v1.1.0', {programs: PROGRAM_PLATFORMS});
    const up = run(fx, downloaded(fx, 'v1.1.0'), [], MAC);
    assert.equal(up.status, 0, up.output);
    assert.equal(resolved(fx), NATIVE_LINK(fx));
    const back = run(fx, installed(fx), ['--rollback'], MAC);
    assert.equal(back.status, 0, back.output);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.equal(resolved(fx), PYTHON_LINK(fx));
  });
});

describe('install.sh never replaces a mesh-logout-all the user made', () => {
  // Each entry puts the user's own thing at the path and returns a function that fails if it changed.
  const OWN: Record<string, (fx: Fixture) => () => void> = {
    'a file': (fx) => {
      fs.writeFileSync(linkOf(fx), '#!/bin/sh\necho mine\n', {mode: 0o755});
      return () => {
        assert.ok(!fs.lstatSync(linkOf(fx)).isSymbolicLink(), 'still a file');
        assert.equal(fs.readFileSync(linkOf(fx), 'utf8'), '#!/bin/sh\necho mine\n');
      };
    },
    'a link to a program elsewhere': (fx) => {
      const mine = path.join(fx.root, 'mine/bin/mesh-logout-all');
      fs.mkdirSync(path.dirname(mine), {recursive: true});
      fs.writeFileSync(mine, '#!/bin/sh\necho mine\n', {mode: 0o755});
      fs.symlinkSync(mine, linkOf(fx));
      return () => {
        assert.equal(fs.readlinkSync(linkOf(fx)), mine);
        assert.equal(fs.readFileSync(mine, 'utf8'), '#!/bin/sh\necho mine\n');
      };
    },
    'a link into a prefix that holds programs named like ours': (fx) => {
      const prefix = path.join(fx.root, 'opt/bin');
      fs.mkdirSync(prefix, {recursive: true});
      for (const name of ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-logout-all']) fs.writeFileSync(path.join(prefix, name), `#!/bin/sh\necho user-${name}\n`, {mode: 0o755});
      const mine = path.join(prefix, 'mesh-logout-all');
      fs.symlinkSync(mine, linkOf(fx));
      return () => {
        assert.equal(fs.readlinkSync(linkOf(fx)), mine);
        assert.equal(fs.readFileSync(mine, 'utf8'), '#!/bin/sh\necho user-mesh-logout-all\n');
      };
    },
    'a link that leaves the install through ..': (fx) => {
      const target = `${fx.share}/releases/../../../../mine/bin/mesh-logout-all`;
      fs.symlinkSync(target, linkOf(fx));
      return () => assert.equal(fs.readlinkSync(linkOf(fx)), target);
    },
  };

  for (const [label, put] of Object.entries(OWN)) {
    test(`${label}: a release install, an upgrade and --rollback leave it and say where the program is`, () => {
      const fx = fixture();
      fs.mkdirSync(path.dirname(linkOf(fx)), {recursive: true});
      const unchanged = put(fx);
      publish(fx, 'v1.0.0');
      const first = run(fx, downloaded(fx, 'v1.0.0'));
      assert.equal(first.status, 0, first.output);
      assert.match(first.output, LEFT);
      unchanged();
      assert.equal(fs.readlinkSync(path.join(fx.home, '.local/bin/mesh-open')), `${fx.share}/current/bin/mesh-open`, 'the other commands are linked');
      running(fx, 'session-mesh-pty.service');
      publish(fx, 'v1.1.0');
      const up = run(fx, downloaded(fx, 'v1.1.0'));
      assert.equal(up.status, 0, up.output);
      assert.match(up.output, LEFT);
      unchanged();
      const back = run(fx, installed(fx), ['--rollback']);
      assert.equal(back.status, 0, back.output);
      assert.match(back.output, LEFT);
      unchanged();
    });
  }

  test('a link an earlier install made, to a bundle extracted elsewhere, is replaced without a warning', () => {
    const fx = fixture();
    const bundle = path.join(fx.root, 'old-bundle');
    fs.mkdirSync(path.join(bundle, 'libexec'), {recursive: true});
    fs.mkdirSync(path.join(bundle, 'bin'));
    for (const file of ['env.sh', 'libexec/mesh-ptyhost', 'bin/mesh-logout-all']) fs.writeFileSync(path.join(bundle, file), '');
    fs.mkdirSync(path.dirname(linkOf(fx)), {recursive: true});
    fs.symlinkSync(path.join(bundle, 'bin/mesh-logout-all'), linkOf(fx));
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, LEFT);
    assert.equal(resolved(fx), NATIVE_LINK(fx));
  });
});
