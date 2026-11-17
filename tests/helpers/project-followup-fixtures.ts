// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { normalizeProvider } from '../../tools/project-snapshot.ts';
import { projectFollowup } from '../../tools/project-followup-projection.ts';
import { parseProjectCatalog } from '../../static/project-catalog.ts';

/** Authored selected-observation fixtures; these are not recorded execution. */
export function roadmapTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'task', objective: 'Deliver the selected behavior', state: 'queued', attempts: 0, depends_on: [], checks: [],
    max_attempts: 3, assignment: null, topology: null, timeline: [], progress: { status: 'not-active', sequence: 0 },
    kind: 'contract', derived: null, corrections: [], estimate: null, last_result: null, blocker: null, recovery: null, ...overrides };
}
export function roadmapObservation(tasks: unknown[] = [roadmapTask()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'roster-roadmap-view', schema_version: 1, generated_at: '2026-11-14T12:00:00Z', version: 'source-one',
    board_id: 'delivery', contract_digest: 'a'.repeat(64), accepted: true, revision: 2,
    goal: 'Deliver a bounded feature', phase: 'active', counts: { total: tasks.length }, completion: {}, global: { accepted: false },
    tasks, recent_events: [], events_total: 0, events_truncated: false, estimates: null, ...overrides };
}
export function attemptObservation(ordinal: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { attempt: ordinal, attempt_id: `attempt-${ordinal}`, assignee: 'worker', runtime: 'runtime', route: null, model: null,
    claimed_at: '2026-11-14T10:00:00Z', ended_at: '2026-11-14T10:10:00Z', outcome: 'released', ...overrides };
}
export function followupCatalog(raw = roadmapObservation()) {
  const summary = normalizeProvider('roster', raw);
  summary.followup = projectFollowup(raw, summary);
  const catalog = parseProjectCatalog({ kind: 'mesh-project-catalog', schema_version: 2, features: ['roster-followup/1'],
    machine_id: 'host', revision: 'snapshot-one', generated_at: '2026-11-14T12:01:00Z',
    projects: [{ id: 'one', title: 'Delivery', sources: [{ id: 'roadmap', kind: 'roster', label: 'Roadmap', status: 'available',
      observed_at: '2026-11-14T12:01:00Z', summary }], sessions: [] }] });
  if (!catalog) throw Error('invalid authored catalog fixture'); return catalog;
}
