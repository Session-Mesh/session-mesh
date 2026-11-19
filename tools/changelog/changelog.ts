// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Changelog fragments of session-mesh (docs/changelog-fragments.md). Each pull request adds one
// file under changelog.d/ instead of editing CHANGELOG.md; the entries are assembled when a
// release is cut.
//
// Usage: node --experimental-strip-types tools/changelog/changelog.ts <command> [--root DIR]
//   check [FILE..]          validate every fragment of changelog.d/, or the named files
//   assemble [--entries-only]
//                           print the Unreleased section as it reads with the fragments merged in
//                           (its preamble, its bullets, then the fragments by kind and number);
//                           --entries-only prints the bullets alone
//   cut VERSION [--date YYYY-MM-DD] [--intro TEXT] [--only NAME..] [--dry-run]
//                           move the unreleased entries under "## VERSION" below the Unreleased
//                           section of CHANGELOG.md and delete the fragments it used; --only takes
//                           the named fragments alone (file names of changelog.d/, not paths; a
//                           version ends the list, so VERSION may also follow them) and leaves the
//                           bullets under Unreleased in place (a patch release cut on main);
//                           --dry-run prints the new CHANGELOG.md and changes nothing. If a
//                           fragment cannot be deleted once CHANGELOG.md is written, cut names it
//                           and exits 1: delete those files by hand, do not cut again.
//   check-pr --event FILE --changes FILE
//                           the changelog rule of a pull request (pr-check.ts): FILE of --event is
//                           a GitHub pull_request event, FILE of --changes the output of the
//                           merge-base diff (three dots, never two: a two-dot diff lists the
//                           fragments a later cut deleted on main as added by the pull request)
//                           git diff --name-status --no-renames "$BASE_SHA"..."$HEAD_SHA"
// --root is the repository root (default: the current directory).
// Exit status: 0 success, 1 refused (an invalid fragment, a pull request without a fragment, a
// version already in CHANGELOG.md, nothing to cut), 2 usage error or a file that cannot be read.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assemble, cut, VERSION, type CutOptions} from './changelog-file.ts';
import {FRAGMENT_DIR, parseFragment, readFragmentDir, compareFragments, type Fragment} from './fragments.ts';
import {judgePull, parseNameStatus} from './pr-check.ts';

class UsageError extends Error {}

type Io = {out: (text: string) => void; err: (text: string) => void};
type Args = {positional: string[]; flags: Map<string, string[]>};

const VALUE_FLAGS = new Set(['--root', '--date', '--intro', '--event', '--changes']);
const BOOLEAN_FLAGS = new Set(['--entries-only', '--dry-run']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let listFlag: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--only') { listFlag = arg; flags.set(arg, flags.get(arg) ?? []); continue; }
    // A version is never a fragment name: it ends the list of --only.
    if (listFlag !== null && VERSION.test(arg)) listFlag = null;
    if (VALUE_FLAGS.has(arg)) {
      if (index + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      if (flags.has(arg)) throw new UsageError(`${arg} is given twice`);
      flags.set(arg, [argv[index + 1]]);
      index += 1;
      listFlag = null;
    } else if (BOOLEAN_FLAGS.has(arg)) { flags.set(arg, []); listFlag = null; }
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (listFlag !== null) flags.get(listFlag)?.push(arg);
    else positional.push(arg);
  }
  return {positional, flags};
}

const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.[0];

function readFile(file: string): Buffer {
  try { return fs.readFileSync(file); }
  catch (error) { throw new UsageError(`cannot read ${file}: ${(error as Error).message}`); }
}

function loadFragments(root: string, io: Io): Fragment[] | null {
  const report = readFragmentDir(path.join(root, FRAGMENT_DIR));
  for (const problem of report.problems) io.err(`${problem}\n`);
  return report.problems.length > 0 ? null : report.fragments;
}

function commandCheck(root: string, args: Args, io: Io): number {
  if (args.positional.length === 0) {
    const fragments = loadFragments(root, io);
    if (fragments === null) return 1;
    io.out(`${fragments.length} changelog fragment(s), all valid\n`);
    return 0;
  }
  let problems = 0;
  for (const file of args.positional) {
    const parsed = parseFragment(path.basename(file), readFile(path.resolve(root, file)));
    for (const problem of parsed.problems) io.err(`${file}: ${problem}\n`);
    problems += parsed.problems.length;
  }
  if (problems === 0) io.out(`${args.positional.length} changelog fragment(s), all valid\n`);
  return problems === 0 ? 0 : 1;
}

function selectFragments(all: Fragment[], only: string[] | undefined): Fragment[] {
  if (only === undefined) return all;
  if (only.length === 0) throw new UsageError('--only needs at least one fragment');
  const paths = only.filter((name) => /[/\\]/.test(name));
  if (paths.length > 0) throw new UsageError(`--only takes file names of ${FRAGMENT_DIR}/, not paths: ${paths.join(', ')}`);
  const missing = only.filter((name) => !all.some((fragment) => fragment.name === name));
  if (missing.length > 0) throw new UsageError(`not a fragment of ${FRAGMENT_DIR}/: ${missing.join(', ')}`);
  return all.filter((fragment) => only.includes(fragment.name)).sort(compareFragments);
}

function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, text, {flag: 'wx'});
  fs.renameSync(temporary, file);
}

function commandCut(root: string, args: Args, io: Io): number {
  if (args.positional.length !== 1) throw new UsageError('cut takes one VERSION');
  const fragments = loadFragments(root, io);
  if (fragments === null) return 1;
  const only = args.flags.get('--only');
  const selected = selectFragments(fragments, only);
  const options: CutOptions = {version: args.positional[0], fragmentsOnly: only !== undefined};
  const date = flag(args, '--date');
  const intro = flag(args, '--intro');
  if (date !== undefined) options.date = date;
  if (intro !== undefined) options.intro = intro;
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const updated = cut(readFile(changelogPath).toString('utf8'), selected, options);
  if (args.flags.has('--dry-run')) { io.out(updated); return 0; }
  writeAtomically(changelogPath, updated);
  const remaining = deleteFragments(root, selected);
  if (remaining.files.length > 0) {
    io.err(`changelog: CHANGELOG.md now has "## ${options.version}", but ${remaining.files.length} fragment(s) it moved could not be deleted (${remaining.codes.join(', ')}): ${remaining.files.join(' ')}\n` +
      `Delete exactly these files by hand and nothing else: rm ${remaining.files.join(' ')}\n` +
      'Do not run cut again before that: their entries are already in CHANGELOG.md, and another cut would list them twice.\n');
    return 1;
  }
  io.err(`CHANGELOG.md: "## ${options.version}" with ${selected.length} fragment(s); the fragments are deleted\n`);
  return 0;
}

// Deletes the fragments a cut moved, every one it can; returns those left, as changelog.d/<name>.
function deleteFragments(root: string, fragments: Fragment[]): {files: string[]; codes: string[]} {
  const files: string[] = [];
  const codes = new Set<string>();
  for (const fragment of fragments) {
    try { fs.unlinkSync(path.join(root, FRAGMENT_DIR, fragment.name)); }
    catch (error) {
      files.push(`${FRAGMENT_DIR}/${fragment.name}`);
      codes.add((error as NodeJS.ErrnoException).code ?? 'error');
    }
  }
  return {files, codes: [...codes]};
}

function commandCheckPr(args: Args, io: Io): number {
  const eventFile = flag(args, '--event');
  const changesFile = flag(args, '--changes');
  if (eventFile === undefined || changesFile === undefined) throw new UsageError('check-pr needs --event and --changes');
  let pull: {base?: {ref?: unknown}; labels?: unknown; body?: unknown};
  try { pull = (JSON.parse(readFile(eventFile).toString('utf8')) as {pull_request?: typeof pull}).pull_request ?? {}; }
  catch (error) { throw new UsageError(`cannot parse ${eventFile}: ${(error as Error).message}`); }
  if (typeof pull.base?.ref !== 'string') throw new UsageError(`${eventFile} has no pull_request.base.ref`);
  const labels = Array.isArray(pull.labels) ? pull.labels.flatMap((label: {name?: unknown}) => (typeof label?.name === 'string' ? [label.name] : [])) : [];
  let changes;
  try { changes = parseNameStatus(readFile(changesFile).toString('utf8')); }
  catch (error) { throw new UsageError((error as Error).message); }
  const verdict = judgePull({baseRef: pull.base.ref, labels, body: typeof pull.body === 'string' ? pull.body : '', changes});
  (verdict.ok ? io.out : io.err)(`${verdict.ok ? 'accepted' : 'refused'}: ${verdict.reason}\n`);
  return verdict.ok ? 0 : 1;
}

export function run(argv: string[], io: Io): number {
  try {
    const [command, ...rest] = argv;
    const args = parseArgs(rest);
    const root = path.resolve(flag(args, '--root') ?? '.');
    if (command === 'check') return commandCheck(root, args, io);
    if (command === 'assemble') {
      if (args.positional.length > 0) throw new UsageError('assemble takes no argument');
      const fragments = loadFragments(root, io);
      if (fragments === null) return 1;
      io.out(assemble(readFile(path.join(root, 'CHANGELOG.md')).toString('utf8'), fragments, args.flags.has('--entries-only')));
      return 0;
    }
    if (command === 'cut') return commandCut(root, args, io);
    if (command === 'check-pr') return commandCheckPr(args, io);
    throw new UsageError('usage: changelog.ts check|assemble|cut|check-pr (see the header of tools/changelog/changelog.ts)');
  } catch (error) {
    io.err(`changelog: ${(error as Error).message}\n`);
    // A refusal of the content (a version already cut, nothing to cut) is 1, a usage error 2.
    return error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2), {out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text)});
}
