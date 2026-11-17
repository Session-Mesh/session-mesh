// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// How a PTY host starts, and what it does when it cannot serve:
// - an empty XDG_RUNTIME_DIR counts as unset, never as a socket path relative to the cwd;
// - a regular file at the socket path is not the host's to delete: it refuses to start;
// - the host refuses a missing (or otherwise unusable) runtime directory with one line and
//   status 1;
// - the Python client resolves an empty XDG_RUNTIME_DIR as unset too.
// Host under test: see ptyhost-command.ts. Every host runs in its own scratch runtime directory.
// (Running out of descriptors is tested in ocaml/test/ptyhost_robustness_test.ml.)
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {ptyhostArgv} from './ptyhost-command.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const HOST_ARGV = ptyhostArgv();

const scratches: string[] = [];
after(() => {
  for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true});
});

function scratch(): {root: string; runtime: string; socketPath: string; env: NodeJS.ProcessEnv} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-start-'));
  scratches.push(root);
  const runtime = path.join(root, 'run');
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(runtime, {mode: 0o700});
  const env = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(root, 'home'), XDG_RUNTIME_DIR: runtime,
    SHELL: '/bin/sh', LANG: 'C'};
  return {root, runtime, socketPath: path.join(runtime, 'session-mesh', 'ptyhost.sock'), env};
}

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(argv[0], argv.slice(1), {env, cwd, encoding: 'utf8', timeout: 15000});
}

describe('PTY host start-up', () => {
  test('a regular file at the socket path is refused and kept', () => {
    const where = scratch();
    fs.mkdirSync(path.dirname(where.socketPath), {mode: 0o700});
    fs.writeFileSync(where.socketPath, 'not a socket');
    const result = run(HOST_ARGV, where.env, where.root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /not starting: socket target exists and is not a socket/);
    assert.doesNotMatch(result.stderr, /Traceback|Fatal error|exception/i);
    assert.equal(fs.readFileSync(where.socketPath, 'utf8'), 'not a socket');
  });

  test('an empty XDG_RUNTIME_DIR counts as unset (the Python client)', () => {
    const where = scratch();
    // The module only, not the host: the default runtime directory is the account's real one.
    const probe = run([PYTHON, '-c', 'import ptyhost; print(ptyhost.SOCK)'], {...where.env, XDG_RUNTIME_DIR: ''}, REPO);
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), `/run/user/${process.getuid!()}/session-mesh/ptyhost.sock`);
  });

  test('a missing runtime directory: one line and status 1', () => {
    const where = scratch();
    const result = run(HOST_ARGV, {...where.env, XDG_RUNTIME_DIR: path.join(where.root, 'absent')}, where.root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /not starting: unusable runtime directory: XDG_RUNTIME_DIR: cannot inspect ".*absent": No such file/);
    assert.doesNotMatch(result.stderr, /Fatal error|exception|Failure/);
  });
});
