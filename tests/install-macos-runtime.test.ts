// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// install.sh on macOS (scripts/install-macos.sh): the runtime directory both launchd jobs receive,
// its checks, and the stale-socket recovery. The fakes are described in tests/install-macos-lib.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {FAKES, PTY, SUPPORT, UID, WEB, changes, defaultRuntime, escape, fixture, install, loaded, plist, staleSocket,
  stateFile} from './install-macos-lib.ts';

describe('install.sh on macOS: the runtime directory and its socket', () => {
  test('a stale socket is looked for in the directory of the installed PTY agent, removed, and the agent loaded', () => {
    const fx = fixture();
    const runtime = path.join(fx.root, 'custom-run');
    fs.mkdirSync(runtime, {mode: 0o700});
    assert.equal(install(fx, [], {MESH_RUNTIME_DIR: runtime}).status, 0);
    fs.rmSync(stateFile(fx, `gui/${UID}`, PTY));
    const socket = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    staleSocket(socket);
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.output, new RegExp(`removed the stale PTY socket ${escape(socket)}`));
    assert.ok(!fs.existsSync(socket));
    assert.ok(loaded(fx, `gui/${UID}`, PTY));
    assert.equal(plist(fx, WEB).EnvironmentVariables.MESH_RUNTIME_DIR, runtime);
  });

  test('the default directory, with its space, round-trips through the plists and the stale-socket check', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    fs.rmSync(stateFile(fx, `gui/${UID}`, PTY));
    const socket = path.join(defaultRuntime(fx), 'session-mesh', 'ptyhost.sock');
    staleSocket(socket);
    const run = install(fx);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.output, new RegExp(`removed the stale PTY socket ${escape(socket)}`));
    assert.ok(!fs.existsSync(socket));
    assert.equal(plist(fx, PTY).EnvironmentVariables.MESH_RUNTIME_DIR, defaultRuntime(fx));
    assert.match(run.stdout, new RegExp(`runtime  : ${escape(defaultRuntime(fx))}$`, 'm'));
  });

  test('something answering on the socket is not removed', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    fs.rmSync(stateFile(fx, `gui/${UID}`, PTY));
    const socket = path.join(defaultRuntime(fx), 'session-mesh', 'ptyhost.sock');
    staleSocket(socket);
    const run = install(fx, [], {FAKE_UNIX_CURL: '0'});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /something answers on .* while the PTY job is not running/);
    assert.ok(fs.existsSync(socket));
  });

  test('a stale socket in a directory that fails the host checks is left alone', () => {
    const fx = fixture();
    const runtime = path.join(fx.root, 'custom-run');
    fs.mkdirSync(runtime, {mode: 0o700});
    assert.equal(install(fx, [], {MESH_RUNTIME_DIR: runtime}).status, 0);
    fs.rmSync(stateFile(fx, `gui/${UID}`, PTY));
    const socket = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    staleSocket(socket);
    fs.chmodSync(runtime, 0o777);
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /writable by group or others/);
    assert.ok(fs.existsSync(socket));
    assert.doesNotMatch(run.calls, changes);
  });

  test('without curl a leftover socket is refused, not removed', () => {
    const {curl: _curl, ...noCurl} = FAKES;
    const fx = fixture({fakes: noCurl});
    const socket = path.join(defaultRuntime(fx), 'session-mesh', 'ptyhost.sock');
    staleSocket(socket);
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /the PTY socket .* exists while the PTY job is not running/);
    assert.ok(fs.existsSync(socket));
  });

  test('without MESH_RUNTIME_DIR, XDG_RUNTIME_DIR names the directory, as for the hosts and clients', () => {
    const fx = fixture();
    const xdg = path.join(fx.root, 'xdg-run');
    fs.mkdirSync(xdg, {mode: 0o700});
    const run = install(fx, [], {XDG_RUNTIME_DIR: xdg});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(plist(fx, PTY).EnvironmentVariables.MESH_RUNTIME_DIR, xdg);
    assert.equal(plist(fx, WEB).EnvironmentVariables.MESH_RUNTIME_DIR, xdg);
    assert.ok(!fs.existsSync(path.join(fx.home, SUPPORT, 'session-mesh')));
  });

  test('MESH_RUNTIME_DIR comes before XDG_RUNTIME_DIR, and an empty one counts as unset', () => {
    const fx = fixture();
    const [mesh, xdg] = ['mesh-run', 'xdg-run'].map((name) => path.join(fx.root, name));
    for (const dir of [mesh, xdg]) fs.mkdirSync(dir, {mode: 0o700});
    assert.equal(install(fx, [], {MESH_RUNTIME_DIR: mesh, XDG_RUNTIME_DIR: xdg}).status, 0);
    assert.equal(plist(fx, PTY).EnvironmentVariables.MESH_RUNTIME_DIR, mesh);
    const empty = fixture();
    const emptyXdg = path.join(empty.root, 'xdg-run');
    fs.mkdirSync(emptyXdg, {mode: 0o700});
    assert.equal(install(empty, [], {MESH_RUNTIME_DIR: '', XDG_RUNTIME_DIR: emptyXdg}).status, 0);
    assert.equal(plist(empty, PTY).EnvironmentVariables.MESH_RUNTIME_DIR, emptyXdg);
    const neither = fixture();
    assert.equal(install(neither, [], {MESH_RUNTIME_DIR: '', XDG_RUNTIME_DIR: ''}).status, 0);
    assert.equal(plist(neither, PTY).EnvironmentVariables.MESH_RUNTIME_DIR, defaultRuntime(neither));
  });

  test('the installed PTY agent\'s directory comes before XDG_RUNTIME_DIR on a rerun', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    const xdg = path.join(fx.root, 'xdg-run');
    fs.mkdirSync(xdg, {mode: 0o700});
    const run = install(fx, [], {XDG_RUNTIME_DIR: xdg});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(plist(fx, WEB).EnvironmentVariables.MESH_RUNTIME_DIR, defaultRuntime(fx));
  });

  test('another MESH_RUNTIME_DIR than the installed PTY agent\'s is refused', () => {
    const fx = fixture();
    assert.equal(install(fx).status, 0);
    const run = install(fx, [], {MESH_RUNTIME_DIR: path.join(fx.root, 'elsewhere')});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /the installed PTY host uses MESH_RUNTIME_DIR=/);
    assert.doesNotMatch(run.calls, changes);
  });

  test('a runtime directory writable by others is refused as the native host would', () => {
    const fx = fixture();
    const runtime = path.join(fx.root, 'open-run');
    fs.mkdirSync(runtime);
    fs.chmodSync(runtime, 0o777);
    const run = install(fx, [], {MESH_RUNTIME_DIR: runtime});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /writable by group or others/);
    assert.doesNotMatch(run.calls, changes);
  });

  test('a socket path over 103 bytes is refused before any change, with the variable to set', () => {
    const fx = fixture();
    const long = path.join(fx.root, 'r'.repeat(100 - fx.root.length));
    const run = install(fx, [], {MESH_RUNTIME_DIR: long});
    assert.equal(run.status, 1);
    assert.match(run.stderr, /over macOS's 103-byte limit: set MESH_RUNTIME_DIR to a shorter private directory/);
    assert.ok(!fs.existsSync(long));
    const longHome = fixture({homeName: 'h'.repeat(40)});
    const second = install(longHome);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /Application Support\/session-mesh\/run\/session-mesh\/ptyhost\.sock is \d+ bytes, over macOS's 103-byte limit/);
    assert.ok(!fs.existsSync(path.join(longHome.home, SUPPORT, 'session-mesh')));
    assert.doesNotMatch(second.calls, changes);
  });

  test('a symbolic link in place of the default directory is refused', () => {
    const fx = fixture();
    const elsewhere = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(elsewhere, {mode: 0o700});
    fs.symlinkSync(elsewhere, path.join(fx.home, SUPPORT, 'session-mesh'));
    const run = install(fx);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /session-mesh is not a directory \(a symbolic link is refused\)/);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'run')));
  });
});
