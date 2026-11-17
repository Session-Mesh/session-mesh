// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { record, identity, text, integer, boolean, hasTruncation, window } from '../static/project-followup-primitives.ts';
import { readMetadata, readEvent, readFollowup, validateForecast } from '../static/project-followup-schema.ts';
import type { Followup } from '../static/project-followup-schema.ts';
import { forecast } from '../static/project-followup-estimate-schema.ts';
import { selectPart, selectWindow, projectTask, rawArray, invalid } from './project-followup-task-projection.ts';
import type { ProviderSummary, SummaryItem } from '../static/project-catalog.ts';

function coreTask(value: unknown): SummaryItem {
  const o = record(value), deps = rawArray(o.depends_on), checks = rawArray(o.checks);
  if (deps.length > 200) throw Error('dependencies');
  const allChecks = checks.map(v => { const c = record(v); return { id: identity(c.id), accepted_status: text(c.accepted_status, 80), reported_status: text(c.reported_status, 80) }; });
  if (new Set(allChecks.map(c => c.id)).size !== allChecks.length) throw Error('checks');
  return { id: identity(o.id), title: text(o.objective, 240), state: text(o.state, 80), attempts: integer(o.attempts),
    depends_on: deps.map(identity), checks: allChecks.slice(0, 200) };
}
function selectedForecast(value: unknown, display: (value: unknown, max: number) => string): unknown {
  const o = record(value);
  const eta = (value: unknown) => {
    const e = record(value);
    return { status: e.status, remaining_minutes: e.remaining_minutes, finish_at: e.finish_at,
      reasons: selectWindow(e.reasons, 20, v => display(v, 240)) };
  };
  return { schema_version: o.schema_version, as_of: o.as_of, estimate_revision: o.estimate_revision,
    based_on_state_revision: o.based_on_state_revision, status: record(o.global_eta).status,
    tasks_eta: eta(o.tasks_eta), global_eta: eta(o.global_eta), assumptions: selectWindow(o.assumptions, 100, v => display(v, 240)) };
}
export function projectFollowup(raw: unknown, summary: ProviderSummary): Followup {
  const o = record(raw), all = rawArray(o.tasks);
  const metadata = selectPart(['board_id', 'contract_digest', 'accepted', 'revision'].every(k => o[k] === undefined) ? undefined : o,
    value => { const b = record(value); return { board_id: b.board_id, contract_digest: b.contract_digest, contract_accepted: b.accepted, state_revision: b.revision }; }, readMetadata);
  const tasks = all.map(value => { const item = coreTask(value); return projectTask(value, item); });
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw Error('task identities');
  const task_details = { items: tasks.slice(0, 200), total: tasks.length, truncated: tasks.length > 200 };
  const events = selectPart(o.recent_events, (value, display) => {
    if (rawArray(value).length > 100) throw Error('event window');
    const selected = selectWindow(value, 100, value => {
      const e = record(value); return readEvent({ action: e.action, task_id: e.task_id ?? null, at: e.at ?? null, reason: e.reason == null ? null : display(e.reason, 2000) });
    });
    const total = o.events_total === undefined ? null : integer(o.events_total), truncated = boolean(o.events_truncated);
    return { ...selected, total, truncated };
  }, value => window(value, 100, readEvent));
  const selected = selectPart(o.estimates, selectedForecast, forecast, true);
  if (selected.value) { try { validateForecast(selected.value, metadata, summary); } catch { Object.assign(selected, invalid()); } }
  const result = { schema_version: 1, metadata, task_details, events, forecast: selected,
    truncated: [metadata, task_details, events, selected].some(hasTruncation) };
  return readFollowup(result, summary);
}
