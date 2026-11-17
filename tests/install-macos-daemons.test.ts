// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// install.sh --at-boot on macOS (scripts/install-macos.sh): boot-time daemons in the system domain,
// the one sudo confirmation, reruns and --uninstall. Every privileged command goes through the fake
// sudo of tests/install-macos-lib.ts, which accepts only absolute paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES, LAUNCHCTL, PTY, SUPPORT, UID, WEB, changes, daemonFile, defaultRuntime, escape, fixture, hasScript, install, loaded,
  plistFile, readJob, stateFile, sudoCalls} from './install-macos-lib.ts';

const terminal = {skip: !hasScript && 'util-linux script absent'};
const ROOT_COMMANDS = /^sudo (\/usr\/bin\/install|\/bin\/launchctl|\/bin\/rm) /;
// Every command run as root is named by an absolute path, and every launchctl call in the system
// domain went through sudo (the fake launchctl also refuses the system domain without it).
function assertPrivilegedCalls(calls: string): void {
  for (const line of sudoCalls(calls)) assert.match(line, ROOT_COMMANDS);
  const system = calls.split('\n').filter((line) => /^launchctl (bootstrap system|bootout system\/|kickstart system\/)/.test(line));
  assert.equal(system.length, sudoCalls(calls).filter((line) => line.startsWith('sudo /bin/launchctl ')).length);
}
const sudoLaunchctl = (action: string, target: string) => new RegExp(`^sudo /bin/launchctl ${action} ${escape(target)}`, 'm');
const atBoot = (fx: ReturnType<typeof fixture>, env: Record<string, string> = {}, answer = 'y') =>
  install(fx, ['--at-boot'], {FAKE_GUI: '0', ...env}, {answer});

describe('install.sh on macOS: boot-time daemons (--at-boot)', () => {
  test('without a terminal --at-boot never runs sudo and changes nothing', () => {
    const fx = fixture();
    const run = install(fx, ['--at-boot'], {FAKE_GUI: '0'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--at-boot needs sudo and asks before using it: run it from a terminal; nothing was changed/);
    assert.deepEqual(sudoCalls(run.calls), []);
    assert.deepEqual(fs.readdirSync(fx.daemons), []);
    assert.ok(!fs.existsSync(path.join(fx.home, SUPPORT, 'session-mesh')));
    assert.doesNotMatch(run.calls, changes);
  });

  test('answered no on a terminal: sudo is never called', terminal, () => {
    const fx = fixture();
    const run = install(fx, ['--at-boot'], {FAKE_GUI: '0'}, {answer: 'n'});
    assert.match(run.output, /Run these commands with sudo now\? \[y\/N\]/);
    assert.match(run.output, /sudo declined; nothing was changed/);
    assert.deepEqual(sudoCalls(run.calls), []);
    assert.deepEqual(fs.readdirSync(fx.daemons), []);
  });

  for (const answer of ['n', '', 'yeah', 'yes please']) {
    test(`answer ${JSON.stringify(answer)} is refused: sudo is never called`, terminal, () => {
      const fx = fixture();
      const run = install(fx, ['--at-boot'], {FAKE_GUI: '0'}, {answer});
      assert.match(run.output, /sudo declined; nothing was changed/);
      assert.deepEqual(sudoCalls(run.calls), []);
      assert.deepEqual(fs.readdirSync(fx.daemons), []);
    });
  }

  for (const answer of ['Y', 'YES', 'Yes', ' y ']) {
    test(`answer ${JSON.stringify(answer)} is accepted like y`, terminal, () => {
      const fx = fixture();
      const run = atBoot(fx, {}, answer);
      assert.equal(run.status, 0, run.output);
      assert.doesNotMatch(run.output, /sudo declined/);
      assert.ok(sudoCalls(run.calls).length > 0);
    });
  }

  test('answered yes: both daemons run as the account in the system domain, with a login environment',
    terminal, () => {
      const fx = fixture();
      const run = atBoot(fx);
      assert.equal(run.status, 0, run.output);
      for (const label of [PTY, WEB]) {
        const job = readJob(daemonFile(fx, label));
        assert.equal(job.UserName, 'fixture');
        assert.equal(job.GroupName, 'staff');
        assert.equal(job.LimitLoadToSessionType, undefined);
        assert.equal(job.WorkingDirectory, fx.home);
        assert.equal(job.EnvironmentVariables.HOME, fx.home);
        assert.equal(job.EnvironmentVariables.USER, 'fixture');
        assert.equal(job.EnvironmentVariables.LOGNAME, 'fixture');
        assert.equal(job.EnvironmentVariables.SHELL, '/bin/zsh');
        assert.equal(job.EnvironmentVariables.MESH_RUNTIME_DIR, defaultRuntime(fx));
        assert.equal(fs.statSync(daemonFile(fx, label)).mode & 0o777, 0o644);
        assert.ok(loaded(fx, 'system', label));
      }
      assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
      for (const label of [PTY, WEB]) {
        const file = escape(daemonFile(fx, label));
        assert.match(run.calls, new RegExp(`^sudo /usr/bin/install -m 644 -o root -g wheel \\S+ ${file}$`, 'm'));
        assert.match(run.output, new RegExp(`/usr/bin/install -m 644 -o root -g wheel <new plist> '${file}'`));
        assert.match(run.calls, sudoLaunchctl('bootstrap', `system ${daemonFile(fx, label)}`));
        assert.match(run.output, new RegExp(`/bin/launchctl bootstrap system '${file}'`));
      }
      assertPrivilegedCalls(run.calls);
      assert.match(run.output, /launchd starts them at boot as fixture, with nobody logged in/);
      assert.match(run.output, /restart  : sudo launchctl kickstart -k system\/io\.session-mesh\.web/);
    });

  test('a rerun of installed daemons needs --at-boot; --at-boot over installed agents is refused', () => {
    const daemons = fixture();
    fs.writeFileSync(daemonFile(daemons, PTY), '');
    const plain = install(daemons);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /installed as boot-time daemons .*: rerun with --at-boot/);
    assert.doesNotMatch(plain.calls, changes);
    const agents = fixture();
    assert.equal(install(agents, [], {FAKE_GUI: '0'}).status, 0);
    const moved = install(agents, ['--at-boot'], {FAKE_GUI: '0'});
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, /moving to boot-time daemons ends every mesh session, so the installer does not do it/);
    assert.doesNotMatch(moved.calls, changes);
  });

  test('--uninstall removes the web daemon with sudo after a yes, and keeps the PTY daemon',
    terminal, () => {
      const fx = fixture();
      assert.equal(atBoot(fx).status, 0);
      const refused = install(fx, ['--uninstall'], {FAKE_GUI: '0'});
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /run --uninstall from a terminal, or run: sudo launchctl bootout system\/io\.session-mesh\.web/);
      assert.deepEqual(sudoCalls(refused.calls), []);
      const run = install(fx, ['--uninstall'], {FAKE_GUI: '0'}, {answer: 'y'});
      assert.equal(run.status, 0, run.output);
      assert.ok(!fs.existsSync(daemonFile(fx, WEB)) && !loaded(fx, 'system', WEB));
      assert.ok(fs.existsSync(daemonFile(fx, PTY)) && loaded(fx, 'system', PTY));
      assert.match(run.output, /To stop everything: sudo launchctl bootout system\/io\.session-mesh\.pty/);
      assert.match(run.calls, /^sudo \/bin\/rm -f -- \S+io\.session-mesh\.web\.plist$/m);
      assertPrivilegedCalls(run.calls);
    });

  test('agents and daemons installed together are refused before any change', () => {
    const fx = fixture();
    assert.equal(install(fx, [], {FAKE_GUI: '0'}).status, 0);
    fs.writeFileSync(daemonFile(fx, WEB), '');
    for (const args of [[], ['--at-boot']]) {
      const run = install(fx, args, {FAKE_GUI: '0'});
      assert.equal(run.status, 1);
      assert.match(run.stderr, /has both launchd agents .* and boot-time daemons .*; keep one form/);
      assert.doesNotMatch(run.calls, changes);
    }
    assert.ok(loaded(fx, `user/${UID}`, WEB) && fs.existsSync(plistFile(fx, WEB)));
  });

  test('a web daemon plist that is a symbolic link is refused before sudo', terminal, () => {
    const fx = fixture();
    assert.equal(atBoot(fx).status, 0);
    const target = path.join(fx.root, 'elsewhere.plist');
    fs.writeFileSync(target, 'kept');
    fs.rmSync(daemonFile(fx, WEB));
    fs.symlinkSync(target, daemonFile(fx, WEB));
    const run = atBoot(fx);
    assert.equal(run.status, 1);
    assert.match(run.output, /io\.session-mesh\.web\.plist is not a regular file \(a symbolic link is refused\)/);
    assert.deepEqual(sudoCalls(run.calls), []);
    assert.equal(fs.readFileSync(target, 'utf8'), 'kept');
  });
});

describe('install.sh on macOS: rerunning --at-boot', () => {
  test('a new LANG rewrites the running PTY daemon\'s plist with sudo, never unloads it, and says how to apply it',
    terminal, () => {
      const fx = fixture();
      assert.equal(atBoot(fx, {LANG: 'en_GB.UTF-8'}).status, 0);
      const run = atBoot(fx, {LANG: 'de_DE.UTF-8'});
      assert.equal(run.status, 0, run.output);
      assert.equal(readJob(daemonFile(fx, PTY)).EnvironmentVariables.LANG, 'de_DE.UTF-8');
      assert.match(run.calls, new RegExp(`^sudo /usr/bin/install -m 644 -o root -g wheel \\S+ ${escape(daemonFile(fx, PTY))}$`, 'm'));
      assert.doesNotMatch(run.calls, new RegExp(`^(sudo /bin/)?launchctl (bootout|kickstart|bootstrap) system\\S* ?\\S*${PTY}`, 'm'));
      assert.ok(loaded(fx, 'system', PTY));
      assert.match(run.output, new RegExp(`now with sudo launchctl bootout system/${PTY} \\(this ends every mesh session\\) then sudo launchctl bootstrap system`));
      assert.match(run.output, new RegExp(`/bin/launchctl bootout system/${WEB}   \\(stops the web server`));
      assert.match(run.calls, sudoLaunchctl('bootout', `system/${WEB}`));
      assert.match(run.calls, sudoLaunchctl('bootstrap', `system ${daemonFile(fx, WEB)}`));
      assertPrivilegedCalls(run.calls);
    });

  test('a stopped PTY daemon is kickstarted with sudo, and the prompt lists the kickstart', terminal, () => {
    const fx = fixture();
    assert.equal(atBoot(fx, {LANG: 'en_GB.UTF-8'}).status, 0);
    fs.writeFileSync(stateFile(fx, 'system', PTY), 'not running');
    const run = atBoot(fx, {LANG: 'en_GB.UTF-8'});
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, new RegExp(`/bin/launchctl kickstart system/${PTY}   \\(starts the stopped PTY host\\)`));
    assert.match(run.calls, sudoLaunchctl('kickstart', `system/${PTY}`));
    assert.doesNotMatch(run.calls, new RegExp(`^launchctl bootout system/${PTY}`, 'm'));
    assert.equal(fs.readFileSync(stateFile(fx, 'system', PTY), 'utf8').trim(), 'running');
    assertPrivilegedCalls(run.calls);
  });

  test('a stopped PTY daemon whose LANG changes is loaded again with sudo, not kickstarted', terminal, () => {
    const fx = fixture();
    assert.equal(atBoot(fx, {LANG: 'en_GB.UTF-8'}).status, 0);
    fs.writeFileSync(stateFile(fx, 'system', PTY), 'not running');
    const run = atBoot(fx, {LANG: 'de_DE.UTF-8'});
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, new RegExp(`/bin/launchctl bootout system/${PTY}   \\(the PTY host is not running`));
    assert.match(run.calls, sudoLaunchctl('bootout', `system/${PTY}`));
    assert.match(run.calls, sudoLaunchctl('bootstrap', `system ${daemonFile(fx, PTY)}`));
    assert.doesNotMatch(run.calls, /kickstart/);
    assert.ok(loaded(fx, 'system', PTY));
    assertPrivilegedCalls(run.calls);
  });
});

describe('install.sh on macOS: --uninstall of boot-time daemons', () => {
  test('a web job loaded both as an agent and as a daemon is unloaded from both domains', terminal, () => {
    const fx = fixture();
    assert.equal(atBoot(fx).status, 0);
    fs.writeFileSync(stateFile(fx, `user/${UID}`, WEB), 'running');
    const run = install(fx, ['--uninstall'], {FAKE_GUI: '0'}, {answer: 'y'});
    assert.equal(run.status, 0, run.output);
    assert.ok(!loaded(fx, `user/${UID}`, WEB) && !loaded(fx, 'system', WEB));
    assert.match(run.calls, new RegExp(`^launchctl bootout user/${UID}/${WEB}$`, 'm'));
    assert.match(run.calls, sudoLaunchctl('bootout', `system/${WEB}`));
    assert.ok(!fs.existsSync(daemonFile(fx, WEB)));
    assertPrivilegedCalls(run.calls);
  });

  test('a failed sudo is reported, not taken for a job that was not loaded', terminal, () => {
    const fx = fixture();
    assert.equal(atBoot(fx).status, 0);
    const run = install(fx, ['--uninstall'], {FAKE_GUI: '0', FAKE_SUDO_FAIL: '1'}, {answer: 'y'});
    assert.equal(run.status, 1);
    assert.match(run.output, /sudo: a password is required/);
    assert.match(run.output, new RegExp(`sudo /bin/launchctl bootout system/${WEB} failed \\(status 1\\); the job is still loaded`));
    assert.ok(loaded(fx, 'system', WEB) && fs.existsSync(daemonFile(fx, WEB)));
  });
});

describe('install.sh on macOS: a job that is still exiting', () => {
  test('bootout answering 36 while the job unloads 0.3 s later is not an error', () => {
    const slow = LAUNCHCTL.replace(/bootout\) .*/, 'bootout) [[ -f $(state "$2") ]] || exit 3; f=$(state "$2"); (sleep 0.3; rm -f "$f") >/dev/null 2>&1 & echo "Boot-out failed: 36: Operation now in progress" >&2; exit 36 ;;');
    assert.notEqual(slow, LAUNCHCTL);
    const fx = fixture({fakes: {...FAKES, launchctl: slow}});
    assert.equal(install(fx, [], {FAKE_GUI: '0'}).status, 0);
    const run = install(fx, [], {FAKE_GUI: '0'});
    assert.equal(run.status, 0, run.stderr);
    assert.ok(loaded(fx, `user/${UID}`, WEB));
    assert.match(run.calls, new RegExp(`^launchctl bootstrap user/${UID} `, 'm'));
  });
});
