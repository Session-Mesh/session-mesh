// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Project JSON file primitives. Local cooperative ownership is enforced by the editor. */
import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { PROJECT_LIMITS } from '../static/project-catalog.ts';

export class ProjectFileError extends Error {
  code: 'unsafe-path' | 'too-large' | 'io-refused';
  constructor(code: ProjectFileError['code']) { super(code); this.code = code; }
}
const unsafe = () => { throw new ProjectFileError('unsafe-path'); };
export function sameProjectFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function owned(info: Stats, mode: number): void {
  if (info.uid !== process.geteuid?.() || (info.mode & 0o7777) !== mode || !Number.isSafeInteger(info.ino)) unsafe();
}
export function privateProjectFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) unsafe(); owned(info, 0o600);
}
export function projectJSONPath(path: string): string {
  const file = resolve(path); if (!file.endsWith('.json')) unsafe(); return file;
}
export async function noProjectSymlinks(path: string, leafMayBeMissing = false, strict = false): Promise<void> {
  const parts = resolve(path).split(sep).filter(Boolean); let current: string = sep;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let info: Stats;
    try { info = await fs.lstat(current); }
    catch (e) { if (leafMayBeMissing && i === parts.length - 1 && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (info.isSymbolicLink() || i < parts.length - 1 && !info.isDirectory()) unsafe();
    if (strict && info.isDirectory() && (info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0)) unsafe();
  }
}
export async function projectParent(path: string, strict = false): Promise<{ handle: FileHandle; info: Stats }> {
  await noProjectSymlinks(path, false, strict);
  const handle = await fs.open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const info = await handle.stat(); if (!info.isDirectory()) unsafe(); if (strict) owned(info, 0o700);
    return { handle, info };
  } catch (e) { await handle.close(); throw e; }
}
export async function readProjectBytes(handle: FileHandle, max = PROJECT_LIMITS.bytes): Promise<Buffer> {
  const before = await handle.stat(); if (!before.isFile()) unsafe(); if (before.size > max) throw new ProjectFileError('too-large');
  const chunks: Buffer[] = []; let total = 0, position = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(65536, max + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    total += bytesRead; position += bytesRead; if (total > max) throw new ProjectFileError('too-large'); chunks.push(chunk.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  if (!sameProjectFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || total !== after.size) throw new ProjectFileError('io-refused');
  return Buffer.concat(chunks);
}
export async function openProjectRead(path: string, strict = false, max = PROJECT_LIMITS.bytes) {
  const file = projectJSONPath(path), parent = await projectParent(file, strict);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat(); if (!info.isFile()) unsafe(); if (strict) privateProjectFile(info);
    const bytes = await readProjectBytes(handle, max);
    const current = await fs.lstat(file); if (!sameProjectFile(info, current) || current.isSymbolicLink()) unsafe();
    return { path: file, parent, handle, info, bytes };
  } catch (e) { await handle?.close(); await parent.handle.close(); throw e; }
}
export async function closeProjectRead(value: Awaited<ReturnType<typeof openProjectRead>>): Promise<void> {
  try { await value.handle.close(); } finally { await value.parent.handle.close(); }
}
export async function openPrivateProjectFile(path: string): Promise<FileHandle> {
  const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { privateProjectFile(await handle.stat()); return handle; }
  catch (e) { await handle.close(); throw e; }
}
