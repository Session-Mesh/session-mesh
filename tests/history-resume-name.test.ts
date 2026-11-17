// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A session renamed B and resumed from the History must come back as B, not under the name it was started with.
// "Rename" is an organisation label (mesh.json): the PTY host's session name never changes, so the new
// incarnation, which reuses the free generated name A, used to show A. Real server.py and native PTY host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {KINDS, SIDS, withHistoryLab} from './history-resume-name-lib.ts';

for (const kind of KINDS) {
  test(`${kind}: a conversation renamed B and resumed from the History is shown as B`, () => withHistoryLab(async lab => {
    const original = await lab.closedRenamed(kind, 'chosen name');
    const answer = await lab.resume(kind);
    assert.equal(answer.status, 200, answer.text);
    const resumed = await lab.resumed(kind, answer.id!);
    assert.equal(resumed.label, 'chosen name');
    assert.equal(resumed.name, original, 'the host name is the free generated one, as before');
  }));
}

test('the name survives a restart of the web server', () => withHistoryLab(async lab => {
  await lab.closedRenamed('claude', 'before restart');
  await lab.restartServer();
  const answer = await lab.resume('claude');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('claude', answer.id!)).label, 'before restart');
}));

test('two renames: the last one wins', () => withHistoryLab(async lab => {
  await lab.closedRenamed('codex', 'first', 'second');
  const answer = await lab.resume('codex');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('codex', answer.id!)).label, 'second');
}));

test('a label cleared before the stop is not brought back', () => withHistoryLab(async lab => {
  await lab.closedRenamed('claude', 'temporary', '');
  const answer = await lab.resume('claude');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('claude', answer.id!)).label, null);
}));

test('a conversation never renamed is resumed as before', () => withHistoryLab(async lab => {
  const original = await lab.closedRenamed('claude');
  const answer = await lab.resume('claude');
  assert.equal(answer.status, 200, answer.text);
  const resumed = await lab.resumed('claude', answer.id!);
  assert.equal(resumed.label, null);
  assert.equal(resumed.name, original);
}));

test('a name already shown by a live session is not duplicated: the generated name stays', () => withHistoryLab(async lab => {
  await lab.closedRenamed('claude', 'taken-by-label');
  await lab.shell('other', 'taken-by-label');
  const byLabel = await lab.resume('claude');
  assert.equal(byLabel.status, 200, byLabel.text);
  assert.equal((await lab.resumed('claude', byLabel.id!)).label, null, 'a live label is not reused');
}));

test('renamed again after a resume: the latest incarnation decides', () => withHistoryLab(async lab => {
  await lab.closedRenamed('claude', 'first life');
  const first = await lab.resume('claude');
  assert.equal(first.status, 200, first.text);
  const resumed = await lab.resumed('claude', first.id!);
  assert.equal(resumed.label, 'first life');
  await lab.rename(resumed.name, 'second life');
  await lab.kill(resumed);
  await lab.restartServer();   // the server holds a just-resumed conversation back for two minutes
  const second = await lab.resume('claude');
  assert.equal(second.status, 200, second.text);
  assert.equal((await lab.resumed('claude', second.id!)).label, 'second life');
}));

test('a name equal to a live host name is not duplicated either', () => withHistoryLab(async lab => {
  await lab.closedRenamed('codex', 'taken-by-name');
  await lab.shell('taken-by-name');
  const answer = await lab.resume('codex');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('codex', answer.id!)).label, null);
}));

const SECOND_CLAUDE = '0a1b2c3d-1111-2222-3333-4444444444b2';

test('claude: a label given while a later conversation runs does not return on the earlier one (/clear)', () => withHistoryLab(async lab => {
  const session = await lab.create('claude');
  await lab.rename(session.name, 'label of A');
  await lab.claudeSwitchTo(session, SECOND_CLAUDE);
  await lab.rename(session.name, 'work on B');
  assert.equal(lab.recordedLabels()[SECOND_CLAUDE], 'work on B', 'the label belongs to the conversation running when it was given');
  await lab.kill(session);
  const answer = await lab.resume('claude');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('claude', answer.id!)).label, 'label of A');
}));

test('claude: back to an earlier conversation of the same session, a new label is for that one again', () => withHistoryLab(async lab => {
  // No label before the return: nothing but the "newest" bookkeeping changes when A is seen again.
  const session = await lab.create('claude');
  await lab.claudeSwitchTo(session, SECOND_CLAUDE);
  await lab.claudeSwitchTo(session, SIDS.claude);
  await lab.rename(session.name, 'back on A');
  assert.equal(lab.recordedLabels()[SIDS.claude], 'back on A', 'the conversation running now owns the label');
  assert.equal(lab.recordedLabels()[SECOND_CLAUDE], '');
  await lab.kill(session);
  const answer = await lab.resume('claude');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('claude', answer.id!)).label, 'back on A');
}));

const SECOND_CODEX = '0a1b2c3d-1111-2222-3333-4444444444b3';

test('codex: a label given after /new (no rollout held open, only a guess) is not put on the earlier conversation', () => withHistoryLab(async lab => {
  lab.holdCodexRollout();
  const session = await lab.create('codex');
  await lab.rename(session.name, 'label of A');
  await lab.codexStartsNew(session, SECOND_CODEX);
  await lab.rename(session.name, 'new topic');
  assert.equal(lab.recordedLabels()[SIDS.codex], 'label of A');
  assert.equal(lab.recordedLabels().unbound, 'new topic', 'kept with no conversation, applied to none');
  await lab.kill(session);
  const answer = await lab.resume('codex');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('codex', answer.id!)).label, 'label of A');
}));

test('pi: a label given while the conversation is ambiguous (after /new) is not put on the old one', () => withHistoryLab(async lab => {
  const session = await lab.create('pi');
  await lab.rename(session.name, 'label of A');
  await lab.piBecomesAmbiguous(session);
  await lab.rename(session.name, 'new topic');
  assert.equal(lab.recordedLabels()[SIDS.pi], 'label of A');
  assert.equal(lab.recordedLabels().unbound, 'new topic', 'kept with no conversation, applied to none');
  await lab.kill(session);
  lab.piDropsSecondTranscript();
  const answer = await lab.resume('pi');
  assert.equal(answer.status, 200, answer.text);
  assert.equal((await lab.resumed('pi', answer.id!)).label, 'label of A');
}));

// Not only the failures that were expected (OSError, ValueError, a refusal): any exception while the label is
// restored leaves the resume at 200, since the agent is running by now. Here the label of a live session in
// mesh.json is a list (a file edited by hand): only the step that compares the labels needs it hashable, so it
// raises a TypeError after the session was started, which no narrow except clause would catch.
test('an unexpected exception while the label is restored (TypeError) still returns the session (200)', () => withHistoryLab(async lab => {
  await lab.closedRenamed('claude', 'chosen name');
  await lab.shell('other', 'a label');
  const file = path.join(lab.where.confDir, 'mesh.json');
  const healthy = fs.readFileSync(file, 'utf8');
  const tampered = JSON.parse(healthy) as {sessions: Record<string, {label: unknown}>};
  tampered.sessions.other.label = ['not', 'text'];
  fs.writeFileSync(file, JSON.stringify(tampered));
  const answer = await lab.resume('claude');
  fs.writeFileSync(file, healthy);   // the checks below read mesh.json too
  assert.equal(answer.status, 200, answer.text);
  assert.ok(answer.id, 'the name of the session started is returned');
  assert.match(lab.serverOutput(), /history resume: label of \S+ not restored: TypeError/);
  assert.doesNotMatch(lab.serverOutput(), /Traceback/);
  assert.equal((await lab.resumed('claude', answer.id!)).label, null, 'the label was not applied, the session runs');
}));

// The host's list is read again once the session is started (so that a name is never shown twice). A reply that
// is not a list of sessions must never fail the resume: the agent is running, a second click would start another.
const LABEL_REFUSED = /history resume: label of \S+ not restored: ValueError\("the host's list is not usable"\)/;

for (const [title, malformed] of [
  ['null instead of a list', 'null'],
  ['items without a name', '[{"pid": 1}, {"cwd": "/"}]'],
] as const) {
  test(`the host answers ${title} while the label is restored: the resume still returns the session`, async () => {
    let armed = false;
    let created = false;
    await withHistoryLab(async lab => {
      await lab.closedRenamed('claude', 'chosen name');
      armed = true;
      const answer = await lab.resume('claude');
      armed = false;   // the host's lists are normal again for the checks below
      assert.equal(answer.status, 200, answer.text);
      assert.ok(created, 'the list was malformed after the session was created');
      assert.ok(answer.id, 'the name of the session started is returned');
      assert.match(lab.serverOutput(), LABEL_REFUSED);
      assert.doesNotMatch(lab.serverOutput(), /Traceback/);
      assert.equal((await lab.resumed('claude', answer.id!)).label, null, 'nothing is applied from an unusable list');
    }, request => {
      if (!armed) return undefined;
      if (request.op === 'new') created = true;   // from the creation on, the list is the one the label step reads
      if (request.op === 'list' && created) return {rawReply: malformed};
      return undefined;
    });
  });
}
