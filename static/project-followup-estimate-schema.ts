// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { record, text, integer, boolean, nullable, choice, window } from './project-followup-primitives.ts';
import type { Window } from './project-followup-primitives.ts';
import { recordedInstant } from './project-followup-time.ts';

export interface Range { optimistic: number; likely: number; pessimistic: number }
export interface Finish { optimistic: string; likely: string; pessimistic: string }
export interface Estimate { status: string; duration_minutes: Range | null; remaining_minutes: Range | null;
  source: 'completed' | 'planner-duration' | 'claim-time' | 'planner-remaining' | null;
  overdue: boolean; reestimate_needed: boolean; reasons: Window<string> }
export interface Eta { status: 'unknown' | 'conditional' | 'complete'; remaining_minutes: Range | null; finish_at: Finish | null; reasons: Window<string> }
export interface Forecast { schema_version: 1; as_of: string; estimate_revision: number; based_on_state_revision: number | null;
  status: Eta['status']; tasks_eta: Eta; global_eta: Eta; assumptions: Window<string> }
export function range(value: unknown): Range {
  const o = record(value, ['optimistic', 'likely', 'pessimistic']);
  const values = [o.optimistic, o.likely, o.pessimistic];
  if (values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 5256000) || Number(values[0]) > Number(values[1]) || Number(values[1]) > Number(values[2])) throw Error('range');
  return { optimistic: o.optimistic as number, likely: o.likely as number, pessimistic: o.pessimistic as number };
}
function finish(value: unknown): Finish {
  const o = record(value, ['optimistic', 'likely', 'pessimistic']);
  const optimistic = text(o.optimistic, 80), likely = text(o.likely, 80), pessimistic = text(o.pessimistic, 80);
  const times = [optimistic, likely, pessimistic].map(recordedInstant);
  if (times.some(v => v === null) || times[0]! > times[1]! || times[1]! > times[2]!) throw Error('finish');
  return { optimistic, likely, pessimistic };
}
export function estimate(value: unknown): Estimate {
  const o = record(value, ['status', 'duration_minutes', 'remaining_minutes', 'source', 'overdue', 'reestimate_needed', 'reasons']);
  return { status: text(o.status, 80), duration_minutes: nullable(o.duration_minutes, range), remaining_minutes: nullable(o.remaining_minutes, range),
    source: nullable(o.source, v => choice(v, ['completed', 'planner-duration', 'claim-time', 'planner-remaining'])), overdue: boolean(o.overdue),
    reestimate_needed: boolean(o.reestimate_needed), reasons: window(o.reasons, 20, v => text(v, 240, true)) };
}
function eta(value: unknown): Eta {
  const o = record(value, ['status', 'remaining_minutes', 'finish_at', 'reasons']);
  const status = choice(o.status, ['unknown', 'conditional', 'complete']), remaining_minutes = nullable(o.remaining_minutes, range), finish_at = nullable(o.finish_at, finish);
  if (status === 'conditional' && (!remaining_minutes || !finish_at) || status !== 'conditional' && finish_at !== null) throw Error('eta');
  if (status === 'complete' && (!remaining_minutes || Object.values(remaining_minutes).some(v => v !== 0))) throw Error('complete eta');
  return { status, remaining_minutes, finish_at, reasons: window(o.reasons, 20, v => text(v, 240, true)) };
}
export function forecast(value: unknown): Forecast {
  const o = record(value, ['schema_version', 'as_of', 'estimate_revision', 'based_on_state_revision', 'status', 'tasks_eta', 'global_eta', 'assumptions']);
  const as_of = text(o.as_of, 80); if (o.schema_version !== 1 || recordedInstant(as_of) === null) throw Error('forecast');
  const global_eta = eta(o.global_eta), status = choice(o.status, ['unknown', 'conditional', 'complete']);
  if (status !== global_eta.status) throw Error('forecast status');
  return { schema_version: 1, as_of, estimate_revision: integer(o.estimate_revision), based_on_state_revision: nullable(o.based_on_state_revision, integer),
    status, tasks_eta: eta(o.tasks_eta), global_eta, assumptions: window(o.assumptions, 100, v => text(v, 240, true)) };
}
