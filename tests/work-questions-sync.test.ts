// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The way an answered question leaves every surface: the questions channel (static/work-questions-sync.ts), the
// session marker hearing it (static/work-session-marker.ts) against a fake fetch whose replies the test releases and a
// fake clock, and the way back of the Projects view over a fake history (static/work-nav.ts). The page runs them in
// tests/work-back-answered-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSlots } from '../static/work-api.ts';
import { createWorkNav, levelOf } from '../static/work-nav.ts';
import { createQuestionsSync } from '../static/work-questions-sync.ts';
import type { QuestionsChange } from '../static/work-questions-sync.ts';
import { createSessionMarker, MARKER_INTERVAL_MS } from '../static/work-session-marker.ts';
import { parseSessionQuestions, withoutAnswered } from '../static/work-session-questions.ts';

const doc = (open: number, alpha: string[], beta: string[]) => ({
  schema: 1, command: 'session-questions', open_questions: open,
  sessions: [
    { name: 'alpha', open_questions: alpha.length, questions: alpha.map(id => ({ id, about: 'T-1a', project: 'P-9' })) },
    { name: 'beta', open_questions: beta.length, questions: beta.map(id => ({ id, about: 'T-1a', project: 'P-9' })) },
  ],
});
const BEFORE = doc(3, ['N-1', 'N-2'], ['N-1', 'N-3']);   // N-1 asked by alpha, about a task beta is linked to
const AFTER = doc(2, ['N-2'], ['N-3']);

describe('the questions channel', () => {
  test('a reader hears the other one, never itself; an unchanged count is not sent again; an answer always is', () => {
    const sync = createQuestionsSync();
    const view: QuestionsChange[] = [], marker: QuestionsChange[] = [];
    sync.subscribe('view', change => view.push(change));
    const stop = sync.subscribe('marker', change => marker.push(change));
    sync.publish({ source: 'view', openQuestions: 3 });
    sync.publish({ source: 'marker', openQuestions: 3 });
    sync.publish({ source: 'view', openQuestions: 3 });
    assert.deepEqual(marker, [{ source: 'view', openQuestions: 3 }]);
    assert.deepEqual(view, [], 'the marker agreed: nothing to tell');
    sync.publish({ source: 'view', answered: 'N-1' });
    sync.publish({ source: 'view', answered: 'N-1' });
    assert.equal(marker.length, 3, 'each answer is news');
    assert.equal(sync.lastCount(), 3, 'an answer alone does not move the count');
    sync.publish({ source: 'view', openQuestions: null });
    assert.deepEqual(marker.at(-1), { source: 'view', openQuestions: null }, 'a failed read is news too');
    stop();
    sync.publish({ source: 'view', openQuestions: 1 });
    assert.equal(marker.length, 4, 'nothing after unsubscribing');
  });
});

describe('an answered question leaves the marker document', () => {
  test('every session listing it counts one less, the total too; one nobody lists gives null', () => {
    const parsed = parseSessionQuestions(BEFORE)!;
    const without = withoutAnswered(parsed, 'N-1')!;
    assert.deepEqual(without.sessions.map(entry => [entry.name, entry.count, entry.questions.map(q => q.id)]),
      [['alpha', 1, ['N-2']], ['beta', 1, ['N-3']]]);
    assert.equal(without.openQuestions, 2, 'the question counts once in the total');
    assert.equal(withoutAnswered(parsed, 'N-9'), null);
    const omitted = parseSessionQuestions({ open_questions: 4, sessions: [{ name: 'a', open_questions: 4, questions: [{ id: 'N-1' }], questions_omitted: 3 }] })!;
    assert.equal(withoutAnswered(omitted, 'N-1')?.sessions[0]?.count, 3, 'the ones left out still count');
  });
});

/** A marker over a fake fetch: each read waits until the test releases it with a document (or a status). */
function rig() {
  let now = 1_000_000, changes = 0;
  const sync = createQuestionsSync();
  const heard: QuestionsChange[] = [];
  sync.subscribe('view', change => heard.push(change));
  const pending: ((reply: { status: number; body: unknown }) => void)[] = [];
  const request = (): Promise<Response> => new Promise(resolve => {
    pending.push(reply => resolve(new Response(JSON.stringify(reply.body), { status: reply.status })));
  });
  const marker = createSessionMarker({ request, onChange: () => { changes++; }, now: () => now, sync,
    api: { slots: readSlots(2), busyDelays: [] } });
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  const release = async (body: unknown, status = 200): Promise<void> => { pending.shift()!({ status, body }); await settle(); await settle(); };
  return { marker, sync, heard, reads: () => pending.length, changes: () => changes, advance: (ms: number) => { now += ms; }, settle, release };
}

describe('the marker hears the view', () => {
  test('an answer drops the question at once, then a read starts now, not a minute later', async () => {
    const r = rig();
    r.marker.tick(); await r.settle();
    await r.release(BEFORE);
    assert.equal(r.marker.marker('alpha')?.count, 2);
    assert.equal(r.changes(), 1);
    r.advance(1000);
    r.sync.publish({ source: 'view', answered: 'N-1' });
    assert.equal(r.marker.marker('alpha')?.count, 1, 'dropped before any read');
    assert.equal(r.marker.marker('beta')?.count, 1, 'from every session that listed it');
    assert.equal(r.marker.openQuestions(), 2);
    assert.equal(r.changes(), 2, 'the page redraws at once');
    await r.settle();
    assert.equal(r.reads(), 1, 'a read started at once, within the minute');
    await r.release(AFTER);
    assert.equal(r.changes(), 3, 'the confirming read reports even though it changed nothing');
    assert.equal(r.marker.marker('alpha')?.count, 1);
  });

  test('a read started before the answer is discarded and read again, so the question never comes back', async () => {
    const r = rig();
    r.marker.tick(); await r.settle();
    await r.release(BEFORE);
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    assert.equal(r.reads(), 1, 'the minute read is in flight');
    r.sync.publish({ source: 'view', answered: 'N-1' });
    assert.equal(r.marker.marker('alpha')?.count, 1);
    await r.release(BEFORE);   // the tracker as it was before the answer
    assert.equal(r.marker.marker('alpha')?.count, 1, 'the old read does not bring the question back');
    assert.equal(r.reads(), 1, 'a new read started when the old one settled');
    await r.release(AFTER);
    assert.equal(r.marker.openQuestions(), 2);
  });

  test('after a failed read of the view (badge emptied), the next read reports even an unchanged count', async () => {
    const r = rig();
    r.marker.tick(); await r.settle();
    await r.release(AFTER);
    assert.equal(r.changes(), 1);
    r.sync.publish({ source: 'view', openQuestions: null });   // the view wrote "unknown" to the badge
    await r.settle();
    assert.equal(r.reads(), 1, 'read at once');
    await r.release(AFTER);
    assert.equal(r.changes(), 2, 'the same markers, reported again so that the badge shows the count');
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    await r.release(AFTER);
    assert.equal(r.changes(), 2, 'an ordinary read with nothing new stays silent');
  });

  test('a read that finds another count tells the view; the same count does not', async () => {
    const r = rig();
    r.marker.tick(); await r.settle();
    await r.release(BEFORE);
    assert.deepEqual(r.heard, [{ source: 'marker', openQuestions: 3 }]);
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    await r.release(BEFORE);
    assert.equal(r.heard.length, 1);
    r.advance(MARKER_INTERVAL_MS); r.marker.tick(); await r.settle();
    await r.release(AFTER);   // answered elsewhere
    assert.deepEqual(r.heard.at(-1), { source: 'marker', openQuestions: 2 });
  });

  test('a stopped marker hears nothing and reads nothing', async () => {
    const r = rig();
    r.marker.stop();
    r.sync.publish({ source: 'view', answered: 'N-1' });
    await r.settle();
    assert.equal(r.reads(), 0);
    assert.equal(r.changes(), 0);
  });

  test('a hidden page takes the answer at once but reads only when shown', async () => {
    let shown = true;
    const sync = createQuestionsSync();
    const pending: (() => void)[] = [];
    let changes = 0;
    const request = (): Promise<Response> => new Promise(resolve => pending.push(() => resolve(new Response(JSON.stringify(BEFORE)))));
    const marker = createSessionMarker({ request, onChange: () => { changes++; }, visible: () => shown, sync,
      api: { slots: readSlots(2), busyDelays: [] } });
    marker.tick(); await new Promise(resolve => setTimeout(resolve, 0));
    pending.shift()!(); await new Promise(resolve => setTimeout(resolve, 0));
    shown = false;
    sync.publish({ source: 'view', answered: 'N-1' });
    assert.equal(marker.openQuestions(), 2);
    assert.equal(changes, 2);
    assert.equal(pending.length, 0, 'no read while hidden');
    shown = true; marker.tick(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(pending.length, 1, 'the read is due at the next tick');
  });
});

/** A fake history: the entries, where the page is, and the popstate the browser would send after a `go`. */
function fakeHistory() {
  const entries: unknown[] = [null];
  let index = 0;
  const queued: unknown[] = [];
  return {
    entries, index: () => index, queued,
    port: {
      pushState: (state: unknown) => { entries.splice(index + 1); entries.push(state); index++; },
      go: (delta: number) => { index = Math.max(0, Math.min(entries.length - 1, index + delta)); queued.push(entries[index]); },
    },
    /** The owner presses the browser's Back: the state of the entry landed on. */
    back: () => { index = Math.max(0, index - 1); return entries[index]; },
    forward: () => { index = Math.min(entries.length - 1, index + 1); return entries[index]; },
  };
}

describe('the way back of the Projects view', () => {
  test('one entry per level above the entry screen; going up by the view takes them back, and their popstate is not a Back', () => {
    const history = fakeHistory();
    const nav = createWorkNav(history.port);
    nav.at(1); nav.at(2); nav.at(2);
    assert.deepEqual(history.entries.map(levelOf), [0, 1, 2], 'bounded: two entries at most');
    nav.at(0);
    assert.equal(history.index(), 0);
    assert.equal(nav.popped(history.queued.shift()), null, 'the popstate of its own move is ignored');
    assert.equal(nav.level(), 0);
  });

  test('the browser Back goes up one level at a time: sheet, then tab, then the entry screen', () => {
    const history = fakeHistory();
    const nav = createWorkNav(history.port);
    nav.at(1); nav.at(2);
    assert.equal(nav.popped(history.back()), 1, 'from the sheet to the tab');
    nav.at(1);   // the view closes the sheet and says so: nothing more moves
    assert.equal(history.queued.length, 0);
    assert.equal(nav.popped(history.back()), 0, 'from the tab to the entry screen');
    assert.equal(history.index(), 0, 'the page itself was never left');
  });

  test('a Forward to a level the view no longer shows is undone', () => {
    const history = fakeHistory();
    const nav = createWorkNav(history.port);
    nav.at(1); nav.at(2);
    nav.popped(history.back());
    assert.equal(nav.popped(history.forward()), null);
    assert.equal(history.index(), 1, 'back where the view is');
    assert.equal(nav.popped(history.queued.shift()), null);
  });

  test('a level asked while its own move is under way waits for that move to land', () => {
    const history = fakeHistory();
    const nav = createWorkNav(history.port);
    nav.at(1); nav.at(2);
    nav.at(0);    // the view closes: go(-2) is under way
    nav.at(1);    // and opens again at once
    assert.deepEqual(history.entries.map(levelOf), [0, 1, 2], 'nothing pushed before the move landed');
    nav.popped(history.queued.shift());
    assert.equal(history.index(), 1);
    assert.deepEqual(history.entries.map(levelOf), [0, 1], 'pushed from the entry screen once there');
  });

  test('an entry of the page that is not one of the view stands for the entry screen', () => {
    assert.equal(levelOf(null), 0);
    assert.equal(levelOf({ meshWorkLevel: 7 }), 0);
    assert.equal(levelOf({ meshWorkLevel: 2 }), 2);
    assert.equal(levelOf('meshWorkLevel'), 0);
  });
});
