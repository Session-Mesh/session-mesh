// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// install.sh on a machine without Tailscale. The real installer runs
// in an owned temporary HOME, with fake systemctl, curl, loginctl, python3 and sudo on a closed PATH:
// nothing reaches the real service manager, network or account.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';
import {copyInstallerScripts} from './install-scripts.ts';

const SOURCE = process.env.MESH_INSTALL_SOURCE || path.resolve(import.meta.dirname, '..');
const REAL_TOOLS = ['dirname', 'readlink', 'mkdir', 'rm', 'seq', 'sleep', 'grep', 'cat', 'ln', 'mktemp'];
const FAKES: Record<string, string> = {
  systemctl: `if [[ $* == "--user show "* ]]; then
  printf '%s\\n' LoadState=not-found ActiveState=inactive SubState=dead FragmentPath= DropInPaths= NeedDaemonReload=no; exit 0; fi`,
  // A probe of the PTY socket answers like curl: 7 when nothing accepts the connection.
  curl: '[[ $* == *--unix-socket* ]] && exit "${FAKE_UNIX_CURL:-7}"; exit 0',
  loginctl: 'printf "Linger=yes\\n"',
  python3: `[[ $1 == -c && $2 == "import sys;"* ]] && { echo "\${FAKE_PYTHON_VERSION:-3.12}"; exit 0; }
[[ $1 == -c && ( $2 == "import aiohttp" || $2 == "import cryptography" ) ]] || exit 97`,
  sudo: 'exit 0',
  // The native PTY host the unit runs; the installer never executes it.
  'mesh-ptyhost': 'exit 97',
};

type Fixture = {root: string; checkout: string; home: string; fakes: string; log: string};
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "${path.basename(file)} $*" >> "$LOG"\n${body}\n`, {mode: 0o700});
}

function fixture(checkoutName = 'checkout', fakes: Record<string, string> = FAKES): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-install-'));
  fixtures.push(root);
  const checkout = path.join(root, checkoutName);
  fs.mkdirSync(path.join(checkout, 'bin'), {recursive: true});
  fs.copyFileSync(path.join(SOURCE, 'install.sh'), path.join(checkout, 'install.sh'));
  fs.cpSync(path.join(SOURCE, 'systemd'), path.join(checkout, 'systemd'), {recursive: true});
  copyInstallerScripts(SOURCE, checkout);
  for (const cmd of ['mesh-open', 'mesh-attach', 'mesh-rename', 'mesh-logout-all']) fs.writeFileSync(path.join(checkout, 'bin', cmd), '');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'fakes');
  fs.mkdirSync(home, {mode: 0o700});
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'runtime'));
  for (const [name, body] of Object.entries(fakes)) writeExecutable(path.join(bin, name), body);
  for (const tool of REAL_TOOLS) fs.symlinkSync(`/usr/bin/${tool}`, path.join(bin, tool));
  return {root, checkout, home, fakes: bin, log: path.join(root, 'calls.log')};
}

function install(fx: Fixture, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync('/bin/bash', [path.join(fx.checkout, 'install.sh'), ...args], {
    env: {HOME: fx.home, USER: 'fixture', PATH: fx.fakes, TMPDIR: fx.root, LC_ALL: 'C',
      XDG_RUNTIME_DIR: path.join(fx.root, 'runtime'), LOG: fx.log, ...env},
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000,
  });
  const calls = fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8') : '';
  return {...result, calls};
}

const withoutHost = (extra: Record<string, string> = {}) => {
  const {'mesh-ptyhost': _host, ...rest} = FAKES;
  return {...rest, ...extra};
};
const re = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unit = (fx: Fixture, name: string) => fs.readFileSync(path.join(fx.home, '.config/systemd/user', name), 'utf8');

describe('install.sh: local install without Tailscale', () => {
  test('no option, no tailscale: installs on loopback with the native PTY host found on PATH', () => {
    const fx = fixture();
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /running on 127\.0\.0\.1:7690/);
    assert.match(run.stdout, /URL {6}: http:\/\/127\.0\.0\.1:7690/);
    assert.match(unit(fx, 'session-mesh-pty.service'), new RegExp(`^ExecStart=:"${re(path.join(fx.fakes, 'mesh-ptyhost'))}"$`, 'm'));
    assert.doesNotMatch(run.calls, /^(tailscale|sudo) /m);
    assert.match(run.calls, /^systemctl --user start session-mesh-pty\.service$/m);
  });

  test('the web unit runs the interpreter the installer checked (MESH_PYTHON); the PTY unit needs none', () => {
    const fx = fixture();
    const venv = path.join(fx.root, 'venv', 'bin');
    fs.mkdirSync(venv, {recursive: true});
    writeExecutable(path.join(venv, 'python'), FAKES.python3);
    const run = install(fx, [], {MESH_PYTHON: path.join(venv, 'python')});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.calls, new RegExp(`^python -c import aiohttp$`, 'm'));
    assert.match(unit(fx, 'session-mesh.service'), new RegExp(`^ExecStart=:"${re(venv)}/python" `, 'm'));
    assert.doesNotMatch(unit(fx, 'session-mesh-pty.service'), /python/);
  });

  test('the web unit receives MESH_OPAM_SWITCH so the server finds mesh-board-mcp', () => {
    const fx = fixture();
    const run = install(fx, [], {MESH_OPAM_SWITCH: '/opt/my switch'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_OPAM_SWITCH=\/opt\/my switch"$/m);
  });

  test('without MESH_OPAM_SWITCH, the current opam switch is recorded', () => {
    const fx = fixture('checkout', {...FAKES, opam: '[[ $* == "switch show" ]] && echo session-mesh'});
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_OPAM_SWITCH=session-mesh"$/m);
  });

  test('missing dependencies name the packages for Debian, Ubuntu, Fedora and Arch, in English, before any change', () => {
    const fakes = {...FAKES, python3: '[[ $2 == "import sys;"* ]] && echo 3.12; [[ $2 == "import aiohttp" ]] && exit 1; exit 0'};
    delete (fakes as Record<string, string>).curl;
    const fx = fixture('checkout', fakes);
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /missing: aiohttp curl/);
    for (const hint of [/Debian, Ubuntu: sudo apt install python3 python3-aiohttp curl/, /Fedora: +sudo dnf install python3 python3-aiohttp curl/,
      /Arch: +sudo pacman -S python python-aiohttp curl/, /pip install -r requirements\.txt/]) assert.match(run.stdout, hint);
    assert.ok(!fs.existsSync(path.join(fx.home, '.config')));
    assert.doesNotMatch(run.calls, /^(sudo|systemctl --user (daemon-reload|enable|start|restart))/m);
  });

  test('--ptyhost names the native host the unit runs', () => {
    const fx = fixture('checkout', withoutHost());
    const host = path.join(fx.root, 'elsewhere', 'mesh-ptyhost');
    fs.mkdirSync(path.dirname(host));
    writeExecutable(host, 'exit 97');
    const run = install(fx, ['--ptyhost', host]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(unit(fx, 'session-mesh-pty.service'), new RegExp(`^ExecStart=:"${re(host)}"$`, 'm'));
  });

  test('without mesh-ptyhost on PATH, the bin directory of the opam switch is used', () => {
    const fx = fixture('checkout', withoutHost({opam: '[[ $* == "switch show" ]] && echo sw; [[ $* == "var --switch=sw bin" ]] && echo "$SWITCH_BIN"; exit 0'}));
    const bin = path.join(fx.root, 'switch-bin');
    fs.mkdirSync(bin);
    writeExecutable(path.join(bin, 'mesh-ptyhost'), 'exit 97');
    const run = install(fx, [], {SWITCH_BIN: bin});
    assert.equal(run.status, 0, run.stderr);
    assert.match(unit(fx, 'session-mesh-pty.service'), new RegExp(`^ExecStart=:"${re(path.join(bin, 'mesh-ptyhost'))}"$`, 'm'));
  });

  test('without a native host the installer refuses before any change, and says how to get one', () => {
    const fx = fixture('checkout', withoutHost());
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /mesh-ptyhost is missing: build it with bash scripts\/bootstrap\.sh --install-only/);
    assert.match(run.stderr, /rerun with --from-source, or pass --ptyhost .* pass a host you obtained yourself/);
    assert.match(run.stderr, /or install a release instead/);
    assert.ok(!fs.existsSync(path.join(fx.home, '.config')));
    assert.doesNotMatch(run.calls, changes);
  });

  test('--pty-backend no longer exists', () => {
    const fx = fixture();
    const run = install(fx, ['--pty-backend', 'native']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage: [^]*--ptyhost ABSOLUTE_PATH \| --from-source\]/);
    assert.doesNotMatch(run.stdout + run.stderr, /pty-backend/);
  });

  test('requirements.txt names the runtime dependencies', () => {
    const text = fs.readFileSync(path.join(SOURCE, 'requirements.txt'), 'utf8');
    assert.match(text, /^aiohttp\b/m);
  });
});

// A socket file left by a listener that exited without closing it: nothing accepts on it any more.
function staleSocket(file: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const made = spawnSync(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.exit(0))', file]);
  assert.equal(made.status, 0, String(made.stderr));
  assert.ok(fs.lstatSync(file).isSocket());
}
const endpoint = (fx: Fixture) => path.join(fx.root, 'runtime', 'session-mesh', 'ptyhost.sock');
const changes = /^(sudo|systemctl --user (daemon-reload|enable|start|restart))/m;

describe('install.sh: a PTY socket left after the unit stopped', () => {
  test('a stale socket of this account is removed and the install goes on', () => {
    const fx = fixture();
    staleSocket(endpoint(fx));
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /removed the stale PTY socket .*nothing answered on it/);
    assert.ok(!fs.existsSync(endpoint(fx)));
    assert.match(run.calls, /^curl --noproxy \* -s -o \/dev\/null --max-time 2 --unix-socket \S+ptyhost\.sock http:\/\/localhost\/$/m);
  });

  test('MESH_RUNTIME_DIR names the socket before XDG_RUNTIME_DIR, as the hosts', () => {
    const fx = fixture();
    const meshRuntime = path.join(fx.root, 'mesh-runtime');
    const meshEndpoint = path.join(meshRuntime, 'session-mesh', 'ptyhost.sock');
    staleSocket(meshEndpoint);
    staleSocket(endpoint(fx));
    const run = install(fx, [], {MESH_RUNTIME_DIR: meshRuntime});
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.ok(!fs.existsSync(meshEndpoint));
    assert.ok(fs.lstatSync(endpoint(fx)).isSocket(), 'the XDG_RUNTIME_DIR socket is not the endpoint');
  });

  test('a socket that answers is kept and the refusal names the remedy', () => {
    const fx = fixture();
    staleSocket(endpoint(fx));
    const run = install(fx, [], {FAKE_UNIX_CURL: '52'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /something answers on \S+ while session-mesh-pty\.service is not running/);
    assert.match(run.stderr, /systemctl --user status session-mesh-pty\.service.*rm -- '\S+ptyhost\.sock' then run the installer again/);
    assert.ok(fs.lstatSync(endpoint(fx)).isSocket());
    assert.doesNotMatch(run.calls, changes);
  });

  test('a file that is not a socket is never removed; the refusal names the remedy', () => {
    const fx = fixture();
    fs.mkdirSync(path.dirname(endpoint(fx)));
    fs.writeFileSync(endpoint(fx), 'not a socket');
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a socket of this account; if no PTY host is running .*rm -- /);
    assert.equal(fs.readFileSync(endpoint(fx), 'utf8'), 'not a socket');
    assert.doesNotMatch(run.calls, /--unix-socket/);
    assert.doesNotMatch(run.calls, changes);
  });

  test('both PTY units let systemd remove the socket directory on stop and survive an OOM kill', () => {
    const text = fs.readFileSync(path.join(SOURCE, 'systemd', 'session-mesh-pty.service.in'), 'utf8');
    for (const line of ['RuntimeDirectory=session-mesh', 'RuntimeDirectoryMode=0700', 'OOMPolicy=continue']) {
      assert.match(text, new RegExp(`^${line}$`, 'm'), line);
    }
  });
});

describe('install.sh: environment checks', () => {
  test('without a systemd user session, the refusal says so first and names sudo', () => {
    const fx = fixture('checkout', {...FAKES, systemctl: 'echo "Failed to connect to bus: No medium found" >&2; exit 1'});
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^installer: session-mesh needs a systemd user session: .*do not use sudo or root/);
    assert.doesNotMatch(run.stderr, /Failed to connect to bus/);
    assert.ok(!fs.existsSync(path.join(fx.home, '.config')));
  });

  test('uninstall without a systemd user session gives the same message', () => {
    const fx = fixture('checkout', {...FAKES, systemctl: 'exit 1'});
    const run = install(fx, ['--uninstall']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /needs a systemd user session/);
  });

  test('Python older than 3.10 is refused before any change', () => {
    const fx = fixture();
    const run = install(fx, [], {FAKE_PYTHON_VERSION: '3.9'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /needs Python 3\.10 or newer; \S+python3 is Python 3\.9/);
    assert.ok(!fs.existsSync(path.join(fx.home, '.config')));
    assert.doesNotMatch(run.calls, changes);
  });

  test('the health check bypasses any proxy of the environment', () => {
    const fx = fixture();
    const run = install(fx, [], {http_proxy: 'http://proxy.invalid:3128', HTTP_PROXY: 'http://proxy.invalid:3128'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.calls, /^curl --noproxy \* -fs -o \/dev\/null http:\/\/127\.0\.0\.1:7690\/login$/m);
    assert.doesNotMatch(run.calls, /^curl (?!--noproxy)/m);
  });
});

describe('install.sh: rerunning keeps the installed port', () => {
  function installedWith(fx: Fixture, port: string): void {
    fs.mkdirSync(path.join(fx.home, '.config/systemd/user'), {recursive: true});
    fs.writeFileSync(path.join(fx.home, '.config/systemd/user/session-mesh.service'), `[Service]\nEnvironment="MESH_PORT=${port}"\n`);
  }

  test('without MESH_PORT, the port of the installed unit is kept', () => {
    const fx = fixture();
    installedWith(fx, '7700');
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Keeping the installed port 7700 \(set MESH_PORT to change it\)/);
    assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_PORT=7700"$/m);
    assert.match(run.calls, /^curl --noproxy \* -fs -o \/dev\/null http:\/\/127\.0\.0\.1:7700\/login$/m);
  });

  test('an explicit MESH_PORT replaces it, with a warning', () => {
    const fx = fixture();
    installedWith(fx, '7700');
    const run = install(fx, [], {MESH_PORT: '7701'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /the port changes from 7700 to 7701/);
    assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_PORT=7701"$/m);
  });

  // A port edited by hand: unquoted, or in a drop-in written by `systemctl --user edit`.
  function editedWith(fx: Fixture, file: string, text: string): void {
    const target = path.join(fx.home, '.config/systemd/user', file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, text);
  }

  test('an unquoted hand-edited port is kept, not replaced by 7690', () => {
    const fx = fixture();
    editedWith(fx, 'session-mesh.service', '[Service]\nEnvironment=MESH_PORT=7702\n');
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Keeping the installed port 7702/);
    assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_PORT=7702"$/m);
  });

  test('the port of a drop-in is kept, and another MESH_PORT is refused before any change', () => {
    const fx = fixture();
    installedWith(fx, '7700');
    editedWith(fx, 'session-mesh.service.d/override.conf', '[Service]\nEnvironment="MESH_PORT=7703"\n');
    const kept = install(fx);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /Keeping the installed port 7703/);
    const refused = install(fx, [], {MESH_PORT: '7704'});
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /override\.conf sets MESH_PORT and overrides the installed unit/);
  });

  test('a MESH_PORT line the installer cannot read is refused, not replaced by 7690', () => {
    const fx = fixture();
    editedWith(fx, 'session-mesh.service', '[Service]\nEnvironment="MESH_HOST=127.0.0.1" "MESH_PORT=7705"\n');
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /sets MESH_PORT to unreadable.*set MESH_PORT to the port to use/);
    assert.match(unit(fx, 'session-mesh.service'), /"MESH_PORT=7705"/);
  });

  test('a variable whose name ends with MESH_PORT is not read as the port', () => {
    const fx = fixture();
    editedWith(fx, 'session-mesh.service', '[Service]\nEnvironment=FOO_MESH_PORT=7707\n');
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /unreadable/);
    assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_PORT=7690"$/m);
  });

  // systemd: an empty `Environment=` drops every earlier assignment, the unit's included.
  test('a drop-in that resets Environment= leaves the default port, and another MESH_PORT is refused', () => {
    const fx = fixture();
    installedWith(fx, '7700');
    editedWith(fx, 'session-mesh.service.d/override.conf', '[Service]\nEnvironment=\n');
    const kept = install(fx);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /Keeping the installed port 7690/);
    const refused = install(fx, [], {MESH_PORT: '7706'});
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /override\.conf sets MESH_PORT and overrides the installed unit/);
  });

  test('a reset followed by a port in the same drop-in keeps that port', () => {
    const fx = fixture();
    installedWith(fx, '7700');
    editedWith(fx, 'session-mesh.service.d/override.conf', '[Service]\nEnvironment=\nEnvironment="MESH_PORT=7707"\n');
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Keeping the installed port 7707/);
  });

  test('an EnvironmentFile= line is refused: the installer cannot read the port it may set', () => {
    const fx = fixture();
    installedWith(fx, '7700');
    editedWith(fx, 'session-mesh.service.d/env.conf', '[Service]\nEnvironmentFile=%h/.config/mesh.env\n');
    for (const env of [{}, {MESH_PORT: '7700'}]) {
      const run = install(fx, [], env);
      assert.equal(run.status, 1, run.output);
      assert.match(run.stderr, /env\.conf uses EnvironmentFile=, which the installer does not read/);
      assert.match(unit(fx, 'session-mesh.service'), /^Environment="MESH_PORT=7700"$/m);
    }
  });
});
