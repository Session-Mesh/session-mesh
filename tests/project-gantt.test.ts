// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockGantt, clockPosition, clockTicks } from '../static/project-gantt-model.ts';
import { roadmapRows } from '../static/project-followup-model.ts';
import { followupCatalog, roadmapObservation, roadmapTask, attemptObservation } from './helpers/project-followup-fixtures.ts';

function model(tasks: Record<string, unknown>[], generated = '2026-11-14T12:00:00Z') {
  const summary = followupCatalog(roadmapObservation(tasks, { generated_at: generated })).projects[0]!.sources[0]!.summary!;
  return clockGantt(roadmapRows(summary), summary);
}
test('clock geometry retains retry identity, outcomes and their actual horizontal positions', () => {
  const value = model([roadmapTask({ attempts: 2, timeline: [
    attemptObservation(1, { outcome: 'released', claimed_at: '2026-11-14T09:00:00Z', ended_at: '2026-11-14T09:20:00Z' }),
    attemptObservation(2, { outcome: 'done', claimed_at: '2026-11-14T11:00:00Z', ended_at: '2026-11-14T11:40:00Z' }),
  ] })]);
  const segments = value.rows[0]!.segments;
  assert.equal(segments.length, 2); assert.deepEqual(segments.map(s => s.ordinal), [1, 2]);
  assert.deepEqual(segments.map(s => s.outcome), ['released', 'done']);
  assert.ok(clockPosition(segments[1]!.start, value)! > clockPosition(segments[0]!.end, value)!);
  assert.equal(segments[1]!.end - segments[1]!.start, 40 * 60000);
});
test('open attempts end at the recorded snapshot, not the current browser time', () => {
  const task = roadmapTask({ state: 'active', attempts: 1, assignment: { id: 'attempt-1' },
    timeline: [attemptObservation(1, { outcome: 'active', ended_at: null })], progress: { status: 'unreported', sequence: 0 } });
  const value = model([task]);
  assert.equal(value.rows[0]!.segments[0]!.end, Date.parse('2026-11-14T12:00:00Z'));
  assert.equal(value.conditionalForecast, false);
});
test('invalid or missing recorded dates do not become zero-duration bars', () => {
  const value = model([roadmapTask({ attempts: 3, timeline: [
    attemptObservation(1, { claimed_at: 'not-a-time' }),
    attemptObservation(2, { ended_at: '2026-11-14T09:00:00Z' }),
    attemptObservation(3, { claimed_at: '2026-11-14T13:00:00Z', ended_at: '2026-11-14T13:10:00Z' }),
  ] })]);
  assert.deepEqual(value.rows[0]!.segments, []); assert.equal(value.rows[0]!.unknownAttempts, 3);
  assert.equal(value.rows[0]!.unknown, 'time-unknown');
  assert.equal(clockPosition(Infinity, value), null);
});
test('the real-board shape keeps four recorded rows and thirteen explicitly unestimated rows', () => {
  const done = Array.from({ length: 4 }, (_, i) => roadmapTask({ id: `done-${i}`, state: 'done', attempts: 1,
    timeline: [attemptObservation(1, { outcome: 'done' })] }));
  const queued = Array.from({ length: 13 }, (_, i) => roadmapTask({ id: `next-${i}` }));
  const value = model([...done, ...queued]);
  assert.equal(value.rows.length, 17);
  assert.equal(value.rows.filter(row => row.segments.length).length, 4);
  assert.equal(value.rows.filter(row => row.unknown === 'unestimated').length, 13);
  assert.equal(value.conditionalForecast, false);
});
test('truncated history keeps all observed attempts and marks the window as incomplete', () => {
  const timeline = Array.from({ length: 201 }, (_, index) => attemptObservation(index + 1));
  const value = model([roadmapTask({ attempts: timeline.length, timeline })]);
  assert.equal(value.rows[0]!.segments.length, 200); assert.equal(value.rows[0]!.truncated, true);
  assert.equal(value.rows[0]!.segments[0]!.ordinal, 2);
});
test('conditional remaining projections respect known prerequisites and never use global ETA as a task duration', () => {
  const range = (likely: number) => ({ optimistic: likely / 2, likely, pessimistic: likely * 2 });
  const estimated = (id: string, likely: number, depends_on: string[] = []) => roadmapTask({ id, depends_on,
    estimate: { id, status: 'conditional', duration_minutes: range(likely), remaining_minutes: range(likely),
      source: 'planner-duration', overdue: false, reestimate_needed: false, reasons: [] } });
  const value = model([estimated('first', 10), estimated('second', 20, ['first'])]);
  const [first, second] = value.rows.map(row => row.segments[0]!);
  assert.equal(value.conditionalForecast, true);
  assert.equal(first!.end, second!.start);
  assert.equal(second!.latest - value.observed!, 60 * 60000);
  assert.equal(second!.earliest - value.observed!, 5 * 60000);
  const unknown = model([estimated('first', 10), roadmapTask({ id: 'unknown' })]);
  assert.equal(unknown.conditionalForecast, true, 'an unrelated unknown does not erase the known independent branch');
  assert.equal(unknown.rows[1]!.unknown, 'unestimated');
  const missingPredecessor = model([estimated('first', 10, ['unknown']), roadmapTask({ id: 'unknown' })]);
  assert.equal(missingPredecessor.conditionalForecast, false);
  assert.equal(missingPredecessor.rows[0]!.unknown, 'forecast-unresolved');
});
test('clock ticks remain finite and sparse over zero or long recorded spans', () => {
  const value = model([]), ticks = clockTicks(value, 700);
  assert.ok(ticks.length > 0 && ticks.length <= 32);
  assert.ok(ticks.every(Number.isFinite));
  assert.deepEqual(clockTicks({ from: null, to: null }, 700), []);
  assert.equal(clockPosition(1, { from: null, to: null }), null);
});
test('missing observation time and stale or blocked estimates cannot manufacture future positions', () => {
  const range = { optimistic: 10, likely: 20, pessimistic: 30 };
  const task = roadmapTask({ id: 'stale', estimate: { id: 'stale', status: 'conditional', duration_minutes: range, remaining_minutes: range,
    source: 'planner-duration', overdue: true, reestimate_needed: true, reasons: [] } });
  assert.equal(model([task]).conditionalForecast, false);
  const blocked = structuredClone(task); (blocked.estimate as Record<string, unknown>).reestimate_needed = false; blocked.state = 'blocked';
  assert.equal(model([blocked]).conditionalForecast, false);
  const summary = followupCatalog(roadmapObservation([roadmapTask({ attempts: 1, timeline: [attemptObservation(1)] })])).projects[0]!.sources[0]!.summary!;
  summary.source_generated_at = null;
  const invalidClock = clockGantt(roadmapRows(summary), summary);
  assert.equal(invalidClock.from, null); assert.equal(invalidClock.to, null);
  assert.equal(invalidClock.rows[0]!.segments.length, 0);
});
