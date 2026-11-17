// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Human-readable report and exit status.
import {type Finding, maskKeys} from './rules.ts';

export type ScanResult = {command: string; findings: Finding[]; warnings: string[]};

export function countsByRule(findings: Finding[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  return [...counts.entries()].sort(([leftRule, leftCount], [rightRule, rightCount]) => rightCount - leftCount || leftRule.localeCompare(rightRule));
}

// A key can sit in a file name or a scanned directory: every path shown goes through the mask.
function location(finding: Finding): string {
  const shown = maskKeys(finding.path);
  return finding.line > 0 ? `${shown}:${finding.line}` : shown;
}

export function formatReport(result: ScanResult): string {
  const lines = [`leak-guard ${maskKeys(result.command)}: ${result.findings.length} finding(s)`];
  for (const warning of result.warnings) lines.push(`warning: ${maskKeys(warning)}`);
  for (const [rule, count] of countsByRule(result.findings)) lines.push(`  ${String(count).padStart(5)}  ${rule}`);
  if (result.findings.length > 0) lines.push('');
  for (const finding of result.findings) {
    lines.push(`${location(finding)}  [${finding.gate}] ${finding.rule}  ${finding.excerpt}`);
  }
  return lines.join('\n') + '\n';
}

export function exitCode(result: ScanResult): number {
  return result.findings.length === 0 ? 0 : 1;
}
