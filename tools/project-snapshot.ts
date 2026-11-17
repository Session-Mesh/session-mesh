#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import { parseJsonStrict } from '../static/demo-view-contract.ts';
import { projectFollowup } from './project-followup-projection.ts';
/** Explicit local observations only. Selected executables are owner-trusted, not sandboxed. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseProjectConfig, parseProjectCatalog, COUNT_KEYS, PROJECT_LIMITS, PIPELINE_COMPONENTS, PIPELINE_LIMITS, README_PATHS } from '../static/project-catalog.ts';
import type { ProjectConfig, ProjectCatalog, ProjectSource, ProviderSummary, SourceConfig, SourceError, SummaryItem, PipelineDetail, ConfigProject, ProjectFeature, Project, RepositoryObservation, RepositoryReadme, RepositoryReason } from '../static/project-catalog.ts';
import { noProjectSymlinks as noSymlinks, projectJSONPath as jsonPath, openProjectRead, closeProjectRead, openPrivateProjectFile } from './project-file.ts';

export const SNAPSHOT_LIMITS = Object.freeze({ providerMs: 5000, runMs: 30000,
  stdoutBytes: PROJECT_LIMITS.bytes, stderrBytes: 65536, concurrency: 4 });
class SnapshotError extends Error {
  code: SourceError;
  constructor(code: SourceError) { super(code); this.code = code; }
}
interface ProcessOptions { timeoutMs?: number | undefined; stdoutBytes?: number; stderrBytes?: number; signal?: AbortSignal; onBytes?: (bytes: number) => boolean }
function runProjectChild(executable: string, args: string[], env: Record<string, string | undefined>, options: ProcessOptions = {}): Promise<Buffer> {
  return new Promise((accept, reject) => {
    if (options.signal?.aborted) { reject(new SnapshotError('budget-exceeded')); return; }
    if (!isAbsolute(executable) || executable.includes('\0')) { reject(new SnapshotError('spawn-failed')); return; }
    const child = spawn(executable, args, { shell: false, detached: process.platform !== 'win32',
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let signalAuthority = true;
    child.once('exit', () => { signalAuthority = false; });
    const outputLimit = Math.max(0, Math.min(options.stdoutBytes ?? SNAPSHOT_LIMITS.stdoutBytes, SNAPSHOT_LIMITS.stdoutBytes));
    let output: Buffer | undefined; let stdout = 0, stderr = 0, done = false, closed = false;
    let resultError: SourceError | undefined;
    const settle = () => {
      // Transfer one buffer/view; no concatenation duplicates retained stdout.
      const bytes = output?.subarray(0, stdout) ?? Buffer.alloc(0); output = undefined;
      if (resultError) reject(new SnapshotError(resultError)); else accept(bytes);
    };
    const kill = () => {
      // The numeric group is signalable only while its owned leader is live.
      // Reaped leader identity cannot authorize a later group signal. Pipe
      // ownership still persists until the actual child close event.
      if (signalAuthority && child.exitCode === null && child.signalCode === null && child.pid) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already gone */ } }
    };
    const finish = (error?: SourceError) => {
      if (done) return; done = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) { output = undefined; kill(); }
      resultError = error;
      if (closed) settle();
    };
    const abort = () => finish('budget-exceeded');
    const timer = setTimeout(() => finish('timeout'), Math.min(options.timeoutMs ?? SNAPSHOT_LIMITS.providerMs, SNAPSHOT_LIMITS.providerMs));
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return;
      if (options.onBytes && !options.onBytes(chunk.length)) { finish('budget-exceeded'); return; }
      stdout += chunk.length;
      if (stdout > outputLimit) finish('output-limit');
      else if (!done) { output ??= Buffer.alloc(outputLimit); chunk.copy(output, stdout - chunk.length); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (done) return;
      if (options.onBytes && !options.onBytes(chunk.length)) { finish('budget-exceeded'); return; }
      stderr += chunk.length;
      if (stderr > Math.min(options.stderrBytes ?? SNAPSHOT_LIMITS.stderrBytes, SNAPSHOT_LIMITS.stderrBytes)) finish('output-limit');
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? 'missing-executable' : 'spawn-failed'));
    child.on('close', (code, signal) => { closed = true; if (done) settle(); else finish(code === 0 && !signal ? undefined : 'provider-failed'); });
  });
}
export async function runProvider(executable: string, args: string[], env: Record<string, string | undefined>, options: ProcessOptions = {}): Promise<unknown> {
  const bytes = await runProjectChild(executable, args, env, options);
  try { return parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'project'); }
  catch { throw new SnapshotError('invalid-output'); }
}

type Obj = Record<string, unknown>;
function obj(v: unknown): Obj { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('object'); return v as Obj; }
function arr(v: unknown): unknown[] { if (!Array.isArray(v)) throw Error('array'); return v; }
function text(v: unknown, max = 240, empty = false): string {
  if (typeof v !== 'string' || (!empty && !v.length)) throw Error('text');
  // Reject instead of silently altering the source's assertions, including overlong strings.
  if (v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) throw Error('text'); return v;
}
function count(v: unknown): number { if (!Number.isSafeInteger(v) || (v as number) < 0) throw Error('count'); return v as number; }
function identifier(v: unknown): string { const s = text(v, 80); if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error('id'); return s; }
function timestamp(v: unknown): string {
  const s = text(v, 40); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) || !Number.isFinite(Date.parse(s))) throw Error('timestamp');
  if (new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) throw Error('calendar'); return s;
}
function counts(v: unknown): Record<string, number> {
  const o = obj(v); return Object.fromEntries(COUNT_KEYS.filter(k => Object.hasOwn(o, k)).map(k => [k, count(o[k])]));
}
export function normalizeProvider(kind: 'roster', value: unknown): ProviderSummary {
  const o = obj(value);
  if (kind !== 'roster') throw Error('provider');
  if (o.schema_version !== 1 || o.kind !== 'roster-roadmap-view') throw Error('schema');
  const all = arr(o.tasks), selected = all.slice(0, PROJECT_LIMITS.items);
  let truncated = all.length > selected.length;
  const items: SummaryItem[] = selected.map(v => {
    const t = obj(v);
    const item: SummaryItem = { id: identifier(t.id), title: text(t.objective), state: text(t.state, 80) };
    {
      const deps = arr(t.depends_on); if (deps.length > 200) throw Error('dependencies');
      item.depends_on = deps.map(identifier); item.attempts = count(t.attempts);
      const checks = arr(t.checks); truncated ||= checks.length > 200;
      item.checks = checks.slice(0, 200).map(v => { const c = obj(v);
        return { id: identifier(c.id), accepted_status: text(c.accepted_status, 80), reported_status: text(c.reported_status, 80) }; });
    }
    return item;
  });
  const result: ProviderSummary = { provider_schema: 'roster-roadmap-view', provider_version: 1,
    source_generated_at: timestamp(o.generated_at),
    counts: counts(o.counts), items, truncated, more: all.length - items.length };
  {
    result.source_revision = text(o.version); result.goal = text(o.goal, 4000, true); result.phase = text(o.phase, 80);
    const global = obj(o.global); if (typeof global.accepted !== 'boolean') throw Error('acceptance');
    result.global_accepted = global.accepted;
    Object.assign(result.counts, counts(o.completion));
    if (o.operator_requests !== undefined) {
      const requests = obj(o.operator_requests);
      if (!['absent', 'valid', 'invalid'].includes(requests.status as string)) throw Error('operator status');
      result.operator_status = requests.status as 'absent' | 'valid' | 'invalid';
      result.operator_truncated = requests.truncated === true;
      result.operator_requests = [];
      if (requests.status !== 'invalid') {
        const c = obj(requests.counts);
        for (const key of ['open', 'now', 'later', 'unscheduled', 'answered', 'withdrawn', 'archived']) {
          if (Object.hasOwn(c, key)) result.counts[`operator_${key}`] = count(c[key]);
        }
        const list = arr(requests.items); result.operator_truncated ||= list.length > 200;
        result.operator_requests = list.slice(0, 200).map(v => { const r = obj(v);
          return { id: identifier(r.id), title: text(r.text, 2000), state: text(r.status ?? r.state, 80) }; });
      }
      result.truncated ||= result.operator_truncated;
      // Advisory/history truncation cannot be expressed as a reliable omitted task count.
      if (result.operator_truncated) result.more = null;
    }
  }
  return result;
}

function normalizePipeline(value: unknown, root: string, task: string): ProviderSummary {
  const o = obj(value), schema = obj(o.schema), d = obj(o.data), raw = obj(d.components);
  const digest = (v: unknown) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw Error('digest'); return v; };
  if (o.kind !== 'pipeline-task' || o.schema_version !== 1 || schema.id !== 'https://github.com/mathiasbourgoin/roster/schema/pipeline-observation/v1' || o.root !== resolve(root) || d.task !== task) throw Error('pipeline identity');
  digest(schema.digest); const revision = digest(o.version);
  if (Object.keys(raw).length !== PIPELINE_COMPONENTS.length || Object.keys(raw).some(k => !(PIPELINE_COMPONENTS as readonly string[]).includes(k))) throw Error('components');
  const components = Object.fromEntries(PIPELINE_COMPONENTS.map(name => {
    const c = obj(raw[name]); text(c.source, PIPELINE_LIMITS.text);
    if (!['valid', 'absent', 'invalid'].includes(c.availability as string) || typeof c.truncated !== 'boolean') throw Error('component');
    if (c.digest !== null) digest(c.digest);
    if (c.availability === 'valid') { obj(c.value); if (c.digest === null || c.reason !== null) throw Error('valid component'); }
    else if (c.value !== null || c.truncated || c.availability === 'absent' && (c.digest !== null || c.reason !== null)) throw Error('component value');
    return [name, { availability: c.availability, reason: c.reason, truncated: c.truncated }];
  }));
  const select = (v: unknown, names: string[]) => { const item = obj(v); return Object.fromEntries(names.map(name => [name, item[name]])); };
  const reportList = (v: unknown, names: string[]) => {
    const list = obj(v), items = arr(list.items); if (items.length > PIPELINE_LIMITS.items) throw Error('report list');
    return { items: items.map(item => select(item, names)), total: list.total, truncated: list.truncated };
  };
  const report = (name: 'review' | 'qa_state') => {
    const c = obj(raw[name]); if (c.availability !== 'valid') return null;
    const v = obj(c.value);
    const findings = reportList(v.findings, ['severity', 'summary', 'status', 'specialist']);
    return { ...select(v, ['status', 'round', 'cycle', 'date']),
      // The public provider calls the finding text `summary`; Mesh keeps its
      // display DTO's existing `description` field rather than dropping text.
      findings: { ...findings, items: findings.items.map(({ summary, ...finding }) => ({ ...finding, description: summary })) },
      rounds_audit: reportList(v.rounds_audit, ['round', 'date', 'verdict', 'qualifying', 'causes']),
      no_go_reason: v.no_go_reason === null ? null : select(v.no_go_reason, ['type', 'cause', 'failed_acs']),
      ...(name === 'qa_state' ? { qa_no_go_round: v.qa_no_go_round } : {}) };
  };
  const h = obj(d.history), events = arr(h.items); if (events.length > PIPELINE_LIMITS.history) throw Error('history limit');
  const history = { total: h.total, truncated: h.truncated, items: events.map((v, i) => {
    const e = obj(v); if (e.id !== `event:${i}` || e.source_index !== i) throw Error('event identity');
    return { ...select(e, ['source_index', 'phase', 'outcome', 'reason', 'reason_truncated']),
      actor: select(e.actor, ['availability', 'value', 'truncated']), time: select(e.time, ['availability', 'value']) };
  }) };
  const ledger = obj(raw.ledger);
  if (ledger.availability === 'valid') {
    const v = obj(ledger.value), a = obj(v.latest_completed), b = obj(d.latest_completed);
    if (v.mode !== d.mode || v.history_total !== h.total || v.current_phase !== b.phase || a.phase !== b.phase || a.outcome !== b.outcome) throw Error('ledger metadata');
  }
  const coverage = arr(o.coverage); if (coverage.length > PIPELINE_LIMITS.coverage) throw Error('coverage limit');
  // Only selected data crosses into the DTO. The existing per-source catalog parse
  // validates every selected scalar and cross-field invariant before admission.
  const pipeline = { ...select(d, ['task', 'availability', 'mode', 'latest_completed', 'verdict_disagreement']), components, history,
    review: report('review'), qa: report('qa_state'),
    qa_markdown_status: obj(raw.qa).availability === 'valid' ? obj(obj(raw.qa).value).status : null,
    coverage: coverage.map(v => select(v, ['id', 'availability', 'limitations'])) } as unknown as PipelineDetail;
  return { provider_schema: 'pipeline-task', provider_version: 1, source_generated_at: timestamp(o.generated_at), source_revision: revision,
    counts: {}, items: [], pipeline, truncated: Object.values(components).some(c => c.truncated) || h.truncated === true || events.some(e => obj(e).reason_truncated === true || obj(obj(e).actor).truncated === true), more: null };
}

export interface SnapshotOptions { rosterCLI?: string | undefined; rosterPipelineCLI?: string | undefined; runMs?: number; providerMs?: number;
  catalogVersion?: 1 | 2; profile?: "metadata/1" | "followup/1" | "metadata-followup/1"; followup?: boolean; signal?: AbortSignal; compact?: boolean; concurrency?: number; inspectRepositories?: boolean }
function sourceMetadata(source: SourceConfig): Pick<ProjectSource, 'id' | 'kind' | 'label' | 'url' | 'channels'> {
  const { id, kind, label, url, channels } = source;
  return { id, kind, label, ...(url === undefined ? {} : { url }), ...(channels === undefined ? {} : { channels }) };
}
function projectMetadata(project: ConfigProject, observation?: RepositoryObservation): Omit<Project, 'sources'> & { sources: SourceConfig[] } {
  const metadata = project;
  if (!project.repository) return metadata;
  const { url, branch, readme_url } = project.repository;
  return { ...metadata, repository: { url, ...(branch === undefined ? {} : { branch }), ...(readme_url === undefined ? {} : { readme_url }),
    ...(observation === undefined ? {} : { observation }) } };
}
function catalogHeader(version: 1 | 2, followup = false, metadata = true): Pick<ProjectCatalog, 'schema_version' | 'features'> {
  return version === 1 ? { schema_version: 1 } : { schema_version: 2, features: [...(metadata ? ['project-metadata/1' as const] : []), ...(followup ? ['roster-followup/1' as const] : [])] satisfies ProjectFeature[] };
}
const GIT_LIMITS = Object.freeze({ processes: 10, milliseconds: 1000, stdout: 65536, stderr: 8192, aggregate: 2 * 1024 * 1024 });
class GitObservationError extends Error {
  reason: RepositoryReason;
  constructor(reason: RepositoryReason) { super(reason); this.reason = reason; }
}
interface GitBudget { deadline: number; signal: AbortSignal; bytes: number; exhausted: boolean }
const emptyReadme = (status: RepositoryReadme['status'], reason: RepositoryReason): RepositoryReadme =>
  ({ status, reason, path: null, blob: null, size: null, text: null, truncated: false });
function unconfiguredRepository(reason: 'inspection-disabled' | 'no-local-repository', assembled_at: string): RepositoryObservation {
  return { status: 'unconfigured', assembled_at, method: null, reason, ref: null, commit: null, readme: emptyReadme('unconfigured', reason) };
}
function validGitRef(value: string): boolean {
  return value.length <= 240 && /^refs\/(heads|remotes)\/.+/u.test(value) && !/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) &&
    !value.includes('..') && !value.includes('@{') && !value.endsWith('.') &&
    value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.lock'));
}
function gitLine(bytes: Buffer): string {
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new GitObservationError('invalid-output'); }
  if (!/^[^\r\n]+\n$/u.test(text)) throw new GitObservationError('invalid-output'); return text.slice(0, -1);
}
function gitReason(error: unknown, fallback: RepositoryReason): RepositoryReason {
  if (error instanceof GitObservationError) return error.reason;
  if (error instanceof SnapshotError) return error.code === 'timeout' ? 'timeout' :
    ['budget-exceeded', 'output-limit'].includes(error.code) ? 'budget-exceeded' : fallback;
  return 'invalid-output';
}
function repositoryGit(localPath: string, budget: GitBudget): (args: string[]) => Promise<Buffer> {
  let calls = 0;
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined]));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
  return async (args: string[]): Promise<Buffer> => {
    const remaining = budget.deadline - performance.now();
    if (budget.exhausted || budget.signal.aborted || remaining <= 0 || calls >= GIT_LIMITS.processes) throw new GitObservationError('budget-exceeded');
    calls++;
    return runProjectChild('/usr/bin/git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-C', localPath, ...args], env,
    { signal: budget.signal, timeoutMs: Math.max(1, Math.min(GIT_LIMITS.milliseconds, remaining)), stdoutBytes: GIT_LIMITS.stdout, stderrBytes: GIT_LIMITS.stderr,
      onBytes: bytes => { budget.bytes += bytes; if (budget.bytes > GIT_LIMITS.aggregate) budget.exhausted = true; return !budget.exhausted; } });
  };
}
async function observeRepository(project: ConfigProject, assembled_at: string, budget: GitBudget): Promise<RepositoryObservation> {
  const repository = project.repository!;
  if (!repository.local_path) return unconfiguredRepository('no-local-repository', assembled_at);
  const method = repository.primary_ref === undefined ? 'local-origin-head' : 'configured-ref';
  let ref: string | null = null, commit: string | null = null;
  const git = repositoryGit(repository.local_path, budget);
  try {
    try { gitLine(await git(['rev-parse', '--git-dir'])); }
    catch (e) { throw new GitObservationError(gitReason(e, 'invalid-repository')); }
    let selected: string;
    try { selected = repository.primary_ref ?? gitLine(await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])); }
    catch (e) { throw new GitObservationError(gitReason(e, 'ref-unavailable')); }
    if (!validGitRef(selected) || method === 'local-origin-head' && !selected.startsWith('refs/remotes/origin/')) throw new GitObservationError('ref-unavailable');
    ref = selected;
    try { commit = gitLine(await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])); }
    catch (e) { throw new GitObservationError(gitReason(e, 'ref-unavailable')); }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new GitObservationError('invalid-output');
  } catch (e) {
    return { status: 'unavailable', assembled_at, method, reason: gitReason(e, 'invalid-repository'), ref, commit: null,
      readme: emptyReadme('unavailable', 'repository-unavailable') };
  }
  let readme: RepositoryReadme = emptyReadme('absent', 'not-found');
  try {
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await git(['ls-tree', '-z', commit, '--', ...README_PATHS]));
    const entries = raw.split('\0'); if (entries.pop() !== '' || entries.length > README_PATHS.length) throw new GitObservationError('invalid-output');
    const found = new Map<string, { mode: string; type: string; blob: string }>();
    for (const entry of entries) {
      const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(entry);
      if (!match || !README_PATHS.includes(match[4] as typeof README_PATHS[number]) || found.has(match[4]!) || match[3]!.length !== commit.length) throw new GitObservationError('invalid-output');
      found.set(match[4]!, { mode: match[1]!, type: match[2]!, blob: match[3]! });
    }
    const path = README_PATHS.find(path => found.has(path));
    if (path) {
      const entry = found.get(path)!; readme = { ...emptyReadme('unavailable', 'unsupported-type'), path };
      if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') throw new GitObservationError('unsupported-type');
      readme.blob = entry.blob;
      const size = gitLine(await git(['cat-file', '-s', entry.blob]));
      if (!/^\d+$/u.test(size) || !Number.isSafeInteger(Number(size))) throw new GitObservationError('invalid-output');
      readme.size = Number(size); if (readme.size > GIT_LIMITS.stdout) throw new GitObservationError('too-large');
      const bytes = await git(['cat-file', 'blob', entry.blob]); if (bytes.length !== readme.size) throw new GitObservationError('invalid-output');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new GitObservationError('invalid-text'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new GitObservationError('invalid-text');
      let preview = text.slice(0, 4000); if (/[\uD800-\uDBFF]$/u.test(preview)) preview = preview.slice(0, -1);
      readme = { ...readme, status: 'valid', reason: null, text: preview, truncated: preview.length !== text.length };
    }
  } catch (e) { readme = { ...readme, status: 'unavailable', reason: gitReason(e, 'invalid-output'), text: null, truncated: false }; }
  return { status: 'valid', assembled_at, method, reason: null, ref, commit, readme };
}
function formattedBytes(value: unknown, indentation: number, compact = false): number {
  if (compact) return Buffer.byteLength(JSON.stringify(value));
  const text = JSON.stringify(value, null, 2);
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return Buffer.byteLength(text) + indentation * lines;
}
function initialCatalogBudget(config: ProjectConfig, version: 1 | 2, repositories: Map<ConfigProject, RepositoryObservation>, followup = false, compact = false, metadata = true): { bytes: number; reservations: Map<SourceConfig, number> } {
  const reservations = new Map<SourceConfig, number>();
  if (compact) {
    const generated_at = new Date().toISOString();
    const projects = config.projects.map(p => ({ ...projectMetadata(p, repositories.get(p)), sources: p.sources.map(source => {
      const placeholder = { ...sourceMetadata(source), observed_at: generated_at, status: 'unconfigured' };
      reservations.set(source, formattedBytes(placeholder, 0, true)); return placeholder;
    }) }));
    const bytes = formattedBytes({ kind: 'mesh-project-catalog', ...catalogHeader(version, followup, metadata), machine_id: config.machine_id, revision: '0'.repeat(64), generated_at, projects }, 0, true);
    if (bytes > PROJECT_LIMITS.bytes) throw Error('catalog-limit');
    return { bytes, reservations };
  }
  const generated_at = new Date().toISOString();
  let bytes = formattedBytes({ kind: 'mesh-project-catalog', ...catalogHeader(version, followup, metadata),
    machine_id: config.machine_id, revision: '0'.repeat(64), generated_at, projects: [] }, 0) + 1;
  // Count the two-space publication format one project/source at a time, without
  // allocating aggregate JSON. Replacing [] with its first item adds the item's
  // indented bytes plus newline/closing-indent overhead; later items add comma+LF.
  // Fixed-width dates and the SHA-256 revision make reservations exact.
  for (const [projectIndex, project] of config.projects.entries()) {
    bytes += formattedBytes({ ...projectMetadata(project, repositories.get(project)), sources: [] }, 4) + (projectIndex === 0 ? 4 : 2);
    if (bytes > PROJECT_LIMITS.bytes) throw Error('catalog-limit');
    for (const [sourceIndex, source] of project.sources.entries()) {
      const placeholder: ProjectSource = { ...sourceMetadata(source), observed_at: generated_at, status: 'unconfigured' };
      const reserved = formattedBytes(placeholder, 8);
      reservations.set(source, reserved);
      bytes += reserved + (sourceIndex === 0 ? 8 : 2);
      if (bytes > PROJECT_LIMITS.bytes) throw Error('catalog-limit');
    }
  }
  return { bytes, reservations };
}
async function observeSource(source: SourceConfig, machine_id: string, header: ReturnType<typeof catalogHeader>, signal: AbortSignal, options: SnapshotOptions): Promise<ProjectSource> {
  const { kind } = source, base = sourceMetadata(source);
  const pipeline = source.pipeline_root !== undefined;
  const configured = kind === 'roster' && (source.board_path !== undefined || pipeline);
  if (!configured) return { ...base, observed_at: new Date().toISOString(), status: 'unconfigured' };
  try {
    if (signal.aborted) throw new SnapshotError('budget-exceeded');
    const executable = pipeline ? options.rosterPipelineCLI : options.rosterCLI;
    if (!executable) throw new SnapshotError('missing-executable');
    const raw = await runProvider(executable, pipeline ? ['show', '--root', source.pipeline_root!, '--task', source.pipeline_task!, '--history-limit', '50'] : ['view', source.board_path!, '--events', options.followup ? '100' : '0'], {},
      { signal, timeoutMs: options.providerMs });
    const summary = pipeline ? normalizePipeline(raw, source.pipeline_root!, source.pipeline_task!) : normalizeProvider(kind as 'roster', raw);
    if (!pipeline && options.followup) summary.followup = projectFollowup(raw, summary);
    const observation: ProjectSource = { ...base, observed_at: new Date().toISOString(), status: 'available', summary };
    // Validate each DTO before assembly: one malformed provider must not fail the whole catalog.
    const checked = parseProjectCatalog({ kind: 'mesh-project-catalog', ...header, machine_id, revision: 'validation', generated_at: observation.observed_at,
      projects: [{ id: 'validation', title: 'validation', sources: [observation], sessions: [] }] });
    if (!checked) throw Error('invalid-output');
    return observation;
  } catch (e) {
    return { ...base, observed_at: new Date().toISOString(), status: 'unavailable', error_code: e instanceof SnapshotError ? e.code : 'invalid-output' };
  }
}
function assembleSnapshot(config: ProjectConfig, header: ReturnType<typeof catalogHeader>, repositories: Map<ConfigProject, RepositoryObservation>, observations: Map<SourceConfig, ProjectSource>): ProjectCatalog {
  const projects = config.projects.map(p => ({ ...projectMetadata(p, repositories.get(p)), sources: p.sources.map(s => observations.get(s)!) }));
  const generated_at = new Date().toISOString();
  const revision = createHash('sha256').update(JSON.stringify({ machine_id: config.machine_id, generated_at, projects })).digest('hex');
  const catalog = parseProjectCatalog({ kind: 'mesh-project-catalog', ...header, machine_id: config.machine_id, revision, generated_at, projects });
  if (!catalog) throw Error('invalid-catalog'); return catalog;
}
function snapshotVersion(config: ProjectConfig, options: SnapshotOptions): 1 | 2 {
  const version = options.catalogVersion === undefined ? 1 : options.catalogVersion;
  if (version !== 1 && version !== 2 || config.schema_version === 2 && version !== 2 || options.inspectRepositories && version !== 2) throw Error('unsupported-version');
  if (version === 2 && !parseProjectConfig({ ...config, schema_version: 2, features: ['project-metadata/1'] })) throw Error('invalid-catalog');
  return version;
}
function prepareSnapshot(configValue: ProjectConfig, options: SnapshotOptions) {
  const profile = options.profile;
  if (profile !== undefined && !["metadata/1", "followup/1", "metadata-followup/1"].includes(profile)) throw Error("unsupported-version");
  options = { ...options, followup: options.followup ?? (profile === "followup/1" || profile === "metadata-followup/1") };
  const metadata = profile !== "followup/1";
  const config = parseProjectConfig(configValue); if (!config) throw Error('invalid-config');
  const version = snapshotVersion(config, options);
  if ((!metadata && config.schema_version === 2) || version === 1 && (options.followup || profile !== undefined)) throw Error("unsupported-version");
  const header = catalogHeader(version, options.followup, metadata);
  const assembled_at = new Date().toISOString(), repositories = new Map<ConfigProject, RepositoryObservation>();
  if (version === 2 && metadata) for (const project of config.projects) if (project.repository)
    repositories.set(project, unconfiguredRepository(options.inspectRepositories ? 'no-local-repository' : 'inspection-disabled', assembled_at));
  return { config, version, header, metadata, assembled_at, repositories, options };
}
export async function generateSnapshot(configValue: ProjectConfig, options: SnapshotOptions): Promise<ProjectCatalog> {
  const { config, version, header, metadata, assembled_at, repositories, options: preparedOptions } = prepareSnapshot(configValue, options);
  options = preparedOptions;
  const budget = initialCatalogBudget(config, version, repositories, options.followup, options.compact, metadata);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const deadline = performance.now() + Math.min(options.runMs ?? SNAPSHOT_LIMITS.runMs, SNAPSHOT_LIMITS.runMs);
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
  const gitBudget: GitBudget = { deadline, signal: controller.signal, bytes: 0, exhausted: false };
  const sources = config.projects.flatMap(p => p.sources);
  const observations = new Map<SourceConfig, ProjectSource>(); let index = 0;
  let refusal: Error | null = null;
  try {
    const jobs: (() => Promise<void>)[] = sources.map(source => async () => {
        const observation = await observeSource(source, config.machine_id, header, controller.signal, options);
        if (refusal) return;
        const projectedBytes = budget.bytes + formattedBytes(observation, 8, options.compact) - budget.reservations.get(source)!;
        if (projectedBytes > PROJECT_LIMITS.bytes) {
          refusal = Error('catalog-limit');
          observations.clear();
          controller.abort();
          return;
        }
        budget.bytes = projectedBytes;
        // Admission is synchronous and precedes both retention and the next launch.
        observations.set(source, observation);
    });
    if (version === 2 && options.inspectRepositories) for (const project of config.projects) if (project.repository?.local_path) {
      jobs.push(async () => {
        const observation = await observeRepository(project, assembled_at, gitBudget);
        if (refusal) return;
        const before = formattedBytes({ ...projectMetadata(project, repositories.get(project)), sources: [] }, 4, options.compact);
        const after = formattedBytes({ ...projectMetadata(project, observation), sources: [] }, 4, options.compact);
        if (budget.bytes + after - before > PROJECT_LIMITS.bytes) { refusal = Error('catalog-limit'); controller.abort(); return; }
        budget.bytes += after - before; repositories.set(project, observation);
      });
    }
    await Promise.all(Array.from({ length: Math.min(SNAPSHOT_LIMITS.concurrency, options.concurrency ?? SNAPSHOT_LIMITS.concurrency, jobs.length) }, async () => {
      while (!refusal && index < jobs.length) {
        const job = jobs[index++]!;
        try { await job(); } catch (error) { refusal = error instanceof Error ? error : Error('collector-failed'); controller.abort(); }
      }
    }));
    if (refusal) throw refusal;
    return assembleSnapshot(config, header, repositories, observations);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); }
}

export async function readConfigFile(path: string): Promise<ProjectConfig> {
  const read = await openProjectRead(path);
  try {
    const config = parseProjectConfig(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes));
    if (!config) throw Error('invalid-config'); return config;
  } finally { await closeProjectRead(read); }
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return resolve(path); }
}
async function checkOutput(path: string, configPath: string, protectedRoots: string[]): Promise<string> {
  const output = jsonPath(path), config = jsonPath(configPath); await noSymlinks(output, true);
  const configCanonical = await canonical(config);
  if (output === configCanonical || output === config) throw Error('output-alias');
  for (const root of protectedRoots) {
    const candidate = await canonical(root);
    if (output === candidate || output.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep)) throw Error('protected-output');
  }
  try {
    const info = await lstat(output); if (!info.isFile() || info.nlink > 1) throw Error('output-file');
    const source = await lstat(config); if (info.dev === source.dev && info.ino === source.ino) throw Error('output-alias');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return output;
}
export async function publishSnapshot(path: string, value: ProjectCatalog, configPath: string, protectedRoots: string[]): Promise<void> {
  const catalog = parseProjectCatalog(value); if (!catalog) throw Error('invalid-catalog');
  const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n'); if (bytes.length > PROJECT_LIMITS.bytes) throw Error('catalog-limit');
  const output = await checkOutput(path, configPath, protectedRoots);
  const temporary = join(dirname(output), `.${randomUUID()}.tmp`);
  try {
    const handle = await openPrivateProjectFile(temporary);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await checkOutput(output, configPath, protectedRoots);
    await rename(temporary, output);
    const directory = await open(dirname(output), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  } finally { try { await unlink(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
}
export async function main(args: string[]): Promise<void> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; if (!flag || !['--config', '--output', '--roster-cli', '--roster-pipeline-cli', '--catalog-version', '--inspect-repositories', '--profile'].includes(flag) || !args[i + 1] || Object.hasOwn(options, flag)) throw Error('usage');
    options[flag] = args[i + 1]!;
  }
  if (!options['--config'] || options['--profile'] !== undefined && !['metadata/1','followup/1','metadata-followup/1'].includes(options['--profile'])) throw Error('usage');
  if (options['--catalog-version'] !== undefined && !['1', '2'].includes(options['--catalog-version']) ||
      options['--inspect-repositories'] !== undefined && !['true', 'false'].includes(options['--inspect-repositories'])) throw Error('usage');
  const config = await readConfigFile(options['--config']);
  const roots = config.projects.flatMap(p => p.sources.flatMap(s => s.board_path ? [s.board_path] : s.pipeline_root ? [s.pipeline_root] : []));
  if (options['--output']) await checkOutput(options['--output'], options['--config'], roots);
  const catalog = await generateSnapshot(config, { rosterCLI: options['--roster-cli'], rosterPipelineCLI: options['--roster-pipeline-cli'],
    ...(options['--profile'] ? { profile: options['--profile'] as 'metadata/1' | 'followup/1' | 'metadata-followup/1' } : {}),
    catalogVersion: options['--catalog-version'] === '2' ? 2 : 1, inspectRepositories: options['--inspect-repositories'] === 'true' });
  if (options['--output']) await publishSnapshot(options['--output'], catalog, options['--config'], roots);
  else { const text = JSON.stringify(catalog, null, 2) + '\n'; if (Buffer.byteLength(text) > PROJECT_LIMITS.bytes) throw Error('catalog-limit'); process.stdout.write(text); }
}
if (process.argv[1] && /(?:^|[/\\])project-snapshot\.(?:ts|mjs)$/.test(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('project-snapshot: refused; check config, output path and provider configuration\n'); process.exitCode = 1; });
}
