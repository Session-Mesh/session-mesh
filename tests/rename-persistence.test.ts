// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A session the operator renamed keeps that name, its folder and its rank: across a restart of the web server,
// across a restart of the PTY host followed by the restore of its offer, and across a restart of its agent
// asked by the session itself, in the same terminal (a new incarnation: `created` moves on) or, for an agent the
// PTY host cannot restart in place, in a replacement session. Real server.py and native PTY host, fake agents
// (history-resume-name-lib.ts), throwaway HOME, configuration and runtime folders, a free port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {type HistoryLab, type Kind, SIDS, withHistoryLab} from './history-resume-name-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

type Listed = {name: string; created: number; label: string | null; folder: string | null; rank: number | null;
  agent: {session_id?: string} | null};

const LABEL = 'Chosen name';
const FOLDER = 'Projects';

async function listed(lab: HistoryLab, name: string): Promise<Listed | undefined> {
  const answer = await lab.call('GET', '/api/sessions');
  assert.equal(answer.status, 200, answer.text);
  return (answer.json.mesh as Listed[]).find(session => session.name === name);
}

async function organize(lab: HistoryLab, op: Record<string, unknown>): Promise<void> {
  const done = await lab.call('POST', '/api/organize', op);
  assert.equal(done.status, 200, done.text);
}

/** A session of `kind`, renamed LABEL and filed in FOLDER (which ranks it). */
async function arranged(lab: HistoryLab, kind: Kind): Promise<Listed> {
  const session = await lab.create(kind);
  await organize(lab, {op: 'folder-add', name: FOLDER});
  await organize(lab, {op: 'move', id: session.name, folder: FOLDER});
  await lab.rename(session.name, LABEL);
  const shown = await listed(lab, session.name);
  assert.deepEqual([shown?.label, shown?.folder, shown?.rank], [LABEL, FOLDER, 0]);
  return shown!;
}

/** The session `name` once it runs the conversation of `kind` again, in an incarnation other than `before`. */
async function relaunched(lab: HistoryLab, kind: Kind, name: string, before: number): Promise<Listed> {
  let found: Listed | undefined;
  await waitFor(`${name} running ${kind} again`, 20000, async () => {
    found = await listed(lab, name);
    return found !== undefined && found.created !== before && found.agent?.session_id === SIDS[kind];
  }).catch((error: Error) => { throw new Error(`${error.message}; last seen: ${JSON.stringify(found)}`); });
  return found!;
}

/** Its label, folder and rank, read twice: the second listing would have pruned an entry of a past incarnation. */
async function arrangement(lab: HistoryLab, name: string): Promise<unknown[]> {
  await listed(lab, name);
  const shown = await listed(lab, name);
  return [shown?.label, shown?.folder, shown?.rank];
}

/** The owner's cookie, which approves a session's request. */
async function ownerCookie(lab: HistoryLab): Promise<string> {
  const base = `http://127.0.0.1:${lab.where.port}`;
  const token = fs.readFileSync(path.join(lab.where.confDir, 'token'), 'utf8').trim();
  const login = await fetch(`${base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token})});
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie, 'logged in');
  return cookie;
}

/** The session `name` asks for the restart of its own agent and the owner approves it; the request once done. */
async function restartApproved(lab: HistoryLab, name: string): Promise<Record<string, any>> {
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
async function restoredAfterHostRestart(lab: HistoryLab, kind: Kind, name: string, before: number): Promise<Listed> {
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

test('the name, folder and rank survive a restart of the web server', () => withHistoryLab(async lab => {
  const session = await arranged(lab, 'claude');
  await lab.restartServer();
  assert.deepEqual(await arrangement(lab, session.name), [LABEL, FOLDER, 0]);
}));

test('the name, folder and rank survive a restart of the PTY host and the restore of the offer', () => withHistoryLab(async lab => {
  const session = await arranged(lab, 'codex');
  const restored = await restoredAfterHostRestart(lab, 'codex', session.name, session.created);
  assert.deepEqual(await arrangement(lab, restored.name), [LABEL, FOLDER, 0]);
}));

test('a restart of the agent in the same terminal keeps the name, folder and rank of the new incarnation', () => withHistoryLab(async lab => {
  const session = await arranged(lab, 'codex');
  const done = await restartApproved(lab, session.name);
  assert.equal(done.result?.id, session.name, 'the same session');
  await relaunched(lab, 'codex', session.name, session.created);
  assert.deepEqual(await arrangement(lab, session.name), [LABEL, FOLDER, 0]);
  await lab.restartServer();
  assert.deepEqual(await arrangement(lab, session.name), [LABEL, FOLDER, 0], 'and they survive the web server');
}));

test('after a restart of the agent in place, the name also survives a PTY host restart and restore', () => withHistoryLab(async lab => {
  const session = await arranged(lab, 'codex');
  await restartApproved(lab, session.name);
  const again = await relaunched(lab, 'codex', session.name, session.created);
  await arrangement(lab, session.name);   // the snapshot records the new incarnation
  const restored = await restoredAfterHostRestart(lab, 'codex', session.name, again.created);
  assert.deepEqual(await arrangement(lab, restored.name), [LABEL, FOLDER, 0]);
}));

test('an agent restarted in a replacement session (Pi: not restarted in place) gives it the name, folder and rank', () => withHistoryLab(async lab => {
  const session = await arranged(lab, 'pi');
  const done = await restartApproved(lab, session.name);
  const replacement = String(done.result?.id);
  await waitFor(`${session.name} replaced`, 20000, async () => (await listed(lab, session.name)) === undefined
    || replacement === session.name);
  await relaunched(lab, 'pi', replacement, session.created);
  assert.deepEqual(await arrangement(lab, replacement), [LABEL, FOLDER, 0]);
}));
