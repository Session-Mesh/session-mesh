// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared fixture of the release-install tests (tests/install-release*.test.ts, tests/install-bundle.test.ts).
// Releases are built here as the release workflow builds them: one bundle archive per platform
// (mesh-<os>-<arch>.tar.gz, laid out as scripts/build-bundle.sh lays it out, with the repository's
// own launcher, env.sh and wrappers, stand-ins for the native programs and a Python runtime that
// runs the test interpreter), install.sh with the tag and the SHA-256 of every other asset stamped
// into its stamp block by the release workflow's stamper, and SHA256SUMS over everything. A fake
// curl serves the published releases and
// GitHub's /releases/latest from a directory; a fake gh (when a test installs it) passes or fails
// `gh attestation verify`; a fake systemctl keeps the unit states in a directory and derives `show`
// from the unit files, as systemd does (the PTY unit's MainPID is FAKE_PTY_PID). Nothing reaches
// the network or a real service manager.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach} from 'node:test';
import {INSTALL_SCRIPTS} from './install-scripts.ts';
import {linkSystemTools} from './helpers/system-tool.ts';

export const SOURCE = process.env.MESH_INSTALL_SOURCE || path.resolve(import.meta.dirname, '..');
// The native programs of a release, and of a bundle.
export const PROGRAMS = ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-read', 'mesh-platform', 'mesh-history', 'mesh-logout-all', 'mesh-open', 'mesh-profile', 'work-read', 'work-mcp', 'work-write'];
// Where each native program sits in a bundle (scripts/build-bundle.sh).
export const NATIVE: Record<string, string> = {'mesh-ptyhost': 'libexec/mesh-ptyhost', 'mesh-board-mcp': 'bin/mesh-board-mcp',
  'mesh-read': 'bin/mesh-read', 'mesh-platform': 'bin/mesh-platform', 'mesh-history': 'bin/mesh-history',
  'mesh-logout-all': 'bin/mesh-logout-all', 'mesh-open': 'bin/mesh-open', 'mesh-profile': 'bin/mesh-profile', 'work-read': 'bin/work-read', 'work-mcp': 'bin/work-mcp',
  'work-write': 'bin/work-write'};
export const PLATFORMS = ['linux-x86_64', 'linux-arm64', 'macos-arm64'];
// The Python commands of the code (app/bin), which a bundle runs through its wrapper (bin/).
export const HELPERS = ['mesh-event', 'mesh-attach', 'mesh-rename'];
export const bundleAsset = (platform: string) => `mesh-${platform}.tar.gz`;
// The interpreter the fake bundled Python runs (the test suite's own): MESH_PYTHON, else python3
// from PATH, as an absolute path. A bare name would find the fake runtime/python/bin/python3
// itself whenever that directory is on PATH, and call itself forever.
function testPython(): string {
  const configured = process.env.MESH_PYTHON;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`MESH_PYTHON must be an absolute path, not ${configured}`);
    return configured;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'python3');
    if (path.isAbsolute(dir) && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error('no python3 on PATH: set MESH_PYTHON to the absolute path of the test interpreter');
}
const TEST_PYTHON = testPython();
export const DOWNLOAD = 'https://github.com/Session-Mesh/session-mesh/releases/download';
export const LATEST = 'https://api.github.com/repos/Session-Mesh/session-mesh/releases/latest';
// shasum: what install.sh uses where sha256sum is missing (macOS).
const REAL_TOOLS = ['bash', 'dirname', 'basename', 'readlink', 'mkdir', 'rm', 'rmdir', 'seq', 'sleep', 'grep', 'cat', 'ln',
  'mktemp', 'chmod', 'mv', 'ls', 'cp', 'sha256sum', 'shasum', 'tar', 'gzip', 'sed', 'touch', 'tail', 'tee', 'env', 'find',
  'sort', 'tr', 'xargs'];
export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export type Fixture = {root: string; home: string; fakes: string; log: string; served: string; state: string; share: string;
  units: string};
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

export function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "${path.basename(file)} $*" >> "$LOG"\n${body}\n`, {mode: 0o700});
}

export const CURL = `[[ $* == *--unix-socket* ]] && exit 7
if [[ $* == *127.0.0.1* ]]; then
  # FAKE_BAD_ROOT: the web server of a unit that runs from that directory does not answer.
  [[ -n \${FAKE_BAD_ROOT:-} ]] && grep -qF "$FAKE_BAD_ROOT/" "$HOME/.config/systemd/user/session-mesh.service" 2>/dev/null && exit 7
  current=$(readlink "$FAKE_SHARE/current" 2>/dev/null || true)
  [[ -n \${FAKE_BAD_TAG:-} && $current == "releases/$FAKE_BAD_TAG" ]] && exit 7
  exit 0
fi
out=; url=; while (($#)); do [[ $1 == -o ]] && out=$2; [[ $1 == https://* ]] && url=$1; shift; done
case $url in
  ${LATEST}) [[ -f $FAKE_SERVED/latest.json ]] || exit 22; cat "$FAKE_SERVED/latest.json" ;;
  ${DOWNLOAD}/*) file=$FAKE_SERVED/\${url#${DOWNLOAD}/}; [[ -f $file ]] || exit 22; cp "$file" "$out" ;;
  *) exit 97 ;;
esac`;
const SYSTEMCTL = `units=$HOME/.config/systemd/user
case "$1 $2" in
  "--user show")
    if [[ $* == *"-p MainPID"* ]]; then echo "MainPID=\${FAKE_PTY_PID:-0}"; exit 0; fi
    unit=$3 file=$units/$3 drop=
    if [[ -f $file ]]; then load=loaded fragment=$file; else load=not-found fragment=; fi
    for conf in "$units/$unit.d"/*.conf; do [[ -f $conf ]] && drop="$drop\${drop:+ }$conf"; done
    if [[ -f $FAKE_STATE/$unit ]]; then a=active s=running; else a=inactive s=dead; fi
    printf '%s\\n' "LoadState=$load" "ActiveState=$a" "SubState=$s" "FragmentPath=$fragment" "DropInPaths=$drop" NeedDaemonReload=no ;;
  "--user start"|"--user restart") touch "$FAKE_STATE/$3" ;;
  "--user stop") rm -f "$FAKE_STATE/$3" ;;
esac
exit 0`;
// gh attestation verify FILE ...: fails when FAKE_GH_FAIL names FILE's basename (or is "all");
// FAKE_GH_LOGGED_OUT=1 answers as gh does when it is not logged in (exit 4).
export const GH = `[[ $1 == attestation && $2 == verify ]] || exit 97
if [[ \${FAKE_GH_LOGGED_OUT:-} == 1 ]]; then echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; fi
name=\${3##*/}
if [[ \${FAKE_GH_FAIL:-} == all || \${FAKE_GH_FAIL:-} == "$name" ]]; then echo "Error: verifying with issuer \\"sigstore.dev\\": no matching attestation" >&2; exit 1; fi
echo "Loaded digest sha256:x for file://$3"`;
const FAKES: Record<string, string> = {
  curl: CURL,
  systemctl: SYSTEMCTL,
  loginctl: 'printf "Linger=yes\\n"',
  python3: `[[ $1 == -c && $2 == "import sys;"* ]] && { echo 3.12; exit 0; }
[[ $1 == -c && ( $2 == "import aiohttp" || $2 == "import cryptography" ) ]] || exit 97`,
  uname: 'case $* in -s) echo Linux ;; -m) echo "${FAKE_ARCH:-x86_64}" ;; esac',
  // FAKE_GLIBC: the glibc version getconf reports (default 2.39); "none" fails, as on musl.
  getconf: '[[ $* == GNU_LIBC_VERSION ]] || exit 97\n[[ ${FAKE_GLIBC:-} == none ]] && { echo "getconf: Unrecognized variable" >&2; exit 1; }\necho "glibc ${FAKE_GLIBC:-2.39}"',
};

export function fixture(extraFakes: Record<string, string> = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-rel-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const fakes = path.join(root, 'fakes');
  const served = path.join(root, 'served');
  const state = path.join(root, 'state');
  for (const dir of [home, fakes, served, state, path.join(root, 'runtime')]) fs.mkdirSync(dir, {mode: 0o700});
  for (const [name, body] of Object.entries({...FAKES, ...extraFakes})) writeExecutable(path.join(fakes, name), body);
  linkSystemTools(REAL_TOOLS, fakes);
  const share = path.join(home, '.local/share/session-mesh');
  return {root, home, fakes, log: path.join(root, 'calls.log'), served, state, share, units: path.join(home, '.config/systemd/user')};
}

// tamper: an asset served with other bytes; installerSums: the hash SHA256SUMS gives install.sh;
// listedWrong: an asset whose SHA256SUMS line differs from the stamp; platforms: the bundles built;
// manifestWrong: a native program whose bundle.json hash is not its own.
// programs: the platforms whose native programs <program>-<platform> the release also publishes,
// with its code archive session-mesh-<tag>.tar.gz (none by default).
export type ReleaseOptions = {program?: (program: string) => string | Buffer; tamper?: string; installerSums?: string; listedWrong?: string;
  platforms?: string[]; manifestWrong?: string; programs?: string[]};
// The platforms of the native programs, as the release workflow names them.
export const PROGRAM_PLATFORMS = ['linux-x86_64', 'linux-aarch64', 'macos-arm64'];

// The releases these tests install use launchd agents in the fixture's home. The macOS installer
// also reads /Library/LaunchDaemons to choose the form, and on a Mac where session-mesh runs as
// boot-time daemons it would refuse every install; the copy in a release names a directory that
// never exists instead (tests/install-macos-lib.ts redirects it to a directory of its fixture).
const PRODUCT_DAEMON_DIR = /^DAEMON_DIR=\/Library\/LaunchDaemons$/m;
const NO_DAEMON_DIR = '/nonexistent/session-mesh-test/LaunchDaemons';
function withoutHostDaemons(script: string): void {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, PRODUCT_DAEMON_DIR, 'scripts/install-macos.sh no longer sets DAEMON_DIR=/Library/LaunchDaemons on one line');
  fs.writeFileSync(script, text.replace(PRODUCT_DAEMON_DIR, `DAEMON_DIR=${NO_DAEMON_DIR}`));
}

// The directory of an extracted bundle, as scripts/build-bundle.sh lays it out: the repository's
// launcher, env.sh and wrappers; app/ with the installer, its scripts, the unit templates, the
// helper stand-ins, agentmcp.py and a stand-in server.py; the native programs (`program`, by
// default "<label> <program>"); a Python runtime that answers the installer's dependency check and
// otherwise runs the test interpreter; bundle.json with the hashes of the native programs.
export function bundleTree(dir: string, label: string, opts: ReleaseOptions = {}): string {
  const app = path.join(dir, 'app');
  for (const sub of ['app/scripts', 'app/bin', 'bin', 'libexec', 'runtime/python/bin']) fs.mkdirSync(path.join(dir, sub), {recursive: true});
  fs.copyFileSync(path.join(SOURCE, 'install.sh'), path.join(app, 'install.sh'));
  for (const file of INSTALL_SCRIPTS) fs.copyFileSync(path.join(SOURCE, 'scripts', file), path.join(app, 'scripts', file));
  withoutHostDaemons(path.join(app, 'scripts', 'install-macos.sh'));
  fs.cpSync(path.join(SOURCE, 'systemd'), path.join(app, 'systemd'), {recursive: true});
  for (const module of ['agentmcp.py', 'resumeargs.py', 'fsutil.py', 'agentcap.py', 'agentwake.py', 'agentmail.py', 'meshpaths.py', 'respawn.py', 'organize.py', 'conversation_names.py', 'agent-hooks.json']) fs.copyFileSync(path.join(SOURCE, module), path.join(app, module));
  for (const cmd of HELPERS) fs.writeFileSync(path.join(app, 'bin', cmd), '', {mode: 0o755});
  fs.writeFileSync(path.join(app, 'server.py'), `# server of ${label}\n`);
  fs.copyFileSync(path.join(SOURCE, 'scripts/bundle/mesh'), path.join(dir, 'mesh'));
  fs.copyFileSync(path.join(SOURCE, 'scripts/bundle/env.sh'), path.join(dir, 'env.sh'));
  for (const name of ['mesh-python', 'mesh-ptyhost']) fs.copyFileSync(path.join(SOURCE, 'scripts/bundle', name), path.join(dir, 'bin', name));
  for (const name of HELPERS) fs.copyFileSync(path.join(SOURCE, 'scripts/bundle/mesh-helper'), path.join(dir, 'bin', name));
  fs.writeFileSync(path.join(dir, 'runtime/python/bin/python3'),
    `#!/bin/bash\n[[ $* == "-c import aiohttp, cryptography" ]] && exit 0\nexec '${TEST_PYTHON}' "$@"\n`);
  const native: Record<string, string> = {};
  for (const program of PROGRAMS) {
    const data = Buffer.from(opts.program ? opts.program(program) : `${label} ${program}`);
    fs.writeFileSync(path.join(dir, NATIVE[program]), data);
    native[NATIVE[program]] = opts.manifestWrong === program ? sha('other') : sha(data);
  }
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({kind: 'mesh-binary-bundle', version: 1, native}, null, 2) + '\n');
  for (const sub of ['.', 'bin', 'libexec', 'runtime/python/bin']) {
    for (const entry of fs.readdirSync(path.join(dir, sub), {withFileTypes: true})) if (entry.isFile()) fs.chmodSync(path.join(dir, sub, entry.name), 0o755);
  }
  fs.chmodSync(path.join(dir, 'env.sh'), 0o644);
  fs.chmodSync(path.join(dir, 'bundle.json'), 0o644);
  return dir;
}

// The bundle archive of release <tag> for one platform: mesh-<platform>/ and nothing else.
function bundleArchive(fx: Fixture, tag: string, platform: string, opts: ReleaseOptions): Buffer {
  const work = fs.mkdtempSync(path.join(fx.root, 'archive-'));
  bundleTree(path.join(work, `mesh-${platform}`), tag, opts);
  const archive = path.join(work, 'bundle.tar.gz');
  const made = spawnSync('tar', ['-czf', archive, '-C', work, `mesh-${platform}`]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  const data = fs.readFileSync(archive);
  fs.rmSync(work, {recursive: true, force: true});
  return data;
}

// The code archive of release <tag> (git archive of the tagged commit): the app/ of a bundle tree,
// under session-mesh-<tag>/.
function codeArchive(fx: Fixture, tag: string): Buffer {
  const work = fs.mkdtempSync(path.join(fx.root, 'archive-'));
  const tree = bundleTree(path.join(work, 'tree'), tag);
  fs.renameSync(path.join(tree, 'app'), path.join(work, `session-mesh-${tag}`));
  const archive = path.join(work, 'code.tar.gz');
  const made = spawnSync('tar', ['-czf', archive, '-C', work, `session-mesh-${tag}`]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  const data = fs.readFileSync(archive);
  fs.rmSync(work, {recursive: true, force: true});
  return data;
}

// install.sh of the checkout stamped by the release workflow's own stamper
// (scripts/release-stamp-installer.sh), with the tag and the SHA-256 lines `sums`.
export function stamp(tag: string, sums: string): string {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-stamp-'));
  try {
    fs.writeFileSync(path.join(work, 'sums'), `${sums}\n`);
    const made = spawnSync('bash', [path.join(SOURCE, 'scripts', 'release-stamp-installer.sh'), path.join(SOURCE, 'install.sh'), tag,
      path.join(work, 'sums'), path.join(work, 'install.sh')], {encoding: 'utf8'});
    if (made.status !== 0) throw new Error(`release-stamp-installer.sh: ${made.stderr}`);
    return fs.readFileSync(path.join(work, 'install.sh'), 'utf8');
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

// Publishes release <tag> in the fake GitHub and returns its assets directory.
export function publish(fx: Fixture, tag: string, opts: ReleaseOptions = {}): string {
  const dir = path.join(fx.served, tag);
  fs.mkdirSync(dir, {recursive: true});
  const assets: Record<string, Buffer> = {};
  for (const platform of opts.platforms ?? PLATFORMS) assets[bundleAsset(platform)] = bundleArchive(fx, tag, platform, opts);
  if (opts.programs?.length) assets[`session-mesh-${tag}.tar.gz`] = codeArchive(fx, tag);
  for (const platform of opts.programs ?? []) {
    for (const program of PROGRAMS) assets[`${program}-${platform}`] = Buffer.from(opts.program ? opts.program(program) : `${tag} ${program}`);
  }
  const lines = Object.entries(assets).map(([name, data]) => `${sha(data)}  ${name}`).sort();
  const installer = stamp(tag, lines.join('\n'));
  for (const [name, data] of Object.entries(assets)) fs.writeFileSync(path.join(dir, name), opts.tamper === name ? 'tampered' : data);
  fs.writeFileSync(path.join(dir, 'install.sh'), installer, {mode: 0o755});
  const listed = lines.map((line) => line.endsWith(`  ${opts.listedWrong}`) ? `${sha('other')}  ${opts.listedWrong}` : line);
  const installerSum = opts.installerSums ?? sha(installer);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), [...listed, `${installerSum}  install.sh`].sort().join('\n') + '\n');
  return dir;
}
export const setLatest = (fx: Fixture, tag: string) =>
  fs.writeFileSync(path.join(fx.served, 'latest.json'), JSON.stringify({tag_name: tag, draft: false, prerelease: false}, null, 2));

// Runs an installer (the downloaded install.sh of a release, or an installed one).
export function run(fx: Fixture, installer: string, args: string[] = [], env: Record<string, string> = {}) {
  fs.rmSync(fx.log, {force: true});
  const result = spawnSync('/bin/bash', [installer, ...args], {
    env: {HOME: fx.home, USER: 'fixture', PATH: fx.fakes, TMPDIR: fx.root, LC_ALL: 'C', LOG: fx.log, FAKE_SERVED: fx.served,
      FAKE_STATE: fx.state, FAKE_SHARE: fx.share, XDG_RUNTIME_DIR: path.join(fx.root, 'runtime'), ...env},
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
  });
  const calls = fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8') : '';
  return {...result, calls, output: `${result.stdout}${result.stderr}`};
}
export const downloaded = (fx: Fixture, tag: string) => path.join(fx.served, tag, 'install.sh');
export const installed = (fx: Fixture) => path.join(fx.share, 'current', 'install.sh');
export const current = (fx: Fixture) => fs.readlinkSync(path.join(fx.share, 'current'));
export const previous = (fx: Fixture) => fs.readlinkSync(path.join(fx.share, 'previous'));
export const releases = (fx: Fixture) => fs.readdirSync(path.join(fx.share, 'releases')).sort();
export const unit = (fx: Fixture, name: string) => fs.readFileSync(path.join(fx.units, name), 'utf8');
export const systemctl = (calls: string) => calls.split('\n').filter((line) => line.startsWith('systemctl ') && !line.includes(' show '));
export const running = (fx: Fixture, name: string) => fs.writeFileSync(path.join(fx.state, name), '');
export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const mode = (file: string) => fs.statSync(file).mode & 0o7777;

// The fixture with its HOME a symbolic link to the real directory.
export function linkedHome(fx: Fixture): Fixture {
  fs.renameSync(fx.home, `${fx.home}-real`);
  fs.symlinkSync(`${fx.home}-real`, fx.home);
  return fx;
}

// v1.0.0 installed from its downloaded install.sh, the PTY host then running.
export function installedV1(fx = fixture(), opts: ReleaseOptions = {}) {
  publish(fx, 'v1.0.0', opts);
  const first = run(fx, downloaded(fx, 'v1.0.0'));
  assert.equal(first.status, 0, first.output);
  running(fx, 'session-mesh-pty.service');
  return fx;
}

// Turns the installed v1.0.0 into a 0.1.x layout, where mesh-logout-all was a Python command:
// bin/mesh-logout-all the bundle's wrapper of app/bin/mesh-logout-all, absent from bundle.json, and
// ~/.local/bin/mesh-logout-all naming the script directly. Returns that link.
export function withPythonLogoutAll(fx: Fixture): string {
  const old = path.join(fx.share, 'releases/v1.0.0');
  fs.rmSync(path.join(old, 'bin/mesh-logout-all'));
  fs.copyFileSync(path.join(SOURCE, 'scripts/bundle/mesh-helper'), path.join(old, 'bin/mesh-logout-all'));
  const manifest = JSON.parse(fs.readFileSync(path.join(old, 'bundle.json'), 'utf8'));
  delete manifest.native['bin/mesh-logout-all'];
  fs.writeFileSync(path.join(old, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
  const link = path.join(fx.home, '.local/bin/mesh-logout-all');
  fs.rmSync(link);
  fs.symlinkSync(`${fx.share}/current/app/bin/mesh-logout-all`, link);
  return link;
}
