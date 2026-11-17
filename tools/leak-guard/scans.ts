// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// One function per command: collect findings from every gate, then apply exceptions.
import fs from 'node:fs';
import path from 'node:path';
import {scanAdded, scanFile, scanSymlink} from './content.ts';
import {staleAllows} from './allows.ts';
import {applyExceptions, type Exception} from './exceptions.ts';
import {commitChanges, commitData, commitList, git, stagedChanges, worktreeFiles} from './gitrepo.ts';
import {scanSecrets, type SecretTarget} from './gitleaks.ts';
import {checkIdentity, parseIdent} from './identity.ts';
import {checkMessage, checkPrBody, type MessageSource} from './message.ts';
import type {ScanResult} from './report.ts';
import {type Finding, type RuleSet, PRIVATE_RULES_ENV} from './rules.ts';

export type ScanOptions = {ruleSet: RuleSet; exceptions: Exception[]; secrets: boolean};
type Finish = {fullScan: boolean; keep?: (file: string) => boolean};

function baseWarnings(options: ScanOptions): string[] {
  return options.ruleSet.privateSource ? [] : [`no private list (set ${PRIVATE_RULES_ENV} or --private): generic rules only`];
}

function finish(command: string, options: ScanOptions, findings: Finding[], secretTargets: SecretTarget[], how: Finish): ScanResult {
  const warnings = baseWarnings(options);
  if (secretTargets.length > 0 && !options.secrets) warnings.push('secret scan disabled (--no-secrets)');
  let secretsChecked = options.secrets;
  for (const target of options.secrets ? secretTargets : []) {
    const secrets = scanSecrets(target);
    secretsChecked &&= secrets.available;
    for (const warning of secrets.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    const kept = secrets.findings.filter(finding => !how.keep || how.keep(finding.path) || finding.rule === 'gitleaks-ignore-file');
    findings = [...findings, ...kept];
  }
  const {privateAllows = [], allowsUsed = new Set()} = options.ruleSet;
  if (how.fullScan) findings = [...findings, ...staleAllows(privateAllows, allowsUsed)];
  return {command, findings: applyExceptions(findings, options.exceptions, how.fullScan, secretsChecked), warnings};
}

// A regular file is scanned as bytes, a symbolic link as its target string; anything else is skipped.
function scanEntry(ruleSet: RuleSet, absolute: string, relative: string): Finding[] {
  const stat = fs.lstatSync(absolute, {throwIfNoEntry: false});
  if (stat?.isSymbolicLink()) return scanSymlink(ruleSet, relative, fs.readlinkSync(absolute));
  return stat?.isFile() ? scanFile(ruleSet, relative, fs.readFileSync(absolute)) : [];
}

export function scanWorktree(root: string, options: ScanOptions): ScanResult {
  const files = worktreeFiles(root);
  const findings = files.flatMap(file => scanEntry(options.ruleSet, path.join(root, file), file));
  const listed = new Set(files);
  return finish('worktree', options, findings, [{kind: 'dir', path: root}], {fullScan: true, keep: file => listed.has(file)});
}

function walk(directory: string, prefix: string, out: string[]): void {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.name === '.git') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(directory, entry.name), relative, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative);
  }
}

export function scanTree(directory: string, options: ScanOptions): ScanResult {
  const files: string[] = [];
  walk(directory, '', files);
  const findings = files.flatMap(file => scanEntry(options.ruleSet, path.join(directory, file), file));
  return finish(`tree ${directory}`, options, findings, [{kind: 'dir', path: directory}], {fullScan: true});
}

export function scanStaged(root: string, options: ScanOptions): ScanResult {
  const findings = stagedChanges(root).flatMap(change => scanAdded(options.ruleSet, change));
  return finish('staged', options, findings, [{kind: 'staged', repo: root}], {fullScan: false});
}

function commitFindings(root: string, sha: string, options: ScanOptions): {findings: Finding[]; message: string} {
  const short = sha.slice(0, 10);
  const data = commitData(root, sha);
  const findings = [
    ...checkMessage(options.ruleSet, `${short}:<message>`, data.message),
    ...checkIdentity(options.ruleSet, 'author', data.authorName, data.authorEmail, `${short}:<author>`),
    ...checkIdentity(options.ruleSet, 'committer', data.committerName, data.committerEmail, `${short}:<committer>`),
  ];
  for (const change of commitChanges(root, sha)) {
    // Exceptions name tree paths, so they apply before the commit prefix is added.
    const kept = applyExceptions(scanAdded(options.ruleSet, change), options.exceptions, false);
    findings.push(...kept.map(finding => ({...finding, path: `${short}:${finding.path}`})));
  }
  return {findings, message: data.message};
}

// gitleaks reads the diffs of the range; the messages go to it separately, since its git mode skips them.
export function scanCommits(root: string, range: string, options: ScanOptions): ScanResult {
  const findings: Finding[] = [];
  const messages = commitList(root, range).map(sha => {
    const commit = commitFindings(root, sha, options);
    findings.push(...commit.findings);
    return {label: `${sha.slice(0, 10)}:<message>`, text: commit.message};
  });
  const targets: SecretTarget[] = [{kind: 'log', repo: root, range}, {kind: 'texts', texts: messages}];
  return finish(`commits ${range}`, options, findings, targets, {fullScan: false});
}

function messageScan(command: string, file: string, options: ScanOptions, source: MessageSource): ScanResult {
  const text = fs.readFileSync(file, 'utf8');
  const findings = checkMessage(options.ruleSet, '<message>', text, source);
  return finish(command, options, findings, [{kind: 'texts', texts: [{label: '<message>', text}]}], {fullScan: false});
}

export function scanMessage(file: string, options: ScanOptions): ScanResult {
  return messageScan('message', file, options, 'recorded');
}

// A pull request description: content rules only, never exempted (see checkPrBody).
export function scanPrBody(file: string, options: ScanOptions): ScanResult {
  const text = fs.readFileSync(file, 'utf8');
  const findings = checkPrBody(options.ruleSet, '<pr-body>', text);
  return finish('pr-body', options, findings, [{kind: 'texts', texts: [{label: '<pr-body>', text}]}], {fullScan: false});
}

export function scanIdentity(name: string, address: string, options: ScanOptions): ScanResult {
  return finish('identity', options, checkIdentity(options.ruleSet, 'author', name, address), [], {fullScan: false});
}

// commit-msg hook: the message as git hands it over (before cleanup), plus the author and committer.
export function scanCommitMessageHook(root: string, file: string, options: ScanOptions): ScanResult {
  const message = messageScan('hook commit-msg', file, options, 'hook');
  const findings = [...message.findings];
  for (const role of ['author', 'committer'] as const) {
    const ident = parseIdent(git(root, ['var', role === 'author' ? 'GIT_AUTHOR_IDENT' : 'GIT_COMMITTER_IDENT']));
    findings.push(...checkIdentity(options.ruleSet, role, ident.name, ident.address));
  }
  return {command: 'hook commit-msg', findings, warnings: message.warnings};
}
