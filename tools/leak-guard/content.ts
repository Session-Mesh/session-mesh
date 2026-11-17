// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// File content gate: bytes in, findings out. Binary files are read byte for byte as latin1 and,
// for text stored as UTF-16, as UTF-16 at both byte alignments (little- and big-endian ASCII).
import {type Finding, type RuleSet, scanFileName, scanLines, scanText} from './rules.ts';

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

// Whole-file scan: name and every line.
export function scanFile(ruleSet: RuleSet, file: string, bytes: Uint8Array): Finding[] {
  return [...scanFileName(ruleSet, file), ...scanText(ruleSet, {gate: 'content', path: file}, decode(bytes))];
}

// A symbolic link publishes its target string: it is scanned as the link's one line of content.
export function scanSymlink(ruleSet: RuleSet, file: string, target: string): Finding[] {
  return [...scanFileName(ruleSet, file), ...scanLines(ruleSet, {gate: 'content', path: file}, [target], [1])];
}

export type AddedLines = {path: string; isNew: boolean; binary: boolean; lines: string[]; lineNumbers: number[]};

// Diff scan: names of new files and the added lines only.
export function scanAdded(ruleSet: RuleSet, change: AddedLines, label = change.path): Finding[] {
  const findings = change.isNew ? scanFileName(ruleSet, change.path) : [];
  findings.push(...scanLines(ruleSet, {gate: 'content', path: change.path}, change.lines, change.lineNumbers));
  return findings.map(finding => ({...finding, path: label}));
}
