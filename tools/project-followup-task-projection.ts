// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { record, text, identity, hasTruncation, part, unique, window } from '../static/project-followup-primitives.ts';
import type { Part, Window, RecordValue } from '../static/project-followup-primitives.ts';
import { estimate } from '../static/project-followup-estimate-schema.ts';
import { readAssignment, readTopology, readBudget, readAttempt, readProgress, readLineage, readReceipt, readCheck, readRecovery,
  validateTimeline, validateProgress, validateReceipt } from '../static/project-followup-task-schema.ts';
import type { TaskDetail } from '../static/project-followup-task-schema.ts';
import type { SummaryItem } from '../static/project-catalog.ts';

type Display = (value: unknown, maximum: number, empty?: boolean) => string;
export function absent<T>(): Part<T> { return { availability: 'not-provided', reason: 'not-in-source', text_truncated: false, truncated: false, value: null }; }
export function invalid<T>(): Part<T> { return { availability: 'invalid', reason: 'Malformed source observation', text_truncated: false, truncated: false, value: null }; }
export function rawArray(value: unknown): unknown[] { if (!Array.isArray(value)) throw Error('array'); return value; }
export function selectPart<T>(raw: unknown, select: (raw: unknown, display: Display) => unknown, read: (value: unknown) => T, allowNull = false): Part<T> {
  if (raw === undefined) return absent();
  let clipped = false;
  const display: Display = (value, maximum, empty = true) => {
    if (typeof value !== 'string') throw Error('text');
    text(value, Number.MAX_SAFE_INTEGER, empty);
    if (value.length <= maximum) return value;
    clipped = true; let end = maximum;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
    return value.slice(0, end);
  };
  try {
    const value = raw === null && allowNull ? null : select(raw, display);
    return part({ availability: 'valid', reason: null, text_truncated: clipped,
      truncated: clipped || hasTruncation(value), value }, read, allowNull);
  } catch { return invalid(); }
}
export function selectWindow<T>(raw: unknown, cap: number, read: (value: unknown) => T, latest = false): Window<T> {
  const all = rawArray(raw).map(read);
  return { items: latest ? all.slice(-cap) : all.slice(0, cap), total: all.length, truncated: all.length > cap };
}
const DISPLAY_LIMITS: Readonly<Record<string, number>> = { assignee: 240, runtime: 80, role: 80, route: 80, model: 160, reason: 240 };
function labels(o: RecordValue, fields: readonly string[], display?: Display): RecordValue {
  return Object.fromEntries(fields.map(name => {
    const value = o[name] ?? null, limit = DISPLAY_LIMITS[name];
    return [name, value !== null && display && limit !== undefined ? display(value, limit, false) : value];
  }));
}
function lineage(raw: unknown, display: Display): unknown {
  const o = record(raw);
  if (!Object.hasOwn(o, 'kind') || !Object.hasOwn(o, 'derived') || !Object.hasOwn(o, 'corrections')) throw Error('lineage');
  const derived = o.derived === null ? null : record(o.derived);
  return { kind: o.kind, parent: derived?.parent ?? null,
    cause: derived ? labels(record(derived.cause), ['task_id', 'attempt_id', 'assignee'], display) : null,
    created_at: derived?.created_at ?? null, corrections: selectWindow(o.corrections, 200, identity) };
}
function progress(raw: unknown, display: Display): unknown {
  const o = record(raw);
  return { ...labels(o, ['status', 'source', 'sequence', 'recorded_at', 'reason'], display),
    message: o.message == null ? null : display(o.message, 2000), current_step: o.current_step == null ? null : display(o.current_step, 500) };
}
function projectedEstimate(raw: unknown, display: Display, id: string): unknown {
  const o = record(raw); if (o.id !== id) throw Error('estimate task');
  if (['status', 'duration_minutes', 'remaining_minutes', 'source', 'overdue', 'reestimate_needed', 'reasons'].some(k => !Object.hasOwn(o, k))) throw Error('estimate fields');
  return { ...labels(o, ['status', 'duration_minutes', 'remaining_minutes', 'source', 'overdue', 'reestimate_needed']),
    reasons: selectWindow(o.reasons, 20, v => display(v, 240)) };
}
function checks(raw: unknown): unknown {
  const value = selectWindow(raw, 200, v => {
    const o = record(v);
    return readCheck({ id: o.id, assurance: o.assurance,
      accepted_evidence_count: o.accepted_evidence === undefined ? null : rawArray(o.accepted_evidence).length,
      reported_evidence_count: o.reported_evidence === undefined ? null : rawArray(o.reported_evidence).length });
  });
  unique(rawArray(raw).map(v => identity(record(v).id))); return value;
}
function receipt(raw: unknown, display: Display): unknown {
  const o = record(raw);
  return { result: o.result, summary: display(o.summary, 2000), attempt_id: o.attempt_id ?? null,
    evidence_count: o.evidence === undefined ? null : rawArray(o.evidence).length };
}
function recovery(raw: unknown, display: Display): unknown {
  const o = record(raw);
  if (['status', 'reframe_needed', 'retry_allowed', 'threshold', 'retry_blockers'].some(k => !Object.hasOwn(o, k))) throw Error('recovery fields');
  return { ...labels(o, ['status', 'reframe_needed', 'retry_allowed', 'threshold']), retry_blockers: selectWindow(o.retry_blockers, 20, v => display(v, 240)) };
}
export function projectTask(raw: unknown, item: SummaryItem): TaskDetail {
  const o = record(raw);
  const assignment = selectPart(o.assignment, (raw, display) => labels(record(raw), ['id', 'assignee', 'runtime', 'role', 'route', 'model'], display), readAssignment, true);
  const timeline = selectPart(o.timeline, (raw, display) => {
    const all = rawArray(raw).map(v => readAttempt(labels(record(v), ['attempt', 'attempt_id', 'assignee', 'runtime', 'route', 'model', 'claimed_at', 'ended_at', 'outcome'], display)));
    validateTimeline({ items: all, total: all.length, truncated: false }, item, assignment);
    return { items: all.slice(-200), total: all.length, truncated: all.length > 200 };
  }, v => window(v, 200, readAttempt));
  const selectedProgress = selectPart(o.progress, progress, readProgress);
  if (selectedProgress.value) { try { validateProgress(selectedProgress.value, item, assignment); } catch { Object.assign(selectedProgress, invalid()); } }
  const last_result = selectPart(o.last_result, receipt, readReceipt, true);
  if (last_result.value) { try { validateReceipt(last_result.value, item, assignment, timeline); } catch { Object.assign(last_result, invalid()); } }
  return { id: item.id, budget: selectPart(o.max_attempts, value => ({ max_attempts: value }), readBudget), assignment,
    topology: selectPart(o.topology, (raw, display) => labels(record(raw), ['runtime', 'role', 'route', 'model'], display), readTopology, true), timeline, progress: selectedProgress,
    lineage: selectPart(['kind', 'derived', 'corrections'].every(k => o[k] === undefined) ? undefined : o, lineage, readLineage),
    estimate: selectPart(o.estimate, (value, display) => projectedEstimate(value, display, item.id), estimate, true),
    last_result, checks: selectPart(o.checks, checks, v => window(v, 200, readCheck)), blocker: selectPart(o.blocker, (v, display) => display(v, 2000, false), v => text(v, 2000), true),
    recovery: selectPart(o.recovery, recovery, readRecovery, true) };
}
