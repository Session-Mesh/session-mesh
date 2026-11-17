// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The system mounts of the demo compiler's bubblewrap sandbox (scripts/compile-demo-tsx.sh) must be valid on
// hosts without /lib64 (Ubuntu aarch64: the loader is /lib/ld-linux-aarch64.so.1) and unchanged where it exists.
// The mount arguments are read from the launcher itself and run through the real /usr/bin/bwrap, with the
// /lib64 source replaced by a path that is absent, a real directory, or a symlink (merged /usr layout).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';

const LAUNCHER = path.resolve(import.meta.dirname, '..', 'scripts', 'compile-demo-tsx.sh');
const BWRAP = '/usr/bin/bwrap';
const usable = process.platform === 'linux' && fs.existsSync(BWRAP);
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

// The tokens of the launcher's line that binds /usr, /lib and /lib64 (the x86_64-only one must be optional).
function systemMountTokens(): string[] {
  const line = fs.readFileSync(LAUNCHER, 'utf8').split('\n').find((text) => text.includes('--ro-bind /usr /usr'));
  assert.ok(line, 'launcher no longer binds /usr');
  return line.replace(/\\$/, '').trim().split(/\s+/);
}

// Runs /usr/bin/true in the sandbox built from the launcher's mounts, with `lib64Source` as the /lib64 source.
function runWith(lib64Source: string) {
  const tokens = systemMountTokens().map((token) => (token === '/lib64' ? lib64Source : token));
  // Only the source (the token after the option) is substituted; the destination stays /lib64.
  const at = tokens.findIndex((token) => token === lib64Source);
  tokens[at + 1] = '/lib64';
  return spawnSync(BWRAP, ['--unshare-all', ...tokens, '--', '/usr/bin/true'], {encoding: 'utf8'});
}

describe('compile-demo-tsx.sh system mounts', () => {
  test('/lib64 is bound with --ro-bind-try, never --ro-bind', () => {
    const tokens = systemMountTokens();
    const at = tokens.indexOf('/lib64');
    assert.ok(at > 0);
    assert.equal(tokens[at - 1], '--ro-bind-try');
    assert.deepEqual(tokens.slice(at - 1, at + 2), ['--ro-bind-try', '/lib64', '/lib64']);
    assert.deepEqual(tokens.slice(0, 6), ['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib']);
    assert.equal(tokens.filter((token) => token === '--bind' || token === '--bind-try').length, 0);
  });

  test('the address-space limit is 1 GiB except on aarch64 (2 GiB), and always bounded', () => {
    const text = fs.readFileSync(LAUNCHER, 'utf8');
    assert.match(text, /--as="\$address_space" --cpu=4/);
    assert.match(text, /aarch64\|arm64\) address_space=2147483648 ;;/);
    assert.match(text, /\*\) address_space=1073741824 ;;/);
    assert.equal((text.match(/address_space=/g) ?? []).length, 2);
    // The other bounds are untouched on every architecture.
    assert.match(text, /--cpu=4 --nofile=64 --core=0/);
    assert.match(text, /--max-old-space-size=128/);
  });

  test('the argument list is valid when /lib64 is absent', {skip: !usable}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-nolib64-'));
    dirs.push(root);
    const done = runWith(path.join(root, 'lib64'));
    // bwrap sets up every mount, then execs. On an x86_64 host the exec may fail (no loader without /lib64):
    // that is not a mount error. On a host without /lib64 (aarch64) the whole run must succeed.
    assert.doesNotMatch(done.stderr, /Can.t find source path/);
    if (!fs.existsSync('/lib64')) assert.equal(done.status, 0, done.stderr);
  });

  test('a real /lib64 and a symlink to it (merged /usr) are still mounted', {skip: !usable || !fs.existsSync('/lib64')}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-lib64-'));
    dirs.push(root);
    fs.symlinkSync(fs.realpathSync('/lib64'), path.join(root, 'lib64'));
    for (const source of [fs.realpathSync('/lib64'), path.join(root, 'lib64')]) {
      const done = runWith(source);
      assert.equal(done.status, 0, `${source}: ${done.stderr}`);
    }
  });
});
