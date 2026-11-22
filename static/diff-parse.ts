// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Unified Git and plain diff parsing; paths and patch content remain data.

import {isModeLine, readModeLine, type FileModes} from './diff-file-mode.ts';

export type LineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  // the line's content, carriage return included when it belongs to the file (shown as ␍)
  text: string;
  oldNo: number | null;
  newNo: number | null;
  // "\ No newline at end of file" followed this line
  noNewline: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'binary';

export interface FileDiff extends FileModes {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  hunks: Hunk[];
  added: number;
  deleted: number;
  // opened by a `diff --git` header: its `a/` and `b/` prefixes are Git's, and are dropped
  git: boolean;
  // its content change is binary (whatever else happened to it: added, renamed, copied...)
  binary: boolean;
}

export interface ParsedDiff {
  files: FileDiff[];
  // lines before the first file (a commit message from `git show`, `git format-patch` headers)
  preamble: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// ---------------------------------------------------------------- path names

const ESCAPES: Record<string, number> = {a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92};

// A C-style quoted name as Git writes it (`"caf\303\251.sh"`), from its opening quote at `start`:
// the decoded name and the index after its closing quote, or null when it is not one.
export function readQuoted(text: string, start = 0): [string, number] | null {
  if (text[start] !== '"') return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === '"') return [new TextDecoder().decode(new Uint8Array(bytes)), i + 1];
    if (c === '\\') {
      const next = text[i + 1] ?? '';
      const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
      if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += 4; continue; }
      const escaped = ESCAPES[next];
      if (escaped === undefined) return null;
      bytes.push(escaped);
      i += 2;
      continue;
    }
    const point = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(point);
    bytes.push(...encoder.encode(char));
    i += char.length;
  }
  return null;
}

// A name that may be quoted, as the whole of `raw` (rename from/to, copy from/to).
function unquoteWhole(raw: string): string {
  const quoted = readQuoted(raw);
  return quoted && quoted[1] === raw.length ? quoted[0] : raw;
}

function dropPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// `diff --git a/x b/y`, either name possibly quoted: the two names without their prefixes, or
// null when they cannot be split. Unquoted names with spaces are split where both halves name
// the same file (the case without a rename, whose rename lines give the names otherwise).
export function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  let first: string;
  let second: string;
  const quoted = readQuoted(rest);
  if (quoted) {
    if (rest[quoted[1]] !== ' ') return null;
    first = quoted[0];
    second = unquoteWhole(rest.slice(quoted[1] + 1));
  } else if (rest.endsWith('"') && rest.lastIndexOf(' "') > 0) {
    const at = rest.lastIndexOf(' "');
    first = rest.slice(0, at);
    second = unquoteWhole(rest.slice(at + 1));
  } else {
    const half = (rest.length - 1) / 2;
    const same = (from: number): boolean => rest.slice(from, half) === rest.slice(half + 1 + from);
    if (Number.isInteger(half) && rest[half] === ' ' && (same(2) || same(0))) {
      first = rest.slice(0, half);
      second = rest.slice(half + 1);
    } else {
      const match = /^(a\/.*) (b\/.*)$/.exec(rest);
      if (!match || match[1] === undefined || match[2] === undefined) return null;
      first = match[1];
      second = match[2];
    }
  }
  if (first.startsWith('a/') && second.startsWith('b/')) return [first.slice(2), second.slice(2)];
  // `diff.noprefix` writes the names without a/ and b/: accepted when they name the same file
  return first === second ? [first, second] : null;
}

// The name of a `--- ` or `+++ ` line: quoted (Git), or up to a tab (`diff -u` adds a date).
// `/dev/null` is no file. Git's `a/` or `b/` is dropped only in a file opened by `diff --git`:
// a plain `diff -u a/x b/x` keeps its directory names.
function headerPath(raw: string, prefix: string, git: boolean): string | null {
  const quoted = readQuoted(raw);
  const value = quoted ? quoted[0] : (raw.split('\t')[0] ?? '');
  if (value === '/dev/null') return null;
  return git ? dropPrefix(value, prefix) : value;
}

// ---------------------------------------------------------------- parser

function newFile(git: boolean): FileDiff {
  return {oldPath: null, newPath: null, status: 'modified', hunks: [], added: 0, deleted: 0, git, binary: false,
    oldMode: null, newMode: null};
}

/** A quoted name must be complete; unquoted names may contain spaces. */
function validExtendedPath(raw: string): boolean {
  if (!raw) return false;
  if (!raw.startsWith('"')) return true;
  const quoted = readQuoted(raw);
  return !!quoted && quoted[1] === raw.length && quoted[0].length > 0;
}

/** Recognise the full Git notice, including quoted paths and names containing spaces. */
function binaryNotice(line: string, file: FileDiff, gitLine: string): boolean {
  if (!line.startsWith('Binary files ') || !line.endsWith(' differ')) return false;
  const names = line.slice('Binary files '.length, -' differ'.length);
  for (let at = names.indexOf(' and '); at >= 0; at = names.indexOf(' and ', at + 1)) {
    const oldName = names.slice(0, at), newName = names.slice(at + ' and '.length);
    if (!validExtendedPath(oldName) || !validExtendedPath(newName)) continue;
    if (gitLine === `diff --git ${oldName} ${newName}`) return true;
    const headerNames = gitLine.slice('diff --git '.length);
    if (oldName === '/dev/null' && headerNames.endsWith(` ${newName}`) &&
        validExtendedPath(headerNames.slice(0, -newName.length - 1))) return true;
    if (newName === '/dev/null' && headerNames.startsWith(`${oldName} `) &&
        validExtendedPath(headerNames.slice(oldName.length + 1))) return true;
    const oldPath = unquoteWhole(oldName), newPath = unquoteWhole(newName);
    const matches = (path: string, expected: string | null, prefix: string): boolean =>
      path === '/dev/null' || (expected !== null && (path === expected || dropPrefix(path, prefix) === expected));
    if (oldPath !== '/dev/null' || newPath !== '/dev/null') {
      if (matches(oldPath, file.oldPath, 'a/') && matches(newPath, file.newPath, 'b/')) return true;
    }
  }
  return false;
}

/** Git's extended header ends at the first line outside this grammar. */
function extendedHeader(line: string, file: FileDiff, gitLine: string): boolean {
  const path = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line);
  if (path) return validExtendedPath(path[1] ?? '');
  return isModeLine(line) || /^(?:similarity index |dissimilarity index |index )/.test(line)
    || binaryNotice(line, file, gitLine) || line === 'GIT binary patch';
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // A patch saved with CRLF line ends has a CR on every line, its own header lines included:
  // that CR is framing and is dropped. In an LF patch, a CR at the end of a hunk line belongs to
  // the file (a CRLF to LF change) and is kept, so that the change is visible.
  const first = lines.find(line => line !== '') ?? '';
  if (first.endsWith('\r')) {
    for (let k = 0; k < lines.length; k++) lines[k] = (lines[k] ?? '').replace(/\r$/, '');
  }
  const files: FileDiff[] = [];
  const preamble: string[] = [];
  let file: FileDiff | null = null;
  let header = false;
  let pathsSeen = false;
  let gitLine = '';
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      file = newFile(true);
      header = true;
      pathsSeen = false;
      gitLine = line;
      files.push(file);
      const paths = gitHeaderPaths(line);
      if (paths) [file.oldPath, file.newPath] = paths;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // a plain `diff -u` file starts here; in Git output, its `diff --git` line opened it
      if (!file || !header || file.hunks.length > 0 || !file.git) {
        file = newFile(false);
        header = true;
        files.push(file);
      }
      const oldPath = headerPath(line.slice(4), 'a/', file.git);
      const newPath = headerPath((lines[i + 1] ?? '').replace(/\r$/, '').slice(4), 'b/', file.git);
      // a renamed or copied file keeps the names of its rename or copy lines
      if (file.status !== 'renamed' && file.status !== 'copied') { file.oldPath = oldPath; file.newPath = newPath; }
      if (oldPath === null && file.status === 'modified') file.status = 'added';
      if (newPath === null && file.status === 'modified') file.status = 'deleted';
      pathsSeen = true;
      i += 2;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk && file && (header || file.hunks.length > 0)) {
      header = false;
      i = readHunk(lines, i, hunk, file);
      continue;
    }
    if (file && header && pathsSeen && extendedHeader(line, file, gitLine)) {
      i += 1;
      continue;
    }
    if (file && header && !pathsSeen && file.git && file.hunks.length === 0 && extendedHeader(line, file, gitLine)) {
      readModeLine(line, file);
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('copy from ')) { file.oldPath = unquoteWhole(line.slice('copy from '.length)); file.status = 'copied'; }
      else if (line.startsWith('copy to ')) { file.newPath = unquoteWhole(line.slice('copy to '.length)); file.status = 'copied'; }
      else if (line.startsWith('rename from ')) { file.oldPath = unquoteWhole(line.slice('rename from '.length)); file.status = 'renamed'; }
      else if (line.startsWith('rename to ')) { file.newPath = unquoteWhole(line.slice('rename to '.length)); file.status = 'renamed'; }
      else if (binaryNotice(line, file, gitLine) || line === 'GIT binary patch') {
        // a binary change keeps the status of the file (a copy stays a copy, with both names)
        file.binary = true;
        if (file.status === 'modified') file.status = 'binary';
        header = false;
      }
    } else if (file && header && file.hunks.length === 0) {
      header = false;
    } else if (!file) {
      preamble.push(line);
    }
    i += 1;
  }
  return {files, preamble};
}

// Reads the hunk whose header is lines[start]; returns the index of the first line after it.
// The line counts of the header bound the hunk, so a deleted line reading "-- x" is not taken for
// the next file's "--- " header. A hunk cut short (its counts not reached when it stops) gives
// back the `--- `/`+++ ` pair it took in just before stopping: that pair starts the next file.
function readHunk(lines: string[], start: number, match: RegExpExecArray, file: FileDiff): number {
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  let newLeft = match[4] === undefined ? 1 : Number(match[4]);
  const hunk: Hunk = {header: (lines[start] ?? '').replace(/\r$/, ''), oldStart, newStart, lines: []};
  file.hunks.push(hunk);
  const origin: number[] = [];   // the index in `lines` of each line of the hunk
  let oldNo = oldStart;
  let newNo = newStart;
  let i = start + 1;
  while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] ?? '').startsWith('\\'))) {
    const raw = lines[i] ?? '';
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '\\') {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (sign === '+' && newLeft > 0) {
      hunk.lines.push({kind: 'add', text, oldNo: null, newNo: newNo++, noNewline: false});
      origin.push(i);
      newLeft -= 1;
      file.added += 1;
    } else if (sign === '-' && oldLeft > 0) {
      hunk.lines.push({kind: 'del', text, oldNo: oldNo++, newNo: null, noNewline: false});
      origin.push(i);
      oldLeft -= 1;
      file.deleted += 1;
    } else if ((sign === ' ' || raw === '') && oldLeft > 0 && newLeft > 0) {
      // an empty line is a context line whose leading space was stripped (some editors do it)
      hunk.lines.push({kind: 'context', text, oldNo: oldNo++, newNo: newNo++, noNewline: false});
      origin.push(i);
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      break;    // a malformed hunk: stop here rather than swallow what follows
    }
    i += 1;
  }
  if (oldLeft > 0 || newLeft > 0) {
    for (const k of [i - 2, i - 1]) {
      if (k > start && (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) {
        while (origin.length > 0 && (origin[origin.length - 1] ?? 0) >= k) {
          origin.pop();
          const dropped = hunk.lines.pop();
          if (dropped?.kind === 'add') file.added -= 1;
          if (dropped?.kind === 'del') file.deleted -= 1;
        }
        return k;
      }
    }
  }
  return i;
}

