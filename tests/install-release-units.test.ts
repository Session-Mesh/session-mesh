// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The release install next to units it did not write: custom units stay untouched (and block
// --upgrade), units of a clone-based install are replaced after a notice, a source install takes
// over from a release install with --from-source, and the macOS jobs follow the same rules.
// The fixture is tests/install-release-lib.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES as MAC_FAKES} from './install-macos-lib.ts';
import {bundleTree, CURL, current, downloaded, escape, type Fixture, fixture, installed, publish, releases, run, running, setLatest,
  SOURCE, systemctl, unit, writeExecutable} from './install-release-lib.ts';
import {copyInstallerScripts} from './install-scripts.ts';
import {parsePlist} from './plist-lib.ts';

const PTY = 'session-mesh-pty.service';
const WEB = 'session-mesh.service';
const changes = (calls: string) => systemctl(calls).filter((line) => !/daemon-reload|enable|status/.test(line));

function writeUnit(fx: Fixture, name: string, text: string): string {
  fs.mkdirSync(path.dirname(path.join(fx.units, name)), {recursive: true});
  fs.writeFileSync(path.join(fx.units, name), text);
  return path.join(fx.units, name);
}

describe('units the installer did not write', () => {
  test('a custom PTY unit is preserved by an install, and --upgrade refuses without changing anything', () => {
    const fx = fixture();
    const custom = '[Service]\nExecStart=:"/opt/mesh-ptyhost"\n';
    writeUnit(fx, PTY, custom);
    running(fx, PTY);
    publish(fx, 'v1.0.0');
    const first = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /session-mesh-pty\.service was not written by a release install: it is preserved/);
    assert.equal(unit(fx, PTY), custom);
    assert.ok(!changes(first.calls).some((line) => line.includes(PTY)));
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const upgrade = run(fx, installed(fx), ['--upgrade']);
    assert.equal(upgrade.status, 1);
    assert.match(upgrade.stderr, /session-mesh-pty\.service is not the unit a release install writes .*never replaces a PTY host it did not install.*Nothing was changed/);
    assert.equal(unit(fx, PTY), custom);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.deepEqual(changes(upgrade.calls), []);
    assert.doesNotMatch(upgrade.calls, /releases\/latest/, 'refused before asking GitHub');
  });

  test('a drop-in on the web unit makes --upgrade and --rollback refuse', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    writeUnit(fx, `${WEB}.d/override.conf`, '[Service]\nNice=5\n');
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    for (const args of [['--upgrade'], ['--rollback']]) {
      const result = run(fx, installed(fx), args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /session-mesh\.service is not the unit a release install writes \(its own file, no drop-in/);
      assert.deepEqual(changes(result.calls), []);
    }
  });
  // A drop-in that sets the command or the environment wins over the unit the installer writes:
  // the service would keep running what it says while the installer reports the release running.
  for (const [name, text] of [[`${WEB}.d/override.conf`, '[Service]\nExecStart=\nExecStart=/opt/other/python /opt/other/server.py\n'],
    [`${WEB}.d/port.conf`, '[Service]\nEnvironment="MESH_PORT=7690"\n'], [`${PTY}.d/env.conf`, '[Service]\nEnvironment=SHELL=/bin/zsh\n'],
    [`${WEB}.d/my port.conf`, '[Service]\nEnvironment=MESH_PORT=7691\n'], [`${PTY}.d/unset.conf`, '[Service]\nUnsetEnvironment=MESH_BIN_DIR\n'],
    [`${WEB}.d/pass.conf`, '[Service]\nPassEnvironment=LANG\n'], [`${WEB}.d/other.conf`, '[Service]\nEnvironment=FOO_MESH_PORT=7692\n']]) {
    test(`a release install refuses before the units change when ${name} overrides the command or the environment`, () => {
      const fx = fixture();
      writeUnit(fx, WEB, '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/server.py"\n');
      writeUnit(fx, PTY, '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/ptyhost.py"\n');
      const dropin = writeUnit(fx, name, text);
      const before = fs.readdirSync(fx.units, {recursive: true}).map(String).sort()
        .map((file) => [file, fs.statSync(path.join(fx.units, file)).isFile() ? fs.readFileSync(path.join(fx.units, file), 'utf8') : '']);
      publish(fx, 'v1.0.0');
      const result = run(fx, downloaded(fx, 'v1.0.0'));
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, new RegExp(`${escape(dropin)}, a drop-in of ${escape(name.split('.d/')[0])}, sets (ExecStart=|Environment=|UnsetEnvironment=|PassEnvironment=): it overrides .*remove the drop-in or move it aside .*daemon-reload, then rerun .*never edits or removes a drop-in; the services, their units and current/ were not changed; release v1\\.0\\.0 stays downloaded and checked in ${escape(fx.share)}/releases/v1\\.0\\.0, where a rerun finds it`));
      // Only MESH_PORT itself: FOO_MESH_PORT is another variable.
      const port = /[\s"'=]MESH_PORT=([0-9]+)/.exec(text)?.[1];
      if (port) assert.match(result.stderr, new RegExp(`sets MESH_PORT=${port}, .*rerun with MESH_PORT=${port} in the environment`));
      else assert.doesNotMatch(result.stderr, /rerun with MESH_PORT/);
      const after = fs.readdirSync(fx.units, {recursive: true}).map(String).sort()
        .map((file) => [file, fs.statSync(path.join(fx.units, file)).isFile() ? fs.readFileSync(path.join(fx.units, file), 'utf8') : '']);
      assert.deepEqual(after, before, 'no unit file or drop-in changed');
      assert.deepEqual(changes(result.calls), []);
      assert.ok(!fs.existsSync(path.join(fx.share, 'current')));
    });
  }
});

describe('moving a clone-based install to a release', () => {
  test('the units of a checkout are replaced after a notice; the running PTY host and the port stay', () => {
    const fx = fixture();
    writeUnit(fx, WEB, '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/server.py"\nEnvironment="MESH_PORT=7691"\n');
    writeUnit(fx, PTY, '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/ptyhost.py"\n');
    running(fx, PTY);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /session-mesh\.service runs the web server of a git checkout; the installer replaces it with the release's/);
    assert.match(result.output, /session-mesh-pty\.service runs the Python PTY host of a git checkout, which is gone\. The installer replaces the unit/);
    const share = escape(fx.share);
    assert.match(unit(fx, WEB), new RegExp(`"${share}/current/app/server.py"`));
    assert.match(unit(fx, WEB), /MESH_PORT=7691/);
    assert.match(unit(fx, PTY), new RegExp(`^ExecStart=:"${share}/current/bin/mesh-ptyhost"$`, 'm'));
    assert.ok(!changes(result.calls).some((line) => line.includes(PTY)), 'the running PTY host is neither stopped nor restarted');
    assert.match(result.output, /mesh-ptyhost changed .*systemctl --user restart session-mesh-pty\.service/);
  });

  test('a release whose web server does not answer gives the checkout its units back, and its web server runs again', () => {
    const fx = fixture();
    const web = '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/server.py"\nEnvironment="MESH_PORT=7691"\n';
    const pty = '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/ptyhost.py"\n';
    writeUnit(fx, WEB, web);
    writeUnit(fx, PTY, pty);
    running(fx, PTY);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_BAD_TAG: 'v1.0.0'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /the web server does not answer with v1\.0\.0: going back to the installation it replaced \(session-mesh\.service as it was\)/);
    assert.match(result.stderr, /v1\.0\.0 was not kept: .* and the installation it replaced \(session-mesh\.service as it was\) runs again/);
    assert.equal(unit(fx, WEB), web);
    assert.equal(unit(fx, PTY), pty);
    assert.ok(!fs.existsSync(path.join(fx.share, 'current')), 'current is removed');
    const restarts = changes(result.calls).filter((line) => line === `systemctl --user restart ${WEB}`);
    assert.equal(restarts.length, 2, 'the release, then the checkout');
  });

  // The PTY host was not running: the release install started it, so going back stops it again.
  test('going back to a checkout without a PTY unit stops the host it started and removes the unit it created', () => {
    const fx = fixture();
    const web = '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/server.py"\n';
    writeUnit(fx, WEB, web);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_BAD_TAG: 'v1.0.0'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /runs again; the PTY host it started is stopped and session-mesh-pty\.service, which it created, is removed \(logs:/);
    assert.equal(unit(fx, WEB), web);
    assert.ok(!fs.existsSync(path.join(fx.units, PTY)), 'the PTY unit it created is removed');
    assert.ok(!fs.existsSync(path.join(fx.state, PTY)), 'the PTY host it started is stopped');
    const pty = systemctl(result.calls).filter((line) => line.includes(PTY));
    assert.deepEqual(pty.filter((line) => !/enable/.test(line)), [`systemctl --user start ${PTY}`, `systemctl --user stop ${PTY}`,
      `systemctl --user disable ${PTY}`]);
  });

  test('going back to a checkout whose Python PTY host was stopped stops the native host it started and restores the unit', () => {
    const fx = fixture();
    const web = '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/server.py"\n';
    const pty = '[Service]\nExecStart=:"/usr/bin/python3" "/old/checkout/ptyhost.py"\n';
    writeUnit(fx, WEB, web);
    writeUnit(fx, PTY, pty);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), [], {FAKE_BAD_TAG: 'v1.0.0'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /runs again; the PTY host it started is stopped, as it was before \(logs:/);
    assert.equal(unit(fx, WEB), web);
    assert.equal(unit(fx, PTY), pty);
    assert.ok(!fs.existsSync(path.join(fx.state, PTY)), 'the PTY host it started is stopped');
    assert.deepEqual(changes(result.calls).filter((line) => line.includes(PTY)), [`systemctl --user start ${PTY}`, `systemctl --user stop ${PTY}`]);
  });
});

// A git checkout of this repository: the source installer, with mesh-ptyhost on PATH.
function checkout(fx: Fixture): string {
  const dir = path.join(fx.root, 'clone');
  fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
  fs.copyFileSync(path.join(SOURCE, 'install.sh'), path.join(dir, 'install.sh'));
  copyInstallerScripts(SOURCE, dir);
  fs.cpSync(path.join(SOURCE, 'systemd'), path.join(dir, 'systemd'), {recursive: true});
  for (const cmd of ['mesh-open', 'mesh-attach', 'mesh-rename', 'mesh-logout-all']) fs.writeFileSync(path.join(dir, 'bin', cmd), '');
  writeExecutable(path.join(fx.fakes, 'mesh-ptyhost'), 'exit 97');
  return path.join(dir, 'install.sh');
}

describe('source installs', () => {
  test('--from-source after a release install removes current, keeps the releases and runs the clone', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    running(fx, PTY);
    const source = checkout(fx);
    const refused = run(fx, source);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /this account runs a release install .*To run this checkout or bundle instead, rerun with --from-source/);
    const result = run(fx, source, ['--from-source']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /The installer now removes the link .*current \(the releases stay in/);
    assert.ok(!fs.existsSync(path.join(fx.share, 'current')));
    assert.deepEqual(releases(fx), ['v1.0.0']);
    const clone = escape(path.dirname(source));
    assert.match(unit(fx, WEB), new RegExp(`"${clone}/server.py"`));
    assert.match(unit(fx, PTY), new RegExp(`^ExecStart=:"${escape(fx.fakes)}/mesh-ptyhost"$`, 'm'));
    assert.ok(!changes(result.calls).some((line) => line.includes(PTY)), 'the running PTY host is not restarted');
    assert.match(result.output, /session-mesh-pty\.service now runs .*restarting it ends every mesh session/);
    assert.equal(fs.readlinkSync(path.join(fx.home, '.local/bin/mesh-open')), `${path.dirname(source)}/bin/mesh-open`);
  });

  test('--from-source whose web server does not answer gives the release its link and units back', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    running(fx, PTY);
    const web = unit(fx, WEB);
    const pty = unit(fx, PTY);
    const source = checkout(fx);
    const result = run(fx, source, ['--from-source'], {FAKE_BAD_ROOT: path.dirname(source)});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /was not kept: its web server did not answer .* runs again/);
    assert.equal(current(fx), 'releases/v1.0.0');
    assert.equal(unit(fx, WEB), web);
    assert.equal(unit(fx, PTY), pty);
    assert.deepEqual(changes(result.calls), [`systemctl --user restart ${WEB}`, `systemctl --user restart ${WEB}`]);
  });

  test('--upgrade in a checkout refuses and says git pull', () => {
    const fx = fixture();
    const result = run(fx, checkout(fx), ['--upgrade']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /this is a source install \(a git clone\): to upgrade it, run git pull, then \.\/install\.sh/);
    assert.doesNotMatch(result.calls, /systemctl|curl/);
  });

  test('the unstamped install.sh inside an installed release refuses and names the release installer', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    const result = run(fx, path.join(fx.share, 'releases/v1.0.0/app/install.sh'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /this is the code of an installed release; run the release's installer instead/);
  });
});

describe('the release contract', () => {
  test('install.sh holds the empty stamp block exactly once', () => {
    const text = fs.readFileSync(path.join(SOURCE, 'install.sh'), 'utf8');
    const block = "# @release-stamp-begin\nMESH_RELEASE_TAG=''\nMESH_RELEASE_SUMS=''\n# @release-stamp-end\n";
    assert.equal(text.split(block).length, 2);
  });
});

describe('macOS release install (launchd agents)', () => {
  const uid = process.getuid!();
  function macFixture(): Fixture {
    const fx = fixture({...MAC_FAKES, curl: CURL});
    writeExecutable(path.join(fx.fakes, 'plutil'), `exec "${process.execPath}" --experimental-strip-types "${path.join(SOURCE, 'tests/fixtures/fake-plutil.ts')}" "$@"`);
    fs.mkdirSync(path.join(fx.home, 'Library/Application Support'), {recursive: true, mode: 0o700});
    return fx;
  }
  const job = (fx: Fixture, label: string) =>
    parsePlist(fs.readFileSync(path.join(fx.home, 'Library/LaunchAgents', `${label}.plist`), 'utf8')) as {ProgramArguments: string[]; EnvironmentVariables: Record<string, string>};

  test('the jobs run from current/, and an upgrade reloads the web job only', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0');
    const first = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(first.status, 0, first.output);
    assert.match(first.calls, /curl .*\/v1\.0\.0\/mesh-macos-arm64\.tar\.gz/);
    assert.equal(job(fx, 'io.session-mesh.pty').ProgramArguments[0], `${fx.share}/current/bin/mesh-ptyhost`);
    assert.deepEqual(job(fx, 'io.session-mesh.web').ProgramArguments, [`${fx.share}/current/bin/mesh-python`, `${fx.share}/current/app/server.py`]);
    assert.equal(fs.readlinkSync(path.join(fx.home, '.local/bin/mesh-attach')), `${fx.share}/current/bin/mesh-attach`);
    assert.ok(job(fx, 'io.session-mesh.web').EnvironmentVariables.PATH.startsWith(`${fx.share}/current/bin:`));
    assert.equal(job(fx, 'io.session-mesh.web').EnvironmentVariables.MESH_OPAM_SWITCH, undefined);
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const upgrade = run(fx, installed(fx), ['--upgrade']);
    assert.equal(upgrade.status, 0, upgrade.output);
    assert.equal(current(fx), 'releases/v1.1.0');
    const launchd = upgrade.calls.split('\n').filter((line) => /^launchctl (bootout|bootstrap|kickstart)/.test(line));
    assert.ok(launchd.includes(`launchctl bootout gui/${uid}/io.session-mesh.web`), launchd.join('\n'));
    assert.ok(!launchd.some((line) => line.includes('io.session-mesh.pty')), launchd.join('\n'));
    assert.match(upgrade.output, new RegExp(`mesh-ptyhost changed \\(v1\\.0\\.0 -> v1\\.1\\.0\\).*launchctl kickstart -k gui/${uid}/io\\.session-mesh\\.pty`));
    const back = run(fx, installed(fx), ['--rollback']);
    assert.equal(back.status, 0, back.output);
    assert.equal(current(fx), 'releases/v1.0.0');
  });

  // The web job of a checkout: a release's, its program moved to a checkout, with no release left.
  test('a first release whose web server does not answer restores the checkout\'s web job and reloads it', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    const plist = path.join(fx.home, 'Library/LaunchAgents/io.session-mesh.web.plist');
    const checkoutJob = fs.readFileSync(plist, 'utf8').replace(`${fx.share}/current/app/server.py`, '/old/checkout/server.py');
    fs.writeFileSync(plist, checkoutJob);
    fs.unlinkSync(path.join(fx.share, 'current'));
    fs.rmSync(path.join(fx.share, 'releases'), {recursive: true});
    publish(fx, 'v1.1.0');
    const result = run(fx, downloaded(fx, 'v1.1.0'), [], {FAKE_BAD_TAG: 'v1.1.0'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /the web server does not answer with v1\.1\.0: going back to the installation it replaced/);
    assert.match(result.stderr, /v1\.1\.0 was not kept: .* runs again/);
    assert.equal(fs.readFileSync(plist, 'utf8').trimEnd(), checkoutJob.trimEnd());
    assert.ok(!fs.existsSync(path.join(fx.share, 'current')));
    const loads = result.calls.split('\n').filter((line) => line.startsWith(`launchctl bootstrap gui/${uid} `) && line.includes('io.session-mesh.web'));
    assert.equal(loads.length, 2, 'loaded with the release, then with the restored plist');
  });

  test('a PTY job the release did not write blocks --upgrade', () => {
    const fx = macFixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    const plist = path.join(fx.home, 'Library/LaunchAgents/io.session-mesh.pty.plist');
    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace(`${fx.share}/current/bin/mesh-ptyhost`, '/opt/mesh-ptyhost'));
    publish(fx, 'v1.1.0');
    setLatest(fx, 'v1.1.0');
    const result = run(fx, installed(fx), ['--upgrade']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /io\.session-mesh\.pty\.plist does not run the release's PTY host/);
    assert.equal(current(fx), 'releases/v1.0.0');
  });

  // A checkout's web job and no loaded PTY job (none at all, or a plist of another host that is not
  // loaded): a first release that does not answer unloads the PTY job it loaded.
  for (const [label, ptyJob] of [['without a PTY job', 'none'], ['with an unloaded PTY job', 'unloaded']] as const) {
    test(`a first release that does not answer, ${label}, leaves the PTY job as it was`, () => {
      const fx = macFixture();
      publish(fx, 'v1.0.0');
      assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
      const agents = path.join(fx.home, 'Library/LaunchAgents');
      const web = path.join(agents, 'io.session-mesh.web.plist');
      fs.writeFileSync(web, fs.readFileSync(web, 'utf8').replace(`${fx.share}/current/app/server.py`, '/old/checkout/server.py'));
      const ptyPlist = path.join(agents, 'io.session-mesh.pty.plist');
      const other = fs.readFileSync(ptyPlist, 'utf8').replace(`${fx.share}/current/bin/mesh-ptyhost`, '/opt/mesh-ptyhost');
      if (ptyJob === 'none') fs.rmSync(ptyPlist); else fs.writeFileSync(ptyPlist, other);
      fs.rmSync(path.join(fx.state, `gui_${uid}_io.session-mesh.pty`));
      fs.unlinkSync(path.join(fx.share, 'current'));
      fs.rmSync(path.join(fx.share, 'releases'), {recursive: true});
      publish(fx, 'v1.1.0');
      const result = run(fx, downloaded(fx, 'v1.1.0'), [], {FAKE_BAD_TAG: 'v1.1.0'});
      assert.equal(result.status, 1, result.output);
      const undone = ptyJob === 'none' ? `the PTY job it created is unloaded and ${escape(ptyPlist)} removed` : 'the PTY job it loaded is unloaded, as it was before';
      assert.match(result.stderr, new RegExp(`v1\\.1\\.0 was not kept: .* runs again; ${undone} \\(logs:`));
      assert.ok(result.calls.includes(`launchctl bootstrap gui/${uid} ${ptyPlist}`), 'the release loaded the PTY job');
      assert.ok(!fs.existsSync(path.join(fx.state, `gui_${uid}_io.session-mesh.pty`)), 'the PTY job is unloaded again');
      if (ptyJob === 'none') assert.ok(!fs.existsSync(ptyPlist), 'the PTY plist it created is removed');
      else assert.equal(fs.readFileSync(ptyPlist, 'utf8'), other);
    });
  }
});

describe('agentmcp.py in a release install: the board MCP server of the running release', () => {
  // agentmcp.py as the web server imports it: through current/bin/mesh-python, whose env.sh sets
  // MESH_BIN_DIR to current/bin, in a temporary HOME and with no opam switch in the environment.
  const imported = (fx: Fixture, bundle: string) => {
    const env: NodeJS.ProcessEnv = {...process.env, HOME: fx.home, MESH_OPAM_SWITCH: path.join(fx.root, 'switch')};
    for (const name of ['MESH_BIN_DIR', 'OPAMSWITCH', 'OPAM_SWITCH_PREFIX', 'OPAMROOT']) delete env[name];
    const result = spawnSync(path.join(bundle, 'bin/mesh-python'),
      ['-c', 'import agentmcp, resumeargs; print(agentmcp.BOARD_MCP); print(resumeargs.MESH_EVENT)'],
      {cwd: path.join(bundle, 'app'), env, encoding: 'utf8', timeout: 20000});
    assert.equal(result.status, 0, `${result.error ?? ''}${result.stderr}`);
    return result.stdout.trim().split('\n');
  };

  // An agent keeps the MCP command and the event hook it was started with across upgrades, and
  // only current and previous are kept: through current/, they reach the installed release.
  test('agents get the mesh-board-mcp and mesh-event of current/, never an opam switch or a release directory', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    const bin = path.join(fx.share, 'current/bin');
    assert.deepEqual(imported(fx, path.join(fx.share, 'current')), [path.join(bin, 'mesh-board-mcp'), path.join(bin, 'mesh-event')]);
  });

  test('an extracted bundle outside releases/ names its own directory', () => {
    const fx = fixture();
    const bundle = bundleTree(path.join(fx.root, 'mesh-linux-x86_64'), 'extracted');
    assert.deepEqual(imported(fx, bundle), [path.join(bundle, 'bin/mesh-board-mcp'), path.join(bundle, 'bin/mesh-event')]);
  });
});

// systemd's DropInPaths separates the drop-ins with a space and does not quote a path that holds one.
describe('the drop-in paths systemd reports', () => {
  test('a path with spaces stays one drop-in, wherever it is', () => {
    const fx = fixture();
    const dir = path.join(fx.root, 'etc systemd', 'session-mesh.service.d');
    fs.mkdirSync(dir, {recursive: true});
    const files = [path.join(dir, 'my  port.conf'), path.join(dir, 'b.conf')];
    for (const file of files) fs.writeFileSync(file, '[Service]\n');
    const units = path.join(SOURCE, 'scripts/install-linux-units.sh');
    const result = spawnSync('/bin/bash', ['-c', 'source <(sed -n "/^dropin_files()/,/^}/p" "$1"); dropin_files "$2"; printf "%s\\n" "${DROPIN_FILES[@]}"',
      '_', units, `${files.join(' ')} /gone/x.conf`], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [...files, '/gone/x.conf']);
  });
});
