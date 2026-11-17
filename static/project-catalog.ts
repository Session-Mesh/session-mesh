// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { parseJsonStrict } from './demo-view-contract.ts';
/** Browser-safe, bounded project DTO. Labels are assertions, never capabilities. */
import { readFollowup } from './project-followup-schema.ts';
import type { Followup } from './project-followup-schema.ts';
export const PROJECT_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, projects: 100,
  sourcesPerProject: 20, sources: 1000, items: 200, sessions: 100, id: 80,
  title: 240, description: 4000, path: 4096 });
export const SOURCE_KINDS = ['roster', 'slack', 'teams', 'linear', 'github', 'gitlab', 'other'] as const;
export const PIPELINE_LIMITS = Object.freeze({ task: 120, text: 2000, history: 50, items: 100, coverage: 32 });
export const PIPELINE_COMPONENTS = ['ledger', 'intake', 'spec', 'plan', 'implementation', 'review', 'qa_state', 'qa', 'manifest'] as const;
export const PIPELINE_UNSUPPORTED = ['checks', 'live-execution', 'session', 'attempt', 'full-report-history', 'standalone-acceptance'] as const;
export type PipelineAvailability = 'valid' | 'absent' | 'invalid';
export interface PipelineComponent { availability: PipelineAvailability; reason: string | null; truncated: boolean }
export interface PipelinePair { phase: string; outcome: string | null }
export interface PipelineEvent extends PipelinePair { source_index: number; reason: string | null; reason_truncated: boolean;
  actor: { availability: 'valid' | 'unknown'; value: string | null; truncated: boolean };
  time: { availability: 'valid' | 'unknown'; value: string | null } }
export interface PipelineList<T> { items: T[]; total: number | null; truncated: boolean }
export interface PipelineFinding { severity: string | null; description: string | null; status: string | null; specialist: string | null }
export interface PipelineRound { round: number | null; date: string | null; verdict: string | null; qualifying: boolean | null; causes: string | null }
export interface PipelineReport { status: 'GO' | 'NO-GO'; round: number | null; cycle: number | null; date: string | null;
  findings: PipelineList<PipelineFinding>; rounds_audit: PipelineList<PipelineRound>;
  no_go_reason: { type: string | null; cause: string | null; failed_acs: string | null } | null; qa_no_go_round?: number | null }
export interface PipelineDetail { task: string; availability: PipelineAvailability; mode: string | null; latest_completed: PipelinePair | null;
  verdict_disagreement: boolean | null; components: Record<typeof PIPELINE_COMPONENTS[number], PipelineComponent>;
  history: PipelineList<PipelineEvent>; review: PipelineReport | null; qa: PipelineReport | null;
  qa_markdown_status: 'VALIDATED' | 'GO' | 'NO-GO' | null;
  coverage: { id: string; availability: 'supported' | 'delegated' | 'unsupported'; limitations: string }[] }
export type SourceKind = typeof SOURCE_KINDS[number];
export type ProjectFeature = 'project-metadata/1' | 'roster-followup/1';
export interface WorkReference { source_id: string; kind: string; native_id: string; instance_id?: string }
export type ParticipationTarget = { kind: 'mesh'; name: string; created: number; machine_id?: string } |
  { kind: 'history'; agent: 'claude' | 'codex' | 'pi'; conversation_id: string };
export interface Participation { id: string; label?: string; recorded_relation: 'active' | 'saved' | 'historical';
  target: ParticipationTarget; role_label?: string; work_refs?: WorkReference[] }
export interface ProjectChannel { id: string; label: string; tenant_id?: string; workspace_id?: string; native_id?: string; url?: string }
export interface ProjectSession { name: string; created: number; machine_id?: string }
export const README_PATHS = ['README.md', 'README', 'README.txt', 'readme.md'] as const;
export type RepositoryReason = 'inspection-disabled' | 'no-local-repository' | 'invalid-repository' | 'ref-unavailable' |
  'invalid-output' | 'timeout' | 'budget-exceeded' | 'unsupported-type' | 'too-large' | 'invalid-text' | 'not-found' | 'repository-unavailable';
export interface RepositoryReadme { status: 'valid' | 'absent' | 'unavailable' | 'unconfigured'; reason: RepositoryReason | null;
  path: typeof README_PATHS[number] | null; blob: string | null; size: number | null; text: string | null; truncated: boolean }
export interface RepositoryObservation { status: 'valid' | 'unavailable' | 'unconfigured'; assembled_at: string;
  method: 'configured-ref' | 'local-origin-head' | null; reason: RepositoryReason | null;
  ref: string | null; commit: string | null; readme: RepositoryReadme }
export interface Repository { url: string; branch?: string; readme_url?: string; observation?: RepositoryObservation }
export interface RepositoryConfig extends Omit<Repository, 'observation'> { local_path?: string; primary_ref?: string }
export interface SourceConfig { id: string; kind: SourceKind; label: string; url?: string;
  board_path?: string; pipeline_root?: string; pipeline_task?: string; channels?: ProjectChannel[] }
export interface SummaryCheck { id: string; accepted_status: string; reported_status: string }
export interface SummaryItem { id: string; title: string; state: string;
  depends_on?: string[]; attempts?: number; checks?: SummaryCheck[] }
export interface OperatorRequest { id: string; title: string; state: string }
export interface ProviderSummary { provider_schema: 'roster-roadmap-view' | 'pipeline-task'; provider_version: 1;
  source_generated_at?: string; source_revision?: string; goal?: string; phase?: string;
  global_accepted?: boolean; counts: Record<string, number>; items: SummaryItem[];
  operator_requests?: OperatorRequest[]; operator_status?: 'absent' | 'valid' | 'invalid';
  operator_truncated?: boolean; truncated: boolean; more: number | null; pipeline?: PipelineDetail; followup?: Followup }
export type SourceError = 'missing-executable' | 'timeout' | 'budget-exceeded' | 'output-limit' |
  'invalid-output' | 'provider-failed' | 'spawn-failed';
export interface ProjectSource { id: string; kind: SourceKind; label: string; url?: string;
  status: 'available' | 'unavailable' | 'unconfigured'; observed_at: string;
  error_code?: SourceError; summary?: ProviderSummary; channels?: ProjectChannel[] }
export interface Project { id: string; title: string; description?: string; repository?: Repository;
  sources: ProjectSource[]; sessions: ProjectSession[]; participations?: Participation[] }
export interface ObservationPlan { repository: boolean; source_ids: string[] }
export interface ConfigProject extends Omit<Project, 'sources' | 'repository'> { sources: SourceConfig[]; repository?: RepositoryConfig }
type ProjectVersion = { schema_version: 1; features?: never } | { schema_version: 2; features: ProjectFeature[] };
export type ProjectConfig = ProjectVersion & { kind: 'mesh-project-config'; machine_id: string; projects: ConfigProject[] };
export type ProjectCatalog = ProjectVersion & { kind: 'mesh-project-catalog'; machine_id: string;
  revision: string; generated_at: string; projects: Project[] };

export const COUNT_KEYS = ['queued', 'active', 'blocked', 'done', 'withdrawn', 'total', 'tasks_total',
  'tasks_done', 'derived_total', 'derived_done', 'derived_active', 'derived_blocked', 'operator_open', 'operator_now', 'operator_later', 'operator_unscheduled',
  'operator_answered', 'operator_withdrawn', 'operator_archived'] as const;
const errors: SourceError[] = ['missing-executable', 'timeout', 'budget-exceeded', 'output-limit',
  'invalid-output', 'provider-failed', 'spawn-failed'];
type Obj = Record<string, unknown>;
function object(v: unknown): Obj { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('object'); return v as Obj; }
function keys(v: Obj, names: string[]): void { if (Object.keys(v).some(k => !names.includes(k))) throw Error('unknown field'); }
function str(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || /[\ud800-\udfff]/u.test(v) || v.length > max || (!empty && !v.length) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) throw Error('text');
  return v;
}
function id(v: unknown): string { const s = str(v, 80); if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error('id'); return s; }
function date(v: unknown): string {
  const s = str(v, 40); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) || !Number.isFinite(Date.parse(s))) throw Error('timestamp');
  if (new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) throw Error('calendar');
  return s;
}
function count(v: unknown): number { if (!Number.isSafeInteger(v) || (v as number) < 0) throw Error('count'); return v as number; }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') throw Error('boolean'); return v; }
function list<T>(v: unknown, max: number, read: (v: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw Error('list'); return v.map(read);
}
function unique<T extends { id: string }>(items: T[]): T[] { if (new Set(items.map(i => i.id)).size !== items.length) throw Error('duplicate'); return items; }
export function safeProjectURL(v: unknown): string | null {
  if (typeof v !== 'string' || /[\ud800-\udfff]/u.test(v) || v.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(v)) return null;
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function url(v: unknown): string { const u = safeProjectURL(v); if (!u) throw Error('url'); return u; }
function optional<T>(o: Obj, key: string, read: (v: unknown) => T): Partial<Record<string, T>> {
  return o[key] === undefined ? {} : { [key]: read(o[key]) };
}
function opaque(v: unknown, max = 240): string {
  const s = str(v, max); if (/[\u0000-\u001f\u007f]/u.test(s)) throw Error('single line'); return s;
}
function label(v: unknown): string { const s = opaque(v); if (!s.trim()) throw Error('label'); return s; }
function modernURL(v: unknown): string { const s = url(v); if (s.length > 4096) throw Error('url'); return s; }
function channel(v: unknown): ProjectChannel {
  const o = object(v); keys(o, ['id', 'label', 'tenant_id', 'workspace_id', 'native_id', 'url']);
  return { id: id(o.id), label: label(o.label), ...optional(o, 'tenant_id', opaque),
    ...optional(o, 'workspace_id', opaque), ...optional(o, 'native_id', opaque), ...optional(o, 'url', modernURL) };
}
function participation(v: unknown): Participation {
  const o = object(v); keys(o, ['id', 'label', 'recorded_relation', 'target', 'role_label', 'work_refs']);
  const t = object(o.target); let target: ParticipationTarget;
  if (t.kind === 'mesh') { keys(t, ['kind', 'name', 'created', 'machine_id']);
    target = { kind: 'mesh', ...session({ name: t.name, created: t.created, ...optional(t, 'machine_id', id) }) }; }
  else { keys(t, ['kind', 'agent', 'conversation_id']); target = { kind: choice(t.kind, ['history']),
    agent: choice(t.agent, ['claude', 'codex', 'pi']), conversation_id: opaque(t.conversation_id) }; }
  if (target.kind === 'mesh') target.name = opaque(target.name);
  const refs = optional(o, 'work_refs', v => {
    const rows = list<WorkReference>(v, 20, v => { const r = object(v); keys(r, ['source_id', 'kind', 'native_id', 'instance_id']);
      return { source_id: id(r.source_id), kind: id(r.kind), native_id: opaque(r.native_id), ...optional(r, 'instance_id', opaque) }; });
    if (new Set(rows.map(r => JSON.stringify([r.source_id, r.kind, r.native_id, r.instance_id ?? null]))).size !== rows.length) throw Error('duplicate reference');
    return rows;
  });
  return { id: id(o.id), ...optional(o, 'label', label), recorded_relation: choice(o.recorded_relation, ['active', 'saved', 'historical']),
    target, ...optional(o, 'role_label', label), ...refs };
}
function repository(v: unknown, modern = false, config = false): RepositoryConfig & Repository {
  const o = object(v); keys(o, ['url', 'branch', 'readme_url', ...(modern ? config ? ['local_path', 'primary_ref'] : ['observation'] : [])]);
  const readURL = modern ? modernURL : url;
  return { url: readURL(o.url), ...optional(o, 'branch', v => str(v, 240)), ...optional(o, 'readme_url', readURL),
    ...(modern && config ? { ...optional(o, 'local_path', v => { const s = opaque(v, 4096); if (!s.startsWith('/')) throw Error('absolute path'); return s; }),
      ...optional(o, 'primary_ref', v => { const s = opaque(v); if (!/^refs\/(heads|remotes)\/.+/u.test(s)) throw Error('full ref'); return s; }) } : {}),
    ...(modern && !config ? optional(o, 'observation', repositoryObservation) : {}) };
}
function gitObject(v: unknown): string { const s = opaque(v, 64); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(s)) throw Error('object identity'); return s; }
function repositoryObservation(v: unknown): RepositoryObservation {
  const o = object(v); keys(o, ['status', 'assembled_at', 'method', 'reason', 'ref', 'commit', 'readme']);
  const reasons = ['inspection-disabled', 'no-local-repository', 'invalid-repository', 'ref-unavailable', 'invalid-output', 'timeout',
    'budget-exceeded', 'unsupported-type', 'too-large', 'invalid-text', 'not-found', 'repository-unavailable'] as const;
  const status = choice(o.status, ['valid', 'unavailable', 'unconfigured']), assembled_at = date(o.assembled_at);
  const method = nullable(o.method, v => choice(v, ['configured-ref', 'local-origin-head'] as const)), reason = nullable(o.reason, v => choice(v, reasons));
  const ref = nullable(o.ref, v => opaque(v)), commit = nullable(o.commit, gitObject);
  const r = object(o.readme); keys(r, ['status', 'reason', 'path', 'blob', 'size', 'text', 'truncated']);
  const readme: RepositoryReadme = { status: choice(r.status, ['valid', 'absent', 'unavailable', 'unconfigured']),
    reason: nullable(r.reason, v => choice(v, reasons)), path: nullable(r.path, v => choice(v, README_PATHS)),
    blob: nullable(r.blob, gitObject), size: nullable(r.size, count), text: nullable(r.text, v => str(v, 4000, true)), truncated: bool(r.truncated) };
  if (ref !== null && !/^refs\/(heads|remotes)\/.+/u.test(ref)) throw Error('full ref');
  if (commit && readme.blob && commit.length !== readme.blob.length) throw Error('object algorithm');
  if (readme.blob !== null && readme.path === null || readme.size !== null && readme.blob === null) throw Error('readme fact dependencies');
  const empty = readme.path === null && readme.blob === null && readme.size === null && readme.text === null && !readme.truncated;
  if (status === 'unconfigured') {
    if (!['inspection-disabled', 'no-local-repository'].includes(reason ?? '') || method !== null || ref !== null || commit !== null ||
        readme.status !== 'unconfigured' || readme.reason !== reason || !empty) throw Error('unconfigured repository');
  } else if (status === 'unavailable') {
    if (!method || !['invalid-repository', 'ref-unavailable', 'invalid-output', 'timeout', 'budget-exceeded'].includes(reason ?? '') || commit !== null ||
        readme.status !== 'unavailable' || readme.reason !== 'repository-unavailable' || !empty) throw Error('unavailable repository');
  } else {
    if (!method || !ref || !commit || reason !== null || readme.status === 'unconfigured') throw Error('valid repository');
    if (readme.status === 'valid') {
      if (!readme.path || !readme.blob || readme.size === null || readme.size > 65536 || readme.text === null || readme.reason !== null || /[\uD800-\uDFFF]/u.test(readme.text)) throw Error('valid readme');
      const encoded = new TextEncoder().encode(readme.text).byteLength;
      if (readme.truncated ? encoded >= readme.size : encoded !== readme.size) throw Error('readme size');
    } else if (readme.status === 'absent') {
      if (readme.reason !== 'not-found' || !empty) throw Error('absent readme');
    } else if (!['unsupported-type', 'too-large', 'invalid-text', 'invalid-output', 'timeout', 'budget-exceeded'].includes(readme.reason ?? '') || readme.text !== null || readme.truncated) throw Error('unavailable readme');
  }
  return { status, assembled_at, method, reason, ref, commit, readme };
}
function session(v: unknown): ProjectSession {
  const o = object(v); keys(o, ['name', 'created', 'machine_id']);
  if (typeof o.created !== 'number' || !Number.isFinite(o.created) || o.created < 0) throw Error('incarnation');
  return { name: str(o.name, 240), created: o.created, ...optional(o, 'machine_id', id) };
}
function baseSource(o: Obj, modern = false): Pick<SourceConfig, 'id' | 'kind' | 'label' | 'url' | 'channels'> {
  if (!SOURCE_KINDS.includes(o.kind as SourceKind)) throw Error('kind');
  const sourceID = id(o.id); if (modern && sourceID === 'mesh') throw Error('reserved source');
  return { id: sourceID, kind: o.kind as SourceKind, label: str(o.label, 240), ...optional(o, 'url', modern ? modernURL : url),
    ...(modern ? optional(o, 'channels', v => unique(list(v, 20, channel))) : {}) };
}
function locator(v: unknown): string { const s = str(v, 4096); if (!s.startsWith('/') || s.includes('\n') || s.includes('\r')) throw Error('absolute path'); return s; }
function sourceConfig(v: unknown, modern = false): SourceConfig {
  const o = object(v); keys(o, ['id', 'kind', 'label', 'url', 'board_path', 'pipeline_root', 'pipeline_task', ...(modern ? ['channels'] : [])]);
  const s = baseSource(o, modern);
  const pipeline = o.pipeline_root !== undefined || o.pipeline_task !== undefined;
  if (s.kind !== 'roster' && (o.board_path !== undefined || pipeline)) throw Error('locator kind');
  if (pipeline && (o.pipeline_root === undefined || o.pipeline_task === undefined || o.board_path !== undefined)) throw Error('pipeline locator');
  return { ...s, ...optional(o, 'board_path', locator),
    ...optional(o, 'pipeline_root', v => { const path = locator(v); if (path.length > PIPELINE_LIMITS.text) throw Error('pipeline root'); return path; }),
    ...optional(o, 'pipeline_task', pipelineTask) };
}
function pipelineTask(v: unknown): string { const s = str(v, PIPELINE_LIMITS.task); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) throw Error('pipeline task'); return s; }
function nullable<T>(v: unknown, read: (v: unknown) => T): T | null { return v === null ? null : read(v); }
function choice<T extends string>(v: unknown, allowed: readonly T[]): T { if (!allowed.includes(v as T)) throw Error('choice'); return v as T; }
function pipelineText(v: unknown): string { return str(v, PIPELINE_LIMITS.text, true); }
function recordedInteger(v: unknown): number { if (!Number.isSafeInteger(v)) throw Error('recorded integer'); return v as number; }
function pipelinePair(v: unknown): PipelinePair {
  const o = object(v); keys(o, ['phase', 'outcome']);
  const outcomes: Record<string, string[]> = { question: ['COMPLETED'], research: ['COMPLETED'], intake: ['VALIDATED'],
    spec: ['VALIDATED', 'SKIPPED', 'BOUNCED'], plan: ['COMPLETED'], implement: ['COMPLETED', 'PARTIAL'], review: ['GO', 'NO-GO'], qa: ['GO', 'NO-GO'], ship: ['COMPLETED', 'BLOCKED'] };
  const phase = str(o.phase, 80), outcome = nullable(o.outcome, value => str(value, 80));
  if (!Object.hasOwn(outcomes, phase) || outcome !== null && !outcomes[phase]?.includes(outcome)) throw Error('pipeline phase'); return { phase, outcome };
}
function pipelineList<T>(v: unknown, read: (v: unknown) => T): PipelineList<T> {
  const o = object(v); keys(o, ['items', 'total', 'truncated']);
  const items = list(o.items, PIPELINE_LIMITS.items, read), total = nullable(o.total, count), truncated = bool(o.truncated);
  if (total === null ? items.length !== 0 || truncated : items.length !== Math.min(total, PIPELINE_LIMITS.items) || total > items.length && !truncated) throw Error('pipeline list');
  return { items, total, truncated };
}
function pipelineReport(v: unknown, qa: boolean): PipelineReport {
  const o = object(v); keys(o, ['status', 'round', 'cycle', 'date', 'findings', 'rounds_audit', 'no_go_reason', ...(qa ? ['qa_no_go_round'] : [])]);
  return { status: choice(o.status, ['GO', 'NO-GO']), round: nullable(o.round, recordedInteger), cycle: nullable(o.cycle, recordedInteger), date: nullable(o.date, pipelineText),
    findings: pipelineList(o.findings, v => { const f = object(v); keys(f, ['severity', 'description', 'status', 'specialist']);
      return { severity: nullable(f.severity, pipelineText), description: nullable(f.description, pipelineText), status: nullable(f.status, pipelineText), specialist: nullable(f.specialist, pipelineText) }; }),
    rounds_audit: pipelineList(o.rounds_audit, v => { const r = object(v); keys(r, ['round', 'date', 'verdict', 'qualifying', 'causes']);
      return { round: nullable(r.round, recordedInteger), date: nullable(r.date, pipelineText), verdict: nullable(r.verdict, pipelineText), qualifying: nullable(r.qualifying, bool), causes: nullable(r.causes, pipelineText) }; }),
    no_go_reason: nullable(o.no_go_reason, v => { const r = object(v); keys(r, ['type', 'cause', 'failed_acs']);
      return { type: nullable(r.type, pipelineText), cause: nullable(r.cause, pipelineText), failed_acs: nullable(r.failed_acs, pipelineText) }; }),
    ...(qa ? { qa_no_go_round: nullable(o.qa_no_go_round, recordedInteger) } : {}) };
}
function pipelineDetail(v: unknown): PipelineDetail {
  const o = object(v); keys(o, ['task', 'availability', 'mode', 'latest_completed', 'verdict_disagreement', 'components', 'history', 'review', 'qa', 'qa_markdown_status', 'coverage']);
  const raw = object(o.components); keys(raw, [...PIPELINE_COMPONENTS]);
  const components = Object.fromEntries(PIPELINE_COMPONENTS.map(name => { const c = object(raw[name]); keys(c, ['availability', 'reason', 'truncated']);
    const availability = choice(c.availability, ['valid', 'absent', 'invalid']), reason = nullable(c.reason, pipelineText), truncated = bool(c.truncated);
    if (availability !== 'invalid' && reason !== null || availability !== 'valid' && truncated) throw Error('component metadata');
    return [name, { availability, reason, truncated }]; })) as PipelineDetail['components'];
  const availability = choice(o.availability, ['valid', 'absent', 'invalid']);
  const states = Object.values(components).map(c => c.availability);
  if (availability !== (states.includes('valid') ? 'valid' : states.includes('invalid') ? 'invalid' : 'absent')) throw Error('pipeline availability');
  const mode = nullable(o.mode, v => choice(v, ['express-lite', 'express', 'fast', 'full']));
  const latest_completed = nullable(o.latest_completed, pipelinePair), h = object(o.history); keys(h, ['items', 'total', 'truncated']);
  const total = nullable(h.total, count), truncated = bool(h.truncated);
  const items = list(h.items, PIPELINE_LIMITS.history, (v): PipelineEvent => {
    const e = object(v); keys(e, ['source_index', 'phase', 'outcome', 'reason', 'reason_truncated', 'actor', 'time']);
    const actor = object(e.actor), time = object(e.time); keys(actor, ['availability', 'value', 'truncated']); keys(time, ['availability', 'value']);
    const a = { availability: choice(actor.availability, ['valid', 'unknown']), value: nullable(actor.value, pipelineText), truncated: bool(actor.truncated) };
    const t = { availability: choice(time.availability, ['valid', 'unknown']), value: nullable(time.value, pipelineText) };
    if (a.availability === 'valid' ? !a.value : a.value !== null || a.truncated) throw Error('actor');
    if (t.availability === 'valid' ? !t.value || !Number.isFinite(Date.parse(t.value)) : t.value !== null) throw Error('recorded time');
    const reason = nullable(e.reason, pipelineText), reason_truncated = bool(e.reason_truncated);
    if (reason === null && reason_truncated) throw Error('reason truncation');
    return { ...pipelinePair({ phase: e.phase, outcome: e.outcome }), source_index: count(e.source_index), reason, reason_truncated, actor: a, time: t };
  });
  if (components.ledger.availability === 'valid') {
    if (mode === null || latest_completed === null || total === null || total < 1 || items.length !== Math.min(total, PIPELINE_LIMITS.history) || truncated !== (total > items.length) || items.some((e, i) => e.source_index !== i)) throw Error('history');
    const last = items.at(-1)!;
    if (total === items.length && (last.phase !== latest_completed.phase || last.outcome !== latest_completed.outcome)) throw Error('latest phase');
    const allowed = mode === 'full' ? ['question', 'research', 'intake', 'spec', 'plan', 'implement', 'review', 'qa', 'ship'] : mode === 'fast' ? ['implement', 'review', 'qa', 'ship'] : ['implement', 'review', 'ship'];
    if (!allowed.includes(latest_completed.phase)) throw Error('pipeline mode');
  } else if (mode !== null || latest_completed !== null || total !== null || items.length || truncated) throw Error('unknown history');
  const review = nullable(o.review, v => pipelineReport(v, false)), qa = nullable(o.qa, v => pipelineReport(v, true));
  const qa_markdown_status = nullable(o.qa_markdown_status, v => choice(v, ['VALIDATED', 'GO', 'NO-GO'] as const));
  if ((review !== null) !== (components.review.availability === 'valid') || (qa !== null) !== (components.qa_state.availability === 'valid') || components.qa.availability !== 'valid' && qa_markdown_status !== null) throw Error('current reports');
  if (review && (review.findings.truncated || review.rounds_audit.truncated) && !components.review.truncated || qa && (qa.findings.truncated || qa.rounds_audit.truncated) && !components.qa_state.truncated) throw Error('report truncation');
  const verdict_disagreement = nullable(o.verdict_disagreement, bool);
  const verdicts = [review?.status, qa?.status, qa_markdown_status].filter(v => v === 'GO' || v === 'NO-GO');
  if (verdict_disagreement !== (verdicts.length > 1 ? new Set(verdicts).size > 1 : null)) throw Error('verdict disagreement');
  const coverage = unique(list(o.coverage, PIPELINE_LIMITS.coverage, v => { const c = object(v); keys(c, ['id', 'availability', 'limitations']);
    return { id: id(c.id), availability: choice(c.availability, ['supported', 'delegated', 'unsupported']), limitations: pipelineText(c.limitations) }; }));
  if (PIPELINE_UNSUPPORTED.some(name => !coverage.some(c => c.id === name && c.availability === 'unsupported'))) throw Error('pipeline coverage');
  return { task: pipelineTask(o.task), availability, mode, latest_completed, verdict_disagreement, components, history: { items, total, truncated }, review, qa, qa_markdown_status, coverage };
}
function summaryItem(v: unknown): SummaryItem {
  const o = object(v); keys(o, ['id', 'title', 'state', 'depends_on', 'attempts', 'checks']);
  return { id: id(o.id), title: str(o.title, 240), state: str(o.state, 80),
    ...optional(o, 'depends_on', v => list(v, 200, id)), ...optional(o, 'attempts', count),
    ...optional(o, 'checks', v => list(v, 200, v => { const c = object(v); keys(c, ['id', 'accepted_status', 'reported_status']);
      return { id: id(c.id), accepted_status: str(c.accepted_status, 80), reported_status: str(c.reported_status, 80) }; })) };
}
function summary(v: unknown, allowFollowup = false): ProviderSummary {
  const o = object(v); keys(o, ['provider_schema', 'provider_version', 'source_generated_at', 'source_revision',
    'goal', 'phase', 'global_accepted', 'counts', 'items', 'operator_requests', 'operator_status', 'operator_truncated', 'truncated', 'more', 'pipeline', ...(allowFollowup ? ['followup'] : [])]);
  if (!['roster-roadmap-view', 'pipeline-task'].includes(o.provider_schema as string) || o.provider_version !== 1) throw Error('provider schema');
  if (o.provider_schema === 'pipeline-task') {
    if (['goal', 'phase', 'global_accepted', 'operator_requests', 'operator_status', 'operator_truncated', 'followup'].some(k => o[k] !== undefined) || Object.keys(object(o.counts)).length || !Array.isArray(o.items) || o.items.length || o.more !== null || o.source_generated_at === undefined || typeof o.source_revision !== 'string' || !/^[a-f0-9]{64}$/.test(o.source_revision)) throw Error('pipeline variant');
  } else if (o.pipeline !== undefined) throw Error('roadmap variant');
  const pipeline = o.provider_schema === 'pipeline-task' ? pipelineDetail(o.pipeline) : undefined;
  if (pipeline && o.truncated !== (Object.values(pipeline.components).some(c => c.truncated) || pipeline.history.truncated || pipeline.history.items.some(e => e.reason_truncated || e.actor.truncated))) throw Error('pipeline truncation');
  const counts = object(o.counts); keys(counts, [...COUNT_KEYS]);
  const normalized = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, count(v)]));
  const result: ProviderSummary = { provider_schema: o.provider_schema as ProviderSummary['provider_schema'], provider_version: 1,
    ...optional(o, 'source_generated_at', date), ...optional(o, 'source_revision', v => str(v, 240)),
    ...optional(o, 'goal', v => str(v, 4000, true)), ...optional(o, 'phase', v => str(v, 80)),
    ...optional(o, 'global_accepted', bool), counts: normalized, items: unique(list(o.items, 200, summaryItem)),
    ...optional(o, 'operator_requests', v => unique(list(v, 200, v => { const r = object(v); keys(r, ['id', 'title', 'state']);
      return { id: id(r.id), title: str(r.title, 2000), state: str(r.state, 80) }; }))),
    ...optional(o, 'operator_status', v => { if (!['absent', 'valid', 'invalid'].includes(v as string)) throw Error('operator status'); return v as 'absent' | 'valid' | 'invalid'; }),
    ...optional(o, 'operator_truncated', bool), truncated: bool(o.truncated), more: o.more === null ? null : count(o.more),
    ...(pipeline ? { pipeline } : {}) };
  if (o.followup !== undefined) result.followup = readFollowup(o.followup, result);
  return result;
}
function source(v: unknown, modern = false, allowFollowup = false): ProjectSource {
  const o = object(v); keys(o, ['id', 'kind', 'label', 'url', 'status', 'observed_at', 'error_code', 'summary', ...(modern ? ['channels'] : [])]);
  const base = baseSource(o, modern);
  if (!['available', 'unavailable', 'unconfigured'].includes(o.status as string)) throw Error('status');
  if (o.status === 'available' && o.summary === undefined || o.status !== 'available' && o.summary !== undefined) throw Error('summary status');
  if (o.status === 'unavailable' && !errors.includes(o.error_code as SourceError) || o.status !== 'unavailable' && o.error_code !== undefined) throw Error('error status');
  const result: ProjectSource = { ...base, status: o.status as ProjectSource['status'], observed_at: date(o.observed_at),
    ...optional(o, 'error_code', v => v as SourceError), ...optional(o, 'summary', v => summary(v, allowFollowup)) };
  if (result.summary && base.kind !== 'roster') throw Error('summary kind');
  return result;
}
function project<T>(v: unknown, readSource: (v: unknown) => T, required = false, modern = false): Omit<Project, 'sources'> & { sources: T[] } {
  const o = object(v); keys(o, ['id', 'title', 'description', 'repository', 'sources', 'sessions', ...(modern ? ['participations'] : [])]);
  if (required && (!Array.isArray(o.sources) || !Array.isArray(o.sessions))) throw Error('missing arrays');
  return { id: id(o.id), title: str(o.title, 240), ...optional(o, 'description', v => str(v, 4000, true)),
    ...optional(o, 'repository', v => repository(v, modern, !required)), sources: list(o.sources ?? [], 20, readSource), sessions: list(o.sessions ?? [], 100, session),
    ...(modern ? optional(o, 'participations', v => unique(list(v, 100, participation))) : {}) };
}
function input(v: unknown): Obj {
  if (typeof v === 'string') {
    if (new TextEncoder().encode(v).byteLength > PROJECT_LIMITS.bytes) throw Error('bytes');
    return object(parseJsonStrict(v, 'project'));
  }
  // Bound in-memory inputs too; JSON conversion also refuses cycles/BigInt.
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > PROJECT_LIMITS.bytes) throw Error('bytes');
  return object(v);
}
function validateProjects<T extends { id: string; sources: { id: string }[] }>(p: T[]): T[] {
  unique(p); let total = 0;
  for (const row of p) { unique(row.sources); total += row.sources.length; }
  if (total > PROJECT_LIMITS.sources) throw Error('sources'); return p;
}
function normalized<T>(value: T, modern: boolean): T {
  if (modern && new TextEncoder().encode(JSON.stringify(value)).byteLength > PROJECT_LIMITS.bytes) throw Error('normalized bytes');
  return value;
}
export function parseProjectConfig(value: unknown): ProjectConfig | null {
  try { const o = input(value), modern = o.schema_version === 2; keys(o, ['kind', 'schema_version', 'machine_id', 'projects', ...(modern ? ['features'] : [])]);
    if (o.kind !== 'mesh-project-config' || o.schema_version !== 1 && !modern) return null;
    const version = projectVersion(o);
    return normalized({ kind: o.kind, ...version, machine_id: id(o.machine_id),
      projects: validateProjects(list(o.projects, 100, v => project(v, s => sourceConfig(s, modern), false, modern))) }, modern);
  } catch { return null; }
}
export function parseProjectCatalog(value: unknown): ProjectCatalog | null {
  try { const o = input(value), modern = o.schema_version === 2; keys(o, ['kind', 'schema_version', 'machine_id', 'revision', 'generated_at', 'projects', ...(modern ? ['features'] : [])]);
    if (o.kind !== 'mesh-project-catalog' || o.schema_version !== 1 && !modern) return null;
    return normalized({ kind: o.kind, ...projectVersion(o, true), machine_id: id(o.machine_id), revision: id(o.revision), generated_at: date(o.generated_at),
      projects: validateProjects(list(o.projects, 100, v => project(v, s => source(s, modern && (o.features as unknown[]).includes('project-metadata/1'), modern && (o.features as unknown[]).includes('roster-followup/1')), true, modern && (o.features as unknown[]).includes('project-metadata/1')))) }, modern);
  } catch { return null; }
}
function projectVersion(o: Obj, catalog = false): ProjectVersion {
  if (o.schema_version === 1) return { schema_version: 1 };
  const features = list(o.features, 2, v => choice(v, catalog ? ['project-metadata/1', 'roster-followup/1'] as const : ['project-metadata/1'] as const));
  if (!features.length || new Set(features).size !== features.length) throw Error('features'); return { schema_version: 2, features };
}

export function readObservationPlan(value: unknown): ObservationPlan {
  const o = object(value); keys(o, ['repository', 'source_ids']);
  const source_ids = list(o.source_ids, 20, id);
  if (new Set(source_ids).size !== source_ids.length) throw Error('duplicate plan source');
  return { repository: bool(o.repository), source_ids };
}
