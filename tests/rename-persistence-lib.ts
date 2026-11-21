// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared by rename-persistence.test.ts and rename-persistence-sequences.test.ts: what the operator does to a
// session (rename, file, ask its agent to restart, restart the PTY host and restore) and how its name, folder
// and rank read afterwards, through a HistoryLab (real server.py and native PTY host, fake agents).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {type HistoryLab, type Kind, SIDS} from './history-resume-name-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

export type Listed = {name: string; created: number; label: string | null; folder: string | null; rank: number | null;
  agent: {session_id?: string} | null};

export const LABEL = 'Chosen name';
export const FOLDER = 'Projects';

export async function listed(lab: HistoryLab, name: string): Promise<Listed | undefined> {
  const answer = await lab.call('GET', '/api/sessions');
  assert.equal(answer.status, 200, answer.text);
  return (answer.json.mesh as Listed[]).find(session => session.name === name);
}

export async function organize(lab: HistoryLab, op: Record<string, unknown>): Promise<void> {
  const done = await lab.call('POST', '/api/organize', op);
  assert.equal(done.status, 200, done.text);
}

/** A session of `kind`, renamed LABEL and filed in FOLDER (which ranks it). */
export async function arranged(lab: HistoryLab, kind: Kind): Promise<Listed> {
  const session = await lab.create(kind);
  await organize(lab, {op: 'folder-add', name: FOLDER});
  await organize(lab, {op: 'move', id: session.name, folder: FOLDER});
  await lab.rename(session.name, LABEL);
  const shown = await listed(lab, session.name);
  assert.deepEqual([shown?.label, shown?.folder, shown?.rank], [LABEL, FOLDER, 0]);
  return shown!;
}

/** The session `name` once it runs the conversation of `kind` again, in an incarnation other than `before`. */
export async function relaunched(lab: HistoryLab, kind: Kind, name: string, before: number): Promise<Listed> {
  let found: Listed | undefined;
  await waitFor(`${name} running ${kind} again`, 20000, async () => {
    found = await listed(lab, name);
    return found !== undefined && found.created !== before && found.agent?.session_id === SIDS[kind];
  }).catch((error: Error) => { throw new Error(`${error.message}; last seen: ${JSON.stringify(found)}`); });
  return found!;
}

/** Its label, folder and rank, read twice: the second listing would have pruned an entry of a past incarnation. */
export async function arrangement(lab: HistoryLab, name: string): Promise<unknown[]> {
  await listed(lab, name);
  const shown = await listed(lab, name);
  return [shown?.label, shown?.folder, shown?.rank];
}

/** The owner's cookie, which approves a session's request. */
export async function ownerCookie(lab: HistoryLab): Promise<string> {
  const base = `http://127.0.0.1:${lab.where.port}`;
  const token = fs.readFileSync(path.join(lab.where.confDir, 'token'), 'utf8').trim();
  const login = await fetch(`${base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token})});
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie, 'logged in');
  return cookie;
}

/** The session `name` asks for the restart of its own agent and the owner approves it; the request once done. */
export async function restartApproved(lab: HistoryLab, name: string): Promise<Record<string, any>> {
  const base = `http://127.0.0.1:${lab.where.port}`;
  const tokenFile = path.join(lab.bin, `token-${name}`);
  await waitFor(`the session token of ${name}`, 10000, () => fs.existsSync(tokenFile));
  const asked = await fetch(`${base}/api/session-actions/@self/request`, {method: 'POST',
    body: JSON.stringify({action: 'restart'}), headers: {Authorization: `MeshSession ${fs.readFileSync(tokenFile, 'utf8')}`,
      'Content-Type': 'application/json'}});
  assert.equal(asked.status, 202, await asked.clone().text());
  const {request} = await asked.json() as {request: {id: string}};
  const headers = {Cookie: await ownerCookie(lab), Origin: base, 'Content-Type': 'application/json'};
  const claimed = await fetch(`${base}/api/session-actions/${request.id}/claim`, {method: 'POST', headers,
    body: JSON.stringify({tab_nonce: 'b'.repeat(32)})});
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
  const decided = await fetch(`${base}/api/session-actions/${request.id}/decision`, {method: 'POST', headers,
    body: JSON.stringify({approve: true, claim_nonce: claimNonce})});
  assert.equal(decided.status, 200, await decided.clone().text());
  const done = (await decided.json() as {request: Record<string, any>}).request;
  assert.equal(done.state, 'completed', JSON.stringify(done));
  return done;
}

/** Restart the PTY host, then restore the offer of `name`: the restored session, running its conversation again. */
export async function restoredAfterHostRestart(lab: HistoryLab, kind: Kind, name: string, before: number): Promise<Listed> {
  await lab.restartHost();
  // offered, and the agent of the ended session gone (until it exits, its conversation counts as running elsewhere)
  await waitFor(`${name} offered`, 20000, async () => {
    const answer = await lab.call('GET', '/api/sessions');
    const offered = (answer.json?.restorable as {name: string}[] | undefined)?.some(offer => offer.name === name);
    const running = (answer.json?.external as Listed[] | undefined)?.some(item => item.agent?.session_id === SIDS[kind]);
    return Boolean(offered) && !running;
  });
  const restored = await lab.call('POST', '/api/restore', {names: [name]});
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.results[name]?.ok, true, restored.text);
  return relaunched(lab, kind, restored.json.results[name].id ?? name, before);
}

