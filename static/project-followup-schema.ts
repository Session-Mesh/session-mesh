// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { record, identity, digest, boolean, integer, text, nullable, part, window, hasTruncation } from './project-followup-primitives.ts';
import type { Part, Window } from './project-followup-primitives.ts';
import { forecast } from './project-followup-estimate-schema.ts';
import type { Forecast } from './project-followup-estimate-schema.ts';
import { readTaskDetail } from './project-followup-task-schema.ts';
import type { TaskDetail } from './project-followup-task-schema.ts';
import { recordedInstant } from './project-followup-time.ts';
import type { ProviderSummary } from './project-catalog.ts';
export type { TaskDetail, Attempt, Assignment, Budget, Topology, Progress, Lineage, Receipt, Check, Recovery } from './project-followup-task-schema.ts';
export type { Range, Estimate, Forecast, Eta, Finish } from './project-followup-estimate-schema.ts';
export type { Part, Window } from './project-followup-primitives.ts';
export interface BoardMetadata { board_id: string; contract_digest: string; contract_accepted: boolean; state_revision: number }
export interface FollowupEvent { action: string; task_id: string | null; at: string | null; reason: string | null }
export interface Followup { schema_version: 1; metadata: Part<BoardMetadata>; task_details: Window<TaskDetail>;
  events: Part<Window<FollowupEvent>>; forecast: Part<Forecast>; truncated: boolean }
export function readMetadata(value: unknown): BoardMetadata {
  const o = record(value, ['board_id', 'contract_digest', 'contract_accepted', 'state_revision']);
  return { board_id: identity(o.board_id), contract_digest: digest(o.contract_digest), contract_accepted: boolean(o.contract_accepted), state_revision: integer(o.state_revision) };
}
export function readEvent(value: unknown): FollowupEvent {
  const o = record(value, ['action', 'task_id', 'at', 'reason']);
  return { action: text(o.action, 80), task_id: nullable(o.task_id, identity), at: nullable(o.at, v => text(v, 80)), reason: nullable(o.reason, v => text(v, 2000, true)) };
}
export function validateForecast(value: Forecast, metadata: Part<BoardMetadata>, summary: ProviderSummary): void {
  if (metadata.value && value.based_on_state_revision !== null && value.based_on_state_revision > metadata.value.state_revision) throw Error('forecast basis');
  const generated = recordedInstant(summary.source_generated_at), asOf = recordedInstant(value.as_of);
  if (generated !== null && asOf !== null && asOf > generated) throw Error('forecast clock');
  if (value.global_eta.status === 'complete' && summary.global_accepted === false) throw Error('global completion');
}
export function readFollowup(value: unknown, summary: ProviderSummary): Followup {
  const o = record(value, ['schema_version', 'metadata', 'task_details', 'events', 'forecast', 'truncated']);
  if (o.schema_version !== 1 || summary.provider_schema !== 'roster-roadmap-view') throw Error('followup schema');
  let index = 0;
  const task_details = window(o.task_details, 200, v => {
    const item = summary.items[index++]; if (!item) throw Error('extra task'); return readTaskDetail(v, item);
  });
  if (task_details.total === null || index !== summary.items.length || summary.more !== null && task_details.total !== index + summary.more) throw Error('task coverage');
  const metadata = part(o.metadata, readMetadata), events = part(o.events, v => window(v, 100, readEvent)), selectedForecast = part(o.forecast, forecast, true);
  if (selectedForecast.value) validateForecast(selectedForecast.value, metadata, summary);
  const truncated = boolean(o.truncated);
  if (truncated !== [metadata, task_details, events, selectedForecast].some(hasTruncation)) throw Error('followup truncation');
  return { schema_version: 1, metadata, task_details, events, forecast: selectedForecast, truncated };
}
