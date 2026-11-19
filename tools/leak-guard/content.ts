// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// File content gate: bytes in, findings out. Binary files are read byte for byte as latin1 and,
// for text stored as UTF-16, as UTF-16 at both byte alignments (little- and big-endian ASCII).
import {type Finding, type RuleSet, type ScanTarget, scanFileName, scanLines, scanText} from './rules.ts';

const SNIFF_BYTES = 8000;

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0);
}

function utf16Views(buffer: Buffer): string[] {
  const view = (start: number) => {
    const slice = buffer.subarray(start, start + ((buffer.length - start) & ~1));
    return slice.toString('utf16le');
  };
  return [view(0), view(1)];
}

// Binary content becomes one text: the latin1 view, then the two UTF-16 views. Line numbers in a
// binary file are positions in this text, not in the file.
export function decode(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (!isBinary(bytes)) return buffer.toString('utf8');
  return [buffer.toString('latin1'), ...utf16Views(buffer)].join('\n');
}

// A register row exists only in a regular file read as UTF-8 text, as tools/cla-check reads the
// register: a symbolic link, or the latin1 and UTF-16 views of a binary file, holds none.
const NO_ROWS: ReadonlySet<number> = new Set();

function contentTarget(file: string, regularText: boolean): ScanTarget {
  return regularText ? {gate: 'content', path: file} : {gate: 'content', path: file, rowLines: NO_ROWS};
}

// Whole-file scan: name and every line.
export function scanFile(ruleSet: RuleSet, file: string, bytes: Uint8Array): Finding[] {
  return [...scanFileName(ruleSet, file), ...scanText(ruleSet, contentTarget(file, !isBinary(bytes)), decode(bytes))];
}

// A symbolic link publishes its target string: it is scanned as the link's one line of content.
export function scanSymlink(ruleSet: RuleSet, file: string, target: string): Finding[] {
  return [...scanFileName(ruleSet, file), ...scanLines(ruleSet, contentTarget(file, false), [target], [1])];
}

// `binary`: the lines are the decoded views of a binary blob; `symlink`: the link's target (mode 120000).
export type AddedLines = {path: string; isNew: boolean; binary: boolean; symlink: boolean; lines: string[]; lineNumbers: number[]};

// Diff scan: names of new files and the added lines only.
export function scanAdded(ruleSet: RuleSet, change: AddedLines, label = change.path): Finding[] {
  const findings = change.isNew ? scanFileName(ruleSet, change.path) : [];
  const target = contentTarget(change.path, !change.binary && !change.symlink);
  findings.push(...scanLines(ruleSet, target, change.lines, change.lineNumbers));
  return findings.map(finding => ({...finding, path: label}));
}
