// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { record, text, identity, digest, nullable, choice } from './project-followup-primitives.ts';
import { recordedInstant, ObservationAge } from './project-followup-time.ts';
import type { Project, ProjectSource, ProviderSummary, SummaryItem, PipelineDetail } from './project-catalog.ts';
export interface ParentReference { kind: 'roadmap-task'; machine_id: string; project_id: string; source_id: string;
  board_id: string; task_id: string; source_revision: string | null; contract_digest: string | null }
export interface ChildReference { kind: 'pipeline-task'; machine_id: string; project_id: string; source_id: string;
  task_id: string; source_revision: string | null }
export interface FollowupLink { parent: ParentReference; child: ChildReference }
export interface FollowupContext { schema_version: 1; availability: 'provided' | 'unavailable' | 'invalid' | 'unsupported';
  observed_at: string | null; revision: string | null; provenance: string | null; reason: string | null; links: FollowupLink[] }
const unavailable = (availability: 'invalid' | 'unsupported', reason: string): FollowupContext =>
  ({ schema_version: 1, availability, observed_at: null, revision: null, provenance: null, reason, links: [] });
function reference(value: unknown, parent: true): ParentReference;
function reference(value: unknown, parent: false): ChildReference;
function reference(value: unknown, parent: boolean): ParentReference | ChildReference {
  const o = record(value, ['kind', 'machine_id', 'project_id', 'source_id', 'task_id', 'source_revision', ...(parent ? ['board_id', 'contract_digest'] : [])]);
  const base = { machine_id: identity(o.machine_id), project_id: identity(o.project_id), source_id: identity(o.source_id), source_revision: nullable(o.source_revision, v => text(v, 240)) };
  if (parent) return { ...base, kind: choice(o.kind, ['roadmap-task']), task_id: identity(o.task_id), board_id: identity(o.board_id), contract_digest: nullable(o.contract_digest, digest) };
  const task_id = text(o.task_id, 120); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task_id)) throw Error('task');
  return { ...base, kind: choice(o.kind, ['pipeline-task']), task_id };
}
export function readFollowupContext(value?: unknown): FollowupContext {
  if (value === undefined) return unavailable('unsupported', 'not-supplied');
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) throw Error('bytes');
    const o = record(value, ['schema_version', 'availability', 'observed_at', 'revision', 'provenance', 'reason', 'links']);
    const availability = choice(o.availability, ['provided', 'unavailable', 'invalid', 'unsupported']);
    if (o.schema_version !== 1 || !Array.isArray(o.links) || o.links.length > 32) throw Error('context');
    const observed_at = nullable(o.observed_at, v => text(v, 80)), revision = nullable(o.revision, v => text(v, 128));
    const provenance = nullable(o.provenance, v => text(v, 240)), reason = nullable(o.reason, v => text(v, 240));
    if (availability !== 'provided') {
      if (observed_at !== null || revision !== null || provenance !== null || o.links.length || !reason) throw Error('unavailable');
      return { schema_version: 1, availability, observed_at, revision, provenance, reason, links: [] };
    }
    if (recordedInstant(observed_at) === null || !revision || !provenance || reason !== null) throw Error('provenance');
    const links = o.links.map(value => { const link = record(value, ['parent', 'child']); return { parent: reference(link.parent, true), child: reference(link.child, false) }; });
    const keys = links.map(({ parent: p, child: c }) => JSON.stringify([p.machine_id, p.project_id, p.source_id, p.board_id, p.task_id, c.machine_id, c.project_id, c.source_id, c.task_id]));
    if (new Set(keys).size !== keys.length) throw Error('duplicate');
    return { schema_version: 1, availability, observed_at, revision, provenance, reason, links };
  } catch { return unavailable('invalid', 'invalid-display-association'); }
}
function fresh(observation: string | null | undefined, now: number): boolean {
  const instant = recordedInstant(observation); return instant !== null && now - instant >= 0 && now - instant < 120000;
}
/** A missing native identity cannot borrow interface choices from another source entity. */
export function followupScope(machine: string, project: string, source: string, summary: ProviderSummary): string | null {
  const metadata = summary.followup?.metadata;
  const native = summary.pipeline ? ['pipeline', summary.pipeline.task] : metadata?.availability === 'valid' && metadata.value ? ['roadmap', metadata.value.board_id] : null;
  return native ? JSON.stringify([machine, project, source, ...native]) : null;
}
/** Only age anchors are retained; no source records or authority are cached. */
export class FollowupFreshness {
  private ages = new Map<string, ObservationAge>();
  fresh(identity: unknown[], observation: string | null | undefined, wall: number, monotonic: number): boolean {
    if (!observation) return false;
    const key = JSON.stringify([...identity, observation]), age = this.ages.get(key) ?? new ObservationAge();
    this.ages.delete(key); this.ages.set(key, age);
    while (this.ages.size > 200) this.ages.delete(this.ages.keys().next().value!);
    const elapsed = age.age(observation, wall, monotonic); return elapsed !== null && elapsed < 120000;
  }
}
export interface ResolvedFollowupLink { link: FollowupLink; valid: boolean; reason: string;
  parentItem: SummaryItem | null; parentSource: ProjectSource | null; childPipeline: PipelineDetail | null }
export function resolveFollowupLinks(context: FollowupContext, machine: string, project: Project, now: number,
  anchors?: { ages: FollowupFreshness; monotonic: number }): ResolvedFollowupLink[] {
  return context.links.map(link => {
    const { parent: p, child: c } = link;
    const parent = project.sources.find(source => source.id === p.source_id), child = project.sources.find(source => source.id === c.source_id);
    const parentSummary = parent?.summary, childSummary = child?.summary;
    const metadata = parentSummary?.followup?.metadata;
    const parentItem = parentSummary?.items.find(item => item.id === p.task_id) ?? null;
    const identities = p.machine_id === machine && c.machine_id === machine && p.project_id === project.id && c.project_id === project.id &&
      parent?.kind === 'roster' && child?.kind === 'roster' && parent.status === 'available' && child.status === 'available' &&
      parentSummary?.provider_schema === 'roster-roadmap-view' && childSummary?.pipeline?.task === c.task_id &&
      metadata?.availability === 'valid' && metadata.value?.board_id === p.board_id && parentItem !== null;
    const expectations = (p.source_revision === null || p.source_revision === parentSummary?.source_revision) &&
      (c.source_revision === null || c.source_revision === childSummary?.source_revision) && (p.contract_digest === null || p.contract_digest === metadata?.value?.contract_digest);
    const clock = (identity: unknown[], observation: string | null | undefined) => anchors ? anchors.ages.fresh(identity, observation, now, anchors.monotonic) : fresh(observation, now);
    const clocks = context.availability === 'provided' && clock(['context'], context.observed_at) &&
      clock(['parent', p.machine_id, p.project_id, p.source_id, p.board_id], parentSummary?.source_generated_at) &&
      clock(['child', c.machine_id, c.project_id, c.source_id, c.task_id], childSummary?.source_generated_at);
    return { link, valid: Boolean(identities && expectations && clocks), parentItem: identities ? parentItem : null,
      parentSource: identities ? parent! : null, childPipeline: identities ? childSummary!.pipeline! : null,
      reason: !identities ? 'unresolved-identity' : !expectations ? 'observation-mismatch' : !clocks ? 'stale-or-unknown-observation' : 'explicit-caller-declared-association' };
  });
}
