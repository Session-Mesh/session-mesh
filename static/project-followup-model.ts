// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import type { ProviderSummary, SummaryItem, PipelineDetail } from './project-catalog.ts';
import type { TaskDetail, Part, Attempt } from './project-followup-schema.ts';
import { observedInterval, recordedInstant } from './project-followup-time.ts';
import { dependencyGraph } from './project-followup-graph.ts';
export interface FollowupRow { key: string; id: string; title: string; state: string; meaning: string;
  worker: string | null; duration: number | null; timeKind: 'mission-lifetime' | 'completion-point' | 'unknown';
  point: string | null; dependsOn: string[]; item: SummaryItem | null; detail: TaskDetail | null }
export function validValue<T>(value: Part<T> | undefined): T | null { return value?.availability === 'valid' ? value.value : null; }
export function acceptedReceipt(item: SummaryItem, detail: TaskDetail, summary: ProviderSummary): boolean {
  const metadata = validValue(summary.followup?.metadata), result = validValue(detail.last_result), timeline = validValue(detail.timeline);
  const latest = timeline?.items.at(-1);
  return Boolean(metadata?.contract_accepted && metadata.contract_digest && item.state === 'done' && detail.assignment.availability === 'valid' &&
    detail.assignment.value === null && result?.result === 'done' && latest?.outcome === 'done' && latest.attempt === item.attempts &&
    result.attempt_id !== null && latest.attempt_id !== null && latest.attempt_id === result.attempt_id);
}
function workerMeaning(detail: TaskDetail): string | null {
  const progress = validValue(detail.progress);
  if (!progress || progress.status !== 'reported') return null;
  return progress.current_step || progress.message || 'worker-reported';
}
function rowMeaning(item: SummaryItem, detail: TaskDetail | null, summary: ProviderSummary): string {
  if (detail && acceptedReceipt(item, detail, summary)) return 'accepted-receipt';
  if (item.state === 'done') return 'source-done-unqualified';
  if (item.state === 'active') return 'mission-open';
  if (item.state === 'queued') return 'future-conditional';
  return 'source-state';
}
export function roadmapRows(summary: ProviderSummary): FollowupRow[] {
  const details = new Map(summary.followup?.task_details.items.map(detail => [detail.id, detail]) ?? []);
  return summary.items.map(item => {
    const detail = details.get(item.id) ?? null;
    const latest: Attempt | undefined = detail ? validValue(detail.timeline)?.items.at(-1) : undefined;
    const duration = latest && (latest.outcome === 'active' || latest.ended_at !== null) ? observedInterval(latest.claimed_at, latest.ended_at, summary.source_generated_at ?? null) : null;
    return { key: item.id, id: item.id, title: item.title, state: item.state, meaning: rowMeaning(item, detail, summary),
      worker: detail ? workerMeaning(detail) : null, duration, timeKind: duration === null ? 'unknown' : 'mission-lifetime', point: null,
      dependsOn: item.depends_on ?? [], item, detail };
  });
}
export function pipelineRows(pipeline: PipelineDetail): FollowupRow[] {
  return pipeline.history.items.map(event => ({ key: `phase-${event.source_index}`, id: String(event.source_index), title: event.phase,
    state: event.outcome ?? 'unknown', meaning: 'recorded-completion', worker: null, duration: null, timeKind: recordedInstant(event.time.value) === null ? 'unknown' : 'completion-point',
    point: event.time.value, dependsOn: [], item: null, detail: null }));
}
export function followupRows(summary: ProviderSummary): FollowupRow[] { return summary.pipeline ? pipelineRows(summary.pipeline) : roadmapRows(summary); }
export function taskCoverage(summary: ProviderSummary): boolean {
  const window = summary.followup?.task_details;
  return Boolean(window && !window.truncated && window.total === summary.items.length && window.items.length === summary.items.length);
}
export function estimateMinutes(row: FollowupRow, mode: string): number | null {
  const estimate = row.detail ? validValue(row.detail.estimate) : null;
  return (mode === 'timeline-total' ? estimate?.duration_minutes : estimate?.remaining_minutes)?.likely ?? null;
}
export function rowGraph(rows: FollowupRow[], summary: ProviderSummary) {
  return dependencyGraph(rows.map(row => ({ id: row.id, dependsOn: row.dependsOn,
    length: estimateMinutes(row, 'timeline-remaining') })), taskCoverage(summary));
}
