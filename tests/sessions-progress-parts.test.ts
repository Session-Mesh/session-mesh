// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The session list's progressive loading, without a browser: the sessions known on this device
// (static/known-sessions.ts, with hostile stored values), the focus order (sessions-priority.ts),
// the host-silence rows (host-silence.ts), the open replay cutoff (open-replay.ts), the page signals
// (page-signals.ts), and the frame batcher and list window (keyed-render.ts, list-window.ts).
// The keyed morph itself needs a DOM: tests/sessions-progress-browser.test.ts.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {rowState} from '../static/sessions-contract.ts';
import {KNOWN_LIMIT, knownFrom, mayRemember, provisionalListing, readKnown} from '../static/known-sessions.ts';
import {focusRequest, priorityNames} from '../static/sessions-priority.ts';
import {SILENT_AFTER_MS, createHostSilence} from '../static/host-silence.ts';
import {openReplayCutoff, replayCutoff} from '../static/open-replay.ts';
import {watchPageSignals} from '../static/page-signals.ts';
import {createFrameBatcher, occurrenceKeys} from '../static/keyed-render.ts';
import {computeWindow, shownRowCount} from '../static/list-window.ts';

describe('sessions known on this device', () => {
  const listing = {home: '/home/me', folders: ['work'], mesh: [
    {kind: 'mesh', id: 's1', name: 's1', created: 10, cwd: '/home/me/p', folder: 'work', activity: 1234, label: 'my label',
      agent: {type: 'claude', session_id: 'abcdefgh1', title: 'a summary of the conversation', last: 'secret prompt'}},
    {kind: 'mesh', id: 's2', name: 's2', created: 11, cwd: '/x', activity: 99, provisional: true},
    {kind: 'mesh', id: 's3', name: 's3', created: 12, cwd: '/y', activity: 0, agent: {type: 'codex', session_id: null, title: 'model text'}},
  ]};
  test('keeps names, the owner label, folders and conversation ids; never agent text or titles', () => {
    const known = knownFrom(listing)!;
    assert.deepEqual(known.rows.map(row => row.name), ['s1', 's3'], 'a provisional row is never stored back');
    assert.deepEqual(known.rows[0], {id: 's1', name: 's1', created: 10, cwd: '/home/me/p', label: 'my label', folder: 'work',
      agent: {type: 'claude', session_id: 'abcdefgh1'}, known_agent: null, activity: 1200});
    assert.equal(known.rows[1]!.label, '', 'without an owner label nothing is stored, not the agent title');
    assert.ok(!JSON.stringify(known).includes('summary') && !JSON.stringify(known).includes('model text'));
    assert.deepEqual(readKnown(JSON.parse(JSON.stringify(known))), known);
    assert.equal(readKnown({rows: 'x'}), null);
  });

  test('hostile stored values are dropped field by field, or the row is', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const stored = {home: '/h', folders: ['ok', markup, 7], rows: [
      {id: 'good', name: 'good', created: 1, cwd: '/w', label: 'l', folder: 'ok', activity: 60,
        agent: {type: markup, session_id: 'x'}, known_agent: markup},
      {id: 'n', name: 'n', cwd: {toString: 'x'}, label: ['l'], folder: markup, activity: 'soon', created: 'never',
        agent: {type: 'claude', session_id: '"><b>'}},
      {id: 'other', name: markup}, {id: 'x', name: 'y'}, {name: 7}, null, 'row', [],
    ]};
    const known = readKnown(stored)!;
    assert.deepEqual(known.folders, ['ok']);
    assert.deepEqual(known.rows, [
      {id: 'good', name: 'good', created: 1, cwd: '/w', label: 'l', folder: 'ok', agent: null, known_agent: null, activity: 60},
      {id: 'n', name: 'n', created: null, cwd: '', label: '', folder: null, agent: {type: 'claude', session_id: null}, known_agent: null, activity: 0},
    ]);
    const shown = provisionalListing(known, [markup, 'from-layout']);
    assert.deepEqual((shown.mesh as {name: string}[]).map(row => row.name), ['good', 'n', 'from-layout']);
    assert.ok(!JSON.stringify(shown).includes('<'), 'no markup survives into the rows the sidebar draws');
  });

  test('bounded: at most KNOWN_LIMIT rows read back', () => {
    const rows = Array.from({length: KNOWN_LIMIT + 50}, (_, i) => ({id: `s${i}`, name: `s${i}`, cwd: '', label: ''}));
    assert.equal(readKnown({home: '', folders: [], rows})!.rows.length, KNOWN_LIMIT);
  });

  test('the provisional listing marks every row loading and adds layout names', () => {
    const shown = provisionalListing(knownFrom(listing), ['s1', 'from-layout']);
    assert.deepEqual((shown.mesh as {name: string}[]).map(row => row.name), ['s1', 's3', 'from-layout']);
    assert.ok((shown.mesh as Record<string, unknown>[]).every(row => rowState(row) === 'loading'));
    assert.equal(shown.provisional, true);
  });

  test('a page started before a sign-out (in any tab) never stores again; one started after may', () => {
    assert.equal(mayRemember(null, 1000), true, 'never signed out');
    assert.equal(mayRemember(2000, 1000), false, 'an older tab whose answer arrives after the sign-out');
    assert.equal(mayRemember(500, 1000), true, 'a page of the next sign-in');
    assert.equal(mayRemember('2000', 1000), true, 'a stored value that is not a time is ignored');
  });
});

describe('focus order', () => {
  test('focus, pinned, recently active, visible; no repeats; bounded', () => {
    const names = priorityNames({focus: ['p1', 'p2'], pinned: ['pin', 'p1'],
      recent: [{name: 'old', activity: 1}, {name: 'hot', activity: 9}], visible: ['v1', 'hot'], limit: 6});
    assert.deepEqual(names, ['p1', 'p2', 'pin', 'hot', 'old', 'v1']);
    assert.equal(priorityNames({focus: [], pinned: [], recent: [], visible: Array.from({length: 99}, (_, i) => `v${i}`)}).length, 64);
  });

  test('the page asks first for the retried row, then the active pane; only mesh sessions', () => {
    const sessions = new Set(['a', 'b', 'c', 'r', 'pin']);
    const names = focusRequest({retry: 'r', active: 'b', panes: ['a', 'b', 'doc:/x', null], pinned: ['pin', undefined, 'gone'],
      rows: [{id: 'c', activity: 5}, {id: 'a', activity: 'x'}], visible: ['c'], isSession: id => sessions.has(id)});
    assert.deepEqual(names, ['r', 'b', 'a', 'pin', 'c']);
  });
});

describe('host silence', () => {
  type Row = Record<string, unknown>;
  test('rows of the last listing stay shown, unreachable, while the host is silent; closed ones do not', () => {
    const silence = createHostSilence<Row>();
    const listed = [{name: 'a', id: 'a'}, {name: 'b', id: 'b'}];
    silence.update({mesh: listed}, [], true);
    assert.deepEqual(silence.shown(listed), listed);
    silence.noteClosed('b');
    silence.update({mesh: [], ptyhost: false}, listed, false);
    assert.deepEqual(silence.shown([]), [{name: 'a', id: 'a', rowState: 'unreachable'}]);
    silence.update({mesh: [], ptyhost: false}, [], false);
    assert.deepEqual(silence.shown([]).map(row => row.name), ['a'], 'kept across silent answers');
    silence.update({mesh: [{name: 'a'}]}, [], true);
    assert.deepEqual(silence.shown([]), [], 'a listing with rows ends the silence');
  });

  test('an observed listing clears the closed names', () => {
    const silence = createHostSilence<Row>();
    silence.noteClosed('a');
    silence.update({mesh: [{name: 'a'}]}, [], true);
    silence.update({mesh: [], host: 'silent'}, [{name: 'a'}], false);
    assert.deepEqual(silence.shown([]).map(row => row.name), ['a']);
  });

  test('a silent listing that keeps its rows: believed after two answers, rows then unreachable', () => {
    let time = 0;
    const silence = createHostSilence<Row>(() => time);
    const rows = [{name: 'a', id: 'a', ready: true}];
    silence.update({mesh: rows, host: 'silent'}, rows, false);
    assert.equal(silence.silent(), false, 'one silent answer may be a slow round: no flicker');
    assert.deepEqual(silence.shown(rows), rows);
    silence.update({mesh: rows, host: 'ok'}, rows, true);
    time = 1000;
    silence.update({mesh: rows, host: 'silent'}, rows, false);
    assert.equal(silence.silent(), false, 'the streak restarts after an ok answer');
    time = 2000;
    silence.update({mesh: rows, host: 'silent'}, rows, false);
    assert.equal(silence.silent(), true);
    assert.deepEqual(silence.shown(rows), [{name: 'a', id: 'a', ready: true, rowState: 'unreachable'}]);
    silence.update({mesh: rows, host: 'ok'}, rows, true);
    assert.deepEqual([silence.silent(), silence.shown(rows)], [false, rows]);
  });

  test('or 3 s after the first silent answer', () => {
    let time = 0;
    const silence = createHostSilence<Row>(() => time);
    silence.update({mesh: [{name: 'a'}], host: 'silent'}, [], false);
    time = SILENT_AFTER_MS - 1;
    assert.equal(silence.silent(), false);
    time = SILENT_AFTER_MS;
    assert.equal(silence.silent(), true);
  });
});

describe('open replay', () => {
  test('opens made before the page started are not replayed; later ones are', () => {
    assert.equal(openReplayCutoff([], 100), 0);
    assert.equal(openReplayCutoff([{seq: 1, at: 50}, {seq: 2, at: 99}, {seq: 3, at: 101}], 100), 2);
    assert.equal(openReplayCutoff([{seq: 4}, {seq: 5, at: 'late'}], 100), 5, 'an open without a time is old');
  });

  test('an answer without opens (a skeleton) sets no cutoff; a set cutoff is kept', () => {
    assert.equal(replayCutoff(null, undefined, 100), null, 'not 0: the opens of the next full answer would all replay');
    assert.equal(replayCutoff(null, [{seq: 3, at: 50}, {seq: 4, at: 150}], 100), 3);
    assert.equal(replayCutoff(3, [{seq: 9, at: 50}], 100), 3);
    assert.equal(replayCutoff(3, undefined, 100), 3);
  });
});

describe('page signals', () => {
  test('hidden: a 30 s floor; visible or back online: an answer at once; offline is reported', () => {
    const win = Object.assign(new EventTarget(), {navigator: {onLine: true}});
    const doc = Object.assign(new EventTarget(), {hidden: true});
    let wakes = 0, changes = 0;
    const signals = watchPageSignals({win, doc, wake: () => wakes++, changed: () => changes++});
    assert.equal(signals.minDelayMs(), 30_000);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual([signals.minDelayMs(), wakes], [0, 1]);
    win.dispatchEvent(new Event('offline'));
    assert.deepEqual([signals.offline(), changes, wakes], [true, 1, 1]);
    win.dispatchEvent(new Event('online'));
    assert.deepEqual([signals.offline(), changes, wakes], [false, 2, 2]);
    signals.dispose();
    win.dispatchEvent(new Event('online'));
    assert.equal(wakes, 2);
  });
});

describe('frame batcher and list window', () => {
  test('one render per frame however many requests', () => {
    const queue: (() => void)[] = [];
    let renders = 0;
    const batcher = createFrameBatcher(() => renders++, {request: run => queue.push(run), cancel: () => {}});
    for (let i = 0; i < 300; i++) batcher.request();
    assert.equal(queue.length, 1);
    queue.shift()!();
    assert.equal(renders, 1);
    batcher.request();
    assert.equal(batcher.pending(), true);
    assert.equal(batcher.cancel(), true, 'a cancelled render is reported, so the caller can do the rest of it');
    assert.equal(batcher.cancel(), false);
  });

  test('repeated keys get occurrence numbers; folded runs count no rows', () => {
    assert.deepEqual(occurrenceKeys(['a', 'b', 'a']), ['a#0', 'b#0', 'a#1']);
    assert.equal(shownRowCount([{size: 150, folded: false}, {size: 90, folded: true}, {size: 60, folded: false}]), 210);
  });

  test('the window covers the viewport plus overscan, spacers stand for the rest', () => {
    const window = computeWindow({count: 300, rowHeight: 40, runTop: 100, scrollTop: 2100, viewport: 800, overscan: 5});
    assert.deepEqual(window, {ranges: [{start: 45, end: 75}], pads: [1800, 9000]});
  });

  test('a run out of view renders nothing; a kept row far away is rendered alone, between spacers', () => {
    const below = computeWindow({count: 300, rowHeight: 40, runTop: 50_000, scrollTop: 0, viewport: 800, overscan: 5});
    assert.deepEqual(below, {ranges: [], pads: [12_000]});
    const kept = computeWindow({count: 300, rowHeight: 40, runTop: 0, scrollTop: 10_000, viewport: 800, overscan: 5, keep: [0]});
    assert.deepEqual(kept.ranges, [{start: 0, end: 1}, {start: 245, end: 275}]);
    assert.deepEqual(kept.pads, [0, 244 * 40, 25 * 40]);
    const rows = kept.ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    assert.equal(kept.pads.reduce((a, b) => a + b, 0) + rows * 40, 300 * 40, 'the scroll height is kept');
    const near = computeWindow({count: 300, rowHeight: 40, runTop: 0, scrollTop: 10_000, viewport: 800, overscan: 5, keep: [275, -1, 900]});
    assert.deepEqual(near.ranges, [{start: 245, end: 276}], 'a kept row next to the window joins it; invalid indexes are ignored');
  });

  test('bounded for 10 000 rows, even with a kept row at the other end', () => {
    const window = computeWindow({count: 10_000, rowHeight: 46, runTop: 0, scrollTop: 230_000, viewport: 900, overscan: 8, keep: [0]});
    assert.ok(window.ranges.reduce((sum, range) => sum + range.end - range.start, 0) <= 41);
  });
});
