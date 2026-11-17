// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/bootstrap.sh has two installing modes. `--install-only` is what a user who only wants
// the native programs runs: no OCaml test, no Python. The default mode also
// runs the OCaml tests, some of which drive the Python test harness tests/ptyhost_proc.py, so it
// refuses before installing anything when its Python has no pytest.
// opam is replaced by a recorder: these cases check which opam commands each mode issues.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const FAKE_OPAM = `#!/bin/sh
printf '%s\\n' "$*" >> "$OPAM_CALLS"
case "$*" in
  'switch list --short') echo fake-switch ;;
  *'ocamlc -version') echo 5.3.0 ;;
  'pin list --switch=fake-switch --short') for pin in $FAKE_PINS; do echo "$pin"; done ;;
esac
`;
const WITH_PYTEST = '#!/bin/sh\nexit 0\n';
const WITHOUT_PYTEST = '#!/bin/sh\nexit 1\n';

let scratch = '';

function script(name: string, text: string): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, text, {mode: 0o700});
  return file;
}

function bootstrap(args: string[], python: string, pins = ''): {status: number | null; output: string; calls: string[]} {
  const calls = path.join(scratch, `calls-${args.join('') || 'default'}-${path.basename(python)}-${pins ? 'pins' : 'nopins'}`);
  fs.writeFileSync(calls, '');
  const env = {...process.env, PATH: `${scratch}:${process.env.PATH}`, OPAM_CALLS: calls,
    MESH_OPAM_SWITCH: 'fake-switch', PYTHON: python, FAKE_PINS: pins};
  const result = spawnSync('bash', ['scripts/bootstrap.sh', ...args], {cwd: REPO, env, encoding: 'utf8'});
  return {status: result.status, output: result.stdout + result.stderr,
    calls: fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)};
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
    const stale = bootstrap(['--deps-only'], withPytest, 'dune mcp-kit ocaml-quint-connect');
    assert.equal(stale.status, 0, stale.output);
    const removal = stale.calls.findIndex((call) => /pin remove .*ocaml-quint-connect/.test(call));
    const deps = stale.calls.findIndex((call) => call.includes('--deps-only --with-test'));
    assert.ok(removal >= 0 && removal < deps, stale.calls.join('\n'));
    assert.ok(stale.calls.every((call) => !/pin add .*quint/.test(call)), stale.calls.join('\n'));
  });

  test('an unknown option is a usage error', () => {
    const run = bootstrap(['--no-such-mode'], withPytest);
    assert.equal(run.status, 2);
    assert.match(run.output, /usage: bootstrap\.sh \[--print-bin \| --deps-only \| --install-only\]/);
    assert.deepEqual(run.calls, []);
  });
});
