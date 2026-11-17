// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// install.sh on macOS (scripts/install-macos.sh) with launchd agents, the default form: the jobs,
// their session type and environment, the dependencies and Tailscale. The fakes standing in for
// macOS are described in tests/install-macos-lib.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES, PTY, escape, SOURCE, SUPPORT, UID, WEB, changes, defaultRuntime, fixture, install, loaded, plist, plistFile,
  readJob, stateFile, sudoCalls} from './install-macos-lib.ts';

describe('install.sh on macOS: launchd agents', () => {
  test('a first install writes two valid plists sharing the default runtime directory, and loads both', () => {
    const fx = fixture();
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /running on 127\.0\.0\.1:7690/);
    const pty = plist(fx, PTY);
    const web = plist(fx, WEB);
    assert.equal(pty.Label, PTY);
    assert.deepEqual(pty.ProgramArguments, [path.join(fx.switchBin, 'mesh-ptyhost')]);
    assert.deepEqual(web.ProgramArguments, [path.join(fx.fakes, 'python3'), path.join(fx.checkout, 'server.py')]);
    const runtime = defaultRuntime(fx);
    assert.equal(pty.EnvironmentVariables.MESH_RUNTIME_DIR, runtime);
    assert.equal(web.EnvironmentVariables.MESH_RUNTIME_DIR, runtime);
    for (const dir of [path.dirname(runtime), runtime]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(web.EnvironmentVariables.MESH_PORT, '7690');
    assert.equal(web.EnvironmentVariables.MESH_OPAM_SWITCH, 'session-mesh');
    for (const agent of [pty, web]) {
      assert.ok(agent.EnvironmentVariables.PATH.startsWith(`${fx.switchBin}:${fx.home}/.local/bin:`));
      assert.equal(agent.EnvironmentVariables.LANG, 'en_US.UTF-8');
      assert.equal(agent.EnvironmentVariables.HOME, undefined);
      assert.deepEqual(agent.KeepAlive, {SuccessfulExit: false});
      assert.equal(agent.RunAtLoad, true);
      assert.equal(agent.ThrottleInterval, 30);
      assert.equal(agent.LimitLoadToSessionType, 'Aqua');
      assert.equal(agent.UserName, undefined);
    }
    assert.equal(pty.StandardOutPath, path.join(fx.home, 'Library/Logs/session-mesh/pty.log'));
    assert.equal(web.StandardErrorPath, path.join(fx.home, 'Library/Logs/session-mesh/web.log'));
    assert.ok(loaded(fx, `gui/${UID}`, PTY) && loaded(fx, `gui/${UID}`, WEB));
    assert.match(run.stderr + run.stdout, /logging out stops them, and with them every mesh session/);
    assert.ok(!fs.existsSync(path.join(fx.home, '.config/systemd')));
    assert.ok(!fs.existsSync(path.join(fx.home, '.local/state')));
    assert.doesNotMatch(run.calls, /^(systemctl|sudo|tailscale|install) /m);
    assert.deepEqual(fs.readdirSync(fx.root).filter((name) => name.startsWith('session-mesh-plists')), []);
  });

  test('the agents, logs, command links and default runtime directory use the user database home, not HOME', () => {
    const fx = fixture();
    const other = path.join(fx.root, 'db-home');
    fs.mkdirSync(path.join(other, SUPPORT), {recursive: true, mode: 0o700});
    const run = install(fx, [], {FAKE_PW_HOME: other});
    assert.equal(run.status, 0, run.stderr);
    const pty = readJob(path.join(other, 'Library/LaunchAgents', `${PTY}.plist`));
    assert.equal(pty.EnvironmentVariables.MESH_RUNTIME_DIR, path.join(other, SUPPORT, 'session-mesh/run'));
    assert.equal(pty.StandardOutPath, path.join(other, 'Library/Logs/session-mesh/pty.log'));
    assert.ok(fs.existsSync(path.join(other, 'Library/Logs/session-mesh/web.log')));
    assert.ok(fs.lstatSync(path.join(other, '.local/bin/mesh-attach')).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')) && !fs.existsSync(path.join(fx.home, 'Library/Logs')));
  });

  test('a hostile checkout path and runtime directory are escaped, and read back exactly', () => {
    const fx = fixture({checkoutName: `co & <x> "q" 'a' ]]>`});
    const runtime = path.join(fx.root, `run & <r> "d"`);
    fs.mkdirSync(runtime, {mode: 0o700});
    const run = install(fx, [], {MESH_RUNTIME_DIR: runtime});
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const text = fs.readFileSync(plistFile(fx, WEB), 'utf8');
    assert.doesNotMatch(text, /<x>|"q"|<r>/);
    const web = plist(fx, WEB);
    assert.equal(web.ProgramArguments[1], path.join(fx.checkout, 'server.py'));
    assert.equal(web.EnvironmentVariables.MESH_RUNTIME_DIR, runtime);
    assert.equal(plist(fx, PTY).EnvironmentVariables.MESH_RUNTIME_DIR, runtime);
  });

  test('a control character in the runtime directory is refused before anything is written', () => {
    const fx = fixture();
    const run = install(fx, [], {MESH_RUNTIME_DIR: path.join(fx.root, 'run\u0001x')});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /MESH_RUNTIME_DIR \(or XDG_RUNTIME_DIR\) must be an absolute path without control characters/);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });

  test('a control character in any plist value aborts the install before anything is written', () => {
    const fx = fixture();
    const run = install(fx, [], {LANG: 'en_US.UTF-8\u0001'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /contains a control character; nothing was changed/);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
    assert.ok(!fs.existsSync(path.join(fx.home, SUPPORT, 'session-mesh')));
    assert.doesNotMatch(run.calls, changes);
  });

  test('a rerun keeps the installed port and the running PTY host, and replaces the web agent', () => {
    const fx = fixture();
    assert.equal(install(fx, [], {MESH_PORT: '7691'}).status, 0);
    const before = fs.readFileSync(plistFile(fx, PTY), 'utf8');
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Keeping the installed port 7691/);
    assert.equal(plist(fx, WEB).EnvironmentVariables.MESH_PORT, '7691');
    assert.equal(fs.readFileSync(plistFile(fx, PTY), 'utf8'), before);
    assert.doesNotMatch(run.calls, /^launchctl (bootstrap \S+ \S+pty|bootout \S+pty|kickstart)/m);
    assert.match(run.calls, new RegExp(`^launchctl bootout gui/${UID}/${WEB}$`, 'm'));
    assert.match(run.calls, new RegExp(`^launchctl bootstrap gui/${UID} \\S+${WEB}\\.plist$`, 'm'));
  });

  test('an unreadable installed port is refused, not replaced by 7690', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    fs.writeFileSync(plistFile(fx, WEB), 'not a plist');
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /sets MESH_PORT to unreadable, which the installer cannot read as a port number/);
    assert.doesNotMatch(run.calls, changes);
  });

  test('--pty-backend no longer exists on macOS either', () => {
    const fx = fixture();
    const run = install(fx, ['--pty-backend', 'native']);
    assert.equal(run.status, 2);
    assert.match(run.stdout + run.stderr, /usage: [^]*--ptyhost ABSOLUTE_PATH \| --from-source\]/);
    assert.doesNotMatch(run.stdout + run.stderr, /pty-backend/);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });

  test('--ptyhost or --from-source over an installed PTY agent is refused before any change', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    const host = path.join(fx.switchBin, 'mesh-ptyhost');
    for (const args of [['--ptyhost', host], ['--from-source']]) {
      const run = install(fx, args);
      assert.equal(run.status, 1, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /existing PTY configuration preserved; explicit migration is not supported/, args.join(' '));
      assert.doesNotMatch(run.calls, changes, args.join(' '));
    }
  });

  test('no host option combines with --uninstall, in either order', () => {
    const fx = fixture();
    const host = path.join(fx.switchBin, 'mesh-ptyhost');
    for (const option of [['--ptyhost', host], ['--from-source']]) {
      for (const args of [[...option, '--uninstall'], ['--uninstall', ...option]]) {
        const run = install(fx, args);
        assert.equal(run.status, 2, args.join(' '));
        assert.match(run.stdout + run.stderr, /usage: [^]*--from-source\]/);
      }
    }
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });

  test('macOS older than 12.3 is refused', () => {
    const fx = fixture();
    const run = install(fx, [], {FAKE_MACOS: '12.2.1'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /needs macOS 12\.3 or later; this Mac runs macOS 12\.2\.1/);
    assert.equal(install(fx, [], {FAKE_MACOS: '12.3'}).status, 0);
  });

  test('Python older than 3.10 is refused before any change', () => {
    const fx = fixture();
    const run = install(fx, [], {FAKE_PYTHON_VERSION: '3.9'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /needs Python 3\.10 or newer; .* is Python 3\.9/);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });

  test('--uninstall unloads and removes the web agent only, and says how to stop the PTY host', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    const run = install(fx, ['--uninstall']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!fs.existsSync(plistFile(fx, WEB)) && !loaded(fx, `gui/${UID}`, WEB));
    assert.ok(fs.existsSync(plistFile(fx, PTY)) && loaded(fx, `gui/${UID}`, PTY));
    assert.match(run.stdout, new RegExp(`keeps running\\. To stop everything: launchctl bootout gui/${UID}/${PTY}; rm '${escape(plistFile(fx, PTY))}'`));
    assert.deepEqual(sudoCalls(run.calls), []);
  });
});

describe('install.sh on macOS: the session type and the environment of the agents', () => {
  test('without a graphical session the agents go to the background user domain, with the reboot warning', () => {
    const fx = fixture();
    const run = install(fx, [], {FAKE_GUI: '0'});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(plist(fx, PTY).LimitLoadToSessionType, 'Background');
    assert.ok(loaded(fx, `user/${UID}`, PTY) && loaded(fx, `user/${UID}`, WEB));
    assert.match(run.output, /They run until the Mac restarts, and are not loaded again after a restart until you rerun \.\/install\.sh/);
    assert.match(run.output, /launchctl bootstrap user\/\d+ '.*io\.session-mesh\.pty\.plist'/);
    assert.match(run.output, /\.\/install\.sh --at-boot/);
  });

  test('installed under a graphical login, a rerun without one is refused before any change', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    const pty = fs.readFileSync(plistFile(fx, PTY), 'utf8');
    const web = fs.readFileSync(plistFile(fx, WEB), 'utf8');
    fs.rmSync(stateFile(fx, `gui/${UID}`, PTY));
    fs.rmSync(stateFile(fx, `gui/${UID}`, WEB));
    const run = install(fx, [], {FAKE_GUI: '0'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /installed for a graphical login .* no graphical login session now; nothing was changed/);
    assert.equal(fs.readFileSync(plistFile(fx, PTY), 'utf8'), pty);
    assert.equal(fs.readFileSync(plistFile(fx, WEB), 'utf8'), web);
    assert.doesNotMatch(run.calls, changes);
  });

  test('installed in the background domain, a rerun with a graphical login keeps both agents there', () => {
    const fx = fixture();
    assert.equal(install(fx, [], {FAKE_GUI: '0'}).status, 0);
    const run = install(fx, [], {FAKE_GUI: '1'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Keeping the background domain user\/\d+ of the installed PTY agent/);
    assert.equal(plist(fx, WEB).LimitLoadToSessionType, 'Background');
    assert.ok(loaded(fx, `user/${UID}`, PTY) && loaded(fx, `user/${UID}`, WEB));
    assert.ok(!loaded(fx, `gui/${UID}`, WEB));
  });

  test('a new LANG reaches the PTY plist without touching the running host, and says how to apply it', () => {
    const fx = fixture();
    assert.equal(install(fx, [], {LANG: 'en_GB.UTF-8'}).status, 0);
    const run = install(fx, [], {LANG: 'de_DE.UTF-8'});
    assert.equal(run.status, 0, run.stderr);
    const pty = plist(fx, PTY);
    assert.equal(pty.EnvironmentVariables.LANG, 'de_DE.UTF-8');
    assert.deepEqual(pty.ProgramArguments, [path.join(fx.switchBin, 'mesh-ptyhost')]);
    assert.equal(pty.EnvironmentVariables.MESH_RUNTIME_DIR, defaultRuntime(fx));
    assert.doesNotMatch(run.calls, new RegExp(`^launchctl (bootout|kickstart) \\S+/${PTY}`, 'm'));
    assert.match(run.output, /The running PTY host keeps its environment until launchd loads the job again/);
    assert.equal(plist(fx, WEB).EnvironmentVariables.LANG, 'de_DE.UTF-8');
  });

  test('a loaded but stopped PTY agent whose LANG changes is loaded again, not kickstarted', () => {
    const fx = fixture();
    assert.equal(install(fx, [], {LANG: 'en_GB.UTF-8'}).status, 0);
    fs.writeFileSync(stateFile(fx, `gui/${UID}`, PTY), 'not running');
    const run = install(fx, [], {LANG: 'de_DE.UTF-8'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.calls, new RegExp(`^launchctl bootout gui/${UID}/${PTY}$`, 'm'));
    assert.match(run.calls, new RegExp(`^launchctl bootstrap gui/${UID} \\S+${PTY}\\.plist$`, 'm'));
    assert.doesNotMatch(run.calls, /^launchctl kickstart/m);
  });

  test('without LANG a rerun keeps the installed one; a first install takes the account region', () => {
    const fx = fixture();
    assert.equal(install(fx, [], {LANG: 'en_GB.UTF-8'}).status, 0);
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(plist(fx, PTY).EnvironmentVariables.LANG, 'en_GB.UTF-8');
    const regional = fixture({fakes: {...FAKES, defaults: '[[ $* == "read -g AppleLocale" ]] && echo "fr_FR@rg=bezzzz"',
      locale: '[[ $* == -a ]] && printf "C\\nfr_FR.UTF-8\\n"'}});
    assert.equal(install(regional).status, 0);
    assert.equal(plist(regional, PTY).EnvironmentVariables.LANG, 'fr_FR.UTF-8');
  });
});

describe('install.sh on macOS: dependencies and Tailscale', () => {
  test('missing dependencies name Homebrew and the venv, before any change', () => {
    const fakes = {...FAKES, python3: '[[ $2 == "import sys;"* ]] && echo 3.12; [[ $2 == "import aiohttp" ]] && exit 1; exit 0'};
    const fx = fixture({fakes});
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /missing: aiohttp/);
    assert.match(run.stdout, /brew install python opam/);
    assert.match(run.stdout, /pip install -r requirements\.txt/);
    assert.ok(!fs.existsSync(path.join(fx.home, 'Library/LaunchAgents')));
  });

  test('a refused tailscale serve never reaches sudo: the installer says what to check', () => {
    const tailscale = `case "$*" in
  "serve status --json") echo '{}' ;;
  "serve --bg 7690") echo "Access denied: serve config denied" >&2; exit 1 ;;
  *) exit 97 ;;
esac`;
    const fx = fixture({fakes: {...FAKES, tailscale}});
    const run = install(fx, ['--tailscale']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /the installer runs no sudo for Tailscale on macOS/);
    assert.deepEqual(sudoCalls(run.calls), []);
    assert.ok(loaded(fx, `gui/${UID}`, WEB));
  });
});

// macOS runs install.sh with its bash 3.2, which parses the whole file before the Darwin branch,
// Linux part included. No bash 3.2 runs here: this rejects the constructs that bash 3.2 cannot
// parse and that the installers used before; MESH_BASH32 names a bash 3.2 to parse them with.
describe('install.sh on macOS: bash 3.2', () => {
  const scripts = ['install.sh', 'scripts/install-checkout.sh', 'scripts/install-common.sh', 'scripts/install-release.sh', 'scripts/install-macos.sh',
    'scripts/install-macos-launchd.sh', 'scripts/install-macos-release.sh'];
  test('the installers use no test operator or case terminator that bash 3.2 cannot parse', () => {
    for (const script of scripts) {
      const text = fs.readFileSync(path.join(SOURCE, script), 'utf8');
      assert.doesNotMatch(text, /\[\[[^\]]*\s-v\s/, `${script}: [[ -v ]] needs bash 4.2`);
      assert.doesNotMatch(text, /;;&|;&\s*$/m, `${script}: ;& and ;;& need bash 4`);
    }
  });
  test('the installers parse with bash 3.2', {skip: !process.env.MESH_BASH32 && 'MESH_BASH32 is not set'}, () => {
    for (const script of scripts) {
      const run = spawnSync(process.env.MESH_BASH32!, ['-n', path.join(SOURCE, script)], {encoding: 'utf8'});
      assert.equal(run.status, 0, `${script}: ${run.stderr}`);
    }
  });
});
