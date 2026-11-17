// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A listing that read the host BEFORE an exact restore created its session must not erase the
// organisation (label, folder, rank) the restore gave that session. The interleaving is forced through
// the host proxy: the host's answer to one GET /api/sessions is computed before the restore and delivered
// after it (a client polling every 30 ms meets this window by chance).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {type Intercept} from './ptyhost-proxy-lib.ts';
import {Lab, withLab} from './restore-exact-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const HOLD_MS = 2000;   // below the server's 5 s host timeout
const ORG ={label: 'Etiquette alpha', folder: 'Dossier', rank: 0};

/** The offer of `alpha` carries an organisation, and its folder exists. Written before the first request. */
function seedOrganisation(lab: Lab): void {
  const file = path.join(lab.mesh.confDir, 'sessions-snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  snapshot.lost.find((entry: any) => entry.name === 'alpha').org = ORG;
  fs.writeFileSync(file, JSON.stringify(snapshot));
  fs.writeFileSync(path.join(lab.mesh.confDir, 'mesh.json'), JSON.stringify({folders: [ORG.folder], sessions: {}, order: []}));
}

async function organisationOf(lab: Lab, name: string): Promise<Record<string, unknown> | undefined> {
  const {json} = await lab.sessionsJson();
  const session = json.mesh.find((s: any) => s.name === name);
  return session && {label: session.label, folder: session.folder, rank: session.rank};
}

/** A host whose NEXT `list` (once armed) is answered with `stale`, only when `release` is called. */
function staleListing(stale: object[]) {
  let armed = false;
  let held = false;
  let release!: (value: object) => void;
  const gate = new Promise<object>(resolve => { release = resolve; });
  const intercept: Intercept = request => {
    if (!armed || held || request.op !== 'list') return;
    held = true;
    return {replyAfter: gate};
  };
  return {intercept, arm: () => { armed = true; }, held: () => held, release: () => release(stale)};
}

test('a listing read before the restore does not erase the organisation the restore wrote', async () => {
  const stale = staleListing([]);   // the host's list when the listing asked: no session yet
  await withLab(async lab => {
    seedOrganisation(lab);
    stale.arm();
    const listing = lab.sessionsJson();   // asks the host, then waits for its (stale) answer
    await waitFor('the listing reached the host', 10000, () => stale.held());
    // The restore creates the session and writes its organisation meanwhile. A server that read the host
    // under the organisation lock makes the restore wait for the listing: it is let go after HOLD_MS.
    const restoring = lab.exact(lab.offers.alpha);
    await Promise.race([restoring, new Promise(resolve => setTimeout(resolve, HOLD_MS))]);
    stale.release();
    const restored = await restoring;
    assert.equal(restored.json.ok, true, restored.text);
    assert.equal((await listing).status, 200);
    assert.deepEqual(await organisationOf(lab, 'alpha'), ORG);
  }, {intercept: stale.intercept});
});

test('without the stale listing the organisation survives (control)', () => withLab(async lab => {
  seedOrganisation(lab);
  const restored = await lab.exact(lab.offers.alpha);
  assert.equal(restored.json.ok, true, restored.text);
  assert.deepEqual(await organisationOf(lab, 'alpha'), ORG);
  await lab.sessionsJson();
  assert.deepEqual(await organisationOf(lab, 'alpha'), ORG);
}));
