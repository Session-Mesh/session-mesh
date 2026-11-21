// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Native project DTOs. Authored context is never a capability. */
import type { Participation, ParticipationTarget, ProjectSession } from './project-catalog.ts';
import { parseJsonStrict } from './demo-view-contract.ts';
export interface ProjectMembership {
  sessions?: ProjectSession[]; participations?: Participation[];
  complete: boolean; omitted_fields: ('sessions' | 'participations')[];
}
// Future explicit owner capability; neither release14 nor the frozen fde advertises it.
// Covers owner membership reads/participation changes, never liveness or session rights.
export const PROJECT_MEMBERSHIP_FEATURE = 'project-memberships/1';
export const PROJECT_SESSION_TOOLS_FEATURE = 'project-session-tools/1';
export const PROJECT_REQUEST_BYTES = 128 * 1024;
export const PROJECT_REPLY_BYTES = 192 * 1024;
export const PROJECT_OPS = ['project_capabilities', 'project_list', 'project_read', 'project_create',
  'project_settings', 'project_status', 'project_observation_start', 'project_observation_status',
  'project_observation_page', 'project_observation_cancel'] as const;
export interface SourceReference { id: string; kind: string; label: string; url?: string }
export type SourceSelector = { kind: 'board'; path: string } | { kind: 'pipeline'; root: string; task: string } | null;
export interface ObservationPlan { repository: boolean; source_ids: string[] }
export interface ProjectObservationSettings { kind: 'project'; plan: ObservationPlan | null;
  repository: { url: string; local_path?: string; primary_ref?: string } | null;
  source_summaries: { id: string; kind: string; label: string; selector_configured: boolean }[] }
export interface SourceObservationSettings { kind: 'source'; source: SourceReference & { selector: SourceSelector } }
export type ObservationSettings = ProjectObservationSettings | SourceObservationSettings;
export interface ProjectSummary { id: string; title: string }
export interface ProjectDetail extends ProjectSummary {
  description?: string; folders?: string[]; repository?: { url: string; extra_fields?: number };
  sources?: SourceReference[]; folders_total: number; sources_total: number;
  sessions_total: number; participations_total: number;
  sessions?: ProjectSession[];
}
export interface HostReply {
  kind: 'mesh-project-reply'; version: 1; op: string; boot: string; status: string;
  code?: string; revision?: string; machine_id?: string; projects?: ProjectSummary[];
  project?: ProjectDetail; omitted_fields?: string[]; project_id?: string; request_id?: string;
  result?: string; intent_state?: string; intent_kind?: string | null;
  observation_settings?: ObservationSettings; observation?: Record<string, unknown>;
  membership?: ProjectMembership; features?: string[];
}
export type ProjectRequest = { op: typeof PROJECT_OPS[number]; version: 1 } & Record<string, unknown>;
export type ProjectHTTP = (url: string, init?: RequestInit) => Promise<Response>;
export function projectReadRequest(project: string, capability: HostReply | null, boot: string): ProjectRequest {
  const advertised = capability?.op === 'project_capabilities' && capability.status === 'ok' &&
    capability.boot === boot && capability.features?.includes(PROJECT_MEMBERSHIP_FEATURE);
  return { op: 'project_read', version: 1, project_id: project, ...(advertised ? { memberships: true } : {}) };
}
export class ProjectTransportError extends Error {
  reason: 'unavailable' | 'uncertain' | 'denied' | 'too-large' | 'unsupported';
  constructor(reason: ProjectTransportError['reason']) { super(reason); this.reason = reason; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('record');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw Error('text');
  return value;
}
function id(value: unknown): string {
  const result = text(value, 80); if (!/^[A-Za-z0-9_-]+$/.test(result)) throw Error('id'); return result;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error('count'); return value as number;
}
function array<T>(value: unknown, max: number, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw Error('array'); return value.map(read);
}
function summary(value: unknown): ProjectSummary {
  const row = record(value); return { id: id(row.id), title: text(row.title, 240) };
}
function source(value: unknown): SourceReference {
  const row = record(value);
  return { id: id(row.id), kind: text(row.kind, 40), label: text(row.label, 240),
    ...(row.url === undefined ? {} : { url: text(row.url, 4096) }) };
}
function detail(value: unknown): ProjectDetail {
  const row = record(value), base = summary(row);
  const repository = row.repository === undefined ? undefined : record(row.repository);
  const sessions = row.sessions === undefined ? undefined : array(row.sessions, 100, membershipSession);
  if (sessions && sessions.length !== count(row.sessions_total)) throw Error('incomplete-sessions');
  return { ...base, folders_total: count(row.folders_total), sources_total: count(row.sources_total),
    sessions_total: count(row.sessions_total), participations_total: count(row.participations_total),
    ...(sessions === undefined ? {} : {sessions}),
    ...(row.description === undefined ? {} : { description: text(row.description, 4000) }),
    ...(row.folders === undefined ? {} : { folders: array(row.folders, 100, item => text(item, 4096)) }),
    ...(row.sources === undefined ? {} : { sources: array(row.sources, 20, source) }),
    ...(repository === undefined ? {} : { repository: { url: text(repository.url, 4096),
      ...(repository.extra_fields === undefined ? {} : { extra_fields: count(repository.extra_fields) }) } }) };
}
function closed(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw Error('settings-fields');
}
// These owner DTO readers reuse the qualified J row grammar. Catalog observations
// remain a separate, weaker input boundary and cannot authorize owner operations.
function membershipText(value: unknown, max = 240): string {
  const result = text(value, max);
  if (!result.length || /[\ud800-\udfff]/u.test(result)) throw Error('membership-text');
  return result;
}
function membershipOpaque(value: unknown): string {
  const result = membershipText(value);
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw Error('membership-line'); return result;
}
function membershipLabel(value: unknown): string {
  const result = membershipOpaque(value); if (!result.trim()) throw Error('membership-label'); return result;
}
function membershipSession(value: unknown): ProjectSession {
  const row = record(value); closed(row, ['name', 'created', 'machine_id']);
  if (typeof row.created !== 'number' || !Number.isFinite(row.created) || row.created < 0 ||
      Number.isInteger(row.created) && !Number.isSafeInteger(row.created)) throw Error('incarnation');
  return { name: membershipText(row.name), created: row.created,
    ...(row.machine_id === undefined ? {} : { machine_id: id(row.machine_id) }) };
}
function membershipParticipation(value: unknown): Participation {
  const row = record(value); closed(row, ['id', 'label', 'recorded_relation', 'target', 'role_label', 'work_refs']);
  const rawTarget = record(row.target); let target: ParticipationTarget;
  if (rawTarget.kind === 'mesh') {
    closed(rawTarget, ['kind', 'name', 'created', 'machine_id']);
    const {kind: _kind, ...identity} = rawTarget;
    target = {kind: 'mesh', ...membershipSession(identity), name: membershipOpaque(rawTarget.name)};
  } else {
    closed(rawTarget, ['kind', 'agent', 'conversation_id']);
    if (rawTarget.kind !== 'history' || typeof rawTarget.agent !== 'string' || !['claude', 'codex', 'pi'].includes(rawTarget.agent)) throw Error('history-target');
    target = {kind: 'history', agent: rawTarget.agent as 'claude' | 'codex' | 'pi', conversation_id: membershipOpaque(rawTarget.conversation_id)};
  }
  if (typeof row.recorded_relation !== 'string' || !['active', 'saved', 'historical'].includes(row.recorded_relation)) throw Error('relation');
  const work_refs = row.work_refs === undefined ? undefined : array(row.work_refs, 20, value => {
    const ref = record(value); closed(ref, ['source_id', 'kind', 'native_id', 'instance_id']);
    return {source_id: id(ref.source_id), kind: id(ref.kind), native_id: membershipOpaque(ref.native_id),
      ...(ref.instance_id === undefined ? {} : {instance_id: membershipOpaque(ref.instance_id)})};
  });
  if (work_refs && new Set(work_refs.map(ref => JSON.stringify([ref.source_id, ref.kind, ref.native_id, ref.instance_id ?? null]))).size !== work_refs.length)
    throw Error('duplicate-reference');
  return {id: id(row.id), recorded_relation: row.recorded_relation as Participation['recorded_relation'], target,
    ...(row.label === undefined ? {} : {label: membershipLabel(row.label)}),
    ...(row.role_label === undefined ? {} : {role_label: membershipLabel(row.role_label)}),
    ...(work_refs === undefined ? {} : {work_refs})};
}
function membership(value: unknown, project: ProjectDetail | undefined): ProjectMembership {
  const row = record(value); closed(row, ['sessions', 'participations', 'complete', 'omitted_fields']);
  if (!project || project.sessions_total > 100 || project.participations_total > 100 || typeof row.complete !== 'boolean') throw Error('membership');
  const omitted_fields = array(row.omitted_fields, 2, value => {
    if (value !== 'sessions' && value !== 'participations') throw Error('omission'); return value;
  });
  if (new Set(omitted_fields).size !== omitted_fields.length) throw Error('omission');
  const sessions = row.sessions === undefined ? undefined : array(row.sessions, 100, membershipSession);
  const participations = row.participations === undefined ? undefined : array(row.participations, 100, membershipParticipation);
  if (participations && new Set(participations.map(row => row.id)).size !== participations.length) throw Error('duplicate');
  for (const [key, rows, total] of [['sessions', sessions, project.sessions_total], ['participations', participations, project.participations_total]] as const) {
    if (rows === undefined ? !omitted_fields.includes(key) : omitted_fields.includes(key) || rows.length !== total) throw Error('membership-count');
  }
  if (row.complete !== (omitted_fields.length === 0)) throw Error('completeness');
  return {...(sessions ? {sessions} : {}), ...(participations ? {participations} : {}), complete: row.complete, omitted_fields};
}
function settings(value: unknown): ObservationSettings {
  const o = record(value);
  if (o.kind === 'project') {
    closed(o, ['kind', 'plan', 'repository', 'source_summaries']);
    const plan = o.plan === null ? null : record(o.plan), repository = o.repository === null ? null : record(o.repository);
    if (plan) closed(plan, ['repository', 'source_ids']);
    if (repository) closed(repository, ['url', 'local_path', 'primary_ref']);
    if (plan && (typeof plan.repository !== 'boolean' || !Array.isArray(plan.source_ids))) throw Error('plan');
    const ids = plan ? array(plan.source_ids, 20, id) : [];
    if (new Set(ids).size !== ids.length) throw Error('plan');
    return { kind: 'project', plan: plan ? { repository: plan.repository as boolean, source_ids: ids } : null,
      repository: repository ? { url: text(repository.url, 4096),
        ...(repository.local_path === undefined ? {} : { local_path: text(repository.local_path, 4096) }),
        ...(repository.primary_ref === undefined ? {} : { primary_ref: text(repository.primary_ref, 4096) }) } : null,
      source_summaries: array(o.source_summaries, 20, value => {
        const row = record(value); closed(row, ['id', 'kind', 'label', 'selector_configured']); if (typeof row.selector_configured !== 'boolean') throw Error('selector');
        return { id: id(row.id), kind: text(row.kind, 40), label: text(row.label, 240), selector_configured: row.selector_configured };
      }) };
  }
  if (o.kind !== 'source') throw Error('settings');
  closed(o, ['kind', 'source']);
  const row = record(o.source), selector = row.selector === null ? null : record(row.selector);
  closed(row, ['id', 'kind', 'label', 'url', 'selector']);
  if (selector) closed(selector, selector.kind === 'board' ? ['kind', 'path'] : ['kind', 'root', 'task']);
  let selected: SourceSelector = null;
  if (selector?.kind === 'board') selected = { kind: 'board', path: text(selector.path, 4096) };
  else if (selector?.kind === 'pipeline') selected = { kind: 'pipeline', root: text(selector.root, 4096), task: text(selector.task, 120) };
  else if (selector) throw Error('selector');
  return { kind: 'source', source: { ...source(row), selector: selected } };
}
export function parseHostReply(value: unknown, op: string): HostReply {
  const row = record(value);
  if (row.kind !== 'mesh-project-reply' || row.version !== 1 || row.op !== op ||
      typeof row.boot !== 'string' || !/^[a-f0-9]{64}$/.test(row.boot) ||
      typeof row.status !== 'string' || !['ok', 'uninitialized', 'refused', 'conflict', 'uncertain', 'unsupported', 'unavailable', 'busy'].includes(row.status))
    throw Error('reply');
  const result: HostReply = { kind: 'mesh-project-reply', version: 1, op, boot: row.boot, status: row.status };
  for (const key of ['code', 'result', 'intent_state', 'project_id', 'request_id'] as const)
    if (row[key] !== undefined) result[key] = text(row[key], 100);
  if (row.revision !== undefined) {
    const revision = text(row.revision, 80);
    if (revision !== 'cfg1_missing' && !/^cfg1_[a-f0-9]{64}$/.test(revision)) throw Error('revision');
    result.revision = revision;
  }
  if (row.machine_id !== undefined) result.machine_id = id(row.machine_id);
  if (row.projects !== undefined) {
    result.projects = array(row.projects, 100, summary);
    if (new Set(result.projects.map(item => item.id)).size !== result.projects.length || row.complete !== true || row.total !== result.projects.length)
      throw Error('incomplete');
  }
  if (row.project !== undefined) result.project = detail(row.project);
  if (row.membership !== undefined) result.membership = membership(row.membership, result.project);
  if (row.features !== undefined) {
    result.features = array(row.features, 32, value => text(value, 80));
    if (new Set(result.features).size !== result.features.length) throw Error('features');
  }
  if (row.omitted_fields !== undefined) result.omitted_fields = array(row.omitted_fields, 8, item => text(item, 80));
  if (row.observation_settings !== undefined) result.observation_settings = settings(row.observation_settings);
  if (row.observation !== undefined) result.observation = record(row.observation);
  if (row.intent_kind !== undefined) result.intent_kind = row.intent_kind === null ? null : text(row.intent_kind, 40);
  return result;
}

export async function requestProjectValue(request: ProjectHTTP, value: ProjectRequest, signal?: AbortSignal): Promise<unknown> {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > PROJECT_REQUEST_BYTES) throw new ProjectTransportError('too-large');
  const mutation = value.op === 'project_create' || value.op === 'project_settings';
  let attempted = false;
  try {
    attempted = true;
    const response = await request('/api/projects/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, ...(signal ? { signal } : {}), cache: 'no-store', redirect: 'error' });
    if (response.status === 401 || response.status === 403) throw new ProjectTransportError('denied');
    if (!response.body) throw Error('body');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength; if (length > PROJECT_REPLY_BYTES) throw Error('oversize'); chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.op === 'project_capabilities' && response.status === 400 &&
        (contents === 'Unknown op: project_capabilities' || contents === 'invalid request'))
      return { kind: 'mesh-project-reply', version: 1, op: value.op, boot: '', status: 'unsupported', code: 'native-host-required' };
    if (value.op === 'project_observation_start' && response.status === 400) {
      if (contents === 'Unsupported project operation') throw new ProjectTransportError('unsupported');
      const refusal = record(JSON.parse(contents));
      if (Object.keys(refusal).length === 1 && refusal.error === 'Unsupported project operation')
        throw new ProjectTransportError('unsupported');
    }
    if (!response.ok) throw Error('http');
    return parseJsonStrict(contents, 'project');
  } catch (error) {
    if (error instanceof ProjectTransportError) throw error;
    throw new ProjectTransportError(mutation && attempted ? 'uncertain' : 'unavailable');
  }
}

/** Reuse the qualified participation transport's receipt binding, without its older DTO parser. */
function correlateReply(reply:HostReply,value:ProjectRequest):HostReply {
  if(reply.status!=='ok')return reply;
  const mutation=value.op==='project_create'||value.op==='project_settings';
  if(!mutation&&value.op!=='project_status')return reply;
  const project=value.op==='project_create'?value.request_id:value.project_id;
  if(!value.request_id||!project||reply.request_id!==value.request_id||reply.project_id!==project||!reply.revision)throw Error('intent-identity');
  if(mutation) {
    if(reply.boot!==value.boot||!reply.machine_id||reply.revision==='cfg1_missing'||
      !['replayed',value.op==='project_create'?'created':'updated'].includes(reply.result??''))throw Error('mutation-receipt');
  } else {
    if(!['confirmed','pending','absent','unknown'].includes(reply.intent_state??''))throw Error('intent-state');
    if(reply.intent_state==='confirmed' ? !['create','settings'].includes(reply.intent_kind??'')||!reply.machine_id||reply.revision==='cfg1_missing' : reply.intent_kind!==null)throw Error('intent-kind');
  }
  return reply;
}

export async function requestProject(request: ProjectHTTP, value: ProjectRequest, signal?: AbortSignal): Promise<HostReply> {
  const raw = await requestProjectValue(request, value, signal);
  try {
    if (value.op === 'project_capabilities' && (raw as HostReply)?.code === 'native-host-required' && (raw as HostReply)?.boot === '') return raw as HostReply;
    return correlateReply(parseHostReply(raw, value.op),value);
  } catch { throw new ProjectTransportError(value.op === 'project_create' || value.op === 'project_settings' ? 'uncertain' : 'unavailable'); }
}
