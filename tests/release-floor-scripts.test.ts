// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The floors of the prebuilt files and the scripts that hold the release to them, run on any Linux
// machine:
// - scripts/release-floor.sh reads BUNDLE_GLIBC_FLOOR, BUNDLE_MACOS_FLOOR and PROGRAMS_MACOS_FLOOR
//   from install.sh, the one place they are written;
// - scripts/release-check-glibc.sh refuses a Linux bundle with an ELF file that needs a newer glibc
//   than the floor (a stand-in objdump reads the versions each stand-in ELF file names).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const script = (name: string) => path.join(REPO, 'scripts', name);
let scratch = '';
before(() => { scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-floors-'))); });
after(() => { fs.rmSync(scratch, {recursive: true, force: true}); });

describe('release-floor.sh', () => {
  test('prints each floor as install.sh defines it', () => {
    const installer = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
    for (const [name, variable] of [['glibc', 'BUNDLE_GLIBC_FLOOR'], ['macos-bundle', 'BUNDLE_MACOS_FLOOR'], ['macos-programs', 'PROGRAMS_MACOS_FLOOR']]) {
      const result = spawnSync('bash', [script('release-floor.sh'), name], {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${new RegExp(`^${variable}=(.*)$`, 'm').exec(installer)?.[1]}\n`, name);
    }
    assert.deepEqual(['glibc', 'macos-bundle', 'macos-programs'].map((name) => spawnSync('bash', [script('release-floor.sh'), name], {encoding: 'utf8'}).stdout.trim()),
      ['2.28', '13.5', '13.0']);
  });

  test('refuses an unknown floor, and an install.sh that defines one twice or not at all', () => {
    assert.equal(spawnSync('bash', [script('release-floor.sh'), 'windows']).status, 2);
    for (const [label, text] of [['twice', 'BUNDLE_GLIBC_FLOOR=2.28\nBUNDLE_GLIBC_FLOOR=2.17\n'], ['not at all', 'BUNDLE_GLIBC_FLOOR=\n']]) {
      const copy = path.join(scratch, `floor-${label.replace(' ', '-')}`);
      fs.mkdirSync(path.join(copy, 'scripts'), {recursive: true});
      fs.copyFileSync(script('release-floor.sh'), path.join(copy, 'scripts/release-floor.sh'));
      fs.writeFileSync(path.join(copy, 'install.sh'), text);
      const result = spawnSync('bash', [path.join(copy, 'scripts/release-floor.sh'), 'glibc'], {encoding: 'utf8'});
      assert.equal(result.status, 1, label);
      assert.match(result.stderr, /install\.sh must define BUNDLE_GLIBC_FLOOR=<major>\.<minor> exactly once/);
    }
  });
});

// A bundle archive whose files are stand-in ELF files: each names the GLIBC_ versions its
// stand-in objdump -T reports ('static' reports a static executable); other files are not ELF.
function checkGlibc(label: string, files: Record<string, string>) {
  const dir = path.join(scratch, `glibc-${label}`);
  const [fakes, tree] = [path.join(dir, 'fakes'), path.join(dir, 'tree', 'mesh-linux-x86_64')];
  fs.mkdirSync(fakes, {recursive: true});
  for (const [name, versions] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tree, name)), {recursive: true});
    fs.writeFileSync(path.join(tree, name), versions === 'text' ? 'not an executable' : `\x7fELF ${versions}`);
  }
  spawnSync('tar', ['-czf', path.join(dir, 'bundle.tar.gz'), '-C', path.join(dir, 'tree'), 'mesh-linux-x86_64']);
  fs.writeFileSync(path.join(fakes, 'objdump'), `#!/bin/bash
[[ $1 == -T && $2 == -- ]] || exit 97
content=$(cat -- "$3"); content=\${content#?ELF }
[[ $content == static ]] && { echo "objdump: $3: not a dynamic object" >&2; exit 1; }
[[ $content == unreadable ]] && { echo "objdump: $3: file format not recognized" >&2; exit 1; }
for version in $content; do printf '0000000000000000      DF *UND*  0000000000000000 (GLIBC_%s) memcpy\\n' "$version"; done
`, {mode: 0o755});
  return spawnSync('bash', [script('release-check-glibc.sh'), path.join(dir, 'bundle.tar.gz')],
    {encoding: 'utf8', env: {...process.env, PATH: `${fakes}:${process.env.PATH}`}});
}

describe('release-check-glibc.sh', () => {
  test('passes a bundle whose newest required glibc is the floor, and prints each file\'s', () => {
    const result = checkGlibc('ok', {'libexec/mesh-ptyhost': '2.2.5 2.28 2.17', 'runtime/python/bin/python3.12': '2.2.5',
      'app/demo-compiler/esbuild': 'static', 'app/server.py': 'text'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^2\.28 +mesh-linux-x86_64\/libexec\/mesh-ptyhost$/m);
    assert.match(result.stdout, /^none +mesh-linux-x86_64\/app\/demo-compiler\/esbuild$/m);
    assert.doesNotMatch(result.stdout, /server\.py/);
    assert.match(result.stdout, /3 ELF files; the newest glibc symbol version required is GLIBC_2\.28; the floor is 2\.28$/m);
  });

  test('refuses a file that needs a newer glibc (compared as versions, not as text), and an unreadable file', () => {
    const newer = checkGlibc('newer', {'bin/mesh-read': '2.2.5 2.34', 'runtime/node/bin/node': '2.28'});
    assert.equal(newer.status, 1);
    assert.match(newer.stderr, /mesh-linux-x86_64\/bin\/mesh-read requires GLIBC_2\.34, newer than the floor 2\.28/);
    assert.match(newer.stdout, /the newest glibc symbol version required is GLIBC_2\.34/);
    const unreadable = checkGlibc('unreadable', {'bin/mesh-read': 'unreadable'});
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /objdump cannot read mesh-linux-x86_64\/bin\/mesh-read/);
    const none = checkGlibc('none', {'app/server.py': 'text'});
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no ELF file in/);
  });
});
