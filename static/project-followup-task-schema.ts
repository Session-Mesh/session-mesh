// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { record, text, integer, boolean, choice, nullable, identity, window, part, unique } from './project-followup-primitives.ts';
import type { Part, Window } from './project-followup-primitives.ts';
import { estimate } from './project-followup-estimate-schema.ts';
import type { Estimate } from './project-followup-estimate-schema.ts';
import type { SummaryItem } from './project-catalog.ts';

export interface Budget { max_attempts: number | null }
export interface Assignment { id: string | null; assignee: string | null; runtime: string | null; role: string | null; route: string | null; model: string | null }
export interface Topology { runtime: string | null; role: string | null; route: string | null; model: string | null }
export interface Attempt { attempt: number; attempt_id: string | null; assignee: string | null; runtime: string | null;
  route: string | null; model: string | null; claimed_at: string | null; ended_at: string | null; outcome: 'active' | 'done' | 'blocked' | 'released' }
export interface Progress { status: 'reported' | 'unreported' | 'not-active' | 'invalid' | 'unavailable'; source: 'worker-reported' | null;
  sequence: number | null; recorded_at: string | null; message: string | null; current_step: string | null; reason: string | null }
export interface Cause { task_id: string; attempt_id: string | null; assignee: string | null }
export interface Lineage { kind: 'contract' | 'derived'; parent: string | null; cause: Cause | null; created_at: string | null; corrections: Window<string> }
export interface Receipt { result: 'done' | 'blocked'; summary: string; attempt_id: string | null; evidence_count: number | null }
export interface Check { id: string; assurance: 'accepted-local-receipt' | 'unverified'; accepted_evidence_count: number | null; reported_evidence_count: number | null }
export interface Recovery { status: 'needs-reframe' | 'within-threshold' | 'invalid'; reframe_needed: boolean | null; retry_allowed: boolean; threshold: number; retry_blockers: Window<string> }
export interface TaskDetail { id: string; budget: Part<Budget>; assignment: Part<Assignment>; topology: Part<Topology>;
  timeline: Part<Window<Attempt>>; progress: Part<Progress>; lineage: Part<Lineage>; estimate: Part<Estimate>;
  last_result: Part<Receipt>; checks: Part<Window<Check>>; blocker: Part<string>; recovery: Part<Recovery> }
const label = (v: unknown, max = 240) => nullable(v, v => text(v, max));
export function readBudget(value: unknown): Budget {
  const o = record(value, ['max_attempts']); return { max_attempts: nullable(o.max_attempts, integer) };
}
export function readTopology(value: unknown): Topology {
  const o = record(value, ['runtime', 'role', 'route', 'model']);
  return { runtime: label(o.runtime, 80), role: label(o.role, 80), route: label(o.route, 80), model: label(o.model, 160) };
}
export function readAssignment(value: unknown): Assignment {
  const o = record(value, ['id', 'assignee', 'runtime', 'role', 'route', 'model']);
  return { id: label(o.id, 120), assignee: label(o.assignee), runtime: label(o.runtime, 80),
    role: label(o.role, 80), route: label(o.route, 80), model: label(o.model, 160) };
}
export function readAttempt(value: unknown): Attempt {
  const o = record(value, ['attempt', 'attempt_id', 'assignee', 'runtime', 'route', 'model', 'claimed_at', 'ended_at', 'outcome']);
  return { attempt: integer(o.attempt, true), attempt_id: label(o.attempt_id, 120), assignee: label(o.assignee),
    runtime: label(o.runtime, 80), route: label(o.route, 80), model: label(o.model, 160), claimed_at: label(o.claimed_at, 80),
    ended_at: label(o.ended_at, 80), outcome: choice(o.outcome, ['active', 'done', 'blocked', 'released']) };
}
export function validateTimeline(value: Window<Attempt>, item: SummaryItem, assignment: Part<Assignment>): void {
  const { items, total } = value;
  if (total === null || item.attempts !== undefined && total !== item.attempts) throw Error('attempt count');
  unique(items.filter(a => a.attempt_id !== null), a => a.attempt_id);
  if (items.some((a, i) => a.attempt !== total - items.length + i + 1)) throw Error('attempt ordinal');
  for (const [i, a] of items.entries()) {
    if (a.outcome !== 'active') continue;
    const current = assignment.value;
    if (i !== items.length - 1 || item.state !== 'active' || assignment.availability !== 'valid' || !current || a.ended_at !== null) throw Error('active attempt');
    if (a.attempt_id !== null && current.id !== null && a.attempt_id !== current.id) throw Error('attempt assignment');
  }
}
export function readProgress(value: unknown): Progress {
  const o = record(value, ['status', 'source', 'sequence', 'recorded_at', 'message', 'current_step', 'reason']);
  return { status: choice(o.status, ['reported', 'unreported', 'not-active', 'invalid', 'unavailable']),
    source: nullable(o.source, v => choice(v, ['worker-reported'])), sequence: nullable(o.sequence, integer), recorded_at: label(o.recorded_at, 80),
    message: nullable(o.message, v => text(v, 2000, true)), current_step: nullable(o.current_step, v => text(v, 500, true)), reason: label(o.reason) };
}
export function validateProgress(value: Progress, item: SummaryItem, assignment: Part<Assignment>): void {
  if (value.status === 'reported') {
    if (value.source !== 'worker-reported' || !value.sequence || !value.recorded_at || value.reason !== null || item.state !== 'active' || assignment.availability !== 'valid' || !assignment.value?.id) throw Error('reported progress');
    return;
  }
  if (value.source !== null || value.recorded_at !== null || value.message !== null || value.current_step !== null) throw Error('progress content');
  if (value.status === 'unreported' || value.status === 'not-active') {
    if (value.sequence !== 0 || value.reason !== null || (value.status === 'unreported') !== (item.state === 'active')) throw Error('progress state');
  } else if (value.sequence !== null) throw Error('progress sequence');
}
function cause(value: unknown): Cause {
  const o = record(value, ['task_id', 'attempt_id', 'assignee']);
  return { task_id: identity(o.task_id), attempt_id: label(o.attempt_id, 120), assignee: label(o.assignee) };
}
export function readLineage(value: unknown): Lineage {
  const o = record(value, ['kind', 'parent', 'cause', 'created_at', 'corrections']);
  const result: Lineage = { kind: choice(o.kind, ['contract', 'derived']), parent: nullable(o.parent, identity), cause: nullable(o.cause, cause),
    created_at: label(o.created_at, 80), corrections: window(o.corrections, 200, identity) };
  unique(result.corrections.items);
  if (result.kind === 'contract' ? result.parent !== null || result.cause !== null || result.created_at !== null : !result.parent || !result.cause || result.corrections.total !== 0) throw Error('lineage');
  return result;
}
export function readReceipt(value: unknown): Receipt {
  const o = record(value, ['result', 'summary', 'attempt_id', 'evidence_count']);
  return { result: choice(o.result, ['done', 'blocked']), summary: text(o.summary, 2000, true), attempt_id: label(o.attempt_id, 120), evidence_count: nullable(o.evidence_count, integer) };
}
export function validateReceipt(value: Receipt, item: SummaryItem, assignment: Part<Assignment>, timeline: Part<Window<Attempt>>): void {
  const last = timeline.value?.items.at(-1);
  if (value.result === 'done' && (item.state !== 'done' || assignment.availability === 'valid' && assignment.value !== null)) throw Error('receipt state');
  if (last && last.outcome !== 'active' && value.attempt_id !== null && last.attempt_id !== null && (value.attempt_id !== last.attempt_id || value.result !== last.outcome)) throw Error('receipt attempt');
}
export function readCheck(value: unknown): Check {
  const o = record(value, ['id', 'assurance', 'accepted_evidence_count', 'reported_evidence_count']);
  return { id: identity(o.id), assurance: choice(o.assurance, ['accepted-local-receipt', 'unverified']),
    accepted_evidence_count: nullable(o.accepted_evidence_count, integer), reported_evidence_count: nullable(o.reported_evidence_count, integer) };
}
export function readRecovery(value: unknown): Recovery {
  const o = record(value, ['status', 'reframe_needed', 'retry_allowed', 'threshold', 'retry_blockers']);
  const result: Recovery = { status: choice(o.status, ['needs-reframe', 'within-threshold', 'invalid']), reframe_needed: nullable(o.reframe_needed, boolean),
    retry_allowed: boolean(o.retry_allowed), threshold: integer(o.threshold), retry_blockers: window(o.retry_blockers, 20, v => text(v, 240, true)) };
  if (result.status === 'needs-reframe' && result.reframe_needed !== true || result.status === 'within-threshold' && result.reframe_needed !== false || result.status === 'invalid' && (result.reframe_needed !== null || result.retry_allowed)) throw Error('recovery');
  return result;
}
export function readTaskDetail(value: unknown, item: SummaryItem): TaskDetail {
  const o = record(value, ['id', 'budget', 'assignment', 'topology', 'timeline', 'progress', 'lineage', 'estimate', 'last_result', 'checks', 'blocker', 'recovery']);
  if (identity(o.id) !== item.id) throw Error('task identity');
  const assignment = part(o.assignment, readAssignment, true);
  const timeline = part(o.timeline, v => window(v, 200, readAttempt));
  const progress = part(o.progress, readProgress), last_result = part(o.last_result, readReceipt, true);
  const checks = part(o.checks, v => window(v, 200, readCheck));
  if (timeline.value) validateTimeline(timeline.value, item, assignment);
  if (progress.value) validateProgress(progress.value, item, assignment);
  if (last_result.value) validateReceipt(last_result.value, item, assignment, timeline);
  if (checks.value && (checks.value.items.length !== (item.checks?.length ?? 0) || checks.value.items.some((c, i) => c.id !== item.checks?.[i]?.id))) throw Error('check identity');
  return { id: item.id, budget: part(o.budget, readBudget), assignment, topology: part(o.topology, readTopology, true), timeline, progress,
    lineage: part(o.lineage, readLineage), estimate: part(o.estimate, estimate, true), last_result, checks,
    blocker: part(o.blocker, v => text(v, 2000), true), recovery: part(o.recovery, readRecovery, true) };
}
