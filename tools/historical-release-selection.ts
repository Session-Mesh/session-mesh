// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export type ReleaseAsset = {name: string; digest: string | null; size: number};
export type Release = {tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[]};
export type SelectedRelease = {tag: string; archive: ReleaseAsset; host: ReleaseAsset; platform: ReleaseAsset; history: ReleaseAsset};

function asset(release: Release, name: string): ReleaseAsset {
  const matches = release.assets.filter(item => item.name === name);
  if (matches.length !== 1) throw new Error(`release ${release.tag_name}: missing or duplicate ${name}`);
  const item = matches[0]!;
  if (!/^sha256:[0-9a-f]{64}$/.test(item.digest ?? '') || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 200_000_000)
    throw new Error(`release ${release.tag_name}: invalid digest or size for ${name}`);
  return item;
}

function selected(release: Release): SelectedRelease {
  return {tag: release.tag_name, archive: asset(release, `session-mesh-${release.tag_name}.tar.gz`),
    host: asset(release, 'mesh-ptyhost-linux-x86_64'), platform: asset(release, 'mesh-platform-linux-x86_64'),
    history: asset(release, 'mesh-history-linux-x86_64')};
}

/** Select by version/date, not API order. Missing assets fail closed. */
export function selectHistoricalReleases(releases: readonly Release[]): {stable: SelectedRelease; nightly: SelectedRelease} {
  const stable = releases.flatMap(release => {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name);
    return !release.draft && !release.prerelease && m ? [{release, version: m.slice(1).map(Number)}] : [];
  }).filter(row => row.version.every(Number.isSafeInteger));
  stable.sort((a, b) => (b.version[0]! - a.version[0]!) || (b.version[1]! - a.version[1]!) || (b.version[2]! - a.version[2]!));
  const nightlies = releases.flatMap(release => {
    const m = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})$/.exec(release.tag_name);
    return !release.draft && release.prerelease && m ? [{release, version: m.slice(1).map(Number)}] : [];
  }).filter(row => row.version.every(Number.isSafeInteger));
  nightlies.sort((a, b) => (b.version[3]! - a.version[3]!) || (b.version[0]! - a.version[0]!) ||
    (b.version[1]! - a.version[1]!) || (b.version[2]! - a.version[2]!));
  if (!stable[0] || !nightlies[0]) throw new Error('both a stable release and a nightly are required');
  return {stable: selected(stable[0].release), nightly: selected(nightlies[0].release)};
}
