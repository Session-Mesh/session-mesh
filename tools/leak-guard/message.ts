// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Commit message and trailer gate.
import {type Finding, type RuleSet, excerpt, scanLines} from './rules.ts';

const SCISSORS = /^# -+ >8 -+$/;
const TRAILER = /^\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*:\s*(.*)$/;

type Entry = {text: string; line: number};

// `commits` reads the message as recorded: every line counts. The commit-msg hook reads the file
// before git cleans it, and git only certainly removes what follows its own cut line (written with a
// localized notice of two comment lines, then the diff or nothing, in verbose or scissors mode). Comment lines are
// kept by `git commit -m/-F`, so the hook checks them too.
export type MessageSource = 'recorded' | 'hook';

// Git's cut line is followed by its two-line notice, then by nothing or by the diff. Anything else
// after a scissors line was written by the author and is kept by git, so it is checked.
function isGitCutLine(lines: string[], index: number): boolean {
  if (!SCISSORS.test(lines[index])) return false;
  const notice = lines.slice(index + 1, index + 3);
  if (notice.length < 2 || !notice.every(line => line.startsWith('#'))) return false;
  const rest = lines.slice(index + 3);
  const first = rest.find(line => line.trim() !== '');
  return first === undefined || first.startsWith('diff --git ');
}

export function effectiveLines(message: string, source: MessageSource): Entry[] {
  const lines = message.split(/\r?\n/);
  const end = source === 'hook' ? lines.findIndex((_, index) => isGitCutLine(lines, index)) : -1;
  return lines.slice(0, end < 0 ? lines.length : end).map((text, index) => ({text, line: index + 1}));
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '');
}

function lineRule(ruleSet: RuleSet, text: string): string | null {
  const trailer = TRAILER.exec(text);
  const key = trailer ? normalizedKey(trailer[1]) : '';
  if (trailer && ruleSet.publicRules.message.sessionTrailers.map(normalizedKey).includes(key)) return 'agent-session-trailer';
  return null;
}

function agentFindings(ruleSet: RuleSet, label: string, entries: Entry[]): Finding[] {
  const findings: Finding[] = [];
  for (const {text, line} of entries) {
    const rule = lineRule(ruleSet, text);
    if (rule) findings.push({gate: 'message', path: label, line, rule, excerpt: excerpt(text, {index: 0, text})});
  }
  return findings;
}

// Checks content rules on every line kept and agent session trailers.
export function checkMessage(ruleSet: RuleSet, label: string, message: string, source: MessageSource = 'recorded'): Finding[] {
  const entries = effectiveLines(message, source);
  const findings = scanLines(ruleSet, {gate: 'message', path: label}, entries.map(entry => entry.text), entries.map(entry => entry.line));
  findings.push(...agentFindings(ruleSet, label, entries));
  return findings;
}

// A pull request description: the content rules of a commit message only. The commit conventions
// (agent session trailers) say nothing about a description and are left out; there is no identity to check either.
export function checkPrBody(ruleSet: RuleSet, label: string, body: string): Finding[] {
  const entries = effectiveLines(body, 'recorded');
  return scanLines(ruleSet, {gate: 'message', path: label}, entries.map(entry => entry.text), entries.map(entry => entry.line));
}
