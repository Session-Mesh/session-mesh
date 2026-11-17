// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Author and committer identity gate.
import {type Finding, type RuleSet, excerpt, genericHits, maskKeys, privateHits} from './rules.ts';

export type Role = 'author' | 'committer';

export function identityAllowed(ruleSet: RuleSet, role: Role, address: string): boolean {
  const rules = ruleSet.publicRules.identity;
  const lower = address.toLowerCase();
  if (role === 'committer' && rules.committerAddresses.includes(lower)) return true;
  const at = lower.lastIndexOf('@');
  return at > 0 && lower.slice(at + 1) === rules.domain && !/\s/.test(lower);
}

// An identity passes when its address is a GitHub noreply form and nothing private appears in it.
export function checkIdentity(ruleSet: RuleSet, role: Role, name: string, address: string, label: string = role): Finding[] {
  const shown = `${name} <${address}>`;
  const findings: Finding[] = [];
  if (!identityAllowed(ruleSet, role, address)) {
    findings.push({gate: 'identity', path: label, line: 0, rule: 'identity-not-noreply', excerpt: maskKeys(shown)});
  }
  // The address is judged by the noreply rule above; the name gets the generic rules too.
  const hits = [...genericHits(ruleSet.publicRules, name), ...privateHits(ruleSet.privateRules, shown)];
  for (const {rule, hit} of hits) {
    findings.push({gate: 'identity', path: label, line: 0, rule, excerpt: excerpt(shown, hit)});
  }
  return findings;
}

const IDENT = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/;

// Parses `git var GIT_AUTHOR_IDENT` output: "Name <address> 1700000000 +0100".
export function parseIdent(ident: string): {name: string; address: string} {
  const match = IDENT.exec(ident.trim());
  if (!match) return {name: ident.trim(), address: ''};
  return {name: match[1], address: match[2]};
}
