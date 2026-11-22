// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecordedSessions } from '../static/work-project-sessions.ts';

const doc = { schema: 1, command: 'sessions-of', truncated: false, scope: { kind: 'project', id: 'P-5e6f' }, total: 2,
  sessions: [{ name: 'first', agent: 'claude', last_activity: '2026-11-20T10:00:00Z' }] };

test('recorded sessions remain scoped and show omissions', () => {
  assert.deepEqual(parseRecordedSessions(doc, 'P-5e6f'), { sessions: [{ name: 'first', agent: 'claude', last: '2026-11-20T10:00:00Z' }], total: 2, omitted: 1, partial: true });
  assert.equal(parseRecordedSessions(doc, 'P-0000'), null);
  assert.equal(parseRecordedSessions({ ...doc, scope: { kind: 'task', id: 'P-5e6f' } }, 'P-5e6f'), null);
});

test('malformed or incomplete session documents are not presented as empty', () => {
  assert.equal(parseRecordedSessions({ ...doc, total: 0 }, 'P-5e6f'), null);
  assert.equal(parseRecordedSessions({ ...doc, sessions: [{ name: 'first' }] }, 'P-5e6f'), null);
  assert.equal(parseRecordedSessions({ ...doc, sessions_omitted: -1 }, 'P-5e6f'), null);
  assert.equal(parseRecordedSessions({ ...doc, sessions: Array(101).fill(doc.sessions[0]) }, 'P-5e6f'), null);
});

test('truncation and source warnings never look complete', () => {
  const complete = { ...doc, total: 1 };
  assert.equal(parseRecordedSessions(complete, 'P-5e6f')?.partial, false);
  assert.equal(parseRecordedSessions({ ...complete, truncated: true }, 'P-5e6f')?.partial, true);
  assert.equal(parseRecordedSessions({ ...complete, data_warnings: ['bad event'] }, 'P-5e6f')?.partial, true);
  assert.equal(parseRecordedSessions({ ...complete, data_warnings_omitted: 1 }, 'P-5e6f')?.partial, true);
  assert.equal(parseRecordedSessions({ ...complete, schema: 2 }, 'P-5e6f'), null);
  assert.equal(parseRecordedSessions({ ...complete, command: 'task' }, 'P-5e6f'), null);
  assert.equal(parseRecordedSessions({ ...complete, data_warnings: 'bad' }, 'P-5e6f'), null);
});
