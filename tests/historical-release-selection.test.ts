// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {selectHistoricalReleases, type Release} from '../tools/historical-release-selection.ts';
import {verifyAsset} from '../tools/fetch-historical-releases.ts';
import {historicalArtifacts} from './helpers/historical-artifacts.ts';

const digest = `sha256:${'a'.repeat(64)}`;
function release(tag_name: string, prerelease = false): Release {
  return {tag_name, prerelease, draft: false, assets: [
    {name: `session-mesh-${tag_name}.tar.gz`, digest, size: 100},
    {name: 'mesh-ptyhost-linux-x86_64', digest, size: 100},
    {name: 'mesh-platform-linux-x86_64', digest, size: 100},
    {name: 'mesh-history-linux-x86_64', digest, size: 100},
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
  bad.assets.pop();
  const withoutHistory = release('v0.1.10'); withoutHistory.assets.pop();
  assert.throws(() => selectHistoricalReleases([withoutHistory, nightly]), /missing or duplicate mesh-history/);
  bad.assets[0]!.size = 200_000_001;
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

test('dynamic manifest confines paths and rejects invalid digests', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mesh-historical-manifest-'));
  const previous = process.env.MESH_HISTORICAL_DYNAMIC;
  const entry = (role:string, tag:string) => ({tag, archive:`${role}/session-mesh-${tag}.tar.gz`,
    host:`${role}/mesh-ptyhost-linux-x86_64`, platform:`${role}/mesh-platform-linux-x86_64`,
    archiveSha:'a'.repeat(64), hostSha:'b'.repeat(64), platformSha:'c'.repeat(64), history:`${role}/mesh-history-linux-x86_64`, historySha:'d'.repeat(64)});
  const manifest = {version:1, stable:entry('stable', 'v0.1.1'), nightly:entry('nightly', 'v0.2.0-nightly.20261125')};
  const write = () => writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  try {
    process.env.MESH_HISTORICAL_DYNAMIC = '1'; write();
    assert.equal(historicalArtifacts(dir).stable.tag, 'v0.1.1');
    manifest.stable.host = '../outside'; write();
    assert.throws(() => historicalArtifacts(dir));
    manifest.stable.host = 'stable/mesh-ptyhost-linux-x86_64'; manifest.nightly.hostSha = 'bad'; write();
    assert.throws(() => historicalArtifacts(dir));
  } finally {
    if (previous === undefined) delete process.env.MESH_HISTORICAL_DYNAMIC;
    else process.env.MESH_HISTORICAL_DYNAMIC = previous;
    rmSync(dir, {recursive:true, force:true});
  }
});

test('release metadata authorization is confined to curl stdin', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mesh-release-metadata-'));
  try {
    const token = 'fixture_token';
    const program = path.join(dir, 'curl');
    const log = path.join(dir, 'calls.jsonl');
    const payload = 'verified artifact';
    const validDigest = 'sha256:' + createHash('sha256').update(payload).digest('hex');
    const releases = [release('v0.1.2'), release('v0.2.0-nightly.20261127', true)];
    for (const row of releases) for (const asset of row.assets) {
      asset.digest = validDigest;
      asset.size = payload.length;
    }
    writeFileSync(program, '#!/usr/bin/env node\n' + `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const listing = args.at(-1).startsWith('https://api.github.com/');
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, listing,
        input: listing ? fs.readFileSync(0, 'utf8') : null,
        inherited: process.env.MESH_RELEASE_METADATA_TOKEN ?? null}) + '\\n');
      if (listing) process.stdout.write(${JSON.stringify(JSON.stringify(releases))});
      else fs.writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(payload)});
      `, {mode: 0o700});
    const cli = new URL('../tools/fetch-historical-releases.ts', import.meta.url);
    const run = spawnSync(process.execPath, ['--experimental-strip-types', decodeURIComponent(cli.pathname), path.join(dir, 'assets')], {
      env: {...process.env, PATH: dir + path.delimiter + process.env.PATH, MESH_RELEASE_METADATA_TOKEN: token},
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const [metadata, ...downloads] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(metadata.input, 'header = "Authorization: Bearer ' + token + '"\n');
    assert.ok(!metadata.args.includes('--location'));
    assert.equal(downloads.length, 8);
    for (const call of [metadata, ...downloads]) {
      assert.equal(call.inherited, null);
      assert.ok(call.args.every((arg: string) => !arg.includes(token)));
    }
    assert.ok(downloads.every(call => call.input === null && !call.args.includes('--config')));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
