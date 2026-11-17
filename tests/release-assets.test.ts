// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/release-assets.sh, the files of a release, in a scratch git repository: `name` gives the
// built programs their release names, `collect` and `collect-bundle` take from a build job's
// artifact only the files of its own target, and `bundle` adds the code archive, the stamped
// install.sh and SHA256SUMS to the 15 programs and the bundles: the 3 bundles, or the 2 Linux ones when
// the macOS bundle was not qualified, and no other set.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(REPO, 'scripts', 'release-assets.sh');
const BLOCK = "# @release-stamp-begin\nMESH_RELEASE_TAG=''\nMESH_RELEASE_SUMS=''\n# @release-stamp-end\n";
const INSTALLER = `#!/usr/bin/env bash\nset -euo pipefail\n\n${BLOCK}\nprintf '%s|%s\\n' "$MESH_RELEASE_TAG" "$MESH_RELEASE_SUMS"\n`;
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const PROGRAMS = ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-read', 'mesh-platform', 'mesh-history']
  .flatMap((program) => ['linux-x86_64', 'linux-aarch64', 'macos-arm64'].map((target) => `${program}-${target}`));
const BUNDLES = ['mesh-linux-x86_64.tar.gz', 'mesh-linux-arm64.tar.gz', 'mesh-macos-arm64.tar.gz'];

let scratch = '';
before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-')); });
after(() => { fs.rmSync(scratch, {recursive: true, force: true}); });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function repository(name: string): {source: string; dist: string} {
  const source = path.join(scratch, name, 'source');
  fs.mkdirSync(source, {recursive: true});
  fs.writeFileSync(path.join(source, 'install.sh'), INSTALLER);
  fs.writeFileSync(path.join(source, 'server.txt'), 'code\n');
  git(source, 'init', '-q');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'source');
  const dist = path.join(scratch, name, 'dist');
  fs.mkdirSync(dist);
  for (const file of [...PROGRAMS, ...BUNDLES]) fs.writeFileSync(path.join(dist, file), `asset ${file}\n`);
  return {source, dist};
}
const bundle = (source: string, dist: string, tag = 'v1.2.3') =>
  spawnSync('bash', [ASSETS, 'bundle', tag, 'HEAD', dist], {cwd: source, encoding: 'utf8'});

describe('release-assets.sh bundle', () => {
  test('adds the code archive, the stamped installer and SHA256SUMS over every file', () => {
    const {source, dist} = repository('bundle');
    const result = bundle(source, dist);
    assert.equal(result.status, 0, result.stderr);
    const files = fs.readdirSync(dist).sort();
    assert.deepEqual(files, ['SHA256SUMS', 'install.sh', 'session-mesh-v1.2.3.tar.gz', ...PROGRAMS, ...BUNDLES].sort());
    const hash = (file: string) => sha(fs.readFileSync(path.join(dist, file)));
    const listed = fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8');
    assert.deepEqual(listed.trimEnd().split('\n').map((line) => line.split('  ')[1]).sort(), files.filter((file) => file !== 'SHA256SUMS').sort());
    for (const line of listed.trimEnd().split('\n')) assert.equal(line.split('  ')[0], hash(line.split('  ')[1]), line);
    const stamped = spawnSync('bash', [path.join(dist, 'install.sh')], {encoding: 'utf8'}).stdout;
    const [tag, sums] = stamped.split('|');
    assert.equal(tag, 'v1.2.3');
    assert.deepEqual(sums.trimEnd().split('\n').sort(),
      ['session-mesh-v1.2.3.tar.gz', ...PROGRAMS, ...BUNDLES].map((file) => `${hash(file)}  ${file}`).sort());
    const listing = spawnSync('tar', ['-tzf', path.join(dist, 'session-mesh-v1.2.3.tar.gz')], {encoding: 'utf8'}).stdout;
    assert.deepEqual(listing.trim().split('\n').sort(), ['session-mesh-v1.2.3/', 'session-mesh-v1.2.3/install.sh', 'session-mesh-v1.2.3/server.txt']);
  });

  test('without the macOS bundle: the same files less that one, stamped and summed without it', () => {
    const {source, dist} = repository('no-macos-bundle');
    fs.unlinkSync(path.join(dist, 'mesh-macos-arm64.tar.gz'));
    const result = bundle(source, dist);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no mesh-macos-arm64\.tar\.gz: this release is published without it/);
    const linux = BUNDLES.filter((file) => file !== 'mesh-macos-arm64.tar.gz');
    const files = fs.readdirSync(dist).sort();
    assert.deepEqual(files, ['SHA256SUMS', 'install.sh', 'session-mesh-v1.2.3.tar.gz', ...PROGRAMS, ...linux].sort());
    const listed = fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8').trimEnd().split('\n').map((line) => line.split('  ')[1]);
    assert.deepEqual(listed.sort(), files.filter((file) => file !== 'SHA256SUMS'));
    const sums = spawnSync('bash', [path.join(dist, 'install.sh')], {encoding: 'utf8'}).stdout.split('|')[1];
    assert.doesNotMatch(sums, /mesh-macos-arm64\.tar\.gz/);
    assert.equal(sums.trimEnd().split('\n').length, PROGRAMS.length + linux.length + 1);
  });

  test('refuses any other set: a file too many, a program or a Linux bundle missing, and a bad tag', () => {
    const extra = repository('extra');
    fs.writeFileSync(path.join(extra.dist, 'mesh-macos-x86_64.tar.gz'), '');
    assert.equal(bundle(extra.source, extra.dist).status, 1);
    const missingFiles: [string, string[]][] = [['no-program', [PROGRAMS[0]]], ['no-linux-bundle', ['mesh-linux-arm64.tar.gz']],
      ['no-program-no-macos-bundle', [PROGRAMS[0], 'mesh-macos-arm64.tar.gz']],
      ['no-linux-bundle-no-macos-bundle', ['mesh-linux-x86_64.tar.gz', 'mesh-macos-arm64.tar.gz']]];
    for (const [name, files] of missingFiles) {
      const missing = repository(name);
      for (const file of files) fs.unlinkSync(path.join(missing.dist, file));
      const refused = bundle(missing.source, missing.dist);
      assert.equal(refused.status, 1, name);
      assert.match(refused.stderr, /must hold exactly the 15 programs and the 3 bundles .*, or the same without mesh-macos-arm64\.tar\.gz/);
      assert.ok(!fs.existsSync(path.join(missing.dist, 'install.sh')));
    }
    const badTag = repository('bad-tag');
    assert.equal(bundle(badTag.source, badTag.dist, 'v1').status, 1);
    assert.deepEqual(fs.readdirSync(badTag.dist).sort(), [...PROGRAMS, ...BUNDLES].sort());
  });
});

// An artifact directory of `kind` (collect or collect-bundle) for `name`, holding `own` and
// changed by `alter`; the copied files and the result.
function collectRun(command: string, name: string, label: string, own: string[], alter: (artifact: string) => void = () => {}) {
  const artifact = path.join(scratch, command, label, 'artifact');
  const dist = path.join(scratch, command, label, 'dist');
  fs.mkdirSync(artifact, {recursive: true});
  for (const file of own) fs.writeFileSync(path.join(artifact, file), `asset ${file}\n`);
  alter(artifact);
  const result = spawnSync('bash', [ASSETS, command, name, artifact, dist], {encoding: 'utf8'});
  const copied = fs.existsSync(dist) ? fs.readdirSync(dist).sort() : [];
  return {status: result.status, stderr: result.stderr, copied, artifact, dist};
}

const KINDS: [string, string, string[], number, string][] = [
  ['collect', 'linux-aarch64', PROGRAMS.filter((file) => file.endsWith('linux-aarch64')), 0o755, 'mesh-ptyhost-linux-x86_64'],
  ['collect-bundle', 'linux-arm64', ['mesh-linux-arm64.tar.gz'], 0o644, 'mesh-linux-x86_64.tar.gz'],
];
for (const [command, name, own, fileMode, other] of KINDS) {
  describe(`release-assets.sh ${command}`, () => {
    test(`copies exactly the files of ${name}`, () => {
      const result = collectRun(command, name, 'ok', own);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.copied, [...own].sort());
      for (const file of own) assert.equal(fs.statSync(path.join(result.dist, file)).mode & 0o777, fileMode);
    });

    const refusals: [string, (artifact: string) => void][] = [
      ['a file of another target', (artifact) => fs.writeFileSync(path.join(artifact, other), 'x')],
      ['an extra file', (artifact) => fs.writeFileSync(path.join(artifact, 'stray'), 'x')],
      ['a missing file', (artifact) => fs.unlinkSync(path.join(artifact, own[0]))],
      ['a symbolic link in place of a file', (artifact) => {
        fs.unlinkSync(path.join(artifact, own[0]));
        fs.symlinkSync('/etc/passwd', path.join(artifact, own[0]));
      }],
      ['a subdirectory', (artifact) => fs.mkdirSync(path.join(artifact, 'sub', other), {recursive: true})],
    ];
    for (const [label, alter] of refusals) {
      test(`refuses an artifact with ${label}, copying nothing`, () => {
        const result = collectRun(command, name, label.replace(/\W/g, '-'), own, alter);
        assert.equal(result.status, 1, label);
        assert.match(result.stderr, /artifact must hold exactly/);
        assert.deepEqual(result.copied, []);
      });
    }

    test('refuses to overwrite a file already collected, and an unknown target', () => {
      const first = collectRun(command, name, 'twice', own);
      assert.equal(first.status, 0, first.stderr);
      const again = spawnSync('bash', [ASSETS, command, name, first.artifact, first.dist], {encoding: 'utf8'});
      assert.equal(again.status, 1);
      assert.match(again.stderr, /already exists/);
      for (const unknown of ['windows-x86_64', command === 'collect' ? 'linux-arm64' : 'linux-aarch64']) {
        const refused = spawnSync('bash', [ASSETS, command, unknown, first.artifact, first.dist], {encoding: 'utf8'});
        assert.equal(refused.status, 2, unknown);
        assert.match(refused.stderr, /is not one of the/);
      }
    });
  });
}

test('release-assets.sh name copies the four programs under their release names, and refuses an unknown target', () => {
  const out = path.join(scratch, 'name');
  const built = path.join(out, 'built');
  fs.mkdirSync(built, {recursive: true});
  for (const program of ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-read', 'mesh-platform', 'mesh-history']) fs.writeFileSync(path.join(built, program), '', {mode: 0o755});
  assert.equal(spawnSync('bash', [ASSETS, 'name', built, 'linux-aarch64', path.join(out, 'assets')]).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(out, 'assets')).sort(), PROGRAMS.filter((file) => file.endsWith('linux-aarch64')).sort());
  assert.equal(spawnSync('bash', [ASSETS, 'name', built, 'windows-x86_64', path.join(out, 'other')]).status, 2);
});
