// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sameSessionTool} from '../static/session-project-tools.ts';
import {parseHostReply} from '../static/project-host.ts';

test('project tool identity never falls back to a machine or session name', () => {
  const reference = {machine_id: 'local', name: 'same', created: 12};
  assert.equal(sameSessionTool(reference, {...reference}), true);
  assert.equal(sameSessionTool(reference, {...reference, machine_id: 'foreign'}), false);
  assert.equal(sameSessionTool(reference, {...reference, created: 13}), false);
  assert.equal(sameSessionTool(reference, {...reference, name: 'another'}), false);
});

test('bounded native owner projection preserves missing evidence and refuses incomplete session fields', () => {
  const project = {id: 'fixture', title: 'Fixture', sessions_total: 1, participations_total: 0, folders_total: 0, sources_total: 0};
  const reply = {kind: 'mesh-project-reply', version: 1, op: 'project_read', boot: 'a'.repeat(64), status: 'ok', machine_id: 'local', project, omitted_fields: ['sessions']};
  assert.equal(parseHostReply(reply, 'project_read').project!.sessions, undefined);
  assert.throws(() => parseHostReply({...reply, project: {...project, sessions: []}}, 'project_read'));
  const valid = {machine_id: 'local', name: 'same', created: 12};
  assert.deepEqual(parseHostReply({...reply, project: {...project, sessions: [valid]}, omitted_fields: []}, 'project_read').project!.sessions, [valid]);
  assert.throws(() => parseHostReply({...reply, project: {...project, sessions: [{...valid, created: NaN}]}}, 'project_read'));
  assert.throws(() => parseHostReply({...reply, project: {...project, sessions: [{...valid, machine_id: '../foreign'}]}}, 'project_read'));
});
