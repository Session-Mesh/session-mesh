// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Rule sets and line scanners. Generic rules name nothing that belongs to the owner;
// the private list lives outside the repository and is only read from a path.
import fs from 'node:fs';
import path from 'node:path';
import {findAllow, loadAllows, type PrivateAllow} from './allows.ts';

export type Gate = 'content' | 'filename' | 'message' | 'identity';
// `match` is the exact text a line rule matched (for a gitleaks secret, `<gitleaks rule>:sha256:<digest>`);
// reviewed exceptions compare against it. `treePath` is the file path when `path` carries a commit prefix.
export type Finding = {gate: Gate; path: string; line: number; rule: string; excerpt: string; match?: string; treePath?: string};
export type PrivateRule = {id: string; literal: string; caseInsensitive: boolean};
export type PublicRules = {
  email: {allowedAddresses: string[]; allowedDomains: string[]; allowedTopLevels: string[]};
  homeTemplates: string[];
  tailnetIpv6Groups: string[];
  tailnetExampleLabels: string[];
  vendor: {prefixes: string[]; exemptRules: string[]};
  identity: {domain: string; committerAddresses: string[]};
  message: {sessionTrailers: string[]};
};
// `privateAllows` come from the private list; `allowsUsed` records those that lifted a hit during a scan.
export type RuleSet = {
  publicRules: PublicRules; privateRules: PrivateRule[]; privateSource: string | null;
  privateAllows?: PrivateAllow[]; allowsUsed?: Set<PrivateAllow>;
};
type Hit = {index: number; text: string};

export class ToolError extends Error {}

const PUBLIC_RULES_FILE = path.join(import.meta.dirname, 'rules.public.json');
export const PRIVATE_RULES_ENV = 'MESH_LEAK_PRIVATE_RULES';

export function loadPublicRules(file: string = PUBLIC_RULES_FILE): PublicRules {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schema !== 1) throw new ToolError(`${file}: unsupported schema ${value.schema}`);
  return value as PublicRules;
}

function validPrivateRule(entry: unknown): entry is PrivateRule {
  const rule = entry as PrivateRule;
  return typeof rule === 'object' && rule !== null && typeof rule.id === 'string' && rule.id.length > 0 &&
    typeof rule.literal === 'string' && rule.literal.length > 0 && typeof rule.caseInsensitive === 'boolean';
}

function readPrivateList(file: string): {forbidden: PrivateRule[]; allows: PrivateAllow[]} {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ToolError(`private list ${file} unreadable: ${(error as Error).message}`);
  }
  if (value?.schema !== 1 || !Array.isArray(value.forbidden)) throw new ToolError(`private list ${file}: expected schema 1 with a forbidden array`);
  value.forbidden.forEach((entry: unknown, index: number) => {
    if (!validPrivateRule(entry)) throw new ToolError(`private list ${file}: entry ${index} needs id, literal, caseInsensitive`);
  });
  return {forbidden: value.forbidden, allows: loadAllows(file, value, value.forbidden)};
}

export function loadPrivateRules(file: string): PrivateRule[] {
  return readPrivateList(file).forbidden;
}

// Explicit option first, then the environment; absence is reported, never silent.
export function loadRuleSet(privateOption: string | null): RuleSet {
  const source = privateOption ?? process.env[PRIVATE_RULES_ENV] ?? null;
  const list = source ? readPrivateList(source) : {forbidden: [], allows: []};
  return {publicRules: loadPublicRules(), privateRules: list.forbidden, privateSource: source, privateAllows: list.allows, allowsUsed: new Set()};
}

function allHits(text: string, pattern: RegExp, keep: (match: RegExpExecArray) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(pattern)) if (keep(match)) hits.push({index: match.index, text: match[0]});
  return hits;
}

export function emailAllowed(rules: PublicRules, address: string): boolean {
  const lower = address.toLowerCase().replace(/%40/g, '@');
  const domain = lower.slice(lower.lastIndexOf('@') + 1);
  const top = domain.slice(domain.lastIndexOf('.') + 1);
  return rules.email.allowedAddresses.includes(lower) || rules.email.allowedTopLevels.includes(top) ||
    rules.email.allowedDomains.some(allowed => domain === allowed || domain.endsWith('.' + allowed));
}

// `%40` is the URL-encoded `@`.
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi;
// Not preceded by a path character, so `root/home/cwd` is not a home directory; `/var/home` is
// the home root of image-based Fedora systems.
const HOME = /(?<![\w.~-])(?:\/var)?\/(?:home|Users)\/([^/\s'"`:;,)}\]]+)/g;
// `C:\Users\name`, also with doubled backslashes as in JSON or source strings.
const WINDOWS_HOME = /\b[A-Za-z]:\\{1,2}Users\\{1,2}([^\\/\s'"`:;,)}\]]+)/gi;
const IPV4 = /(?<![\d.])100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;
const TAILNET_HOST = /\b((?:[A-Za-z0-9-]+\.)+)ts\.net\b/gi;
// Tailscale keys of any kind (`tskey-<kind>-<value>`: auth, api, client, scim, webhook...); gitleaks 8.30 has no rule for them.
// `tskey-<kind>-<value>`, or the older untyped `tskey-<16 or more alphanumerics>`.
// Not preceded by a letter or digit, so `KEY_tskey-...` (where `\b` fails after `_`) is found.
const TAILSCALE_KEY = /(?<![A-Za-z0-9])tskey-(?:[a-z]+-[A-Za-z0-9-]+|[A-Za-z0-9]{16,})/gi;

function homeAllowed(rules: PublicRules, user: string): boolean {
  return rules.homeTemplates.includes(user) || /^[$<{%*.…]/.test(user);
}

function tailnetIpv4(match: RegExpExecArray): boolean {
  const [second, third, fourth] = [match[1], match[2], match[3]].map(Number);
  return second >= 64 && second <= 127 && third <= 255 && fourth <= 255;
}

function tailnetHostAllowed(rules: PublicRules, labels: string): boolean {
  const parts = labels.split('.').filter(Boolean);
  return rules.tailnetExampleLabels.includes(parts[parts.length - 1].toLowerCase());
}

function ipv6Pattern(rules: PublicRules): RegExp {
  return new RegExp(`${rules.tailnetIpv6Groups.join(':')}:[0-9A-Fa-f:]*`, 'gi');
}

// Generic, owner-neutral detectors. Secrets are delegated to gitleaks.
export function genericHits(rules: PublicRules, line: string): Array<{rule: string; hit: Hit}> {
  const tagged = (rule: string, hits: Hit[]) => hits.map(hit => ({rule, hit}));
  return [
    ...tagged('email', allHits(line, EMAIL, match => !emailAllowed(rules, match[0]))),
    ...tagged('home-path', allHits(line, HOME, match => !homeAllowed(rules, match[1]))),
    ...tagged('home-path', allHits(line, WINDOWS_HOME, match => !homeAllowed(rules, match[1]))),
    ...tagged('tailnet-ipv4', allHits(line, IPV4, tailnetIpv4)),
    ...tagged('tailnet-ipv6', allHits(line, ipv6Pattern(rules), () => true)),
    ...tagged('tailnet-host', allHits(line, TAILNET_HOST, match => !tailnetHostAllowed(rules, match[1]))),
    ...tagged('tailscale-key', allHits(line, TAILSCALE_KEY, () => true)),
  ];
}

export function privateHits(rules: PrivateRule[], line: string): Array<{rule: string; hit: Hit}> {
  const found: Array<{rule: string; hit: Hit}> = [];
  for (const rule of rules) {
    const haystack = rule.caseInsensitive ? line.toLowerCase() : line;
    const needle = rule.caseInsensitive ? rule.literal.toLowerCase() : rule.literal;
    for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
      found.push({rule: `private:${rule.id}`, hit: {index, text: line.slice(index, index + needle.length)}});
    }
  }
  return found;
}

const EXCERPT_RADIUS = 30;
const EXCERPT_MAX = 120;

// A secret is never shown in a report: every Tailscale key of the text is masked, whatever rule
// the finding is about, the way gitleaks redacts values.
function keyMask(text: string): {masked: string; position: (index: number) => number} {
  const spans = [...text.matchAll(TAILSCALE_KEY)].map(match => {
    const prefix = /^tskey-(?:[a-z]+-)?/i.exec(match[0])?.[0] ?? '';
    return {start: match.index, end: match.index + match[0].length, shown: `${prefix}REDACTED`};
  });
  let masked = '';
  let last = 0;
  for (const span of spans) { masked += text.slice(last, span.start) + span.shown; last = span.end; }
  masked += text.slice(last);
  // Maps an index of the original text to the masked text; inside a key it lands on the mask's end.
  const position = (index: number): number => {
    let shift = 0;
    for (const span of spans) {
      if (index >= span.end) shift += span.end - span.start - span.shown.length;
      else if (index > span.start) return span.start - shift + span.shown.length;
    }
    return index - shift;
  };
  return {masked, position};
}

export function maskKeys(text: string): string {
  return keyMask(text).masked;
}

// A window around the hit; a long hit keeps its end, where addresses and hosts are identifying.
export function excerpt(rawLine: string, rawHit: Hit): string {
  const {masked: line, position} = keyMask(rawLine);
  const hit = {index: position(rawHit.index), text: line.slice(position(rawHit.index), position(rawHit.index + rawHit.text.length))};
  const end = Math.min(line.length, hit.index + hit.text.length + EXCERPT_RADIUS);
  const start = Math.max(0, hit.index - EXCERPT_RADIUS, end - EXCERPT_MAX);
  const body = line.slice(start, end).replace(/[\x00-\x1f\x7f]/g, ' ');
  return `${start > 0 ? '…' : ''}${body}${end < line.length ? '…' : ''}`;
}

function vendorExempt(rules: PublicRules, file: string, rule: string): boolean {
  return rules.vendor.exemptRules.includes(rule) && rules.vendor.prefixes.some(prefix => file.startsWith(prefix));
}

export type ScanTarget = {gate: Gate; path: string};

// Only file content and file names can be authorized, like reviewed exceptions.
function allowedPrivateHit(ruleSet: RuleSet, target: ScanTarget, line: string, rule: string, hit: Hit): boolean {
  if (target.gate !== 'content' && target.gate !== 'filename') return false;
  const allow = findAllow(ruleSet.privateAllows ?? [], target.path, rule, line, hit.index, hit.index + hit.text.length);
  if (allow) ruleSet.allowsUsed?.add(allow);
  return allow !== undefined;
}

// Scans text line by line with both rule sets; `lineNumbers` maps positions to source lines.
export function scanLines(ruleSet: RuleSet, target: ScanTarget, lines: string[], lineNumbers?: number[]): Finding[] {
  const findings: Finding[] = [];
  lines.forEach((line, position) => {
    const lineNumber = lineNumbers ? lineNumbers[position] : position + 1;
    const hits = [...genericHits(ruleSet.publicRules, line), ...privateHits(ruleSet.privateRules, line)];
    for (const {rule, hit} of hits) {
      if (vendorExempt(ruleSet.publicRules, target.path, rule)) continue;
      if (allowedPrivateHit(ruleSet, target, line, rule, hit)) continue;
      findings.push({gate: target.gate, path: target.path, line: lineNumber, rule, excerpt: excerpt(line, hit), match: hit.text});
    }
  });
  return findings;
}

export function scanText(ruleSet: RuleSet, target: ScanTarget, text: string): Finding[] {
  return scanLines(ruleSet, target, text.split(/\r?\n/));
}

export function scanFileName(ruleSet: RuleSet, file: string): Finding[] {
  return scanLines(ruleSet, {gate: 'filename', path: file}, [file], [0]);
}
