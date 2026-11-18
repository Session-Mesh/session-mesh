// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// install.sh safety (publication review, section 5, point 2): Tailscale publication is an explicit
// option, sudo only follows a yes typed on a terminal, a foreign tailscale serve configuration is
// never changed, and unit paths are systemd-quoted. The real installer runs in an owned temporary
// HOME with fake systemctl, tailscale, sudo, curl, loginctl and python3 on a closed PATH.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';
import {copyInstallerScripts} from './install-scripts.ts';

const SOURCE = process.env.MESH_INSTALL_SOURCE || path.resolve(import.meta.dirname, '..');
const REAL_TOOLS = ['dirname', 'readlink', 'mkdir', 'rm', 'seq', 'sleep', 'grep', 'cat', 'ln', 'mktemp', 'sed', 'id', 'tee'];
const served = (proxy: string, host = 'node.example.ts.net') => JSON.stringify({TCP: {443: {HTTPS: true}},
  Web: {[`${host}:443`]: {Handlers: {'/': {Proxy: proxy}}}}}, null, 2);
const OURS = served('http://127.0.0.1:7690');
const FOREIGN = served('http://127.0.0.1:3000');
const FAKES: Record<string, string> = {
  systemctl: `if [[ $* == "--user show "* ]]; then
  printf '%s\\n' LoadState=not-found ActiveState=inactive SubState=dead FragmentPath= DropInPaths= NeedDaemonReload=no; fi`,
  curl: '',
  loginctl: 'printf "Linger=yes\\n"',
  python3: `[[ $1 == -c && $2 == "import sys;"* ]] && { echo "\${FAKE_PYTHON_VERSION:-3.12}"; exit 0; }
[[ $1 == -c && ( $2 == "import aiohttp" || $2 == "import cryptography" ) ]] || exit 97`,
  sudo: 'exec "$@"',
  // Present but unused by default: keeps the pre-fix installer (native default) on its normal path.
  'mesh-ptyhost': 'exit 97',
  tailscale: `case "$*" in
  "serve status --json") [[ ! -e $TS_STATUS_FAIL ]] || exit 1; cat "$TS_STATUS" ;;
  "serve --bg 7690")
    if [[ -e $TS_SERVE_FAIL ]]; then cat "$TS_SERVE_FAIL" >&2; [[ ! -e $TS_SERVE_HANG ]] || sleep 4; exit 1; fi
    if [[ -e $TS_DENY && ! -e $TS_OPERATOR ]]; then echo "Access denied: serve config denied" >&2; exit 1; fi
    printf '%s' "$OURS" > "$TS_STATUS" ;;
  "serve --https=443 off") echo '{}' > "$TS_STATUS" ;;
  "set --operator=fixture") : > "$TS_OPERATOR" ;;
  *) exit 97 ;;
esac`,
};

type Fixture = {root: string; checkout: string; home: string; fakes: string; log: string; status: string};
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "${path.basename(file)} $*" >> "$LOG"\n${body}\n`, {mode: 0o700});
}

function fixture(opts: {checkoutName?: string; status?: string; deny?: boolean; tailscale?: boolean} = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-install-'));
  fixtures.push(root);
  const checkout = path.join(root, opts.checkoutName ?? 'checkout');
  fs.mkdirSync(path.join(checkout, 'bin'), {recursive: true});
  fs.copyFileSync(path.join(SOURCE, 'install.sh'), path.join(checkout, 'install.sh'));
  fs.cpSync(path.join(SOURCE, 'systemd'), path.join(checkout, 'systemd'), {recursive: true});
  copyInstallerScripts(SOURCE, checkout);
  for (const cmd of ['mesh-open', 'mesh-attach', 'mesh-rename']) fs.writeFileSync(path.join(checkout, 'bin', cmd), '');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'fakes');
  for (const dir of [home, bin, path.join(root, 'runtime')]) fs.mkdirSync(dir, {mode: 0o700});
  for (const [name, body] of Object.entries(FAKES)) {
    if (name !== 'tailscale' || opts.tailscale !== false) writeExecutable(path.join(bin, name), body);
  }
  for (const tool of REAL_TOOLS) fs.symlinkSync(`/usr/bin/${tool}`, path.join(bin, tool));
  const status = path.join(root, 'serve.json');
  fs.writeFileSync(status, opts.status ?? '{}\n');
  if (opts.deny) fs.writeFileSync(path.join(root, 'deny'), '');
  return {root, checkout, home, fakes: bin, log: path.join(root, 'calls.log'), status};
}

function environment(fx: Fixture, extra: Record<string, string>): Record<string, string> {
  return {HOME: fx.home, USER: 'fixture', PATH: fx.fakes, TMPDIR: fx.root, LC_ALL: 'C', SHELL: '/bin/bash',
    XDG_RUNTIME_DIR: path.join(fx.root, 'runtime'), LOG: fx.log, TS_STATUS: fx.status, OURS,
    TS_DENY: path.join(fx.root, 'deny'), TS_OPERATOR: path.join(fx.root, 'operator'), TS_STATUS_FAIL: path.join(fx.root, 'status-fail'),
    TS_SERVE_FAIL: path.join(fx.root, 'serve-fail'), TS_SERVE_HANG: path.join(fx.root, 'serve-hang'), ...extra};
}

// answer === undefined: stdin is not a terminal. Otherwise the installer runs on a pseudo-terminal
// (util-linux script) and `answer` is typed on it.
type InstallOptions = {answer?: string; env?: Record<string, string>; unset?: string[]; timeout?: number};
function install(fx: Fixture, args: string[], opts: InstallOptions = {}) {
  const command = [path.join(fx.checkout, 'install.sh'), ...args];
  const env = environment(fx, opts.env ?? {});
  for (const name of opts.unset ?? []) delete env[name];
  const result = opts.answer === undefined
    ? spawnSync('/bin/bash', command, {env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: opts.timeout ?? 20000})
    : spawnSync('/usr/bin/script', ['-qec', ['/bin/bash', ...command].map(shellQuote).join(' '), '/dev/null'],
      {env, input: `${opts.answer}\n`, encoding: 'utf8', timeout: 20000});
  const calls = fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8') : '';
  return {...result, calls, output: `${result.stdout}${result.stderr}`};
}

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
const unitDir = (fx: Fixture) => path.join(fx.home, '.config/systemd/user');
const sudoCalls = (calls: string) => calls.split('\n').filter((line) => line.startsWith('sudo '));
const hasScript = fs.existsSync('/usr/bin/script');

describe('install.sh: Tailscale publication is explicit and never takes over a foreign one', () => {
  test('without --tailscale, tailscale and sudo are never called', () => {
    const fx = fixture({status: FOREIGN, deny: true});
    const run = install(fx, []);
    assert.doesNotMatch(run.calls, /^(tailscale|sudo) /m);
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.readFileSync(fx.status, 'utf8'), FOREIGN);
  });

  test('a foreign publication is refused before any effect', () => {
    const fx = fixture({status: FOREIGN});
    const run = install(fx, ['--tailscale']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /already publishes something else.*nothing was changed/);
    assert.equal(fs.readFileSync(fx.status, 'utf8'), FOREIGN);
    assert.ok(!fs.existsSync(unitDir(fx)));
    assert.deepEqual(run.calls.split('\n').filter((line) => /^(systemctl|sudo|tailscale) /.test(line)),
      ['systemctl --user show session-mesh.service --property=LoadState,ActiveState,SubState,FragmentPath,DropInPaths,NeedDaemonReload',
        'systemctl --user show session-mesh-pty.service --property=LoadState,ActiveState,SubState,FragmentPath,DropInPaths,NeedDaemonReload',
        'tailscale serve status --json']);
  });

  test('--tailscale without tailscale installed is refused before any effect', () => {
    const fx = fixture({tailscale: false});
    const run = install(fx, ['--tailscale']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /tailscale is not installed/);
    assert.ok(!fs.existsSync(unitDir(fx)));
  });

  test('a free HTTPS root is published without sudo', () => {
    const fx = fixture();
    const run = install(fx, ['--tailscale']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.calls, /^tailscale serve --bg 7690$/m);
    assert.match(run.stdout, /URL {6}: https:\/\/node\.example\.ts\.net$/m);
    assert.deepEqual(sudoCalls(run.calls), []);
  });

  test('operator rights without a terminal: sudo is never called and the command is named', () => {
    const fx = fixture({deny: true});
    const run = install(fx, ['--tailscale']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /run 'sudo tailscale set --operator=fixture' yourself/);
    assert.deepEqual(sudoCalls(run.calls), []);
  });

  test('operator rights on a terminal answered no: sudo is never called', {skip: !hasScript && 'script absent'}, () => {
    const fx = fixture({deny: true});
    const run = install(fx, ['--tailscale'], {answer: 'n'});
    assert.match(run.output, /Run "sudo tailscale set --operator=fixture" now\? \[y\/N\]/);
    assert.match(run.output, /not published/);
    assert.deepEqual(sudoCalls(run.calls), []);
  });

  test('operator rights on a terminal answered Y: accepted like y', {skip: !hasScript && 'script absent'}, () => {
    const fx = fixture({deny: true});
    const run = install(fx, ['--tailscale'], {answer: 'Y'});
    assert.deepEqual(sudoCalls(run.calls), ['sudo tailscale set --operator=fixture']);
  });

  test('operator rights on a terminal answered yes: exactly one sudo, then publication', {skip: !hasScript && 'script absent'}, () => {
    const fx = fixture({deny: true});
    const run = install(fx, ['--tailscale'], {answer: 'y'});
    assert.deepEqual(sudoCalls(run.calls), ['sudo tailscale set --operator=fixture']);
    assert.match(run.output, /https:\/\/node\.example\.ts\.net/);
  });
});

describe('install.sh --uninstall: only its own publication is removed', () => {
  test('its own publication is turned off', () => {
    const fx = fixture({status: OURS});
    const run = install(fx, ['--uninstall']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.calls, /^tailscale serve --https=443 off$/m);
  });

  test('a foreign publication is left untouched', () => {
    const fx = fixture({status: FOREIGN});
    const run = install(fx, ['--uninstall']);
    assert.equal(run.status, 0, run.output);
    assert.doesNotMatch(run.calls, /--https=443 off/);
    assert.equal(fs.readFileSync(fx.status, 'utf8'), FOREIGN);
  });

  test('without tailscale, uninstall succeeds', () => {
    const fx = fixture({tailscale: false});
    assert.equal(install(fx, ['--uninstall']).status, 0);
  });
});

describe('install.sh: unit paths are systemd-quoted', {skip: !fs.existsSync('/usr/bin/systemd-analyze') && 'systemd-analyze absent'}, () => {
  // %h is a real systemd specifier: left unescaped, it would decode to a home directory.
  for (const name of ['check out', 'odd #&%h$USER path']) {
    test(`a checkout named "${name}" gives units that systemd accepts`, () => {
      const fx = fixture({checkoutName: name});
      // The interpreter lives inside the checkout, so the offline verifier checks the decoded path.
      const python = path.join(fx.checkout, 'venv', 'bin', 'python');
      fs.mkdirSync(path.dirname(python), {recursive: true});
      writeExecutable(python, FAKES.python3);
      const run = install(fx, [], {env: {MESH_PYTHON: python}});
      assert.equal(run.status, 0, run.output);
      const quoted = (text: string) => text.replaceAll('%', '%%');
      const host = path.join(fx.fakes, 'mesh-ptyhost');
      for (const [unit, executable, expected] of [
        ['session-mesh.service', python, `"${quoted(python)}" "${quoted(fx.checkout)}/server.py"`],
        ['session-mesh-pty.service', host, `"${quoted(host)}"`]]) {
        const text = fs.readFileSync(path.join(unitDir(fx), unit), 'utf8');
        assert.ok(text.includes(`\nExecStart=:${expected}\n`), text);
        verifyOffline(fx, unit, executable);
      }
    });
  }
});

// Real systemd offline parser rooted in the fixture: no manager, no generators, nothing executed.
function verifyOffline(fx: Fixture, unit: string, executable: string): void {
  const offline = path.join(fx.root, `offline-${unit}`);
  const mirrored = path.join(offline, executable);
  fs.mkdirSync(path.dirname(mirrored), {recursive: true});
  fs.copyFileSync(executable, mirrored);
  fs.chmodSync(mirrored, 0o700);
  const target = path.join(offline, 'etc/systemd/system', unit);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const text = fs.readFileSync(path.join(unitDir(fx), unit), 'utf8')
    .replace('[Unit]\n', '[Unit]\nDefaultDependencies=no\n').replace(/^(Wants|After)=.*\n/gm, '');
  fs.writeFileSync(target, text);
  const checked = spawnSync('/usr/bin/systemd-analyze', [`--root=${offline}`, '--generators=no', '--man=no', 'verify', target],
    {env: {PATH: '/usr/bin:/bin', LC_ALL: 'C', SYSTEMD_ENVIRONMENT_GENERATOR_PATH: path.join(offline, 'none')}, encoding: 'utf8', timeout: 10000});
  assert.equal(checked.status, 0, `${unit}: ${checked.stderr}\n${text}`);
}

// Installer safety: interpreter admission, Tailscale state, account and port.
const fakePython = (fx: Fixture, ...parts: string[]) => {
  const python = path.join(fx.root, ...parts);
  fs.mkdirSync(path.dirname(python), {recursive: true});
  writeExecutable(python, FAKES.python3);
  return python;
};

describe('install.sh: the interpreter path is admitted like the native binary', () => {
  for (const dir of ["it's", 'glob[1]']) {
    test(`an interpreter under "${dir}" is refused before any change`, () => {
      const fx = fixture();
      const run = install(fx, [], {env: {MESH_PYTHON: fakePython(fx, dir, 'python')}});
      assert.equal(run.status, 1, run.output);
      assert.match(run.stderr, /executable path contains unsupported quote\/backslash\/glob/);
      assert.ok(!fs.existsSync(unitDir(fx)));
    });
  }

  test('a directory is not accepted as the interpreter', () => {
    const fx = fixture();
    const dir = path.join(fx.root, 'pydir');
    fs.mkdirSync(dir);
    const run = install(fx, [], {env: {MESH_PYTHON: dir}});
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /interpreter must be an absolute path to an executable/);
    assert.ok(!fs.existsSync(unitDir(fx)));
  });

  test('a command link pointing to a directory is replaced, not followed', () => {
    const fx = fixture();
    const elsewhere = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(fx.home, '.local/bin'), {recursive: true});
    const link = path.join(fx.home, '.local/bin/mesh-open');
    fs.symlinkSync(elsewhere, link);
    const run = install(fx, []);
    assert.equal(run.status, 0, run.output);
    assert.equal(fs.readlinkSync(link), path.join(fx.checkout, 'bin/mesh-open'));
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });
});

describe('install.sh: Tailscale state is classified strictly', () => {
  test('whitespace inside a JSON string is not compacted into "ours"', () => {
    const spaced = served('http://127.0.0.1:7690', 'node.example .ts.net');
    const fx = fixture({status: spaced});
    const run = install(fx, ['--uninstall']);
    assert.equal(run.status, 0, run.output);
    assert.doesNotMatch(run.calls, /--https=443 off/);
    const fx2 = fixture({status: spaced});
    const refused = install(fx2, ['--tailscale']);
    assert.equal(refused.status, 1, refused.output);
    assert.ok(!fs.existsSync(unitDir(fx2)));
  });

  for (const [name, setup] of [['a failing status command', (fx: Fixture) => fs.writeFileSync(path.join(fx.root, 'status-fail'), '')],
    ['a null status', (fx: Fixture) => fs.writeFileSync(fx.status, 'null\n')]] as const) {
    test(`${name} is reported as unreadable and refused before any change`, () => {
      const fx = fixture();
      setup(fx);
      const run = install(fx, ['--tailscale']);
      assert.equal(run.status, 1, run.output);
      assert.match(run.stderr, /unreadable.*nothing was changed/);
      assert.doesNotMatch(run.stderr, /already publishes something else/);
      assert.ok(!fs.existsSync(unitDir(fx)));
      const uninstall = install(fx, ['--uninstall']);
      assert.equal(uninstall.status, 0, uninstall.output);
      assert.match(uninstall.output, /unreadable/);
      assert.doesNotMatch(uninstall.calls, /--https=443 off/);
    });
  }

  test('the stderr of tailscale serve is shown as it is written, even while it blocks', () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.root, 'serve-fail'), 'Serve is not enabled on your tailnet. To enable, visit: https://login.example/x\n');
    fs.writeFileSync(path.join(fx.root, 'serve-hang'), '');
    const run = install(fx, ['--tailscale'], {timeout: 1500});
    assert.match(run.stderr, /Serve is not enabled on your tailnet/);
  });

  test('a failing tailscale serve shows its stderr and stops', () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.root, 'serve-fail'), 'boom: serve failed\n');
    const run = install(fx, ['--tailscale']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /boom: serve failed/);
    // The file that kept that stderr (in TMPDIR, the fixture's root) is removed on that exit too.
    assert.deepEqual(fs.readdirSync(fx.root).filter((name) => name.startsWith('mesh-serve.')), []);
  });
});

describe('install.sh: account and port', () => {
  test('without USER, the account name comes from id -un', () => {
    const fx = fixture();
    const run = install(fx, [], {unset: ['USER']});
    assert.equal(run.status, 0, run.output);
    assert.match(run.calls, new RegExp(`^loginctl show-user ${os.userInfo().username} -p Linger$`, 'm'));
  });

  test('the web unit receives MESH_PORT', () => {
    const fx = fixture();
    const run = install(fx, [], {env: {MESH_PORT: '7691'}});
    assert.equal(run.status, 0, run.output);
    assert.match(fs.readFileSync(path.join(unitDir(fx), 'session-mesh.service'), 'utf8'), /^Environment="MESH_PORT=7691"$/m);
  });

  for (const port of ['0', '65536', '99999', '07690']) {
    test(`MESH_PORT=${port} is refused before any change`, () => {
      const fx = fixture();
      const run = install(fx, [], {env: {MESH_PORT: port}});
      assert.equal(run.status, 1, run.output);
      assert.match(run.stderr, /MESH_PORT must be a port number/);
      assert.ok(!fs.existsSync(unitDir(fx)));
    });
  }

  // Under a UTF-8 locale, bash's [0-9] can match other scripts' digits (Arabic-Indic,
  // Devanagari), which arithmetic then fails to read: only ASCII digits are a port.
  for (const port of ['7\u0666' + '9\u0660', '\u0967\u0968\u0969\u096a', '\uff17\uff16\uff19\uff10']) {
    for (const locale of ['en_US.UTF-8', 'C.UTF-8']) {
      test(`MESH_PORT=${port} under ${locale} is refused before any change`, () => {
        const fx = fixture();
        const run = install(fx, [], {env: {MESH_PORT: port, LC_ALL: locale, LANG: locale}});
        assert.equal(run.status, 1, run.output);
        assert.match(run.stderr, /MESH_PORT must be a port number/);
        assert.ok(!fs.existsSync(unitDir(fx)));
      });
    }
  }
});
