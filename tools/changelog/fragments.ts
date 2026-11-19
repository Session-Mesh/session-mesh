// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Changelog fragments: one file per pull request under changelog.d/, holding one CHANGELOG.md
// bullet (changelog.d/README.md and docs/changelog-fragments.md describe the format). This module
// reads, validates and orders them; it never writes. Everything read is data: it is matched with
// fixed patterns, never evaluated.
import fs from 'node:fs';
import path from 'node:path';

export const FRAGMENT_DIR = 'changelog.d';
// The order of the kinds in an assembled list; `changed` when a fragment names none.
export const KINDS = ['security', 'added', 'changed', 'fixed', 'docs', 'internal'] as const;
export type Kind = typeof KINDS[number];
export const DEFAULT_KIND: Kind = 'changed';
export const MAX_WIDTH = 100;
export const MAX_BYTES = 8192;
// `<number>-<slug>.md` once the pull request has a number, `<slug>.md` before.
export const FRAGMENT_NAME = /^(?:([1-9][0-9]{0,6})-)?([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.md$/;
// Files of changelog.d/ that are not fragments.
export const NON_FRAGMENTS = ['README.md'];

export type Fragment = {name: string; number: number | null; kind: Kind; bullet: string};
export type Parsed = {fragment: Fragment | null; problems: string[]};

// C0 and C1 controls except the line feed, bidirectional controls, zero-width characters and
// the byte order mark: they hide or reorder text in a rendered changelog.
const FORBIDDEN_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/u;

function widthOf(line: string): number {
  // A link target cannot be wrapped: it does not count against the width.
  return [...line.replace(/\]\([^)\s]*\)/g, ']()')].length;
}

function parseFrontMatter(lines: string[], problems: string[]): {kind: Kind; bodyStart: number} {
  if (lines[0] !== '---') return {kind: DEFAULT_KIND, bodyStart: 0};
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    problems.push('the front matter opened by "---" is never closed');
    return {kind: DEFAULT_KIND, bodyStart: lines.length};
  }
  let kind: Kind = DEFAULT_KIND;
  const seen = new Set<string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+): *([a-z0-9]+)$/.exec(line);
    if (!match) { problems.push(`front matter line is not "kind: <kind>": ${JSON.stringify(line)}`); continue; }
    const [, key, value] = match;
    if (key !== 'kind') { problems.push(`unknown front matter key "${key}" (only "kind")`); continue; }
    if (seen.has(key)) { problems.push('"kind" is given twice'); continue; }
    seen.add(key);
    if ((KINDS as readonly string[]).includes(value)) kind = value as Kind;
    else problems.push(`unknown kind "${value}" (one of ${KINDS.join(', ')})`);
  }
  return {kind, bodyStart: end + 1};
}

function bodyProblems(body: string[]): string[] {
  if (body.every((line) => line.trim() === '')) return ['the fragment has no bullet'];
  const problems: string[] = [];
  if (!body[0].startsWith('- **')) problems.push('the bullet starts with "- **" and a bold lead: "- **What changed.** Details"');
  else if (!body.join('\n').slice(4).includes('**')) problems.push('the bold lead of the bullet is never closed with "**"');
  body.forEach((line, index) => {
    const where = `line ${index + 1} of the bullet`;
    if (line.trim() === '') problems.push(`${where} is blank: a fragment is one bullet, one paragraph`);
    else if (index > 0 && !/^ {2}\S/.test(line) && !/^ {4,}\S/.test(line)) problems.push(`${where} is not indented by two spaces under the bullet`);
    if (index > 0 && /^\s*#/.test(line)) problems.push(`${where} starts with "#"`);
    if (/\s$/.test(line)) problems.push(`${where} ends with a space`);
    if (widthOf(line) > MAX_WIDTH) problems.push(`${where} is wider than ${MAX_WIDTH} columns (link targets not counted)`);
  });
  return problems;
}

// Validates one fragment from its file name and bytes. A fragment with problems is not returned.
export function parseFragment(name: string, bytes: Uint8Array): Parsed {
  const nameMatch = FRAGMENT_NAME.exec(name);
  if (!nameMatch || NON_FRAGMENTS.includes(name)) {
    return {fragment: null, problems: ['the name is not "<number>-<slug>.md" or "<slug>.md" (a slug starts with a lowercase letter; letters, digits, hyphens)']};
  }
  if (bytes.length > MAX_BYTES) return {fragment: null, problems: [`the file is larger than ${MAX_BYTES} bytes`]};
  const problems: string[] = [];
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { return {fragment: null, problems: ['the file is not valid UTF-8']}; }
  if (text.includes('\r')) problems.push('the file has carriage returns: use LF line endings');
  if (FORBIDDEN_CHARS.test(text.replace(/\r/g, ''))) problems.push('the file holds a control, bidirectional, zero-width or byte-order-mark character');
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const {kind, bodyStart} = parseFrontMatter(lines, problems);
  problems.push(...bodyProblems(lines.slice(bodyStart)));
  if (problems.length > 0) return {fragment: null, problems};
  const number = nameMatch[1] === undefined ? null : Number(nameMatch[1]);
  return {fragment: {name, number, kind, bullet: lines.slice(bodyStart).join('\n')}, problems};
}

// Assembly order: kind (KINDS order), then pull request number, a fragment without a number after
// the numbered ones, then file name. Total and independent of the directory listing order.
export function compareFragments(left: Fragment, right: Fragment): number {
  const byKind = KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind);
  if (byKind !== 0) return byKind;
  const leftNumber = left.number ?? Number.MAX_SAFE_INTEGER;
  const rightNumber = right.number ?? Number.MAX_SAFE_INTEGER;
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export type DirectoryReport = {fragments: Fragment[]; problems: string[]};

// Reads and validates every entry of a changelog.d/ directory. A missing directory holds no
// fragment. Symbolic links, subdirectories and unexpected files are problems, never followed.
export function readFragmentDir(dir: string): DirectoryReport {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {fragments: [], problems: []};
    throw error;
  }
  const fragments: Fragment[] = [];
  const problems: string[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const label = `${FRAGMENT_DIR}/${entry.name}`;
    if (!entry.isFile()) { problems.push(`${label}: not a regular file (a symbolic link or directory is refused)`); continue; }
    if (NON_FRAGMENTS.includes(entry.name)) continue;
    const parsed = parseFragment(entry.name, fs.readFileSync(path.join(dir, entry.name)));
    for (const problem of parsed.problems) problems.push(`${label}: ${problem}`);
    if (parsed.fragment) fragments.push(parsed.fragment);
  }
  return {fragments: fragments.sort(compareFragments), problems};
}
