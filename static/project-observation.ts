// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { requestProject, requestProjectValue } from './project-host.ts';
import type { ProjectHTTP, ProjectRequest } from './project-host.ts';
import { parseProjectCatalog } from './project-catalog.ts';
import type { ProjectCatalog } from './project-catalog.ts';
export interface ObservationTarget { boot: string; machine_id: string; project_id: string; revision: string }
export interface ObservationDescriptor { observation_id: string; boot: string; machine_id: string; project_id: string;
  captured_revision: string; byte_length: number; page_count: number; raw_page_bytes: number; sha256: string; captured_at: string; published_at: string }
export interface ObservationLifetime { observation_id: string; request_id: string; requested_scope: { machine_id: string; project_id: string; revision: string };
  observation_state?: string; descriptor?: ObservationDescriptor; cancel_token?: string; code?: string }
const STATES = ['capturing', 'running', 'cancelling', 'cleanup-pending', 'complete', 'failed', 'cancelled', 'stale', 'expired'];
const CODES = ['invalid-request','wrong-version','unsupported-feature','stale-host','lifetime-mismatch','immutable-identity','revision-conflict',
  'identity-mismatch','unknown-project','runtime-not-configured','runtime-unavailable','worker-capacity','control-capacity','record-capacity',
  'byte-capacity','result-capacity','not-ready','stale','expired','evicted','unknown','page-range','cancellation-denied','cancelled','deadline',
  'collector-failed','collector-invalid','collector-oversize','worker-exited-unverified','stopping','unknown-source'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('observation-invalid');
  return value as Record<string, unknown>;
}
function closed(o: Record<string, unknown>, keys: string[]) { if (Object.keys(o).some(key => !keys.includes(key))) throw Error('observation-invalid'); }
function hex(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('observation-invalid'); return value; }
function uint(value: unknown, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw Error('observation-invalid'); return value as number; }
export function parseObservationDescriptor(value: unknown, target: ObservationTarget, observation: string): ObservationDescriptor {
  const o = object(value); closed(o, ['observation_id','boot','machine_id','project_id','captured_revision','byte_length','page_count','raw_page_bytes','sha256','captured_at','published_at']);
  if (o.observation_id !== observation || o.boot !== target.boot || o.machine_id !== target.machine_id || o.project_id !== target.project_id ||
    o.captured_revision !== target.revision || o.raw_page_bytes !== 131072) throw Error('observation-scope');
  const length = uint(o.byte_length, 2097152), pages = uint(o.page_count, 16);
  if (!length || pages !== Math.ceil(length / 131072)) throw Error('observation-pages');
  for (const key of ['captured_at', 'published_at']) if (typeof o[key] !== 'string' || (o[key] as string).length > 80 ||
    !/^\d{4}-\d\d-\d\dT/.test(o[key] as string) || !Number.isFinite(Date.parse(o[key] as string))) throw Error('observation-time');
  hex(o.sha256); return o as unknown as ObservationDescriptor;
}
export function parseObservationReply(value: unknown, op: string, target: ObservationTarget, requestId: string,
  observation?: string): ObservationLifetime & Record<string, unknown> {
  const o = object(value);
  closed(o, ['kind','version','op','boot','status','code','request_id','observation_id','requested_scope','observation_state',
    'identity_retention_ms','descriptor','remaining_ms','cancel_token','replayed','page_index','data_base64']);
  if (o.kind !== 'mesh-project-reply' || o.version !== 1 || o.op !== op || o.boot !== target.boot ||
    !['ok','refused','conflict','unsupported','unavailable','busy'].includes(String(o.status))) throw Error('observation-invalid');
  if (o.code !== undefined && !CODES.includes(String(o.code))) throw Error('observation-code');
  if (o.request_id !== undefined && o.request_id !== requestId) throw Error('observation-request');
  if (o.status !== 'ok') throw Error(typeof o.code === 'string' ? o.code : String(o.status));
  if (o.request_id !== requestId || observation !== undefined && o.observation_id !== observation) throw Error('observation-request');
  hex(o.observation_id);
  const scope = object(o.requested_scope); closed(scope, ['machine_id','project_id','revision']);
  if (scope.machine_id !== target.machine_id || scope.project_id !== target.project_id || scope.revision !== target.revision) throw Error('observation-scope');
  if (o.code === 'unknown') {
    if (Object.keys(o).some(key => !['kind','version','op','boot','status','code','observation_id','request_id','requested_scope'].includes(key))) throw Error('observation-unknown');
    return o as ObservationLifetime & Record<string, unknown>;
  }
  if (!STATES.includes(String(o.observation_state))) throw Error('observation-state');
  if (o.identity_retention_ms !== null) uint(o.identity_retention_ms, 120000);
  if (['capturing','running','cancelling','cleanup-pending'].includes(String(o.observation_state)) && o.identity_retention_ms !== null) throw Error('observation-retention');
  if (o.remaining_ms !== undefined) uint(o.remaining_ms, 120000);
  if (op === 'project_observation_start') {
    hex(o.cancel_token); if (typeof o.replayed !== 'boolean') throw Error('observation-start');
  } else if (o.cancel_token !== undefined || o.replayed !== undefined) throw Error('observation-token');
  if (o.descriptor !== undefined) parseObservationDescriptor(o.descriptor, target, o.observation_id as string);
  if (o.observation_state === 'complete' && o.descriptor === undefined) throw Error('observation-descriptor');
  if (o.data_base64 !== undefined || o.page_index !== undefined) {
    if (op !== 'project_observation_page' || o.observation_state !== 'complete' || typeof o.data_base64 !== 'string') throw Error('observation-data');
    uint(o.page_index, 15);
  } else if (op === 'project_observation_page' && o.observation_state === 'complete') throw Error('observation-data');
  return o as ObservationLifetime & Record<string, unknown>;
}
function canonicalPage(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('observation-base64');
  const raw = atob(value); if (raw.length !== length || btoa(raw) !== value) throw Error('observation-base64');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
/** One explicit intent. Losing a reader never replays admission, cancels a worker or stores its token. */
export class ProjectObservationReader {
  readonly target: ObservationTarget;
  readonly requestId: string;
  private request: ProjectHTTP;
  private current: () => boolean;
  lifetime: ObservationLifetime | null = null;
  constructor(request: ProjectHTTP, target: ObservationTarget, current: () => boolean, requestId = crypto.randomUUID()) {
    this.request = request; this.target = { ...target }; this.current = current; this.requestId = requestId;
  }
  private alive(signal?: AbortSignal) { if (!this.current() || signal?.aborted) throw Error('observation-abandoned'); }
  private async call(op: ProjectRequest['op'], extra: Record<string, unknown>, signal?: AbortSignal) {
    this.alive(signal);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 6500);
    let raw: unknown;
    try { raw = await requestProjectValue(this.request, { op, version: 1, boot: this.target.boot,
      machine_id: this.target.machine_id, project_id: this.target.project_id, request_id: this.requestId, ...extra }, controller.signal);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    this.alive(signal);
    const value = parseObservationReply(raw, op, this.target, this.requestId, op === 'project_observation_start' ? undefined : this.lifetime?.observation_id);
    this.lifetime = { ...value, ...(this.lifetime?.cancel_token ? { cancel_token: this.lifetime.cancel_token } : {}) }; return value;
  }
  async start(signal?: AbortSignal) { return this.call('project_observation_start', { expected_revision: this.target.revision }, signal); }
  private control() { if (!this.lifetime) throw Error('observation-no-admission'); return { requested_revision: this.target.revision, observation_id: this.lifetime.observation_id }; }
  async status(signal?: AbortSignal) { return this.call('project_observation_status', this.control(), signal); }
  async cancel(signal?: AbortSignal) {
    if (!this.lifetime?.cancel_token) throw Error('observation-no-token');
    return this.call('project_observation_cancel', { ...this.control(), cancel_token: this.lifetime.cancel_token }, signal);
  }
  async assemble(signal?: AbortSignal): Promise<ProjectCatalog> {
    const descriptor = this.lifetime?.descriptor;
    if (this.lifetime?.observation_state !== 'complete' || !descriptor) throw Error('observation-not-complete');
    const bytes = new Uint8Array(descriptor.byte_length);
    for (let index = 0; index < descriptor.page_count; index++) {
      const page = await this.call('project_observation_page', { ...this.control(), page_index: index }, signal);
      if (page.page_index !== index || Object.entries(descriptor).some(([key, value]) => (page.descriptor as unknown as Record<string, unknown>)?.[key] !== value)) throw Error('observation-page-changed');
      const offset = index * 131072, length = Math.min(131072, bytes.length - offset);
      bytes.set(canonicalPage(page.data_base64, length), offset);
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); this.alive(signal);
    if (Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') !== descriptor.sha256) throw Error('observation-digest');
    const catalog = parseProjectCatalog(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!catalog || catalog.schema_version !== 2 || !catalog.features.includes('project-metadata/1') || !catalog.features.includes('roster-followup/1') || catalog.machine_id !== this.target.machine_id || catalog.projects.length !== 1 ||
      catalog.projects[0]?.id !== this.target.project_id) throw Error('observation-catalog');
    // Identity/revision must still be native-current after every page, digest and strict decoding step.
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); const timeout = setTimeout(abort, 6500);
    let fresh;
    try { fresh = await requestProject(this.request, { op: 'project_read', version: 1, project_id: this.target.project_id }, controller.signal); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    this.alive(signal);
    if (fresh.status !== 'ok' || fresh.boot !== this.target.boot || fresh.machine_id !== this.target.machine_id ||
      fresh.project?.id !== this.target.project_id || fresh.revision !== this.target.revision) throw Error('observation-stale');
    return catalog;
  }
}
