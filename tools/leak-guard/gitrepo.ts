// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Read-only access to the Git repository: files, staged diff, commit ranges.
import {execFileSync} from 'node:child_process';
import {type AddedLines, decode, isBinary} from './content.ts';
import {ToolError} from './rules.ts';

const MAX_BUFFER = 1 << 30;

export function gitBytes(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    const stderr = String((error as {stderr?: Buffer}).stderr ?? '').trim();
    throw new ToolError(`git ${args.join(' ')} failed: ${stderr || (error as Error).message}`);
  }
}

export function git(cwd: string, args: string[]): string {
  return gitBytes(cwd, args).toString('utf8');
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

// Tracked files plus untracked files that are not ignored.
export function worktreeFiles(root: string): string[] {
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index);
}

type DiffState = {changes: AddedLines[]; current: AddedLines | null; next: number; inHunk: boolean};

function startFile(state: DiffState, line: string): void {
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  state.current = {path: match ? match[2] : line, isNew: false, binary: false, symlink: false, lines: [], lineNumbers: []};
  state.inHunk = false;
  state.changes.push(state.current);
}

// Header lines only appear before the first hunk; inside hunks, `+` lines are content.
function headerLine(current: AddedLines, line: string): void {
  if (line.startsWith('new file mode')) current.isNew = true;
  else if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true;
  else if (line.startsWith('+++ b/')) current.path = line.slice('+++ b/'.length);
  if (/^(?:new file mode|new mode|index \S+) 120000$/.test(line)) current.symlink = true;
}

function diffLine(state: DiffState, line: string): void {
  const current = state.current;
  if (!current) return;
  if (line.startsWith('@@')) {
    state.inHunk = true;
    state.next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
  } else if (!state.inHunk) {
    headerLine(current, line);
  } else if (line.startsWith('+')) {
    current.lines.push(line.slice(1));
    current.lineNumbers.push(state.next++);
  }
}

// Parses a `-U0` patch into added lines per file; deleted-only files keep an empty list.
export function parseDiff(patch: string): AddedLines[] {
  const state: DiffState = {changes: [], current: null, next: 0, inHunk: false};
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) startFile(state, line);
    else diffLine(state, line);
  }
  return state.changes;
}

const DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=ACMRT'];

// Binary changes are read whole from the object store, byte for byte. `binary` then says whether
// the blob itself is binary (Git also shows a text file as binary when its old version was).
function withBinaryBlobs(root: string, changes: AddedLines[], blobPrefix: string): AddedLines[] {
  return changes.map(change => {
    if (!change.binary) return change;
    const bytes = gitBytes(root, ['cat-file', 'blob', `${blobPrefix}${change.path}`]);
    const lines = decode(bytes).split('\n');
    return {...change, binary: isBinary(bytes), lines, lineNumbers: lines.map((_, index) => index + 1)};
  });
}

export function stagedChanges(root: string): AddedLines[] {
  return withBinaryBlobs(root, parseDiff(git(root, ['diff', '--cached', ...DIFF_FLAGS])), ':');
}

export type CommitData = {sha: string; authorName: string; authorEmail: string; committerName: string; committerEmail: string; message: string};

export function commitList(root: string, range: string): string[] {
  return git(root, ['rev-list', '--reverse', range]).split('\n').filter(Boolean);
}

export function commitData(root: string, sha: string): CommitData {
  const [authorName, authorEmail, committerName, committerEmail, ...rest] =
    git(root, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha]).split('\0');
  return {sha, authorName, authorEmail, committerName, committerEmail, message: rest.join('\0')};
}

// Changes a commit introduces relative to its first parent (or the empty tree for a root commit).
export function commitChanges(root: string, sha: string): AddedLines[] {
  const patch = git(root, ['diff-tree', '-p', '-m', '--first-parent', '--root', '--no-commit-id', ...DIFF_FLAGS, sha]);
  return withBinaryBlobs(root, parseDiff(patch), `${sha}:`);
}
