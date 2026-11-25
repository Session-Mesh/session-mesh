// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectHistoricalReleases, type Release, type ReleaseAsset, type SelectedRelease} from './historical-release-selection.ts';

const repository = 'Session-Mesh/session-mesh';
export function verifyAsset(file: string, asset: ReleaseAsset): void {
  if (statSync(file).size !== asset.size) throw new Error(`wrong size for ${asset.name}`);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (`sha256:${digest}` !== asset.digest) throw new Error(`wrong digest for ${asset.name}`);
}

export function fetchHistoricalReleases(target: string): void {
  if (!path.isAbsolute(target)) throw new Error('artifact directory must be absolute');
  // A fresh directory prevents an old or partial download from being reused.
  mkdirSync(target, {mode: 0o700});
  const raw = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`],
    {encoding: 'utf8', maxBuffer: 32_000_000});
  const pages: unknown = JSON.parse(raw);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('invalid release pages');
  const releases = pages.flat() as Release[];
  const chosen = selectHistoricalReleases(releases);
  const fetchOne = (role: 'stable' | 'nightly', release: SelectedRelease) => {
    const dir = path.join(target, role); mkdirSync(dir, {mode: 0o700});
    execFileSync('gh', ['release', 'download', release.tag, '--repo', repository, '--dir', dir,
      '--pattern', release.archive.name, '--pattern', release.host.name, '--pattern', release.platform.name], {stdio: 'pipe'});
    for (const item of [release.archive, release.host, release.platform]) verifyAsset(path.join(dir, item.name), item);
    chmodSync(path.join(dir, release.host.name), 0o700);
    chmodSync(path.join(dir, release.platform.name), 0o700);
    return {tag: release.tag,
      archive: `${role}/${release.archive.name}`, archiveSha: release.archive.digest!.slice(7),
      host: `${role}/${release.host.name}`, hostSha: release.host.digest!.slice(7),
      platform: `${role}/${release.platform.name}`, platformSha: release.platform.digest!.slice(7)};
  };
  const manifest = {version: 1, stable: fetchOne('stable', chosen.stable), nightly: fetchOne('nightly', chosen.nightly)};
  writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: fetch-historical-releases.ts ABSOLUTE_NEW_DIRECTORY');
  fetchHistoricalReleases(process.argv[2]!);
}
