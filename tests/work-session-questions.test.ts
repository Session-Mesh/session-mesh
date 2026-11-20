// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session marker: the parsing of `session-questions` and the join by session name (static/work-session-questions.ts),
// and the reads behind it (static/work-session-marker.ts) against a fake fetch and a fake clock. The marker on the page
// runs in tests/session-questions-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSlots } from '../static/work-api.ts';
import { createSessionMarker, MARKER_INTERVAL_MS } from '../static/work-session-marker.ts';
import { markerIndex, markerTarget, parseSessionQuestions } from '../static/work-session-questions.ts';
import type { SessionEntry } from '../static/work-session-questions.ts';

const entry = (questions: { id: string; about?: string; project?: string }[], omitted = 0): SessionEntry => ({
  name: 's', count: questions.length + omitted, omitted,
  questions: questions.map(q => ({ id: q.id, about: q.about ?? null, project: q.project ?? null })),
});

const DOC = {
  schema: 1, command: 'session-questions', open_questions: 7, total: 3, truncated: false,
  sessions: [
    { name: 'alpha', open_questions: 2, questions: [{ id: 'N-1', about: 'T-1a', project: 'P-9' }, { id: 'N-2', about: 'T-1a', project: 'P-9' }] },
    { name: 'beta', open_questions: 1, questions: [{ id: 'N-3' }] },
    { name: '<img src=x onerror=alert(1)>', open_questions: 1, questions: [{ id: 'N-4', about: 'P-9', project: 'P-9' }] },
  ],
};

describe('parsing session-questions', () => {
  test('sessions by name, with their count and questions; strings kept as received', () => {
    const doc = parseSessionQuestions(DOC);
    assert.ok(doc);
    assert.equal(doc.openQuestions, 7);
    assert.deepEqual(doc.sessions.map(s => [s.name, s.count]), [['alpha', 2], ['beta', 1], ['<img src=x onerror=alert(1)>', 1]]);
    assert.deepEqual(doc.sessions[1]!.questions, [{ id: 'N-3', about: null, project: null }]);
  });

  test('not a document: null; junk entries dropped; a repeated name keeps its first entry; a repeated question once', () => {
    assert.equal(parseSessionQuestions(null), null);
    assert.equal(parseSessionQuestions({ open_questions: 1 }), null, 'no sessions list');
    assert.equal(parseSessionQuestions([]), null);
    const doc = parseSessionQuestions({ open_questions: -3, sessions: [
      null, 7, { open_questions: 2 }, { name: '', open_questions: 1 },
      { name: 'one', open_questions: 'x', questions: [{ id: 'N-1' }, { id: 'N-1' }, { about: 'T-1' }, 'junk'] },
      { name: 'one', open_questions: 9, questions: [] },
    ] });
    assert.ok(doc);
    assert.equal(doc.openQuestions, 0);
    assert.deepEqual(doc.sessions, [{ name: 'one', count: 1, questions: [{ id: 'N-1', about: null, project: null }], omitted: 0 }]);
  });

  test('the count is never below what is listed plus what was left out', () => {
    const doc = parseSessionQuestions({ sessions: [{ name: 'a', open_questions: 1, questions: [{ id: 'N-1' }, { id: 'N-2' }], questions_omitted: 3 }] });
    assert.equal(doc?.sessions[0]?.count, 5);
  });
});

describe('where the marker leads', () => {
  test('all about one task: its sheet', () => {
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'T-1a', project: 'P-9' }, { id: 'N-2', about: 'T-1a', project: 'P-9' }])),
      { kind: 'task', id: 'T-1a' });
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'T-1a' }])), { kind: 'task', id: 'T-1a' }, 'a task outside any project too');
  });

  test('all in one project (about it or its tasks): its Questions tab', () => {
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'T-1a', project: 'P-9' }, { id: 'N-2', about: 'T-2b', project: 'P-9' }])),
      { kind: 'project', id: 'P-9' });
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'P-9', project: 'P-9' }, { id: 'N-2', about: 'T-2b', project: 'P-9' }])),
      { kind: 'project', id: 'P-9' });
  });

  test('anything else: the entry screen', () => {
    assert.deepEqual(markerTarget(entry([{ id: 'N-1' }])), { kind: 'entry' }, 'about nothing');
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'T-1a', project: 'P-9' }, { id: 'N-2', about: 'T-2b', project: 'P-8' }])),
      { kind: 'entry' }, 'two projects');
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'T-1a', project: 'P-9' }, { id: 'N-2' }])), { kind: 'entry' }, 'one about nothing');
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'T-1a', project: 'P-9' }], 2)), { kind: 'entry' }, 'some left out');
    assert.deepEqual(markerTarget(entry([])), { kind: 'entry' });
    assert.deepEqual(markerTarget(entry([{ id: 'N-1', about: 'X-1', project: 'Z-1' }])), { kind: 'entry' }, 'unexpected references');
  });

  test('the index holds only the sessions with an open question, by exact name', () => {
    const index = markerIndex(parseSessionQuestions({ sessions: [...DOC.sessions, { name: 'zero', open_questions: 0, questions: [] }] })!);
    assert.deepEqual([...index.keys()], ['alpha', 'beta', '<img src=x onerror=alert(1)>']);
    assert.deepEqual(index.get('alpha'), { count: 2, target: { kind: 'task', id: 'T-1a' } });
    assert.equal(index.get('Alpha'), undefined, 'names are compared exactly');
  });
});

type Reply = { status: number; body: unknown };
const OK: Reply = { status: 200, body: DOC };
const error = (status: number, code: string): Reply => ({ status, body: { error: { code, message: code } } });

/** A marker over a fake fetch answering from `replies` (the last one repeats) and a clock the test moves. */
function rig(replies: Reply[], visible = () => true) {
  let now = 1_000_000, changes = 0;
  const ops: string[] = [];
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    ops.push(String(JSON.parse(String(init.body)).op));
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  const marker = createSessionMarker({ request, onChange: () => { changes++; }, visible, now: () => now,
    api: { slots: readSlots(2), busyDelays: [] } });
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  return { marker, ops, changes: () => changes, advance: (ms: number) => { now += ms; }, settle };
}

describe('the reads behind the marker', () => {
  test('one read at the first tick, then none before a minute, then one; refresh reads at the next tick', async () => {
    const r = rig([OK]);
    r.marker.tick(); r.marker.tick();
    await r.settle();
    assert.deepEqual(r.ops, ['session-questions'], 'one read, none while it is in flight');
    assert.equal(r.marker.marker('alpha')?.count, 2);
    assert.equal(r.marker.marker('nobody'), null);
    assert.equal(r.marker.openQuestions(), 7);
    assert.equal(r.changes(), 1);
    for (let second = 4; second < 60; second += 4) { r.advance(4000); r.marker.tick(); await r.settle(); }
    assert.equal(r.ops.length, 1, 'no read within the minute, however often the listing comes');
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    assert.equal(r.ops.length, 2);
    assert.equal(r.changes(), 1, 'the same markers do not redraw');
    r.marker.refresh(); r.marker.tick(); await r.settle();
    assert.equal(r.ops.length, 3, 'a refresh reads at once');
  });

  test('a hidden page does not read', async () => {
    let shown = false;
    const r = rig([OK], () => shown);
    r.marker.tick(); await r.settle();
    assert.equal(r.ops.length, 0);
    shown = true; r.marker.tick(); await r.settle();
    assert.equal(r.ops.length, 1);
  });

  for (const [status, code] of [[503, 'not_available'], [400, 'invalid_input']] as const) {
    test(`${code} (${status}): no marker, and no read again`, async () => {
      const r = rig([OK, error(status, code)]);
      r.marker.tick(); await r.settle();
      r.marker.refresh(); r.marker.tick(); await r.settle();
      assert.equal(r.marker.marker('alpha'), null, 'the earlier markers are gone');
      assert.equal(r.marker.openQuestions(), null);
      r.advance(10 * MARKER_INTERVAL_MS); r.marker.refresh(); r.marker.tick(); await r.settle();
      assert.equal(r.ops.length, 2, 'stopped for the page');
    });
  }

  test('no tracker: no marker, read again a minute later; busy keeps the markers shown', async () => {
    const r = rig([error(502, 'repository'), OK, error(503, 'busy'), error(502, 'internal')]);
    r.marker.tick(); await r.settle();
    assert.equal(r.marker.marker('alpha'), null);
    assert.equal(r.changes(), 0, 'nothing shown, nothing changed');
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    assert.equal(r.marker.marker('alpha')?.count, 2);
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    assert.equal(r.marker.marker('alpha')?.count, 2, 'busy: kept');
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    assert.equal(r.marker.marker('alpha'), null, 'another failure: cleared');
    assert.equal(r.ops.length, 4);
  });

  test('stop: no more reads', async () => {
    const r = rig([OK]);
    r.marker.stop(); r.marker.tick(); await r.settle();
    assert.equal(r.ops.length, 0);
  });
});
