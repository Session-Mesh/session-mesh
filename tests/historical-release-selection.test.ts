// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {selectHistoricalReleases, type Release} from '../tools/historical-release-selection.ts';
import {verifyAsset} from '../tools/fetch-historical-releases.ts';

const digest = `sha256:${'a'.repeat(64)}`;
function release(tag_name: string, prerelease = false): Release {
  return {tag_name, prerelease, draft: false, assets: [
    {name: `session-mesh-${tag_name}.tar.gz`, digest, size: 100},
    {name: 'mesh-ptyhost-linux-x86_64', digest, size: 100},
    {name: 'mesh-platform-linux-x86_64', digest, size: 100},
  ]};
}

test('selects latest stable and latest nightly independent of API order', () => {
  const releases = [release('v0.1.9'), release('v0.2.0-nightly.20261124', true), release('v0.1.10'),
    release('v0.2.0-nightly.20261125', true), {...release('v1.0.0'), draft: true}];
  const selected = selectHistoricalReleases(releases);
  assert.equal(selected.stable.tag, 'v0.1.10');
  assert.equal(selected.nightly.tag, 'v0.2.0-nightly.20261125');
});

test('does not silently fall back when the latest release has incomplete or unsafe artifacts', () => {
  const nightly = release('v0.2.0-nightly.20261125', true);
  const bad = release('v0.1.10'); bad.assets[1]!.digest = null;
  assert.throws(() => selectHistoricalReleases([release('v0.1.9'), bad, nightly]), /invalid digest/);
  bad.assets[1]!.digest = digest; bad.assets.push({...bad.assets[1]!});
  assert.throws(() => selectHistoricalReleases([bad, nightly]), /duplicate/);
  bad.assets.pop(); bad.assets[0]!.size = 200_000_001;
  assert.throws(() => selectHistoricalReleases([bad, nightly]), /invalid digest or size/);
});

test('requires published stable and nightly releases', () => {
  assert.throws(() => selectHistoricalReleases([release('v0.1.1')]), /both a stable release and a nightly/);
  assert.throws(() => selectHistoricalReleases([release('v0.2.0-nightly.20261125', true)]), /both a stable release and a nightly/);
});

test('download verification rejects changed or truncated artifacts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mesh-historical-digest-'));
  try {
    const file = path.join(dir, 'artifact'); writeFileSync(file, 'release');
    const item = {name: 'artifact', size: 7, digest: `sha256:${createHash('sha256').update('release').digest('hex')}`};
    assert.doesNotThrow(() => verifyAsset(file, item));
    writeFileSync(file, 'changed');
    assert.throws(() => verifyAsset(file, item), /wrong digest/);
    writeFileSync(file, 'short');
    assert.throws(() => verifyAsset(file, item), /wrong size/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
