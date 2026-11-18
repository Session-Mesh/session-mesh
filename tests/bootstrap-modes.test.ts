// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/bootstrap.sh has two installing modes. `--install-only` is what a user who only wants
// the native programs runs: no OCaml test, no Python. The default mode also
// runs the OCaml tests, some of which drive the Python test harness tests/ptyhost_proc.py, so it
// refuses before installing anything when its Python has no pytest.
// opam is replaced by a recorder that keeps the switches, the repositories and each switch's
// selection in files, so a case sees the effect of every command on the next ones. Unless a case
// says otherwise, the switch exists and reads only the pinned opam repository.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PINNED = /^opam_repository="([^"]+)"$/m.exec(fs.readFileSync(path.join(REPO, 'scripts', 'release-pins.sh'), 'utf8'))?.[1] ?? '';
// `repository list --all` has the layout of opam 2.6.1: a '#' header, then name, URL as
// registered, switches; as opam does, it wraps the URL onto a line of its own when COLUMNS is set,
// even into a pipe. A second add of a repository or a second creation of a switch fails, as with
// opam. With FAKE_CREATE_FAILS, creating a switch registers it without a compiler and fails, as a
// failed compiler installation does.
const FAKE_OPAM = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$OPAM_CALLS"
state="$FAKE_STATE"
key() { printf '%s' "$1" | tr '/' '_'; }
switch_of() { printf '%s' "$1" | sed 's/^--switch=//'; }
case "$1 $2" in
  'switch list')
    if [ -n "$FAKE_SWITCH_LIST_FAILS" ]; then echo '[ERROR] opam root is locked' >&2; exit 15; fi
    cat "$state/switches"; exit 0 ;;
  'switch show')
    if [ -s "$state/current" ]; then cat "$state/current"; exit 0; fi
    echo '[ERROR] No switch is currently set.' >&2; exit 50 ;;
  'switch create')
    repos=$(printf '%s\n' "$@" | sed -n 's/^--repos=//p')
    name=$(printf '%s\n' "$@" | sed -n '6p')
    if grep -Fxq -- "$name" "$state/switches"; then echo "[ERROR] switch $name exists" >&2; exit 2; fi
    echo "$name" >> "$state/switches"
    if [ -n "$FAKE_CREATE_FAILS" ]; then echo "$name" >> "$state/without-compiler"; exit 31; fi
    printf '%s\n' "$repos" | tr ',' '\n' > "$state/selected-$(key "$name")"; exit 0 ;;
  'repository list')
    if [ "$3" = --all ]; then
      echo '# Repository # Url # Switches(rank)'
      while read -r name url; do
        if [ -n "$COLUMNS" ]; then printf '%-12s\n             %s <default>\n' "$name" "$url"
        else printf '%-12s %s <default>\n' "$name" "$url"; fi
      done < "$state/repositories"
    else cat "$state/selected-$(key "$(switch_of "$3")")"; fi
    exit 0 ;;
  'repository add')
    if grep -q "^$4 " "$state/repositories"; then echo "[ERROR] repository $4 exists" >&2; exit 2; fi
    echo "$4 $5" >> "$state/repositories"; exit 0 ;;
  'repository set-url')
    grep -v "^$3 " "$state/repositories" > "$state/repositories.new"
    echo "$3 $4" >> "$state/repositories.new"; mv "$state/repositories.new" "$state/repositories"; exit 0 ;;
  'repository set-repos')
    selection="$state/selected-$(key "$(switch_of "$3")")"; shift 3
    printf '%s\n' "$@" > "$selection"; exit 0 ;;
esac
case "$*" in
  *'ocamlc -version')
    if [ "$(switch_of "$2")" = "$FAKE_NO_COMPILER" ] || grep -Fxq -- "$(switch_of "$2")" "$state/without-compiler" 2>/dev/null; then
      echo 'ocamlc: command not found' >&2; exit 127; fi
    echo 5.3.0 ;;
  'var root') echo "$FAKE_ROOT" ;;
  'pin list --switch='*' --short') for pin in $FAKE_PINS; do echo "$pin"; done ;;
  'var --switch='*' bin') echo /fake/bin ;;
esac
`;
// The opam root the fake reports, with a space: the printed commands must quote it.
const ROOT = '/fake/opam root';
// The shell quoting bootstrap.sh applies (bash printf %q), to compare printed commands with.
const quoted = (word: string) => spawnSync('bash', ['-c', 'printf %q "$1"', '_', word], {encoding: 'utf8'}).stdout;
const opamCommand = (...words: string[]) => `opam ${words[0]} ${words[1]} --root=${quoted(ROOT)}`
  + words.slice(2).map((word) => ` ${quoted(word)}`).join('');
const WITH_PYTEST ='#!/bin/sh\nexit 0\n';
const WITHOUT_PYTEST = '#!/bin/sh\nexit 1\n';
const OPAM_ORG = 'https://opam.ocaml.org';

type OpamState = {switches: string[]; current: string; repositories: Record<string, string>; selected: Record<string, string[]>};
const onPin = (): OpamState => ({switches: ['fake-switch'], current: '',
  repositories: {default: PINNED}, selected: {'fake-switch': ['default']}});

let scratch = '';

function script(name: string, text: string): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, text, {mode: 0o700});
  return file;
}

const key = (name: string) => name.replaceAll('/', '_');

function writeState(dir: string, state: OpamState): void {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'switches'), state.switches.map((name) => `${name}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'current'), state.current);
  fs.writeFileSync(path.join(dir, 'repositories'),
    Object.entries(state.repositories).map(([name, url]) => `${name} ${url}\n`).join(''));
  for (const [name, repositories] of Object.entries(state.selected)) {
    fs.writeFileSync(path.join(dir, `selected-${key(name)}`), repositories.map((repo) => `${repo}\n`).join(''));
  }
}

const lines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];

let runs = 0;

type Run = {status: number | null; output: string; calls: string[]; stateDir: string;
  selected: (name: string) => string[]; repositories: string[]; switches: string[]};

// `reuse` runs against the state an earlier run left, instead of a fresh one built from `state`.
function bootstrap(args: string[], python: string, options: {pins?: string; state?: Partial<OpamState>;
    reuse?: string; env?: Record<string, string | undefined>} = {}): Run {
  const run = runs++;
  const calls = path.join(scratch, `calls-${run}`);
  const stateDir = options.reuse ?? path.join(scratch, `state-${run}`);
  fs.writeFileSync(calls, '');
  if (options.reuse === undefined) writeState(stateDir, {...onPin(), ...options.state});
  const env: Record<string, string | undefined> = {...process.env, PATH: `${scratch}:${process.env.PATH}`,
    OPAM_CALLS: calls, FAKE_STATE: stateDir, MESH_OPAM_SWITCH: 'fake-switch', MESH_OPAM_SELECT_PINNED: undefined,
    OCAML_COMPILER: undefined, FAKE_SWITCH_LIST_FAILS: undefined, FAKE_CREATE_FAILS: undefined, FAKE_NO_COMPILER: undefined,
    COLUMNS: undefined, FAKE_ROOT: ROOT,
    PYTHON: python, FAKE_PINS: options.pins ?? '', ...options.env};
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  const result = spawnSync('bash', ['scripts/bootstrap.sh', ...args], {cwd: REPO, env, encoding: 'utf8'});
  return {status: result.status, output: result.stdout + result.stderr, calls: lines(calls), stateDir,
    selected: (name) => lines(path.join(stateDir, `selected-${key(name)}`)),
    repositories: lines(path.join(stateDir, 'repositories')), switches: lines(path.join(stateDir, 'switches'))};
}

describe('scripts/bootstrap.sh modes', () => {
  let withPytest = '';
  let withoutPytest = '';
  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-modes-'));
    script('opam', FAKE_OPAM);
    withPytest = script('python-with-pytest', WITH_PYTEST);
    withoutPytest = script('python-without-pytest', WITHOUT_PYTEST);
  });
  after(() => fs.rmSync(scratch, {recursive: true, force: true}));

  test('--install-only builds and installs without running a test or Python', () => {
    const run = bootstrap(['--install-only'], withoutPytest);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /built and installed in 'fake-switch' \(tests not run\)/);
    const issued = run.calls.join('\n');
    assert.match(issued, /dune build -p session_mesh @install/);
    assert.match(issued, /--assume-built/);
    assert.match(issued, /--deps-only --with-test/);
    assert.match(issued, /pin add .* dune 3\.\d+\.\d+/);
    assert.ok(!issued.includes('runtest'), issued);
  });

  test('the default mode refuses before any installation when Python has no pytest', () => {
    const run = bootstrap([], withoutPytest);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /need pytest/);
    assert.match(run.output, /bootstrap\.sh --install-only/);
    assert.ok(run.calls.every((call) => !/\b(install|pin)\b/.test(call)), run.calls.join('\n'));
  });

  test('the default mode installs the test dependencies and runs the tests before installing', () => {
    const run = bootstrap([], withPytest);
    assert.equal(run.status, 0, run.output);
    const tests = run.calls.findIndex((call) => call.includes('dune runtest'));
    const install = run.calls.findIndex((call) => call.includes('--assume-built'));
    assert.ok(run.calls.some((call) => call.includes('--deps-only --with-test')), run.calls.join('\n'));
    assert.ok(tests >= 0 && tests < install, run.calls.join('\n'));
  });

  test('quint-connect comes from opam: no pin is added, and a stale ocaml-quint-connect pin is removed first', () => {
    const clean = bootstrap(['--deps-only'], withPytest);
    assert.equal(clean.status, 0, clean.output);
    assert.ok(clean.calls.every((call) => !/pin (add|remove) .*quint/.test(call)), clean.calls.join('\n'));
    const stale = bootstrap(['--deps-only'], withPytest, {pins: 'dune mcp-kit ocaml-quint-connect'});
    assert.equal(stale.status, 0, stale.output);
    const removal = stale.calls.findIndex((call) => /pin remove .*ocaml-quint-connect/.test(call));
    const deps = stale.calls.findIndex((call) => call.includes('--deps-only --with-test'));
    assert.ok(removal >= 0 && removal < deps, stale.calls.join('\n'));
    assert.ok(stale.calls.every((call) => !/pin add .*quint/.test(call)), stale.calls.join('\n'));
  });

  // Issue #1: a host whose opam repository is older than the pins cannot install them, so the
  // switch reads the opam repository at the commit of scripts/release-pins.sh, and only that one.
  // An existing switch is not moved to it unless this run created it, it is the checkout's local
  // switch, or MESH_OPAM_SELECT_PINNED=1 says so: other projects may share it.
  const changes = (calls: string[]) => calls.filter((call) => /^(repository (add|set-url|set-repos)|switch create)/.test(call));
  const beforeDune = (calls: string[], index: number) => index >= 0 && index < calls.findIndex((call) => call.startsWith('pin add'));
  const elsewhere = {repositories: {default: OPAM_ORG}};
  const refused = (run: Run, selection: string[], name = 'fake-switch') => {
    assert.equal(run.status, 1, run.output);
    assert.deepEqual(changes(run.calls), []);
    assert.ok(run.calls.every((call) => !/^(install|pin)\b/.test(call)), run.calls.join('\n'));
    assert.deepEqual(run.selected(name), selection);
    assert.match(run.output, /its repositories are left as they are/);
    assert.ok(run.output.includes(`OPAMROOT=${quoted(ROOT)} MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh --deps-only`), run.output);
    assert.ok(run.output.includes(`OPAMROOT=${quoted(ROOT)} MESH_OPAM_SWITCH=${quoted(name)} MESH_OPAM_SELECT_PINNED=1 bash scripts/bootstrap.sh --deps-only`), run.output);
  };
  const undo = (run: Run, ...words: string[]) => {
    const expected = `to undo: ${opamCommand('repository', ...words)})`;
    assert.ok(run.output.includes(expected), `${expected}\n${run.output}`);
  };

  test('a switch that already reads only the pinned repository is left as it is', () => {
    const run = bootstrap(['--deps-only'], withPytest);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), []);
    assert.deepEqual(run.selected('fake-switch'), ['default']);
  });

  test('with COLUMNS set, a switch on the pinned repository is still recognised', () => {
    const run = bootstrap(['--deps-only'], withPytest, {env: {COLUMNS: '80'}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), []);
  });

  test('an existing named switch on other repositories is refused and left as it is', () => {
    const run = bootstrap(['--deps-only'], withPytest, {state: elsewhere});
    refused(run, ['default']);
  });

  test('without MESH_OPAM_SWITCH, a current switch on other repositories is not touched', () => {
    const run = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: undefined},
      state: {...elsewhere, switches: ['mine'], current: 'mine', selected: {mine: ['default']}}});
    refused(run, ['default'], 'mine');
    assert.deepEqual(run.switches, ['mine']);
  });

  test('without MESH_OPAM_SWITCH, a current switch on the pinned repository is used', () => {
    const run = bootstrap(['--install-only'], withPytest, {env: {MESH_OPAM_SWITCH: undefined},
      state: {switches: ['mine'], current: 'mine', selected: {mine: ['default']}}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), []);
    assert.match(run.output, /installed in 'mine'/);
  });

  test('without MESH_OPAM_SWITCH and without a current switch, nothing is done', () => {
    const run = bootstrap(['--install-only'], withPytest, {env: {MESH_OPAM_SWITCH: undefined}});
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /no current opam switch; .*MESH_OPAM_SWITCH=session-mesh/);
    assert.deepEqual(changes(run.calls), []);
  });

  test('MESH_OPAM_SELECT_PINNED=1 moves an existing switch and prints its former repositories to undo it', () => {
    const run = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SELECT_PINNED: '1'},
      state: {repositories: {default: OPAM_ORG, beta: 'https://example.org/beta'},
        selected: {'fake-switch': ['beta', 'default']}}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), [
      `repository add --dont-select session-mesh ${PINNED}`,
      'repository set-repos --switch=fake-switch session-mesh',
    ]);
    assert.ok(beforeDune(run.calls, run.calls.indexOf('repository set-repos --switch=fake-switch session-mesh')), run.calls.join('\n'));
    undo(run, 'set-repos', '--switch=fake-switch', 'beta', 'default');
    assert.deepEqual(run.selected('fake-switch'), ['session-mesh']);
    assert.ok(run.repositories.includes(`default ${OPAM_ORG}`), run.repositories.join('\n'));
  });

  const old = 'git+https://github.com/ocaml/opam-repository.git#0000000000000000000000000000000000000000';
  const undoUrl = (run: Run) => undo(run, 'set-url', 'session-mesh', old);
  test('a switch that reads only session-mesh follows a changed pin without the opt-in, and prints the undo', () => {
    const run = bootstrap(['--deps-only'], withPytest, {
      state: {repositories: {'session-mesh': old}, selected: {'fake-switch': ['session-mesh']}}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), [`repository set-url session-mesh ${PINNED}`]);
    assert.ok(beforeDune(run.calls, run.calls.indexOf(`repository set-url session-mesh ${PINNED}`)), run.calls.join('\n'));
    assert.deepEqual(run.repositories, [`session-mesh ${PINNED}`]);
    assert.deepEqual(run.selected('fake-switch'), ['session-mesh']);
    undoUrl(run);
    assert.ok(!/MESH_OPAM_SELECT_PINNED|session-mesh-pinned/.test(run.output), run.output);
  });

  test('the switch session-mesh created by an earlier run follows a changed pin on the next run', () => {
    const first = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: 'session-mesh'},
      state: {...elsewhere, switches: ['other'], selected: {other: ['default']}}});
    assert.equal(first.status, 0, first.output);
    assert.deepEqual(first.selected('session-mesh'), ['session-mesh']);
    const later = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: 'session-mesh'},
      state: {switches: first.switches, repositories: {default: OPAM_ORG, 'session-mesh': old},
        selected: {other: ['default'], 'session-mesh': first.selected('session-mesh')}}});
    assert.equal(later.status, 0, later.output);
    assert.deepEqual(changes(later.calls), [`repository set-url session-mesh ${PINNED}`]);
    assert.ok(later.repositories.includes(`session-mesh ${PINNED}`), later.repositories.join('\n'));
    assert.deepEqual(later.selected('session-mesh'), ['session-mesh']);
    assert.deepEqual(later.selected('other'), ['default']);
    assert.ok(!/session-mesh-pinned|MESH_OPAM_SELECT_PINNED/.test(later.output), later.output);
  });

  test('with the opt-in, a switch on several repositories is told how to restore both its repositories and the former URL', () => {
    const run = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SELECT_PINNED: '1'},
      state: {repositories: {default: OPAM_ORG, 'session-mesh': old}, selected: {'fake-switch': ['session-mesh', 'default']}}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), [
      `repository set-url session-mesh ${PINNED}`,
      'repository set-repos --switch=fake-switch session-mesh',
    ]);
    undoUrl(run);
    undo(run, 'set-repos', '--switch=fake-switch', 'session-mesh', 'default');
  });

  test('a switch on session-mesh and another repository is still refused without the opt-in', () => {
    const run = bootstrap(['--deps-only'], withPytest,
      {state: {repositories: {default: OPAM_ORG, 'session-mesh': old}, selected: {'fake-switch': ['session-mesh', 'default']}}});
    refused(run, ['session-mesh', 'default']);
    assert.ok(run.repositories.includes(`session-mesh ${old}`), run.repositories.join('\n'));
  });

  test('the local switch of the checkout (CI) is moved to the pinned repository without the opt-in', () => {
    const run = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: undefined},
      state: {...elsewhere, switches: [REPO], current: REPO, selected: {[REPO]: ['default']}}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), [
      `repository add --dont-select session-mesh ${PINNED}`,
      `repository set-repos --switch=${REPO} session-mesh`,
    ]);
    assert.deepEqual(run.selected(REPO), ['session-mesh']);
  });

  test('the checkout named by an unresolved path is its local switch; a switch named by its _opam is not', () => {
    const dotted = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: `${REPO}/.`},
      state: {...elsewhere, switches: [REPO], selected: {[REPO]: ['default']}}});
    assert.equal(dotted.status, 0, dotted.output);
    assert.ok(dotted.calls.every((call) => !call.startsWith('switch create')), dotted.calls.join('\n'));
    assert.deepEqual(dotted.selected(REPO), ['session-mesh']);
    const store = fs.mkdtempSync(path.join(scratch, 'checkout-'));
    const opamDir = path.join(fs.realpathSync(store), '_opam');
    fs.mkdirSync(opamDir);
    const nested = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: opamDir},
      state: {...elsewhere, switches: [opamDir], selected: {[opamDir]: ['default']}}});
    refused(nested, ['default'], opamDir);
  });

  test('with the opt-in, a switch that read no repository is told how to restore that empty selection', () => {
    const run = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SELECT_PINNED: '1'},
      state: {selected: {'fake-switch': []}}});
    assert.equal(run.status, 0, run.output);
    undo(run, 'set-repos', '--switch=fake-switch');
  });

  test('a local switch whose directory holds a quote and a space is quoted in the refusal and in the undo', () => {
    const local = path.join(fs.realpathSync(scratch), "O'Brien mesh");
    fs.mkdirSync(local, {recursive: true});
    const state = {...elsewhere, switches: [local], selected: {[local]: ['default']}};
    refused(bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: local}, state}), ['default'], local);
    const run = bootstrap(['--deps-only'], withPytest, {env: {MESH_OPAM_SWITCH: local, MESH_OPAM_SELECT_PINNED: '1'}, state});
    assert.equal(run.status, 0, run.output);
    undo(run, 'set-repos', `--switch=${local}`, 'default');
  });

  test('a switch left without a compiler by a failed creation names its removal, on that run and the next', () => {
    const removal = `remove it and rerun: opam switch remove --root=${quoted(ROOT)} fake-switch`;
    const failed = bootstrap(['--install-only'], withPytest, {env: {FAKE_CREATE_FAILS: '1'},
      state: {...elsewhere, switches: ['other'], selected: {other: ['default']}}});
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /creating the opam switch 'fake-switch' failed/);
    assert.ok(failed.output.includes(removal), failed.output);
    const rerun = bootstrap(['--install-only'], withPytest, {reuse: failed.stateDir});
    assert.equal(rerun.status, 1, rerun.output);
    assert.match(rerun.output, /no OCaml compiler runs in the opam switch 'fake-switch'/);
    assert.ok(rerun.output.includes(removal), rerun.output);
    assert.ok(rerun.calls.every((call) => !call.startsWith('switch create')), rerun.calls.join('\n'));
    assert.ok(rerun.calls.every((call) => !/^(install|pin)\b/.test(call)), rerun.calls.join('\n'));
  });

  test('the compiler is run from the switch bin directory, not looked up on the host PATH', () => {
    const run = bootstrap(['--install-only'], withPytest);
    assert.equal(run.status, 0, run.output);
    assert.ok(run.calls.includes('exec --switch=fake-switch -- /fake/bin/ocamlc -version'), run.calls.join('\n'));
  });

  test('a former session-mesh URL with credentials is replaced but not printed', () => {
    const secret = 'git+https://user:s3cret@example.org/opam-repository.git#0000000000000000000000000000000000000000';
    const run = bootstrap(['--deps-only'], withPytest, {
      state: {repositories: {'session-mesh': secret}, selected: {'fake-switch': ['session-mesh']}}});
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.repositories, [`session-mesh ${PINNED}`]);
    assert.ok(!run.output.includes('s3cret'), run.output);
    assert.match(run.output, /former URL carried credentials and is not printed/);
  });

  test('a failed switch listing stops the bootstrap before any change', () => {
    const run = bootstrap(['--install-only'], withPytest, {env: {FAKE_SWITCH_LIST_FAILS: '1'}});
    assert.notEqual(run.status, 0, run.output);
    assert.deepEqual(changes(run.calls), []);
  });

  test('a missing switch is created from the pinned repository, once, without becoming the current switch', () => {
    const run = bootstrap(['--install-only'], withoutPytest, {state: {...elsewhere, switches: ['other'], current: 'other',
      selected: {other: ['default']}}});
    assert.equal(run.status, 0, run.output);
    const create = '--no-switch --no-install --repos=session-mesh fake-switch ocaml-base-compiler.5.3.0';
    assert.deepEqual(changes(run.calls), [
      `repository add --dont-select session-mesh ${PINNED}`,
      `switch create ${create}`,
    ]);
    assert.ok(beforeDune(run.calls, run.calls.indexOf(`switch create ${create}`)), run.calls.join('\n'));
    assert.deepEqual(run.switches, ['other', 'fake-switch']);
    assert.deepEqual(run.selected('fake-switch'), ['session-mesh']);
    assert.deepEqual(run.selected('other'), ['default']);
  });

  test('--print-bin and a relative switch directory create nothing', () => {
    const printBin = bootstrap(['--print-bin'], withPytest, {state: {switches: ['other']}});
    assert.equal(printBin.status, 1, printBin.output);
    assert.ok(printBin.output.includes(
      `does not exist; to create it, run: OPAMROOT=${quoted(ROOT)} MESH_OPAM_SWITCH=fake-switch bash scripts/bootstrap.sh --install-only`),
    printBin.output);
    assert.deepEqual(changes(printBin.calls), []);
    const relative = bootstrap(['--install-only'], withPytest, {env: {MESH_OPAM_SWITCH: 'switches/mesh'}});
    assert.equal(relative.status, 1, relative.output);
    assert.match(relative.output, /a switch name or an absolute directory/);
    assert.deepEqual(relative.calls, []);
  });

  test('an unknown option is a usage error', () => {
    const run = bootstrap(['--no-such-mode'], withPytest);
    assert.equal(run.status, 2);
    assert.match(run.output, /usage: bootstrap\.sh \[--print-bin \| --deps-only \| --install-only\]/);
    assert.deepEqual(run.calls, []);
  });
});
