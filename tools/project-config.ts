#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Local filesystem-owner edits only. References never grant runtime authority. */
import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonStrict } from '../static/demo-view-contract.ts';
import { parseProjectConfig, PROJECT_LIMITS } from '../static/project-catalog.ts';
import type { ProjectConfig, ConfigProject, ParticipationTarget, Participation, ProjectChannel } from '../static/project-catalog.ts';
import { ProjectFileError, projectJSONPath, projectParent, openProjectRead, closeProjectRead,
  readProjectBytes, sameProjectFile, privateProjectFile, openPrivateProjectFile } from './project-file.ts';

type Code = 'invalid-request' | 'invalid-config' | 'unsupported-version' | 'unsupported-feature' |
  'unknown-project' | 'unknown-source' | 'immutable-identity' | 'revision-conflict' | 'busy' |
  'unsafe-path' | 'too-large' | 'io-refused';
type Warning = { warnings?: ['cleanup-failed'] };
type Refused = { status: 'refused'; code: Code } & Warning;
type EditResult = ({ status: 'ok'; revision: string } | Refused | { status: 'uncertain'; code: 'commit-uncertain' }) & Warning;
type ReadResult = { status: 'ok'; revision: string; config: ProjectConfig } | Refused;
class Refusal extends Error { code: Code; constructor(code: Code) { super(code); this.code = code; } }
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('invalid-request'); return value as Obj;
}
function keys(value: Obj, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Refusal('invalid-request');
}
function operational(error: unknown): Code | null {
  if (error instanceof Refusal || error instanceof ProjectFileError) return error.code;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'invalid-config';
  if (['ELOOP', 'EISDIR', 'ENOTDIR', 'EMLINK'].includes(code ?? '')) return 'unsafe-path';
  return typeof code === 'string' && /^E[A-Z0-9]+$/u.test(code) ? 'io-refused' : null;
}
function revision(bytes: Buffer): string { return `cfg1_${createHash('sha256').update(bytes).digest('hex')}`; }
function decodeConfig(bytes: Buffer): ProjectConfig {
  let value: unknown;
  try { value = parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'project'); } catch { throw new Refusal('invalid-config'); }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const header = value as Obj;
    if (header.kind === 'mesh-project-config') {
      if (header.schema_version !== 1 && header.schema_version !== 2) throw new Refusal('unsupported-version');
      if (header.schema_version === 2 && Array.isArray(header.features) && header.features.some(f => f !== 'project-metadata/1')) throw new Refusal('unsupported-feature');
    }
  }
  const config = parseProjectConfig(value); if (!config) throw new Refusal('invalid-config'); return config;
}
export async function readProjectConfigState(path: string): Promise<ReadResult> {
  try {
    const read = await openProjectRead(path, true);
    try {
      const result: ReadResult = { status: 'ok', revision: revision(read.bytes), config: decodeConfig(read.bytes) };
      if (Buffer.byteLength(JSON.stringify(result)) > PROJECT_LIMITS.bytes + 1024) throw new Refusal('too-large');
      return result;
    }
    finally { await closeProjectRead(read); }
  } catch (error) { const code = operational(error); if (!code) throw error; return { status: 'refused', code }; }
}
function editRequest(value: unknown): Obj {
  try { if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new Refusal('too-large'); }
  catch (error) { if (error instanceof Refusal) throw error; throw new Refusal('invalid-request'); }
  const record = object(value); keys(record, ['kind', 'schema_version', 'target_schema', 'expected_revision', 'project_id', 'operation']);
  if (record.kind !== 'mesh-project-config-edit') throw new Refusal('invalid-request');
  if (record.schema_version !== 1 || record.target_schema !== 2) throw new Refusal('unsupported-version');
  if (typeof record.expected_revision !== 'string' || !/^cfg1_[a-f0-9]{64}$/u.test(record.expected_revision) ||
      typeof record.project_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(record.project_id)) throw new Refusal('invalid-request');
  object(record.operation); return record;
}
function sameTarget(leftTarget: ParticipationTarget, rightTarget: ParticipationTarget): boolean {
  return leftTarget.kind === 'mesh' && rightTarget.kind === 'mesh' ? leftTarget.name === rightTarget.name && leftTarget.created === rightTarget.created && leftTarget.machine_id === rightTarget.machine_id :
    leftTarget.kind === 'history' && rightTarget.kind === 'history' && leftTarget.agent === rightTarget.agent && leftTarget.conversation_id === rightTarget.conversation_id;
}
function change(config: ProjectConfig, request: Obj): ProjectConfig {
  const migrated: ProjectConfig = { ...config, schema_version: 2, features: ['project-metadata/1'] };
  const invalidCandidateCode = parseProjectConfig(migrated) ? 'invalid-request' : 'invalid-config';
  const project = migrated.projects.find(projectRow => projectRow.id === request.project_id); if (!project) throw new Refusal('unknown-project');
  const operation = object(request.operation);
  const candidate = (patch: Partial<ConfigProject>): ConfigProject => {
    const checked = parseProjectConfig({ ...migrated, projects: migrated.projects.map(projectRow => projectRow === project ? { ...project, ...patch } : projectRow) });
    if (!checked) throw new Refusal(invalidCandidateCode); return checked.projects.find(projectRow => projectRow.id === project.id)!;
  };
  switch (operation.type) {
    case 'project.describe': {
      keys(operation, ['type', 'title', 'description']);
      if (!Object.hasOwn(operation, 'title') && !Object.hasOwn(operation, 'description') ||
          Object.hasOwn(operation, 'title') && (typeof operation.title !== 'string' || !operation.title.trim() || /[\u0000-\u001f\u007f]/u.test(operation.title)) ||
          Object.hasOwn(operation, 'description') && operation.description !== null && typeof operation.description !== 'string') throw new Refusal('invalid-request');
      if (Object.hasOwn(operation, 'title')) project.title = operation.title as string;
      if (operation.description === null) delete project.description;
      else if (Object.hasOwn(operation, 'description')) project.description = operation.description as string;
      break;
    }
    case 'participation.put': {
      keys(operation, ['type', 'participation']);
      const value = candidate({ participations: [operation.participation as Participation] }).participations![0]!;
      const rows = project.participations ?? [], existing = rows.find(projectRow => projectRow.id === value.id);
      if (existing && !sameTarget(existing.target, value.target)) throw new Refusal('immutable-identity');
      project.participations = existing ? rows.map(projectRow => projectRow.id === value.id ? value : projectRow) : [...rows, value]; break;
    }
    case 'channel.put': {
      keys(operation, ['type', 'source_id', 'channel']);
      if (typeof operation.source_id !== 'string') throw new Refusal('invalid-request');
      const source = project.sources.find(sourceRow => sourceRow.id === operation.source_id); if (!source) throw new Refusal('unknown-source');
      const parsed = candidate({ sources: project.sources.map(sourceRow => sourceRow === source ? { ...sourceRow, channels: [operation.channel as ProjectChannel] } : sourceRow) });
      const value = parsed.sources.find(sourceRow => sourceRow.id === source.id)!.channels![0]!;
      const rows = source.channels ?? [], existing = rows.find(channelRow => channelRow.id === value.id);
      if (existing && (['tenant_id', 'workspace_id', 'native_id'] as const).some(key => existing[key] !== undefined && existing[key] !== value[key])) throw new Refusal('immutable-identity');
      source.channels = existing ? rows.map(channelRow => channelRow.id === value.id ? value : channelRow) : [...rows, value]; break;
    }
    case 'repository.configure':
      keys(operation, ['type', 'repository']);
      if (!Object.hasOwn(operation, 'repository') || operation.repository === undefined) throw new Refusal('invalid-request');
      if (operation.repository === null) delete project.repository;
      else project.repository = candidate({ repository: operation.repository as NonNullable<ConfigProject['repository']> }).repository!;
      break;
    default: throw new Refusal('invalid-request');
  }
  const result = parseProjectConfig(migrated); if (!result) throw new Refusal(invalidCandidateCode); return result;
}
interface Artifact { path: string; handle: FileHandle; info: Stats; parentInfo: Stats; initialized: boolean; nonce?: string; closed?: boolean }
async function verifyArtifact(value: Artifact): Promise<void> {
  const parent = await projectParent(value.path, true);
  try { if (!sameProjectFile(value.parentInfo, parent.info)) throw new Refusal('unsafe-path'); }
  finally { await parent.handle.close(); }
  const current = await fs.lstat(value.path); privateProjectFile(current);
  if (!sameProjectFile(value.info, current)) throw new Refusal('unsafe-path');
  if (value.initialized && value.nonce) {
    const handle = await fs.open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameProjectFile(value.info, await handle.stat())) throw new Refusal('unsafe-path');
      let lock: Obj;
      try { lock = object(JSON.parse((await readProjectBytes(handle, 1024)).toString('utf8'))); } catch { throw new Refusal('unsafe-path'); }
      if (Object.keys(lock).length !== 3 || lock.kind !== 'mesh-project-config-lock' || lock.schema_version !== 1 || lock.nonce !== value.nonce) throw new Refusal('unsafe-path');
    } finally { await handle.close(); }
  }
}
async function cleanupArtifact(value: Artifact): Promise<boolean> {
  let ok = true;
  try { await verifyArtifact(value); await fs.unlink(value.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ok = false; }
  if (!value.closed) { try { await value.handle.close(); } catch { ok = false; } }
  return ok;
}
async function openConfigLock(path: string, parentInfo: Stats, nonce: string): Promise<Artifact> {
  let handle: FileHandle;
  try { handle = await openPrivateProjectFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let held: Stats;
    // The holder may release the lock between our exclusive create and this lstat: still busy, not a missing config.
    try { held = await fs.lstat(path); }
    catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ENOENT') throw new Refusal('busy'); throw gone; }
    privateProjectFile(held); throw new Refusal('busy');
  }
  return { path, handle, info: await handle.stat(), parentInfo, nonce, initialized: false };
}
export async function editProjectConfig(path: string, value: unknown): Promise<EditResult> {
  let lock: Artifact | undefined, temp: Artifact | undefined;
  let parent: Awaited<ReturnType<typeof projectParent>> | undefined;
  let read: Awaited<ReturnType<typeof openProjectRead>> | undefined;
  let result: EditResult | undefined, unexpected: unknown, hasUnexpected = false;
  let phase: 'before' | 'rename' | 'replaced' | 'synced' = 'before';
  try {
    const request = editRequest(value), file = projectJSONPath(path);
    parent = await projectParent(file, true);
    const pathHash = createHash('sha256').update(file).digest('hex'), nonce = randomBytes(16).toString('hex');
    const lockPath = join(dirname(file), `.mesh-project-config-${pathHash}.lock`);
    lock = await openConfigLock(lockPath, parent.info, nonce);
    await lock.handle.writeFile(JSON.stringify({ kind: 'mesh-project-config-lock', schema_version: 1, nonce })); await lock.handle.sync(); lock.initialized = true;
    read = await openProjectRead(file, true);
    if (!sameProjectFile(parent.info, read.parent.info)) throw new Refusal('unsafe-path');
    const config = decodeConfig(read.bytes);
    if (revision(read.bytes) !== request.expected_revision) throw new Refusal('revision-conflict');
    const next = change(config, request), bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (bytes.length > PROJECT_LIMITS.bytes) throw new Refusal('too-large');
    const tempPath = join(dirname(file), `.mesh-project-config-${pathHash}-${nonce}.tmp`);
    const handle = await openPrivateProjectFile(tempPath); temp = { path: tempPath, handle, info: await handle.stat(), parentInfo: parent.info, initialized: false };
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); temp.closed = true;
    const current = await openProjectRead(file, true);
    try {
      if (!sameProjectFile(parent.info, current.parent.info) || !sameProjectFile(read.info, current.info)) throw new Refusal('unsafe-path');
      if (revision(current.bytes) !== request.expected_revision) throw new Refusal('revision-conflict');
      await verifyArtifact(lock); await verifyArtifact(temp);
    } finally { await closeProjectRead(current); }
    phase = 'rename'; await fs.rename(tempPath, file); phase = 'replaced';
    await parent.handle.sync(); phase = 'synced';
    result = { status: 'ok', revision: revision(bytes) };
  } catch (error) {
    const code = operational(error);
    if (!code) { unexpected = error; hasUnexpected = true; }
    else if (phase === 'rename' || phase === 'replaced') result = { status: 'uncertain', code: 'commit-uncertain' };
    else result = { status: 'refused', code };
  } finally {
    let clean = true;
    if (temp) clean = await cleanupArtifact(temp) && clean;
    if (lock) clean = await cleanupArtifact(lock) && clean;
    if (read) { try { await closeProjectRead(read); } catch { clean = false; } }
    if (parent) { try { await parent.handle.close(); } catch { clean = false; } }
    if (!clean && result) result.warnings = ['cleanup-failed'];
  }
  if (hasUnexpected) throw unexpected;
  return result!;
}
export async function main(args: string[]): Promise<void> {
  const command = args[0], options: Record<string, string> = {};
  try {
    if (command !== 'read' && command !== 'edit') throw new Refusal('invalid-request');
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (!flag || !['--config', ...(command === 'edit' ? ['--request'] : [])].includes(flag) || !value || Object.hasOwn(options, flag)) throw new Refusal('invalid-request');
      options[flag] = value;
    }
    if (!options['--config'] || command === 'edit' && !options['--request']) throw new Refusal('invalid-request');
    let result: ReadResult | EditResult;
    if (command === 'read') result = await readProjectConfigState(options['--config']);
    else {
      let input: Awaited<ReturnType<typeof openProjectRead>>;
      try { input = await openProjectRead(options['--request']!, false, 256 * 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Refusal('invalid-request'); throw error; }
      let request: unknown;
      try {
        if (input.bytes.length > 256 * 1024) throw new Refusal('too-large');
        try { request = parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes), 'project'); } catch { throw new Refusal('invalid-request'); }
      } finally { await closeProjectRead(input); }
      result = await editProjectConfig(options['--config'], request);
    }
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.status === 'ok' ? 0 : result.status === 'refused' ? 1 : 2;
  } catch (error) {
    const code = operational(error); process.stdout.write(JSON.stringify(code ? { status: 'refused', code } : { status: 'error', code: 'internal-error' }) + '\n');
    process.exitCode = code ? 1 : 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2));
