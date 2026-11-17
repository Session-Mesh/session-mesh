// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Reviewed authorizations kept in the private list itself (`allow`), so the tree never cites it.
// An entry names a file, a private rule id and an exact text of that file containing the literal;
// it lifts only the hits that lie inside an occurrence of that text, and fails full scans once it
// matches nothing. Its value is never written to a report.
import {type Finding, type PrivateRule, ToolError} from './rules.ts';

export type PrivateAllow = {path: string; rule: string; value: string};

function containsLiteral(rule: PrivateRule, value: string): boolean {
  return rule.caseInsensitive ? value.toLowerCase().includes(rule.literal.toLowerCase()) : value.includes(rule.literal);
}

function isBareLiteral(rule: PrivateRule, value: string): boolean {
  const text = value.trim();
  return rule.caseInsensitive ? text.toLowerCase() === rule.literal.toLowerCase() : text === rule.literal;
}

function validAllow(file: string, entry: PrivateAllow, index: number, forbidden: PrivateRule[]): PrivateAllow {
  for (const field of ['path', 'rule', 'value'] as const) {
    if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') throw new ToolError(`private list ${file}: allow ${index} needs a non-empty ${field}`);
  }
  const rule = forbidden.find(candidate => candidate.id === entry.rule);
  if (!rule) throw new ToolError(`private list ${file}: allow ${index} names an unknown rule`);
  if (!containsLiteral(rule, entry.value)) throw new ToolError(`private list ${file}: allow ${index}: its value does not contain the rule's literal`);
  if (isBareLiteral(rule, entry.value)) throw new ToolError(`private list ${file}: allow ${index}: its value is only the rule's literal and would lift every occurrence`);
  return {path: entry.path, rule: entry.rule, value: entry.value};
}

export function loadAllows(file: string, value: {allow?: unknown}, forbidden: PrivateRule[]): PrivateAllow[] {
  if (value.allow === undefined) return [];
  if (!Array.isArray(value.allow)) throw new ToolError(`private list ${file}: allow must be an array`);
  return value.allow.map((entry: PrivateAllow, index: number) => validAllow(file, entry, index, forbidden));
}

function insideOccurrence(line: string, value: string, start: number, end: number): boolean {
  for (let index = line.indexOf(value); index >= 0; index = line.indexOf(value, index + 1)) {
    if (index <= start && end <= index + value.length) return true;
  }
  return false;
}

// The allow covering a private hit (`private:<id>`) at [start, end) of a line of `file`, if any.
export function findAllow(allows: PrivateAllow[], file: string, rule: string, line: string, start: number, end: number): PrivateAllow | undefined {
  return allows.find(allow => `private:${allow.rule}` === rule && allow.path === file && insideOccurrence(line, allow.value, start, end));
}

// One finding per allow that lifted nothing; the report names its position and rule, not its value.
export function staleAllows(allows: PrivateAllow[], used: ReadonlySet<PrivateAllow>): Finding[] {
  return allows.flatMap((allow, index) => used.has(allow) ? [] : [{
    gate: 'content' as const, path: allow.path, line: 0, rule: 'stale-private-allow',
    excerpt: `private list allow ${index} (rule ${allow.rule}) no longer matches`,
  }]);
}
