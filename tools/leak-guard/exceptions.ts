// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Reviewed exceptions: path, rule, exact matched value (`substring`), reason. Unused exceptions fail full scans.
import fs from 'node:fs';
import path from 'node:path';
import {type Finding, ToolError} from './rules.ts';

export type Exception = {path: string; rule: string; substring: string; reason: string};

export const EXCEPTIONS_FILE = path.join(import.meta.dirname, 'exceptions.json');

// A gitleaks secret is named by its gitleaks rule and the SHA-256 of the exact value, so the
// exception file never holds the value (gitleaks would report the file itself).
const SECRET_SUBSTRING = /^[a-z0-9][a-z0-9-]*:sha256:[0-9a-f]{64}$/;

// An exception names a file of the tree: a relative path without empty, "." or ".." segments. Labels
// such as `<message>`, `<author>` or `<sha>:<message>` are not tree paths, so a message or an
// identity can never be excepted.
function isTreePath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || /[<>]/.test(value)) return false;
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function validate(file: string, entry: Exception, index: number): void {
  const fields = ['path', 'rule', 'substring', 'reason'] as const;
  for (const field of fields) {
    if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') throw new ToolError(`${file}: exception ${index} needs a non-empty ${field}`);
  }
  if (!isTreePath(entry.path)) throw new ToolError(`${file}: exception ${index}: path must be a tree path (a file, never a message or an identity)`);
  if (entry.rule === 'tailscale-key') throw new ToolError(`${file}: exception ${index}: Tailscale keys cannot be excepted`);
  if (entry.rule === 'secret' && !SECRET_SUBSTRING.test(entry.substring)) {
    throw new ToolError(`${file}: exception ${index}: a secret is excepted as "<gitleaks rule>:sha256:<SHA-256 of the exact value, 64 lowercase hex>"`);
  }
  if (entry.rule.startsWith('private:')) throw new ToolError(`${file}: exception ${index}: a private-list exception would cite the private list in the tree`);
}

export function loadExceptions(file: string = EXCEPTIONS_FILE): Exception[] {
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schema !== 1 || !Array.isArray(value.exceptions)) throw new ToolError(`${file}: expected schema 1 with an exceptions array`);
  value.exceptions.forEach((entry: Exception, index: number) => validate(file, entry, index));
  return value.exceptions;
}

// Only file content and file names can be excepted, and only for the exact matched value: an
// exception never covers a message, an identity, or another value on the same line.
const EXCEPTABLE_GATES: ReadonlySet<Finding['gate']> = new Set(['content', 'filename']);

function covers(exception: Exception, finding: Finding): boolean {
  return EXCEPTABLE_GATES.has(finding.gate) && exception.path === (finding.treePath ?? finding.path) &&
    exception.rule === finding.rule && finding.match === exception.substring;
}

// A secret exception is named by its rule only: its digest is never printed.
function staleSubject(exception: Exception): string {
  return exception.rule === 'secret' ? 'secret exception' : `${exception.rule} "${exception.substring}"`;
}

// Removes excepted findings. With `reportStale`, an exception that matched nothing becomes a finding;
// a secret exception only when the secret scan ran (`secretsChecked`).
export function applyExceptions(findings: Finding[], exceptions: Exception[], reportStale: boolean, secretsChecked = true): Finding[] {
  const used = new Set<Exception>();
  const kept = findings.filter(finding => {
    const match = exceptions.find(exception => covers(exception, finding));
    if (match) used.add(match);
    return !match;
  });
  if (!reportStale) return kept;
  const stale = exceptions.filter(exception => !used.has(exception) && (secretsChecked || exception.rule !== 'secret')).map(exception => ({
    gate: 'content' as const, path: exception.path, line: 0, rule: 'stale-exception',
    excerpt: `${staleSubject(exception)} no longer matches (${exception.reason})`,
  }));
  return [...kept, ...stale];
}
