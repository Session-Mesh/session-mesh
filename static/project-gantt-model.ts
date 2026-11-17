// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProviderSummary } from './project-catalog.ts';
import type { FollowupRow } from './project-followup-model.ts';
import { validValue, taskCoverage } from './project-followup-model.ts';
import { dependencyGraph } from './project-followup-graph.ts';
import { observedInterval, recordedInstant } from './project-followup-time.ts';

export interface GanttSegment {
  kind: 'attempt' | 'completion' | 'forecast'; start: number; end: number;
  earliest: number; latest: number; outcome: string; ordinal: number | null;
  attemptId: string | null;
}
export interface GanttRow {
  row: FollowupRow; segments: GanttSegment[]; truncated: boolean; unknownAttempts: number;
  unknown: 'unestimated' | 'time-unknown' | 'forecast-unresolved' | null;
}
export interface ClockGantt {
  rows: GanttRow[]; observed: number | null; from: number | null; to: number | null;
  conditionalForecast: boolean;
}
const MINUTE = 60000;

/** A snapshot is the time boundary. Never extend an open claim using the browser clock. */
export function clockGantt(rows: FollowupRow[], summary: ProviderSummary): ClockGantt {
  const observedText = summary.source_generated_at ?? null, observed = recordedInstant(observedText);
  const values: GanttRow[] = rows.map(row => {
    const history = row.detail ? validValue(row.detail.timeline) : null;
    const segments: GanttSegment[] = [];
    let unknownAttempts = 0;
    for (const attempt of history?.items ?? []) {
      const duration = attempt.outcome !== 'active' && attempt.ended_at === null ? null :
        observedInterval(attempt.claimed_at, attempt.ended_at, observedText);
      const start = recordedInstant(attempt.claimed_at), end = recordedInstant(attempt.ended_at ?? observedText);
      if (duration === null || start === null || end === null) { unknownAttempts++; continue; }
      segments.push({ kind: 'attempt', start, end, earliest: start, latest: end,
        outcome: attempt.outcome, ordinal: attempt.attempt, attemptId: attempt.attempt_id });
    }
    if (row.timeKind === 'completion-point') {
      const instant = recordedInstant(row.point);
      if (instant !== null && observed !== null && instant <= observed)
        segments.push({ kind: 'completion', start: instant, end: instant, earliest: instant, latest: instant,
          outcome: row.state, ordinal: null, attemptId: null });
      else unknownAttempts++;
    }
    return { row, segments, truncated: Boolean(history?.truncated || row.detail?.timeline.truncated), unknownAttempts,
      unknown: segments.length ? null : unknownAttempts || summary.pipeline || row.state === 'done' || (row.item?.attempts ?? 0) > 0 ? 'time-unknown' : 'unestimated' };
  });
  // This is explicitly an unlimited-capacity dependency projection, not the
  // source's capacity-aware global ETA. Unknown predecessors block their branch;
  // an unrelated unknown task must not erase a qualified independent branch.
  const ranges = rows.map(row => {
    const estimate = row.detail ? validValue(row.detail.estimate) : null;
    return row.state === 'blocked' || estimate?.reestimate_needed || estimate?.overdue ||
      ['unknown', 'invalid'].includes(estimate?.status ?? 'unknown') ? null : estimate?.remaining_minutes ?? null;
  });
  const coverage = taskCoverage(summary);
  const graph = dependencyGraph(rows.map((row, index) => ({ id: row.id, dependsOn: row.dependsOn,
    length: ranges[index]?.likely ?? null })), coverage);
  const byId = new Map(rows.map((row, index) => [row.id, { row, range: ranges[index] }]));
  const schedules = (['optimistic', 'likely', 'pessimistic'] as const).map(bound => {
    const schedule = new Map<string, { start: number; end: number }>();
    if (!coverage) return schedule;
    for (const id of graph.order) {
      const entry = byId.get(id)!;
      if (!entry.range || entry.row.dependsOn.some(dependency => !schedule.has(dependency))) continue;
      const start = Math.max(0, ...entry.row.dependsOn.map(dependency => schedule.get(dependency)!.end));
      schedule.set(id, { start, end: start + entry.range[bound] });
    }
    return schedule;
  });
  let conditionalForecast = false;
  for (const [index, value] of values.entries()) {
    if (value.row.state === 'done') continue;
    const range = ranges[index];
    if (!range || observed === null || schedules.some(schedule => !schedule.has(value.row.id))) {
      const authored = value.row.detail ? validValue(value.row.detail.estimate)?.remaining_minutes : null;
      if (!value.segments.length && authored) value.unknown = 'forecast-unresolved';
      continue;
    }
    const slots = schedules.map(schedule => schedule.get(value.row.id)!);
    if (slots.some(slot => !slot)) continue;
    const start = observed + slots[1]!.start * MINUTE, end = observed + slots[1]!.end * MINUTE;
    const earliest = observed + slots[0]!.start * MINUTE, latest = observed + slots[2]!.end * MINUTE;
    if (![start, end, earliest, latest].every(Number.isFinite) || earliest > start || end > latest) continue;
    value.segments.push({ kind: 'forecast', start, end, earliest, latest, outcome: value.row.state, ordinal: null, attemptId: null });
    value.unknown = null; conditionalForecast = true;
  }
  const instants = values.flatMap(value => value.segments.flatMap(segment => [segment.earliest, segment.latest]));
  if (observed !== null) instants.push(observed);
  if (!instants.length) return { rows: values, observed, from: null, to: null, conditionalForecast };
  const first = Math.min(...instants), last = Math.max(...instants), padding = Math.max(MINUTE, (last - first) * .025);
  return { rows: values, observed, from: first - padding, to: last + padding, conditionalForecast };
}

export function clockPosition(instant: number, model: Pick<ClockGantt, 'from' | 'to'>): number | null {
  if (model.from === null || model.to === null || model.to <= model.from || !Number.isFinite(instant)) return null;
  return (instant - model.from) / (model.to - model.from) * 100;
}
/** Sparse UTC-aligned ticks, formatted in the viewer's own locale/time zone. */
export function clockTicks(model: Pick<ClockGantt, 'from' | 'to'>, width: number): number[] {
  if (model.from === null || model.to === null) return [];
  const span = model.to - model.from;
  const steps = [1, 5, 15, 30, 60, 120, 240, 720, 1440, 2880, 10080].map(value => value * MINUTE);
  const step = steps.find(value => value / span * width >= 105) ?? Math.ceil(span / 6 / MINUTE) * MINUTE;
  const ticks: number[] = [];
  for (let at = Math.ceil(model.from / step) * step; at <= model.to && ticks.length < 32; at += step) ticks.push(at);
  return ticks;
}
