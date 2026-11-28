// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {accessSync, constants, readFileSync, statSync} from 'node:fs';
import path from 'node:path';

export type HistoricalRelease = {tag:string; archive:string; archiveSha:string; host:string; hostSha:string; platform?:string; platformSha?:string; history?:string; historySha?:string};
const pinned = {
  stable: {tag:'v0.1.1', archive:'session-mesh-v0.1.1.tar.gz', archiveSha:'f839e0b39dd031831da18bca7fe8654b2e1574222300dc3a2630260e2f2b6f6f', host:'mesh-ptyhost-linux-x86_64', hostSha:'276b2fe69e8ab1ff5def33a455bc444bc773a19913042f246dbd46999a5ad008'},
  nightly: {tag:'v0.2.0-nightly.20261124', archive:'session-mesh-v0.2.0-nightly.20261124.tar.gz', archiveSha:'58ea5761fc840ca2269e1a31c81566cb0c1fb6af6e94354c85be6989c2a63342', host:'nightly-20261124/mesh-ptyhost-linux-x86_64', hostSha:'23e83e42ee335315eebb950469f6a690682d5ec417a451997e4b32cfb446269a', platform:'nightly-20261124/mesh-platform-linux-x86_64', platformSha:'883ae2892e3c2aa93e89a1acf828002bd97a19afb68b6971d9b4d825ecc8011f'},
};

/** Dynamic inputs have fixed role-relative paths; no manifest path can escape the artifact directory. */
export function historicalArtifacts(root: string | undefined): {stable:HistoricalRelease; nightly:HistoricalRelease} {
  if (process.env.MESH_HISTORICAL_DYNAMIC !== '1') return pinned;
  assert.ok(root && path.isAbsolute(root), 'dynamic artifacts require an absolute directory');
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
  const raw = manifest as Record<string, unknown>; assert.equal(raw.version, 1);
  const parse = (role:'stable'|'nightly'): HistoricalRelease => {
    const value = raw[role]; assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const entry = value as Record<string, unknown>;
    assert.equal(typeof entry.tag, 'string'); const tag = entry.tag as string;
    assert.match(tag, role === 'stable' ? /^v\d+\.\d+\.\d+$/ : /^v\d+\.\d+\.\d+-nightly\.\d{8}$/);
    assert.equal(entry.archive, `${role}/session-mesh-${tag}.tar.gz`);
    assert.equal(entry.host, `${role}/mesh-ptyhost-linux-x86_64`);
    assert.equal(entry.platform, `${role}/mesh-platform-linux-x86_64`);
    assert.equal(entry.history, `${role}/mesh-history-linux-x86_64`);
    for (const key of ['archiveSha', 'hostSha', 'platformSha', 'historySha']) assert.match(String(entry[key]), /^[a-f0-9]{64}$/);
    return entry as HistoricalRelease;
  };
  return {stable:parse('stable'), nightly:parse('nightly')};
}


/** The historical harness expects the candidate's installed sibling helper. */
export function candidateHistoryFor(host: string): string {
  const history = path.join(path.dirname(host), 'mesh-history');
  try {
    if (!statSync(history).isFile()) throw new Error('not a regular file');
    accessSync(history, constants.X_OK);
  } catch (cause) {
    throw new Error('Candidate mesh-history is missing or not executable. Build @install and use the installed mesh-ptyhost.', {cause});
  }
  return history;
}
