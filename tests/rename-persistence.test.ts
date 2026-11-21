// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A session the operator renamed keeps that name, its folder and its rank: across a restart of the web server,
// across a restart of the PTY host followed by the restore of its offer, and across a restart of its agent
// asked by the session itself, in the same terminal (a new incarnation: `created` moves on) or, for an agent the
// PTY host cannot restart in place, in a replacement session. Real server.py and native PTY host, fake agents
// (history-resume-name-lib.ts), throwaway HOME, configuration and runtime folders, a free port.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SIDS, withHistoryLab} from './history-resume-name-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';
import {FOLDER, LABEL, type Listed, arranged, arrangement, listed, relaunched, restartApproved,
  restoredAfterHostRestart} from './rename-persistence-lib.ts';

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

test('after a restart of the agent in place and a PTY host restart, a History resume shows the name', () => withHistoryLab(async lab => {
  const session = await arranged(lab, 'codex');
  await restartApproved(lab, session.name);
  await relaunched(lab, 'codex', session.name, session.created);
  await arrangement(lab, session.name);   // the conversation names record the new incarnation
  await lab.restartHost();
  await waitFor('the agent of the ended session gone', 20000, async () => {
    const answer = await lab.call('GET', '/api/sessions');
    return !(answer.json?.external as Listed[] | undefined)?.some(item => item.agent?.session_id === SIDS.codex);
  });
  const answer = await lab.resume('codex');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('codex', answer.id!)).label, LABEL);
}));

test('several renamed sessions restored together after both restart, one whose name was taken meanwhile', () => withHistoryLab(async lab => {
  const agent = await arranged(lab, 'codex');
  await lab.shell('notes', 'My notes');
  await lab.shell('scratch', 'Scratch pad');
  await arrangement(lab, agent.name);   // the snapshot records the three
  await lab.restartHost();
  await lab.restartServer();   // a switch of the installation restarts both
  const names = [agent.name, 'notes', 'scratch'];
  await waitFor('the three offered', 20000, async () => {
    const answer = await lab.call('GET', '/api/sessions');
    const offered = new Set((answer.json?.restorable as {name: string}[] | undefined)?.map(offer => offer.name));
    const running = (answer.json?.external as Listed[] | undefined)?.some(item => item.agent?.session_id === SIDS.codex);
    return names.every(name => offered.has(name)) && !running;
  });
  const taken = await lab.call('POST', '/api/new', {preset: 'shell', cwd: lab.where.home, name: 'scratch'});
  assert.equal(taken.status, 200, taken.text);
  const restored = await lab.call('POST', '/api/restore', {names});
  assert.equal(restored.status, 200, restored.text);
  assert.ok(names.every(name => restored.json.results[name]?.ok), restored.text);
  const ids = names.map(name => restored.json.results[name].id as string);
  assert.notEqual(ids[2], 'scratch', 'restored under another name');
  assert.deepEqual(await arrangement(lab, ids[0]!), [LABEL, FOLDER, 0]);
  assert.equal((await listed(lab, ids[1]!))?.label, 'My notes');
  assert.equal((await listed(lab, ids[2]!))?.label, 'Scratch pad');
  assert.equal((await listed(lab, 'scratch'))?.label, null, 'the session that took the name keeps its own');
}));
