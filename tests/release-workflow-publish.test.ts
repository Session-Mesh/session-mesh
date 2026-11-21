// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The publish job of the release workflow (.github/workflows/release.yml), its scripts run: the
// file check accepts exactly the release with the macOS bundle and the release without it, and
// the release notes take the floors from install.sh (through the package job) and say whether the
// macOS bundle is there. The rest of the workflow is checked in tests/release-workflow.test.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';
import {jobBlocks, parseLines, scriptOf} from './public-ci-workflow-lib.ts';
import {RELEASE_WRITE_JOB} from './release-workflow-checks.ts';

const RELEASE = path.join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml');

describe('the publish job of release.yml', () => {
  const lines = parseLines(fs.readFileSync(RELEASE, 'utf8'));
  const job = (name: string) => jobBlocks(lines).find((item) => item.name === name)?.block ?? [];
  const publishStep = () => lines.findIndex((line) => line.raw.includes('gh release create'));

  test('the publish job accepts exactly the two sets of files, with or without the macOS bundle', () => {
    const index = lines.findIndex((line) => job(RELEASE_WRITE_JOB).includes(line) && line.raw.includes('expected=(install.sh'));
    const script = scriptOf(lines, index);
    const PROGRAMS = ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-read', 'mesh-platform', 'mesh-history', 'mesh-logout-all', 'mesh-profile', 'work-read', 'work-mcp', 'work-write']
      .flatMap((program) => ['linux-x86_64', 'linux-aarch64', 'macos-arm64'].map((target) => `${program}-${target}`));
    const full = ['install.sh', 'SHA256SUMS', 'session-mesh-v1.0.0.tar.gz', 'mesh-linux-x86_64.tar.gz', 'mesh-linux-arm64.tar.gz',
      'mesh-macos-arm64.tar.gz', ...PROGRAMS];
    const check = (files: string[], tamper = '', unlisted = '') => {
      const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'release-publish-'));
      try {
        fs.mkdirSync(path.join(dir, 'dist'));
        for (const file of files) fs.writeFileSync(path.join(dir, 'dist', file), '');
        const hash = createHash('sha256').update('').digest('hex');
        fs.writeFileSync(path.join(dir, 'dist/SHA256SUMS'), files.filter((file) => file !== 'SHA256SUMS' && file !== unlisted)
          .map((file) => `${hash}  ${file}\n`).join(''));
        if (tamper) fs.writeFileSync(path.join(dir, 'dist', tamper), 'modified');
        return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {cwd: dir, encoding: 'utf8',
          env: {...process.env, RELEASE_TAG: 'v1.0.0', GLIBC_FLOOR: '2.28', MACOS_BUNDLE_FLOOR: '13.5', MACOS_PROGRAMS_FLOOR: '13.0'}}).status;
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    };
    assert.equal(check(full), 0, 'with the macOS bundle');
    assert.equal(check(full.filter((file) => file !== 'mesh-macos-arm64.tar.gz')), 0, 'without the macOS bundle');
    assert.notEqual(check(full.filter((file) => file !== 'mesh-linux-arm64.tar.gz')), 0, 'without a Linux bundle');
    assert.notEqual(check(full.filter((file) => file !== PROGRAMS[0])), 0, 'without a program');
    assert.notEqual(check([...full, 'mesh-macos-x86_64.tar.gz']), 0, 'with an extra file');
    assert.notEqual(check(full.filter((file) => file !== 'mesh-macos-arm64.tar.gz' && file !== PROGRAMS[0])), 0, 'without the macOS bundle and a program');
    for (const target of ['linux-x86_64', 'linux-aarch64', 'macos-arm64']) {
      assert.notEqual(check(full.filter((file) => file !== `mesh-profile-${target}`)), 0, `without mesh-profile for ${target}`);
      assert.notEqual(check(full, `mesh-profile-${target}`), 0, `tampered mesh-profile for ${target}`);
      assert.notEqual(check(full, '', `mesh-profile-${target}`), 0, `mesh-profile missing from SHA256SUMS for ${target}`);
    }
  });

  test('the release notes give the floors of install.sh and say whether the macOS bundle is there', () => {
    const notes = scriptOf(lines, publishStep());
    assert.match(notes, /if \[ -e dist\/mesh-macos-arm64\.tar\.gz \]; then/);
    assert.match(notes, /macos="The macOS bundle is part of this release\."/);
    assert.match(notes, /macos="This release has no macOS bundle \(its build did not pass\): on a Mac, install\.sh installs the macOS native programs/);
    assert.match(notes, /glibc \$GLIBC_FLOOR or newer/);
    assert.match(notes, /macOS \$MACOS_BUNDLE_FLOOR or newer/);
    assert.match(notes, /macOS \$MACOS_PROGRAMS_FLOOR or newer/);
    for (const [name, output] of [['GLIBC_FLOOR', 'glibc-floor'], ['MACOS_BUNDLE_FLOOR', 'macos-bundle-floor'], ['MACOS_PROGRAMS_FLOOR', 'macos-programs-floor']]) {
      assert.equal(job(RELEASE_WRITE_JOB).find((line) => line.key === name)?.value, `\${{ needs.package.outputs.${output} }}`, name);
    }
    assert.doesNotMatch(notes, /2\.35|2\.28|13\.5/, 'no floor is written in the notes');
  });
});
