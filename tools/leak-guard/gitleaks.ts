// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Secret detection is delegated to gitleaks when it is installed; this module only adapts its report.
// gitleaks always runs with its default rules: a `.gitleaks.toml`, the GITLEAKS_CONFIG variables or a
// `gitleaks:allow` comment cannot silence it, and a `.gitleaksignore` in the scanned tree is a finding.
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {type Finding, ToolError} from './rules.ts';

export const GITLEAKS_ENV = 'MESH_LEAK_GITLEAKS';
const CONFIG_FILE = '.gitleaks.toml';
const IGNORE_FILE = '.gitleaksignore';

export type SecretScan = {available: boolean; findings: Finding[]; warnings: string[]};
// `texts` are scanned as one stdin stream; each finding is labelled with its text's label and line.
export type LabelledText = {label: string; text: string};
export type SecretTarget =
  | {kind: 'dir'; path: string}
  | {kind: 'staged'; repo: string}
  | {kind: 'log'; repo: string; range: string}
  | {kind: 'texts'; texts: LabelledText[]};

type Leak = {RuleID: string; File: string; StartLine: number; Secret: string; Commit?: string};
type LineOrigin = {label: string; line: number};

function binary(): string {
  return process.env[GITLEAKS_ENV] || 'gitleaks';
}

export function gitleaksAvailable(): boolean {
  const probe = spawnSync(binary(), ['version'], {stdio: 'ignore'});
  return !probe.error && probe.status === 0;
}

function targetArgs(target: SecretTarget): string[] {
  switch (target.kind) {
    case 'dir': return ['dir', '.'];
    case 'staged': return ['git', '--pre-commit', '--staged', '.'];
    case 'log': return ['git', `--log-opts=${target.range}`, '.'];
    case 'texts': return ['stdin'];
  }
}

function workdir(target: SecretTarget): string | undefined {
  return target.kind === 'dir' ? target.path : target.kind === 'texts' ? undefined : target.repo;
}

// Text on standard input has no tree: gitleaks runs in an empty directory so that it reads no
// `.gitleaksignore` of the caller's current directory.
function runDirectory(target: SecretTarget, scratch: string): string {
  if (target.kind !== 'texts') return workdir(target) ?? scratch;
  const empty = path.join(scratch, 'empty');
  fs.mkdirSync(empty);
  return empty;
}

// Joins the texts and remembers, for each line of the stream, which text and line it came from.
function joinTexts(texts: LabelledText[]): {input: string; origins: LineOrigin[]} {
  const origins: LineOrigin[] = [];
  const parts = texts.map(({label, text}) => {
    const lines = text.split('\n');
    lines.forEach((_, index) => origins.push({label, line: index + 1}));
    return lines.join('\n');
  });
  return {input: parts.join('\n'), origins};
}

// The report shows the gitleaks rule only; `match`, which reviewed exceptions compare against, names
// the value by its SHA-256 and is never printed. A secret in a text (a commit message) gets no `match`
// and no `treePath`, so that no exception can ever cover it.
function toFinding(target: SecretTarget, leak: Leak, origins: LineOrigin[]): Finding {
  const excerpt = `${leak.RuleID}: REDACTED`;
  if (target.kind === 'texts') {
    const origin = origins[leak.StartLine - 1] ?? {label: '<stdin>', line: leak.StartLine};
    return {gate: 'content', path: origin.label, line: origin.line, rule: 'secret', excerpt};
  }
  const match = `${leak.RuleID}:sha256:${crypto.createHash('sha256').update(leak.Secret).digest('hex')}`;
  const file = path.isAbsolute(leak.File) ? path.relative(workdir(target) ?? '.', leak.File) : leak.File;
  const label = target.kind === 'log' && leak.Commit ? `${leak.Commit.slice(0, 10)}:${file}` : file;
  return {gate: 'content', path: label, line: leak.StartLine, rule: 'secret', excerpt, match, treePath: file};
}

function inTree(target: SecretTarget, name: string): boolean {
  const directory = workdir(target);
  return directory !== undefined && fs.existsSync(path.join(directory, name));
}

// gitleaks always reads a `.gitleaksignore` at the root of what it scans, whatever the flags, and
// drops the secrets it lists; since secrets cannot be excepted, the file itself is a finding.
function ignoreFileFindings(target: SecretTarget): Finding[] {
  if (!inTree(target, IGNORE_FILE)) return [];
  return [{gate: 'content', path: IGNORE_FILE, line: 0, rule: 'gitleaks-ignore-file',
    excerpt: 'gitleaks drops the secrets this file lists; secrets cannot be excepted'}];
}

function configWarnings(target: SecretTarget): string[] {
  return inTree(target, CONFIG_FILE) ? [`${CONFIG_FILE} found in the scanned tree and ignored: gitleaks runs with its default rules`] : [];
}

function isLeak(value: unknown): value is Leak {
  const leak = value as Leak;
  return typeof leak === 'object' && leak !== null && typeof leak.RuleID === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(leak.RuleID) &&
    typeof leak.Secret === 'string' && typeof leak.File === 'string' && Number.isInteger(leak.StartLine) &&
    (leak.Commit === undefined || typeof leak.Commit === 'string');
}

// The report holds raw values: an error about it says what is wrong and its size, never a part of it.
function parseReport(stdout: string): Leak[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ToolError(`the gitleaks report is not valid JSON (${stdout.length} characters; content not printed)`);
  }
  if (!Array.isArray(value) || !value.every(isLeak)) {
    throw new ToolError(`the gitleaks report does not have the expected shape (${stdout.length} characters; content not printed)`);
  }
  return value;
}

// gitleaks' error output can quote what it scanned (a line it could not decode, a path, a value), so
// only its exit status, its signal and the size of that output are relayed.
function failure(run: ReturnType<typeof spawnSync>): ToolError {
  const reason = run.error ? (run.error as NodeJS.ErrnoException).code ?? 'spawn error' : run.signal ? `signal ${run.signal}` : `status ${run.status}`;
  const size = String(run.stderr ?? '').length;
  return new ToolError(`gitleaks failed (${reason}); its error output (${size} characters) is not printed, as it may quote scanned content`);
}

// The JSON report goes to standard output ("-") and is read in memory: the raw values it holds never
// reach the disk, so an interrupted scan cannot leave them behind.
function runGitleaks(target: SecretTarget, scratch: string, input: string | undefined): Leak[] {
  const config = path.join(scratch, 'gitleaks.toml');
  fs.writeFileSync(config, '[extend]\nuseDefault = true\n');
  const args = [...targetArgs(target), '--config', config, '--gitleaks-ignore-path', scratch, '--ignore-gitleaks-allow',
    '--no-banner', '--log-level', 'error', '--exit-code', '0', '--report-format', 'json', '--report-path', '-'];
  const env = {...process.env};
  delete env.GITLEAKS_CONFIG;
  delete env.GITLEAKS_CONFIG_TOML;
  const run = spawnSync(binary(), args, {cwd: runDirectory(target, scratch), env, input, encoding: 'utf8', maxBuffer: 1 << 28});
  if (run.error || run.status !== 0) throw failure(run);
  return parseReport(run.stdout);
}

// Runs gitleaks with a JSON report; a missing binary is a warning, a failing one an error. The report holds
// the raw values (needed for their digests) and is only read in memory; the temporary directory holds the
// configuration and an empty working directory, never a scanned value.
export function scanSecrets(target: SecretTarget): SecretScan {
  if (!gitleaksAvailable()) {
    return {available: false, findings: [], warnings: [`gitleaks not found (${binary()}): secrets were NOT checked`]};
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-guard-'));
  try {
    const {input, origins} = target.kind === 'texts' ? joinTexts(target.texts) : {input: undefined, origins: []};
    const leaks = runGitleaks(target, scratch, input);
    const findings = [...leaks.map(leak => toFinding(target, leak, origins)), ...ignoreFileFindings(target)];
    return {available: true, findings, warnings: configWarnings(target)};
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}
