// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared by the tests of the macOS branch of install.sh (scripts/install-macos.sh), which run on
// any system: a fake uname answers Darwin, and fake launchctl, plutil, sw_vers, id, sudo, install,
// curl and python3 on a closed PATH stand in for macOS. launchctl keeps the loaded jobs in a state directory and, as
// launchd, loads an Aqua agent only in gui/UID, a Background one only in user/UID and a daemon
// only in the system domain as root (under the fake sudo). plutil reads plists with the strict
// parser of tests/plist-lib.ts, which the tests also use to check every generated plist.
// The fake sudo runs only the absolute paths the installer may run as root (/usr/bin/install,
// /bin/launchctl, /bin/rm), mapped to the fakes; the fake install accepts only root:wheel 0644.
// The fixture's copy of scripts/install-macos.sh names a directory of the fixture instead of
// /Library/LaunchDaemons: the product has no hook that redirects where root writes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach} from 'node:test';
import {copyInstallerScripts} from './install-scripts.ts';
import {parsePlist} from './plist-lib.ts';
import {linkSystemTools} from './helpers/system-tool.ts';

export const SOURCE = process.env.MESH_INSTALL_SOURCE || path.resolve(import.meta.dirname, '..');
export const REAL_TOOLS = ['dirname', 'readlink', 'mkdir', 'rm', 'rmdir', 'seq', 'sleep', 'grep', 'cat', 'ln', 'mktemp',
  'chmod', 'mv', 'ls', 'tail', 'sed', 'touch', 'cp', 'tee'];
export const UID = process.getuid!();
export const PTY = 'io.session-mesh.pty';
export const WEB = 'io.session-mesh.web';
export const SUPPORT = 'Library/Application Support';

export const LAUNCHCTL = `state() { printf '%s/%s' "$FAKE_STATE" "\${1//\\//_}"; }
session() { sed -n 's|.*<key>LimitLoadToSessionType</key><string>\\([^<]*\\)</string>.*|\\1|p' "$1"; }
root() { [[ -n \${FAKE_ROOT:-} ]]; }
case $1 in
  print)
    case $2 in
      gui/*/*|user/*/*|system/*)
        [[ -f $(state "$2") ]] || exit 113
        printf '%s = {\\n\\tstate = %s\\n\\tpid = 4242\\n}\\n' "$2" "$(cat "$(state "$2")")" ;;
      gui/*) [[ \${FAKE_GUI:-1} == 1 ]] || exit 125 ;;
    esac ;;
  bootstrap)
    case $2 in
      gui/*) [[ \${FAKE_GUI:-1} == 1 && $(session "$3") == Aqua ]] || exit 125 ;;
      user/*) [[ $(session "$3") == Background ]] || exit 125 ;;
      system) root && [[ -z $(session "$3") ]] && grep -q '<key>UserName</key>' "$3" || exit 1 ;;
    esac
    label=$(sed -n 's|.*<key>Label</key><string>\\([^<]*\\)</string>.*|\\1|p' "$3")
    [[ -n $label && ! -f $(state "$2/$label") ]] || exit 5
    echo running > "$(state "$2/$label")" ;;
  bootout) [[ $2 != system/* ]] || root || exit 1; [[ -f $(state "$2") ]] || exit 3; rm -f "$(state "$2")" ;;
  kickstart) [[ $2 != system/* ]] || root || exit 1; [[ -f $(state "$2") ]] || exit 3; echo running > "$(state "$2")" ;;
  *) exit 97 ;;
esac`;
export const FAKES: Record<string, string> = {
  uname: 'case $* in -s) echo Darwin ;; -m) echo "${FAKE_ARCH:-arm64}" ;; esac',
  sw_vers: '[[ $* == -productVersion ]] && echo "${FAKE_MACOS:-15.6.1}"',
  id: `case $* in
  -P) echo "fixture:********:${UID}:20::0:0:Fixture:\${FAKE_PW_HOME:-$HOME}:/bin/zsh" ;;
  -gn) echo staff ;;
  *) exit 97 ;;
esac`,
  launchctl: LAUNCHCTL,
  curl: '[[ $* == *--unix-socket* ]] && exit "${FAKE_UNIX_CURL:-7}"; exit 0',
  python3: `[[ $1 == -c && $2 == "import sys;"* ]] && { echo "\${FAKE_PYTHON_VERSION:-3.12}"; exit 0; }
[[ $1 == -c && ( $2 == "import aiohttp" || $2 == "import cryptography" ) ]] || exit 97`,
  sudo: `[[ -z \${FAKE_SUDO_FAIL:-} ]] || { echo "sudo: a password is required" >&2; exit 1; }
case $1 in
  /usr/bin/install) tool=install ;; /bin/launchctl) tool=launchctl ;; /bin/rm) tool=rm ;;
  *) echo "fake sudo: $1 is not a command the installer may run as root" >&2; exit 1 ;;
esac
shift
FAKE_ROOT=1 exec "$tool" "$@"`,
  install: `[[ -n \${FAKE_ROOT:-} && $# == 8 && "$1 $2 $3 $4 $5 $6" == "-m 644 -o root -g wheel" ]] \\
  || { echo "fake install: not root:wheel 0644: $*" >&2; exit 1; }
cp "$7" "$8" && chmod 644 "$8"`,
  opam: '[[ $* == "var --switch=session-mesh bin" ]] && { echo "$FAKE_SWITCH_BIN"; exit 0; }; exit 1',
};

export type Fixture = {root: string; checkout: string; home: string; fakes: string; log: string; state: string;
  switchBin: string; daemons: string};
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

export function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "${path.basename(file)} $*" >> "$LOG"\n${body}\n`, {mode: 0o700});
}

// The default runtime directory sits below the home, and its socket path must fit in 103 bytes:
// the fixture lives under a short directory (/tmp when the temporary directory is long, as on macOS).
export const SCRATCH = os.tmpdir().length <= 20 ? os.tmpdir() : '/tmp';

// The home holds Library/Application Support, as every macOS account; homeName may make it long.
export function fixture(opts: {checkoutName?: string; fakes?: Record<string, string>; homeName?: string} = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, 'm-')));
  fixtures.push(root);
  const checkout = path.join(root, opts.checkoutName ?? 'checkout');
  fs.mkdirSync(path.join(checkout, 'bin'), {recursive: true});
  fs.copyFileSync(path.join(SOURCE, 'install.sh'), path.join(checkout, 'install.sh'));
  copyInstallerScripts(SOURCE, checkout, ['install-macos.sh']);
  const daemons = path.join(root, 'LaunchDaemons');
  const script = fs.readFileSync(path.join(SOURCE, 'scripts', 'install-macos.sh'), 'utf8');
  const product = /^DAEMON_DIR=\/Library\/LaunchDaemons$/m;
  assert.match(script, product, 'scripts/install-macos.sh no longer sets DAEMON_DIR=/Library/LaunchDaemons on one line');
  fs.writeFileSync(path.join(checkout, 'scripts', 'install-macos.sh'), script.replace(product, () => `DAEMON_DIR=${shellQuote(daemons)}`));
  for (const cmd of ['mesh-open', 'mesh-attach', 'mesh-rename']) fs.writeFileSync(path.join(checkout, 'bin', cmd), '');
  const home = path.join(root, opts.homeName ?? 'h');
  const bin = path.join(root, 'fakes');
  const state = path.join(root, 'launchd');
  const switchBin = path.join(root, 'switch', 'bin');
  for (const dir of [bin, state, switchBin, daemons]) fs.mkdirSync(dir, {recursive: true});
  fs.mkdirSync(home, {mode: 0o700});
  fs.mkdirSync(path.join(home, SUPPORT), {recursive: true, mode: 0o700});
  writeExecutable(path.join(switchBin, 'mesh-ptyhost'), 'exit 97');
  for (const [name, body] of Object.entries(opts.fakes ?? FAKES)) writeExecutable(path.join(bin, name), body);
  writeExecutable(path.join(bin, 'plutil'),
    `exec "${process.execPath}" --experimental-strip-types "${path.join(SOURCE, 'tests/fixtures/fake-plutil.ts')}" "$@"`);
  linkSystemTools(REAL_TOOLS, bin);
  return {root, checkout, home, fakes: bin, log: path.join(root, 'calls.log'), state, switchBin, daemons};
}

// answer === undefined: stdin is not a terminal. Otherwise the installer runs on a pseudo-terminal
// (util-linux script) and `answer` is typed on it.
export type InstallOptions = {answer?: string};
export function install(fx: Fixture, args: string[] = [], env: Record<string, string> = {}, opts: InstallOptions = {}) {
  const fullEnv = {HOME: fx.home, USER: 'fixture', PATH: fx.fakes, TMPDIR: fx.root, LC_ALL: 'C', LOG: fx.log,
    FAKE_STATE: fx.state, FAKE_SWITCH_BIN: fx.switchBin, MESH_OPAM_SWITCH: 'session-mesh', ...env};
  const command = [path.join(fx.checkout, 'install.sh'), ...args];
  const result = opts.answer === undefined
    ? spawnSync('/bin/bash', command, {env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000})
    : spawnSync('/usr/bin/script', ['-qec', ['/bin/bash', ...command].map(shellQuote).join(' '), '/dev/null'],
      {env: fullEnv, input: `${opts.answer}\n`, encoding: 'utf8', timeout: 30000});
  const calls = fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8') : '';
  fs.rmSync(fx.log, {force: true});
  return {...result, calls, output: `${result.stdout}${result.stderr}`};
}

export const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
export const hasScript = fs.existsSync('/usr/bin/script') && process.platform === 'linux';
export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const plistFile = (fx: Fixture, label: string) => path.join(fx.home, 'Library/LaunchAgents', `${label}.plist`);
export const daemonFile = (fx: Fixture, label: string) => path.join(fx.daemons, `${label}.plist`);
export type Job = {Label: string; ProgramArguments: string[]; EnvironmentVariables: Record<string, string>; [key: string]: unknown};
export const readJob = (file: string) => parsePlist(fs.readFileSync(file, 'utf8')) as Job;
export const plist = (fx: Fixture, label: string) => readJob(plistFile(fx, label));
export const stateFile = (fx: Fixture, domain: string, label: string) => path.join(fx.state, `${domain}/${label}`.replaceAll('/', '_'));
export const loaded = (fx: Fixture, domain: string, label: string) => fs.existsSync(stateFile(fx, domain, label));
export const defaultRuntime = (fx: Fixture) => path.join(fx.home, SUPPORT, 'session-mesh/run');
export const changes = /^(launchctl (bootstrap|bootout|kickstart)|sudo|install|tailscale serve --)/m;
export const sudoCalls = (calls: string) => calls.split('\n').filter((line) => line.startsWith('sudo '));

// A socket file left by a listener that exited without closing it: nothing accepts on it any more.
export function staleSocket(file: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const made = spawnSync(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.exit(0))', file]);
  assert.equal(made.status, 0, String(made.stderr));
}
