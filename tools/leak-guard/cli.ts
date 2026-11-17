// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// leak-guard: search the tree, staged files, commits, messages and identities for leaks.
// Run with `node --experimental-strip-types tools/leak-guard/cli.ts <command>`.
import path from 'node:path';
import {EXCEPTIONS_FILE, loadExceptions} from './exceptions.ts';
import {repoRoot} from './gitrepo.ts';
import {defaultScope, install, type Scope, status, uninstall} from './hooks.ts';
import {exitCode, formatReport, type ScanResult} from './report.ts';
import {loadRuleSet, maskKeys, PRIVATE_RULES_ENV, ToolError} from './rules.ts';
import * as scans from './scans.ts';

const USAGE = `usage: cli.ts [--private <file>] [--exceptions <file>] [--no-secrets] <command>
  worktree                 tracked and untracked (not ignored) files
  staged                   added lines and new file names in the index
  commits <A..B>           messages, trailers, identities and added content of each commit
  tree <directory>         every file under a directory
  message <file>           a commit message
  pr-body <file>           a pull request description (content rules only)
  identity <name> <email>  a commit identity
  hooks install|status|uninstall [--scope worktree|local]
exit status: 0 clean, 1 findings, 2 usage or tool error`;

type Options = {privateRules: string | null; exceptions: string; secrets: boolean; scope: Scope | null; rest: string[]};

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new ToolError(`${flag} needs a value`);
  return value;
}

export function parseOptions(argv: string[]): Options {
  const options: Options = {privateRules: null, exceptions: EXCEPTIONS_FILE, secrets: true, scope: null, rest: []};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--private') options.privateRules = takeValue(argv, index++, arg);
    else if (arg === '--exceptions') options.exceptions = takeValue(argv, index++, arg);
    else if (arg === '--no-secrets') options.secrets = false;
    else if (arg === '--scope') {
      const scope = takeValue(argv, index++, arg);
      if (scope !== 'worktree' && scope !== 'local') throw new ToolError(`--scope must be worktree or local`);
      options.scope = scope;
    } else options.rest.push(arg);
  }
  return options;
}

function needArgs(rest: string[], count: number): string[] {
  if (rest.length !== count + 1) throw new ToolError(`${rest[0]} expects ${count} argument(s)\n${USAGE}`);
  return rest.slice(1);
}

function scanOptionsOf(options: Options): scans.ScanOptions {
  return {ruleSet: loadRuleSet(options.privateRules), exceptions: loadExceptions(options.exceptions), secrets: options.secrets};
}

function runScan(options: Options, cwd: string): ScanResult {
  const scanOptions = scanOptionsOf(options);
  const [command] = options.rest;
  switch (command) {
    case 'worktree': needArgs(options.rest, 0); return scans.scanWorktree(repoRoot(cwd), scanOptions);
    case 'staged': needArgs(options.rest, 0); return scans.scanStaged(repoRoot(cwd), scanOptions);
    case 'commits': return scans.scanCommits(repoRoot(cwd), needArgs(options.rest, 1)[0], scanOptions);
    case 'tree': return scans.scanTree(path.resolve(cwd, needArgs(options.rest, 1)[0]), scanOptions);
    case 'message': return scans.scanMessage(path.resolve(cwd, needArgs(options.rest, 1)[0]), scanOptions);
    case 'pr-body': return scans.scanPrBody(path.resolve(cwd, needArgs(options.rest, 1)[0]), scanOptions);
    case 'identity': {
      const [name, address] = needArgs(options.rest, 2);
      return scans.scanIdentity(name, address, scanOptions);
    }
    default: throw new ToolError(`unknown command ${command ?? '(none)'}\n${USAGE}`);
  }
}

function runHooks(options: Options, cwd: string): number {
  const root = repoRoot(cwd);
  const [, action] = options.rest;
  const log = (line: string) => process.stdout.write(maskKeys(line) + '\n');
  const scope = options.scope ?? defaultScope(root);
  if (action === 'install') install(root, scope, options.privateRules ?? process.env[PRIVATE_RULES_ENV] ?? null, log);
  else if (action === 'uninstall') uninstall(root, scope, log);
  else if (action === 'status') return status(root, log) ? 0 : 1;
  else throw new ToolError(`hooks expects install, status or uninstall\n${USAGE}`);
  return 0;
}

// Entry points called by the hooks that `hooks install` declares.
function runHook(options: Options, cwd: string): number {
  const [, event, file] = options.rest;
  const root = repoRoot(cwd);
  const scanOptions = scanOptionsOf(options);
  let result: ScanResult;
  if (event === 'pre-commit') result = scans.scanStaged(root, scanOptions);
  else if (event === 'commit-msg' && file) result = scans.scanCommitMessageHook(root, path.resolve(cwd, file), scanOptions);
  else throw new ToolError(`hook expects pre-commit or commit-msg <file>`);
  process.stderr.write(formatReport({...result, command: `hook ${event}`}));
  if (result.findings.length > 0) process.stderr.write('leak-guard: commit refused; remove the leak (bypass only after review: --no-verify)\n');
  return exitCode(result);
}

function unexpectedDetail(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const frames = error instanceof Error ? (error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)) : [];
  return [`unexpected ${name} (message not printed: it may quote scanned content)`, ...frames].join('\n');
}

export function main(argv: string[], cwd: string = process.cwd()): number {
  try {
    const options = parseOptions(argv);
    if (options.rest[0] === 'hooks') return runHooks(options, cwd);
    if (options.rest[0] === 'hook') return runHook(options, cwd);
    const result = runScan(options, cwd);
    process.stdout.write(formatReport(result));
    return exitCode(result);
  } catch (error) {
    // Any failure is a tool error (2), never confused with findings (1). An unexpected error's message
    // can quote what was being read (JSON.parse does), so only its name and stack frames are printed.
    const detail = error instanceof ToolError ? error.message : unexpectedDetail(error);
    process.stderr.write(`leak-guard: ${maskKeys(detail)}\n`);
    return 2;
  }
}

// A closed output (`| head`) ends the tool with the status it computed, without a stack trace.
function endOnClosedOutput(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

if ((import.meta as {main?: boolean}).main) {
  endOnClosedOutput(process.stdout);
  endOnClosedOutput(process.stderr);
  process.exitCode = main(process.argv.slice(2));
}
