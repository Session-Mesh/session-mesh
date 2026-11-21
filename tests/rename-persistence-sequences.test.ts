// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The operator's sequences around renamed sessions, end to end: several sessions (Claude, Codex, Pi) renamed and
// filed at once, the web server restarted onto a new build, then the PTY host (every session ends), then the
// Restore of every offer; the same after their agents were restarted (in the same terminal, or in a replacement
// session for Pi); and a rename that must stay the name shown when the agent's own conversation title appears
// later. Real server.py and native PTY host, fake agents (history-resume-name-lib.ts), throwaway HOME,
// configuration and runtime folders, a free port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';
import {type HistoryLab, type Kind, KINDS, SIDS, withHistoryLab} from './history-resume-name-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';
import {FOLDER, type Listed, arrangement, listed, organize, relaunched, restartApproved} from './rename-persistence-lib.ts';
import {REPO} from './mesh-server-lib.ts';

const NAMES: Record<Kind, string> = {claude: 'Review notes', codex: 'Release work', pi: 'Small fixes'};

/** A running session of `kind`. Claude is resumed from History: a new Claude is launched with --session-id, which
 * the fake one ignores (it runs the conversation of the lab), and a restore would look for that id. */
async function started(lab: HistoryLab, kind: Kind): Promise<Listed> {
  if (kind !== 'claude') return await lab.create(kind) as Listed;
  const answer = await lab.resume(kind);
  assert.equal(answer.status, 200, answer.text);
  return await lab.resumed(kind, answer.id!) as Listed;
}

/** One session of each kind, each renamed, all three filed in FOLDER (ranks 0, 1, 2): name by kind. */
async function arrangedAll(lab: HistoryLab): Promise<Record<Kind, Listed>> {
  await organize(lab, {op: 'folder-add', name: FOLDER});
  const made = {} as Record<Kind, Listed>;
  for (const kind of KINDS) {
    const session = await started(lab, kind);
    await organize(lab, {op: 'move', id: session.name, folder: FOLDER});
    await lab.rename(session.name, NAMES[kind]);
    made[kind] = (await listed(lab, session.name))!;
  }
  assert.deepEqual(KINDS.map(kind => [made[kind].label, made[kind].folder, made[kind].rank]),
    [[NAMES.claude, FOLDER, 0], [NAMES.codex, FOLDER, 1], [NAMES.pi, FOLDER, 2]]);
  return made;
}

/** The nightly switch: the web server restarts onto the new build (the sessions live on), then the PTY host
 * (every session ends); the offers of `names` once all are offered and no agent of theirs still runs. */
async function bothRestarted(lab: HistoryLab, names: string[]): Promise<void> {
  await lab.restartServer();
  await lab.restartHost();
  await waitFor('every renamed session offered', 20000, async () => {
    const answer = await lab.call('GET', '/api/sessions');
    const offered = new Set((answer.json?.restorable as {name: string}[] | undefined)?.map(offer => offer.name));
    const running = (answer.json?.external as Listed[] | undefined)?.some(item =>
      KINDS.some(kind => item.agent?.session_id === SIDS[kind]));
    return names.every(name => offered.has(name)) && !running;
  });
}

/** Restore every offer of `names` in one click; the label, folder and rank of each restored session, by kind. */
async function restoredAll(lab: HistoryLab, names: Record<Kind, string>): Promise<unknown[][]> {
  const restored = await lab.call('POST', '/api/restore', {names: KINDS.map(kind => names[kind])});
  assert.equal(restored.status, 200, restored.text);
  const shown: unknown[][] = [];
  for (const kind of KINDS) {
    const result = restored.json.results[names[kind]];
    assert.equal(result?.ok, true, restored.text);
    const again = await relaunched(lab, kind, result.id ?? names[kind], -1);
    shown.push(await arrangement(lab, again.name));
  }
  return shown;
}

const EXPECTED = [[NAMES.claude, FOLDER, 0], [NAMES.codex, FOLDER, 1], [NAMES.pi, FOLDER, 2]];

test('renamed Claude, Codex and Pi sessions keep their names after a web server restart, a PTY host restart and Restore', () => withHistoryLab(async lab => {
  const made = await arrangedAll(lab);
  const names = {claude: made.claude.name, codex: made.codex.name, pi: made.pi.name};
  await arrangement(lab, made.pi.name);   // the snapshot records the three
  await bothRestarted(lab, Object.values(names));
  assert.deepEqual(await restoredAll(lab, names), EXPECTED);
}));

test('after their agents restarted (in place, or in a replacement for Pi), the names survive both restarts and Restore', () => withHistoryLab(async lab => {
  const made = await arrangedAll(lab);
  const names = {} as Record<Kind, string>;
  for (const kind of KINDS) {
    const done = await restartApproved(lab, made[kind].name);
    names[kind] = String(done.result?.id ?? made[kind].name);
    await relaunched(lab, kind, names[kind], made[kind].created);
  }
  assert.equal(names.claude, made.claude.name, 'Claude restarts in the same terminal');
  assert.equal(names.codex, made.codex.name, 'Codex restarts in the same terminal');
  assert.deepEqual(await Promise.all(KINDS.map(kind => arrangement(lab, names[kind]))), EXPECTED, 'after the restarts');
  await bothRestarted(lab, Object.values(names));
  assert.deepEqual(await restoredAll(lab, names), EXPECTED, 'after Restore');
}));

/** label(s) of static/app.js: the name the list and the pane header show for a listed session. */
function shownName(session: Record<string, unknown>): string {
  const source = fs.readFileSync(path.join(REPO, 'static', 'app.js'), 'utf8');
  const body = /\nfunction label\(s\) \{\n[\s\S]*?\n\}\n/.exec(source);
  assert.ok(body, 'label(s) found in static/app.js');
  const context = {short: (folder: string) => folder, session, out: ''};
  vm.runInNewContext(`${body[0]}\nout = label(session);`, context);
  return context.out;
}

test('a renamed session shows its name, not the title its agent gives the conversation later, also once restarted', () => withHistoryLab(async lab => {
  const session = await lab.create('claude');
  await lab.rename(session.name, NAMES.claude);
  // Claude titles the conversation after the rename (an "ai-title" line in its transcript)
  const transcript = path.join(lab.where.home, '.claude', 'projects', '-home-x', `${SIDS.claude}.jsonl`);
  fs.appendFileSync(transcript, JSON.stringify({type: 'ai-title', aiTitle: 'Agent title', sessionId: SIDS.claude}) + '\n');
  let shown: Listed | undefined;
  await waitFor('the agent title listed', 15000, async () => {
    shown = await listed(lab, session.name);
    return (shown?.agent as {title?: string} | null)?.title === 'Agent title';
  });
  assert.equal(shownName(shown!), NAMES.claude);
  await restartApproved(lab, session.name);
  const again = await relaunched(lab, 'claude', session.name, session.created);
  await listed(lab, session.name);
  const after = await listed(lab, session.name);
  assert.equal(after?.label, NAMES.claude, 'the label of the new incarnation');
  assert.equal(shownName({...after!, agent: {...again.agent, title: 'Agent title'}}), NAMES.claude);
}));

test('without a rename the agent title, then the session name, then the folder is shown (unchanged order)', () => {
  const agent = {title: 'Agent title', name: 'claude'};
  assert.equal(shownName({kind: 'mesh', name: 'home-claude', label: 'Mine', agent}), 'Mine');
  assert.equal(shownName({kind: 'mesh', name: 'home-claude', label: null, agent}), 'Agent title');
  assert.equal(shownName({kind: 'mesh', name: 'home-claude', label: null, agent: {name: 'claude'}}), 'claude');
  assert.equal(shownName({kind: 'mesh', name: 'home', label: null, agent: null}), 'home');
  assert.equal(shownName({kind: 'external', name: 'x', cwd: '/srv/notes', label: null, agent: null}), 'notes');
});
