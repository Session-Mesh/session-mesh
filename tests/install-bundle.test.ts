// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// An extracted bundle installed in place (`./mesh install`, which runs the bundle's app/install.sh)
// and the rule for an account whose services already run another extracted bundle, such as one
// unpacked by hand under ~/.local/libexec/session-mesh: a release, bundle or source install leaves
// those services as they are unless --switch-from-bundle, and never deletes that bundle; with the
// option the web service moves and the PTY unit is rewritten without restarting the running host
// (on macOS the PTY job is preserved). The fixture is tests/install-release-lib.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES as MAC_FAKES} from './install-macos-lib.ts';
import {bundleTree, CURL, current, downloaded, escape, type Fixture, fixture, publish, run, running, SOURCE, systemctl, unit,
  writeExecutable} from './install-release-lib.ts';
import {parsePlist} from './plist-lib.ts';
import {roadmapObservation, roadmapTask} from './helpers/project-followup-fixtures.ts';

const PTY = 'session-mesh-pty.service';
const WEB = 'session-mesh.service';
const changes = (calls: string) => systemctl(calls).filter((line) => !/daemon-reload|enable|status/.test(line));

// An extracted bundle in the fixture; `./mesh install` is its launcher, which sources env.sh.
function extracted(fx: Fixture, dir: string, label = 'extracted'): string {
  return bundleTree(path.join(fx.root, dir), label);
}
const mesh = (bundle: string) => path.join(bundle, 'mesh');
const launch = (fx: Fixture, bundle: string, args: string[] = [], env: Record<string, string> = {}) => run(fx, mesh(bundle), ['install', ...args], env);

// The services of a bundle unpacked by hand under ~/.local/libexec/session-mesh, running.
function libexecInstall(fx: Fixture): {bundle: string; web: string; pty: string} {
  const bundle = bundleTree(path.join(fx.home, '.local/libexec/session-mesh/releases/7907944c-linux-x86_64'), 'libexec');
  const web = `[Service]\nExecStart=:"${bundle}/bin/mesh-python" "${bundle}/app/server.py"\nEnvironment="MESH_PORT=7690"\n`;
  const pty = `[Service]\nExecStart=:"${bundle}/bin/mesh-ptyhost"\n`;
  fs.mkdirSync(fx.units, {recursive: true});
  fs.writeFileSync(path.join(fx.units, WEB), web);
  fs.writeFileSync(path.join(fx.units, PTY), pty);
  running(fx, PTY);
  running(fx, WEB);
  return {bundle, web, pty};
}

// Every file of a directory with its content, to show that nothing of it changed.
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, {recursive: true, withFileTypes: true})) {
    if (entry.isFile()) files[path.join(entry.parentPath, entry.name)] = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return files;
}

describe('./mesh install: an extracted bundle installed in place', () => {
  test('the units and the mesh commands run the bundle\'s own Python, wrappers and PTY host, from where it was extracted', () => {
    const fx = fixture();
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    const result = launch(fx, bundle);
    assert.equal(result.status, 0, result.output);
    const root = escape(bundle);
    assert.match(unit(fx, WEB), new RegExp(`^ExecStart=:"${root}/bin/mesh-python" "${root}/app/server.py"$`, 'm'));
    assert.match(unit(fx, PTY), new RegExp(`^ExecStart=:"${root}/bin/mesh-ptyhost"$`, 'm'));
    assert.doesNotMatch(unit(fx, WEB), /MESH_OPAM_SWITCH/);
    assert.equal(fs.readlinkSync(path.join(fx.home, '.local/bin/mesh-attach')), `${bundle}/bin/mesh-attach`);
    assert.match(result.stdout, /ok: bundled Python/);
    assert.doesNotMatch(result.calls, /^python3 /m, 'no Python of the machine is used');
    assert.ok(!fs.existsSync(fx.share), 'no release layout is created');
    const again = launch(fx, bundle);
    assert.equal(again.status, 0, `the same bundle installs again without an option: ${again.output}`);
    assert.ok(!changes(again.calls).some((line) => line.includes(PTY)), 'its running PTY host is kept');
  });

  test('an incomplete bundle, and the options of a release or a checkout, are refused before any change', () => {
    const fx = fixture();
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    fs.writeFileSync(path.join(bundle, 'bin/mesh-read'), 'modified');
    const broken = launch(fx, bundle);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /is not a complete bundle .*extract the archive again/);
    const good = extracted(fx, 'other');
    for (const [args, message] of [[['--ptyhost', '/opt/mesh-ptyhost'], /--ptyhost belongs to a git checkout/],
      [['--upgrade'], /this is an extracted bundle .*install a release/], [['--rollback'], /belong to a release install/]] as const) {
      const result = launch(fx, good, [...args]);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, message);
    }
    assert.ok(!fs.existsSync(fx.units));
  });

  test('a release install, then ./mesh install from current/, runs the release\'s own installer', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    assert.equal(run(fx, downloaded(fx, 'v1.0.0')).status, 0);
    const result = launch(fx, path.join(fx.share, 'current'));
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /Release v1\.0\.0 is already on disk, bundle checked/);
    assert.equal(current(fx), 'releases/v1.0.0');
  });

  test('a missing or modified mesh-profile refuses the extracted bundle before installation', () => {
    for (const missing of [true, false]) {
      const fx = fixture();
      const bundle = extracted(fx, 'mesh-linux-x86_64');
      const helper = path.join(bundle, 'bin/mesh-profile');
      if (missing) fs.unlinkSync(helper);
      else fs.writeFileSync(helper, 'modified');
      const result = launch(fx, bundle);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /is not a complete bundle .*extract the archive again/);
      assert.ok(!fs.existsSync(fx.units));
    }
  });
});

describe('an account whose services run another extracted bundle (~/.local/libexec/session-mesh)', () => {
  test('a release install leaves the services as they are and names --switch-from-bundle', () => {
    const fx = fixture();
    const before = libexecInstall(fx);
    const files = snapshot(before.bundle);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, new RegExp(`services run the bundle in ${escape(before.bundle)}; they were left as they are.*rerun with --switch-from-bundle`));
    assert.equal(unit(fx, WEB), before.web);
    assert.equal(unit(fx, PTY), before.pty);
    assert.deepEqual(changes(result.calls), []);
    assert.ok(!fs.existsSync(path.join(fx.share, 'current')));
    assert.deepEqual(snapshot(before.bundle), files);
  });

  test('--switch-from-bundle moves the web service to the release, rewrites the PTY unit, restarts no PTY host and deletes nothing', () => {
    const fx = fixture();
    const before = libexecInstall(fx);
    const files = snapshot(before.bundle);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), ['--switch-from-bundle']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`--switch-from-bundle: the services move from the bundle in ${escape(before.bundle)} to .*current.*never deletes it`));
    const share = escape(fx.share);
    assert.match(unit(fx, WEB), new RegExp(`^ExecStart=:"${share}/current/bin/mesh-python" "${share}/current/app/server.py"$`, 'm'));
    assert.match(unit(fx, WEB), /MESH_PORT=7690/);
    assert.match(unit(fx, PTY), new RegExp(`^ExecStart=:"${share}/current/bin/mesh-ptyhost"$`, 'm'));
    const calls = changes(result.calls);
    assert.ok(calls.includes(`systemctl --user restart ${WEB}`), calls.join('\n'));
    assert.ok(!calls.some((line) => line.includes(PTY)), 'the running PTY host is neither stopped nor restarted');
    assert.match(result.output, /restarting it ends every mesh session/);
    assert.deepEqual(snapshot(before.bundle), files, 'the bundle the PTY host still runs is left in place');
  });

  test('with --switch-from-bundle, a release whose web server does not answer gives the bundle its units back', () => {
    const fx = fixture();
    const before = libexecInstall(fx);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'), ['--switch-from-bundle'], {FAKE_BAD_TAG: 'v1.0.0'});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /v1\.0\.0 was not kept: .*runs again/);
    assert.equal(unit(fx, WEB), before.web);
    assert.equal(unit(fx, PTY), before.pty);
    assert.ok(!changes(result.calls).some((line) => line.includes(PTY)));
    assert.ok(fs.existsSync(path.join(before.bundle, 'libexec/mesh-ptyhost')));
  });

  test('./mesh install of another extracted bundle is refused the same way, and accepted with the option', () => {
    const fx = fixture();
    const before = libexecInstall(fx);
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    const refused = launch(fx, bundle);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /services run the bundle in .*libexec.*--switch-from-bundle/);
    assert.equal(unit(fx, WEB), before.web);
    const moved = launch(fx, bundle, ['--switch-from-bundle']);
    assert.equal(moved.status, 0, moved.output);
    assert.match(unit(fx, WEB), new RegExp(`"${escape(bundle)}/app/server.py"`));
    assert.match(unit(fx, PTY), new RegExp(`^ExecStart=:"${escape(bundle)}/bin/mesh-ptyhost"$`, 'm'));
    assert.ok(!changes(moved.calls).some((line) => line.includes(PTY)));
    assert.ok(fs.existsSync(path.join(before.bundle, 'libexec/mesh-ptyhost')));
  });

  test('a bundle switch whose web server does not answer gives the old bundle its units back, and restarts no PTY host', () => {
    const fx = fixture();
    const before = libexecInstall(fx);
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    const result = launch(fx, bundle, ['--switch-from-bundle'], {FAKE_BAD_ROOT: bundle});
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, new RegExp(`${escape(bundle)} was not kept: its web server did not answer .* runs again`));
    assert.equal(unit(fx, WEB), before.web);
    assert.equal(unit(fx, PTY), before.pty);
    assert.deepEqual(changes(result.calls), [`systemctl --user restart ${WEB}`, `systemctl --user restart ${WEB}`]);
  });

  // The web unit of such an account may carry a drop-in that resets ExecStart= and sets its own:
  // rewriting the unit would leave the drop-in running the old server behind a passing check.
  test('a drop-in that sets the web unit\'s ExecStart= stops --switch-from-bundle before any change, and is left as it is', () => {
    const fx = fixture();
    const before = libexecInstall(fx);
    const text = `[Service]\nExecStart=\nExecStart=:"${before.bundle}/bin/mesh-python" "${before.bundle}/app/server.py"\n`;
    fs.mkdirSync(path.join(fx.units, `${WEB}.d`));
    const dropin = path.join(fx.units, `${WEB}.d/override.conf`);
    fs.writeFileSync(dropin, text);
    publish(fx, 'v1.0.0');
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    for (const result of [run(fx, downloaded(fx, 'v1.0.0'), ['--switch-from-bundle']), launch(fx, bundle, ['--switch-from-bundle'])]) {
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, new RegExp(`${escape(dropin)}, a drop-in of session-mesh\\.service, sets ExecStart=: it overrides the command and environment .*remove the drop-in or move it aside`));
      assert.equal(unit(fx, WEB), before.web);
      assert.equal(unit(fx, PTY), before.pty);
      assert.equal(fs.readFileSync(dropin, 'utf8'), text);
      assert.deepEqual(changes(result.calls), []);
    }
    assert.ok(!fs.existsSync(path.join(fx.share, 'current')));
  });

  test('--switch-from-bundle is refused with --upgrade, --rollback and --uninstall', () => {
    const fx = fixture();
    publish(fx, 'v1.0.0');
    for (const args of [['--upgrade'], ['--rollback'], ['--uninstall']]) {
      const result = run(fx, downloaded(fx, 'v1.0.0'), [...args, '--switch-from-bundle']);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stderr, /usage:/);
    }
  });

  test('a unit that only looks like a bundle (no env.sh or libexec beside it) is not taken for one', () => {
    const fx = fixture();
    fs.mkdirSync(fx.units, {recursive: true});
    const custom = '[Service]\nExecStart=:"/opt/switch/bin/mesh-ptyhost"\n';
    fs.writeFileSync(path.join(fx.units, PTY), custom);
    running(fx, PTY);
    publish(fx, 'v1.0.0');
    const result = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /was not written by a release install: it is preserved/);
    assert.equal(unit(fx, PTY), custom);
  });
});

describe('macOS: jobs that run another extracted bundle', () => {
  function macFixture(): Fixture {
    const fx = fixture({...MAC_FAKES, curl: CURL});
    writeExecutable(path.join(fx.fakes, 'plutil'), `exec "${process.execPath}" --experimental-strip-types "${path.join(import.meta.dirname, 'fixtures/fake-plutil.ts')}" "$@"`);
    fs.mkdirSync(path.join(fx.home, 'Library/Application Support'), {recursive: true, mode: 0o700});
    return fx;
  }
  const agents = (fx: Fixture) => path.join(fx.home, 'Library/LaunchAgents');
  const job = (fx: Fixture, label: string) =>
    parsePlist(fs.readFileSync(path.join(agents(fx), `${label}.plist`), 'utf8')) as {ProgramArguments: string[]};

  test('a release install refuses without the option; with it the web job moves and the PTY job is preserved', () => {
    const fx = macFixture();
    const first = extracted(fx, 'mesh-macos-arm64');
    const installed = launch(fx, first);
    assert.equal(installed.status, 0, installed.output);
    assert.deepEqual(job(fx, 'io.session-mesh.web').ProgramArguments, [`${first}/bin/mesh-python`, `${first}/app/server.py`]);
    publish(fx, 'v1.0.0');
    const refused = run(fx, downloaded(fx, 'v1.0.0'));
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.stderr, new RegExp(`jobs run the bundle in ${escape(first)}; they were left as they are.*--switch-from-bundle`));
    assert.deepEqual(job(fx, 'io.session-mesh.web').ProgramArguments[1], `${first}/app/server.py`);
    const moved = run(fx, downloaded(fx, 'v1.0.0'), ['--switch-from-bundle']);
    assert.equal(moved.status, 0, moved.output);
    assert.deepEqual(job(fx, 'io.session-mesh.web').ProgramArguments, [`${fx.share}/current/bin/mesh-python`, `${fx.share}/current/app/server.py`]);
    assert.equal(job(fx, 'io.session-mesh.pty').ProgramArguments[0], `${first}/bin/mesh-ptyhost`, 'the PTY job keeps its host');
    assert.ok(!moved.calls.split('\n').some((line) => /^launchctl (bootout|kickstart)/.test(line) && line.includes('io.session-mesh.pty')),
      'the PTY host is neither unloaded nor restarted');
    assert.ok(fs.existsSync(path.join(first, 'libexec/mesh-ptyhost')));
  });
});

// The web server and the PTY host start through the bundle's wrappers, and the PTY host passes its
// PATH to every session: the bundle's Node and Python must not shadow the user's own there.
describe('the bundle wrappers and PATH', () => {
  test('a child of the PTY host or of the bundled Python sees the bundle\'s bin/ on PATH, not its runtimes', () => {
    const fx = fixture();
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    fs.writeFileSync(path.join(bundle, 'libexec/mesh-ptyhost'), '#!/bin/bash\nexec /usr/bin/printenv PATH\n', {mode: 0o755});
    const env = {HOME: fx.home, PATH: '/usr/bin:/bin'};
    const host = spawnSync(path.join(bundle, 'bin/mesh-ptyhost'), [], {env, encoding: 'utf8', timeout: 10000});
    const python = spawnSync(path.join(bundle, 'bin/mesh-python'), ['-c', 'import subprocess; subprocess.run(["/usr/bin/printenv", "PATH"])'],
      {env, encoding: 'utf8', timeout: 10000});
    for (const result of [host, python]) {
      assert.equal(result.status, 0, `${result.error ?? ''}${result.stderr}`);
      assert.deepEqual(result.stdout.trim().split(':'), [path.join(bundle, 'bin'), '/usr/bin', '/bin']);
    }
  });

  // The PTY host starts the project observation worker (the bundled Node) with its own environment,
  // whose PATH has no node; the worker runs the Roster CLIs, which start with #!/usr/bin/env node.
  test('the observation worker runs a bundled Roster CLI with the bundled Node, with nothing on PATH', () => {
    const fx = fixture();
    const bundle = extracted(fx, 'mesh-linux-x86_64');
    fs.mkdirSync(path.join(bundle, 'runtime/node/bin'), {recursive: true});
    fs.symlinkSync(process.execPath, path.join(bundle, 'runtime/node/bin/node'));
    fs.mkdirSync(path.join(bundle, 'app/tools'), {recursive: true});
    fs.copyFileSync(path.join(SOURCE, 'tools/project-observation.mjs'), path.join(bundle, 'app/tools/project-observation.mjs'));
    fs.mkdirSync(path.join(bundle, 'optional/roster/scripts'), {recursive: true});
    const view = JSON.stringify(roadmapObservation([roadmapTask()]));
    fs.writeFileSync(path.join(bundle, 'optional/roster/scripts/roster-roadmap.cjs'),
      `#!/usr/bin/env node\nif (process.argv[2] !== 'view') process.exit(3);\nconsole.log(${JSON.stringify(view)});\n`);
    fs.copyFileSync(path.join(SOURCE, 'scripts/bundle/mesh-roster'), path.join(bundle, 'libexec/mesh-roster-roadmap'));
    fs.chmodSync(path.join(bundle, 'libexec/mesh-roster-roadmap'), 0o755);
    const sourced = spawnSync('/bin/bash', ['-c', 'MESH_BUNDLE_ROOT=$1; source "$1/env.sh"; printf "%s\\n" "$MESH_PROJECT_OBSERVATION_RUNTIME" '
      + '"$MESH_PROJECT_OBSERVATION_ENTRY" "$MESH_PROJECT_ROSTER_CLI" "$PATH"', '_', bundle], {env: {PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
    const [runtime, entry, roster, sessionPath] = sourced.stdout.trim().split('\n');
    assert.equal(roster, path.join(bundle, 'libexec/mesh-roster-roadmap'));
    assert.ok(!sessionPath!.split(':').some((dir) => dir.startsWith(path.join(bundle, 'runtime'))), sessionPath);
    const board = path.join(fx.home, 'board');
    const input = {kind: 'mesh-project-observation-input', version: 1, observation_id: 'a'.repeat(64), boot: 'b'.repeat(64),
      scope: {machine_id: 'host', project_id: 'one', captured_revision: `cfg1_${'c'.repeat(64)}`}, plan: {repository: false, source_ids: ['r']},
      config: {kind: 'mesh-project-config', schema_version: 2, features: ['project-metadata/1'], machine_id: 'host',
        projects: [{id: 'one', title: 'One', sources: [{id: 'r', kind: 'roster', label: 'R', board_path: board}], sessions: []}]},
      profile: 'metadata-followup/1'};
    const worker = spawnSync(runtime!, [entry!], {input: JSON.stringify(input), encoding: 'utf8', timeout: 20000,
      env: {HOME: fx.home, PATH: '/opt/none', MESH_PROJECT_ROSTER_CLI: roster}});
    assert.equal(worker.status, 0, worker.stderr);
    const source = JSON.parse(worker.stdout).result.catalog.projects[0].sources[0];
    assert.equal(source.status, 'available', JSON.stringify(source));
    assert.equal(source.summary.followup.metadata.value.board_id, 'delivery');
  });
});
