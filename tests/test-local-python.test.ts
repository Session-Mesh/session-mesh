// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// select_python of scripts/test-local-python.sh (sourced by scripts/test-local.sh), run by bash in a
// scratch directory with a stand-in python3 on PATH: the version it reports, a `-m venv` and a
// `-m pip` that succeed or fail on demand, and a log of its calls. Nothing is installed.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'test-local-python.sh');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'test-local-python-'));
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

// The stand-in: FAKE_VERSION (FAKE_VENV_VERSION for the .venv copy), FAKE_VENV_STATUS (venv fails
// after writing bin/python, as a venv broken half-way), FAKE_PIP_STATUS; every call goes to FAKE_LOG.
const STAND_IN = `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >> "$FAKE_LOG"
case "$1" in
  -c) case "$0" in *.venv/bin/python) printf '%s\\n' "\${FAKE_VENV_VERSION:-$FAKE_VERSION}" ;; *) printf '%s\\n' "$FAKE_VERSION" ;; esac ;;
  -m) case "$2" in
        venv) mkdir -p "$3/bin" && cp "$0" "$3/bin/python" && chmod +x "$3/bin/python"; exit "\${FAKE_VENV_STATUS:-0}" ;;
        pip) exit "\${FAKE_PIP_STATUS:-0}" ;;
      esac ;;
esac
`;
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'python3'), STAND_IN, {mode: 0o755});

type Run = {status: number | null; stdout: string; stderr: string; dir: string; calls: string[]};
let counter = 0;

/** select_python in a fresh directory, after `prepare(dir)`; preflight: --preflight-only. */
function run(env: Record<string, string>, {preflight = false, prepare}: {preflight?: boolean; prepare?: (dir: string) => void} = {}): Run {
  const dir = path.join(scratch, `case-${counter++}`);
  fs.mkdirSync(dir);
  prepare?.(dir);
  const log = path.join(dir, 'calls.log');
  const result = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; preflight_only=$2; select_python; echo "PY=$PY"',
    '_', SCRIPT, preflight ? '1' : '0'], {
    cwd: dir, encoding: 'utf8',
    env: {PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: log, ...env},
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => line.replace(dir, '<dir>')) : [];
  return {status: result.status, stdout: result.stdout, stderr: result.stderr, dir, calls};
}
const exists = (dir: string, relative: string) => fs.existsSync(path.join(dir, relative));
const pipCalls = (r: Run) => r.calls.filter(call => call.includes(' -m pip install'));

/** A .venv as an earlier run or a person left it: bin/python (the stand-in), with or without the marker. */
function venv(dir: string, {marker = false} = {}): void {
  fs.mkdirSync(path.join(dir, '.venv', 'bin'), {recursive: true});
  fs.copyFileSync(path.join(bin, 'python3'), path.join(dir, '.venv', 'bin', 'python'));
  fs.chmodSync(path.join(dir, '.venv', 'bin', 'python'), 0o755);
  if (marker) fs.writeFileSync(path.join(dir, '.venv', '.test-local-installed'), '');
}

describe('the python3 that creates .venv', () => {
  for (const version of ['3.9', '3.15', '3.100', '2.7', 'x.y']) {
    test(`Python ${version} is refused before anything is created`, () => {
      const r = run({FAKE_VERSION: version});
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /the pinned test packages install on Python 3\.10 to 3\.14/);
      assert.match(r.stderr, /python3\.14 -m venv \.venv/);
      assert.ok(!exists(r.dir, '.venv'));
    });
  }

  for (const version of ['3.10', '3.12', '3.14']) {
    test(`Python ${version} creates .venv, installs the packages and marks it ready`, () => {
      const r = run({FAKE_VERSION: version});
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PY=.*\/\.venv\/bin\/python$/m);
      assert.ok(exists(r.dir, '.venv/.test-local-installed'));
      assert.equal(pipCalls(r).length, 1);
    });
  }
});

describe('a failure while creating .venv', () => {
  test('a failed package install removes the .venv this run made', () => {
    const r = run({FAKE_VERSION: '3.12', FAKE_PIP_STATUS: '1'});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\.venv was removed/);
    assert.ok(!exists(r.dir, '.venv'));
  });

  test('a venv that fails after writing bin/python is removed too, and pip never runs', () => {
    const r = run({FAKE_VERSION: '3.12', FAKE_VENV_STATUS: '1'});
    assert.equal(r.status, 1);
    assert.ok(!exists(r.dir, '.venv'));
    assert.deepEqual(pipCalls(r), []);
  });
});

describe('a .venv already there', () => {
  test('with the marker it is used as it is: no version check, no install', () => {
    const r = run({FAKE_VERSION: '3.15'}, {prepare: dir => venv(dir, {marker: true})});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, []);
  });

  test('without the marker (an install that did not finish, or one made by hand) it is completed', () => {
    const r = run({FAKE_VERSION: '3.15', FAKE_VENV_VERSION: '3.14'}, {prepare: dir => venv(dir)});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pipCalls(r).length, 1);
    assert.ok(exists(r.dir, '.venv/.test-local-installed'));
  });

  test('without the marker and with an unsupported Python it is refused, and kept', () => {
    const r = run({FAKE_VERSION: '3.12', FAKE_VENV_VERSION: '3.15'}, {prepare: dir => venv(dir)});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /move \.venv aside/);
    assert.ok(exists(r.dir, '.venv/bin/python'));
    assert.deepEqual(pipCalls(r), []);
  });

  test('a failed completion keeps the .venv, which this run did not make, and leaves it unmarked', () => {
    const r = run({FAKE_VERSION: '3.12', FAKE_PIP_STATUS: '1'}, {prepare: dir => venv(dir)});
    assert.equal(r.status, 1);
    assert.ok(exists(r.dir, '.venv/bin/python'));
    assert.ok(!exists(r.dir, '.venv/.test-local-installed'));
  });

  test('without bin/python it is refused, in a full run and in a preflight alike', () => {
    for (const preflight of [false, true]) {
      const r = run({FAKE_VERSION: '3.12'}, {preflight, prepare: dir => fs.mkdirSync(path.join(dir, '.venv'))});
      assert.equal(r.status, 1, `preflight=${preflight}`);
      assert.match(r.stderr, /\.venv exists but has no bin\/python/);
      assert.ok(exists(r.dir, '.venv'));
    }
  });
});

describe('a preflight changes nothing', () => {
  test('without .venv it checks python3 and creates nothing', () => {
    const ok = run({FAKE_VERSION: '3.12'}, {preflight: true});
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /\.venv absent/);
    assert.ok(!exists(ok.dir, '.venv'));
    assert.equal(run({FAKE_VERSION: '3.15'}, {preflight: true}).status, 1);
  });

  test('with an unfinished .venv it checks its Python and installs nothing', () => {
    const r = run({FAKE_VERSION: '3.12'}, {preflight: true, prepare: dir => venv(dir)});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\.venv incomplete/);
    assert.deepEqual(pipCalls(r), []);
    assert.ok(!exists(r.dir, '.venv/.test-local-installed'));
  });
});

test('MESH_PYTHON is used as it is: no .venv, no version check', () => {
  const r = run({MESH_PYTHON: path.join(bin, 'python3'), FAKE_VERSION: '3.15'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`PY=${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/python3$`, 'm'));
  assert.ok(!exists(r.dir, '.venv'));
  assert.deepEqual(r.calls, []);
});
