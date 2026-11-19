// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// CLA check of a pull request integrated by "Rebase and merge", judged on what would land on the
// base branch. The specification is tools/cla-check/SPEC.md; in short:
// 0. History: base..head is a straight line of ordinary commits (no merge commit, no commit
//    without parent). A rebase drops merge commits, so only then is what lands what is judged
//    here. The base is an ancestor of the head (exit 2 when the test merge tree differs from the
//    head tree), or no commit of the range changes the register (exit 2 when the test merge's
//    register differs from the base's): the register that lands is then the base's.
// 1. Identities: every commit of base..head has an author address, and a committer address, that
//    is a maintainer's or has a line in CLA-SIGNATORIES.md as the test merge commit holds it.
//    GitHub's own committer identity (web edits) is accepted as committer only.
// 2. Integrity of the register: a line the pull request removes from the base was removed by a
//    commit of its holder or of a maintainer; a line it adds was added by a commit authored with
//    the line's address (or is a maintainer's correction that keeps the address).
//
// Usage: node --experimental-strip-types tools/cla-check/cla-check.ts --base SHA --head SHA --merge SHA [--repo DIR]
// Exit status: 0 accepted, 1 refused, 2 usage or git error (including an unreadable commit header,
// or a test merge tree different from the head's).
//
// Everything read from the repository (names, addresses, file contents) is data: it is parsed with
// fixed patterns, never evaluated, and only addresses and commit ids are printed. Git runs without a
// shell and with full object ids only. Self-contained (Node built-ins only), so that CI can run the
// copy from the base branch rather than the one a pull request may have edited.
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const CLA_VERSIONS: ReadonlySet<string> = new Set(['1.0']);
export const REGISTER = 'CLA-SIGNATORIES.md';
export const MAINTAINERS_FILE = 'tools/cla-check/MAINTAINERS';
const WEB_COMMITTER = {name: 'GitHub', email: 'noreply@github.com'};
const CLA_URL = 'https://github.com/Session-Mesh/session-mesh/blob/main/CLA.md';
const CONTRIBUTING_URL = 'https://github.com/Session-Mesh/session-mesh/blob/main/CONTRIBUTING.md#contributor-license-agreement';
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Printable ASCII without space: no space of any width, no look-alike letter, none that
// lower-cases to an ASCII one (the Kelvin sign gives `k`).
const ADDRESS = /^(?=[\x21-\x7e]+$)[^@<>`|]+@[^@<>`|]+$/;
const MAX_BUFFER = 1 << 28;
const USAGE = 'usage: cla-check.ts --base SHA --head SHA --merge SHA [--repo DIR]';

export class CheckError extends Error {}

type Identity = {name: string; email: string};
type Commit = {id: string; parents: string[]; author: Identity; committer: Identity};
export type Offender = {email: string; roles: ('author' | 'committer')[]};
// A difference between the base's register and the merge result's that no commit may answer for.
// `by` lists the commits of the pull request that make the change, none when no commit does.
export type Violation = {email: string; change: 'added' | 'removed'; by: {commit: string; author: string}[]};
// Why the pull request is not a straight line on top of the base: a commit with more than one
// parent, a commit without parent, or a head that does not contain the base (`commit` is the head).
export type HistoryProblem = {commit: string; problem: 'merge' | 'root' | 'behind'};
export type Result = {history: HistoryProblem[]; offenders: Offender[]; violations: Violation[]};

// Lower case for ASCII letters only: no other character may fold into an ASCII address.
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
      env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}}).toString('utf8');
  } catch {
    throw new CheckError(`git ${args[0]} failed`);
  }
}

// One identity field, from the raw header line: no format string, no mailmap. A name holding `<`
// or `>` would give the header two readings (tools disagree on which address is the real one), so
// it is refused rather than interpreted.
function readIdentity(id: string, role: string, line: string): Identity {
  const match = /^\S+ (.*?) ?<([^<>]*)> \d+ [+-]\d{4}$/.exec(line);
  if (!match) throw new CheckError(`commit ${id} has no readable ${role}`);
  if (/[<>]/.test(match[1])) throw new CheckError(`commit ${id} has a ${role} header with more than one address`);
  return {name: match[1], email: lowerAscii(match[2].trim())};
}

// The header in the order Git reads it: tree, the parents, author, committer. A `parent` line
// anywhere else is not a parent for Git and is not one here; a second `author` or `committer` line
// anywhere in the header is refused, since readers disagree on which one counts.
function readCommit(repo: string, id: string): Commit {
  const header = git(repo, ['cat-file', 'commit', id]).split('\n\n', 1)[0].split('\n');
  const unreadable = new CheckError(`commit ${id} has an unreadable header`);
  if (!/^tree [0-9a-f]+$/.test(header[0] ?? '')) throw unreadable;
  let index = 1;
  const parents: string[] = [];
  for (; header[index]?.startsWith('parent '); index++) {
    const parent = header[index].slice('parent '.length);
    if (!OBJECT_ID.test(parent)) throw unreadable;
    parents.push(parent);
  }
  const [authorLine, committerLine] = [header[index] ?? '', header[index + 1] ?? ''];
  if (!authorLine.startsWith('author ') || !committerLine.startsWith('committer ')) throw unreadable;
  for (const role of ['author', 'committer']) {
    if (header.filter((line) => line.startsWith(`${role} `)).length !== 1) {
      throw new CheckError(`commit ${id} has more than one ${role} line`);
    }
  }
  return {id, parents, author: readIdentity(id, 'author', authorLine), committer: readIdentity(id, 'committer', committerLine)};
}

// A file at a commit: only a regular file counts (not a symlink, not a directory).
function fileAt(repo: string, commit: string, file: string): string | null {
  const entry = git(repo, ['ls-tree', '-z', commit, '--', file]).split('\0')[0];
  const match = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry ?? '');
  return match ? git(repo, ['cat-file', 'blob', match[2]]) : null;
}

// Maintainer addresses, one `Name <address>` per line; `#` starts a comment line.
export function parseMaintainers(text: string): Set<string> {
  const addresses = new Set<string>();
  for (const line of text.split('\n').map((item) => item.trim())) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^[^<>]+ <([^<>\s]+)>$/.exec(line);
    if (!match || !ADDRESS.test(match[1])) throw new CheckError(`${MAINTAINERS_FILE} has an unreadable line`);
    addresses.add(lowerAscii(match[1]));
  }
  if (addresses.size === 0) throw new CheckError(`${MAINTAINERS_FILE} names no maintainer`);
  return addresses;
}

function maintainersAt(repo: string, commit: string): Set<string> {
  const text = fileAt(repo, commit, MAINTAINERS_FILE);
  if (text === null) throw new CheckError(`${MAINTAINERS_FILE} is missing from the base`);
  return parseMaintainers(text);
}

function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export type Row = {key: string; email: string};

// One signatory line: | Public name | Commit e-mail | CLA version | YYYY-MM-DD |, from the first
// column (an indented line is a code block for Markdown). Keyed by its normalised cells, so a line
// changed by someone else is a different row. tools/leak-guard reads the same definition.
export function parseRow(line: string): Row | null {
  const cells = /^\|(.*)\|\s*$/.exec(line)?.[1].split('|').map((cell) => cell.trim());
  if (!cells || cells.length !== 4) return null;
  const [name, rawEmail, version, date] = cells;
  const email = lowerAscii(rawEmail.replace(/^`(.*)`$/, '$1').trim());
  if (name === '' || !ADDRESS.test(email) || !CLA_VERSIONS.has(version) || !isCalendarDate(date)) return null;
  return {key: [name, email, version, date].join('|'), email};
}

// Positions (0-based) of the register lines that can be rows. Lines inside fenced code blocks (the
// example of the file's header) and inside HTML comments are not rows, nor is a line that opens or
// closes a comment: a line the rendered page does not show as a table row is not a signature.
// tools/leak-guard reads the same definition.
export function rowCandidates(lines: readonly string[]): number[] {
  const positions: number[] = [];
  let fence: string | null = null;
  let commented = false;
  lines.forEach((line, position) => {
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    const comment = commented || line.includes('<!--');
    if (comment) {
      commented = line.lastIndexOf('<!--') > line.lastIndexOf('-->') || (commented && !line.includes('-->'));
      return;
    }
    const opener = /^\s*(```|~~~)/.exec(line);
    if (opener) {
      fence = opener[1];
      return;
    }
    positions.push(position);
  });
  return positions;
}

// Valid rows of the register (see rowCandidates and parseRow).
export function parseRegister(text: string): Row[] {
  const lines = text.split('\n');
  return rowCandidates(lines).flatMap((position) => parseRow(lines[position] ?? '') ?? []);
}

function rowsAt(repo: string, commit: string): Map<string, Row> {
  return new Map(parseRegister(fileAt(repo, commit, REGISTER) ?? '').map((row) => [row.key, row]));
}

type Change = {commit: string; author: string; added: Map<string, Row>; removed: Map<string, Row>};

// What each commit of the range does to the register, against its only parent (rule 0 has refused
// any other shape before this runs).
function registerChanges(repo: string, commits: Commit[]): Change[] {
  const difference = (from: Map<string, Row>, without: Map<string, Row>): Map<string, Row> =>
    new Map([...from].filter(([key]) => !without.has(key)));
  return commits.map((commit) => {
    const after = rowsAt(repo, commit.id);
    const before = rowsAt(repo, commit.parents[0]);
    return {commit: commit.id, author: commit.author.email, added: difference(after, before), removed: difference(before, after)};
  });
}

function mayAdd(change: Change, row: Row, maintainers: Set<string>): boolean {
  if (change.author === row.email) return true;
  const corrected = [...change.removed.values()].some((removed) => removed.email === row.email);
  return maintainers.has(change.author) && corrected;
}

// Rows the merge adds to, or removes from, the base's register without a commit that may do so.
function registerViolations(base: Map<string, Row>, merged: Map<string, Row>, changes: Change[],
  maintainers: Set<string>): Violation[] {
  const violations: Violation[] = [];
  const by = (made: Change[]) => made.map((change) => ({commit: change.commit, author: change.author}));
  for (const [key, row] of merged) {
    if (base.has(key)) continue;
    const adding = changes.filter((change) => change.added.has(key));
    if (!adding.some((change) => mayAdd(change, row, maintainers))) violations.push({email: row.email, change: 'added', by: by(adding)});
  }
  for (const [key, row] of base) {
    if (merged.has(key)) continue;
    const removing = changes.filter((change) => change.removed.has(key));
    if (!removing.some((change) => change.author === row.email || maintainers.has(change.author))) {
      violations.push({email: row.email, change: 'removed', by: by(removing)});
    }
  }
  return violations;
}

function addressesToCheck(commit: Commit): [string, 'author' | 'committer'][] {
  const {committer} = commit;
  const web = committer.name === WEB_COMMITTER.name && committer.email === WEB_COMMITTER.email;
  return web ? [[commit.author.email, 'author']] : [[commit.author.email, 'author'], [committer.email, 'committer']];
}

function identityOffenders(commits: Commit[], accepted: Set<string>): Offender[] {
  const offenders = new Map<string, Offender>();
  for (const commit of commits) {
    for (const [email, role] of addressesToCheck(commit)) {
      if (accepted.has(email)) continue;
      const offender = offenders.get(email) ?? {email, roles: []};
      if (!offender.roles.includes(role)) offender.roles.push(role);
      offenders.set(email, offender);
    }
  }
  return [...offenders.values()];
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant],
      {stdio: 'ignore', env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}});
    return true;
  } catch (error) {
    if ((error as {status?: number}).status === 1) return false;
    throw new CheckError('git merge-base failed');
  }
}

// The register's entry at a commit as the tree records it (mode, type and object id), '' when absent.
function registerEntry(repo: string, commit: string): string {
  return git(repo, ['ls-tree', '-z', commit, '--', REGISTER]).split('\0')[0].split('\t')[0];
}

// Rule 0: the commits "Rebase and merge" would replay are the whole pull request. A merge commit is
// dropped by the rebase while its content counts in the test merge. A branch behind the base is
// replayed commit by commit, which can land another register than the test merge holds (SPEC.md):
// it is accepted only when none of its commits changes the register.
function historyProblems(repo: string, head: string, commits: Commit[], upToDate: boolean): HistoryProblem[] {
  const problems: HistoryProblem[] = commits.filter((commit) => commit.parents.length !== 1)
    .map((commit) => ({commit: commit.id, problem: commit.parents.length === 0 ? 'root' : 'merge'}));
  if (problems.length > 0 || upToDate) return problems;
  const leavesRegister = (commit: Commit) => registerEntry(repo, commit.id) === registerEntry(repo, commit.parents[0]);
  if (commits.length > 0 && commits.every(leavesRegister)) return problems;
  return [{commit: head, problem: 'behind'}];
}

function treeOf(repo: string, commit: string): string {
  return git(repo, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
}

// What the test merge holds is what the rest of the check relies on: the head's tree for a branch on
// the tip of the base, the base's register for a branch behind it that leaves the register alone.
function verifyTestMerge(repo: string, base: string, head: string, merge: string, upToDate: boolean): void {
  if (upToDate && treeOf(repo, merge) !== treeOf(repo, head)) {
    throw new CheckError('the merge commit does not hold the tree of the head');
  }
  if (!upToDate && registerEntry(repo, merge) !== registerEntry(repo, base)) {
    throw new CheckError('the merge commit does not hold the register of the base');
  }
}

// `merge` is the test merge commit of the pull request: its parents are the base, then the head.
export function checkPullRequest(repo: string, base: string, head: string, merge: string): Result {
  for (const id of [base, head, merge]) {
    if (!OBJECT_ID.test(id)) throw new CheckError('base, head and merge must be full object ids');
  }
  const parents = readCommit(repo, merge).parents;
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    throw new CheckError('the merge commit must have the base and the head as its two parents, in that order');
  }
  const maintainers = maintainersAt(repo, base);
  const ids = git(repo, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  const commits = ids.map((id) => readCommit(repo, id));
  const upToDate = isAncestor(repo, base, head);
  const history = historyProblems(repo, head, commits, upToDate);
  if (history.length > 0) return {history, offenders: [], violations: []};
  verifyTestMerge(repo, base, head, merge, upToDate);
  const merged = rowsAt(repo, merge);
  const violations = registerViolations(rowsAt(repo, base), merged, registerChanges(repo, commits), maintainers);
  const accepted = new Set([...maintainers, ...[...merged.values()].map((row) => row.email)]);
  return {history, offenders: identityOffenders(commits, accepted), violations};
}

// Printable form of an address taken from a commit: no control character, bounded length.
function shown(email: string): string {
  const clean = email.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean;
}

function describeViolation(violation: Violation): string {
  const what = violation.change === 'added'
    ? `the merge adds a line for ${shown(violation.email)}`
    : `the merge removes or changes the line of ${shown(violation.email)}`;
  const verb = violation.change === 'added' ? 'added' : 'removed';
  const by = violation.by.map((item) => `commit ${item.commit.slice(0, 12)} (author ${shown(item.author)})`).join(', ');
  return `  - ${what}, ${by === '' ? `${verb} by no commit of the pull request` : `${verb} by ${by}`}`;
}

function violationReport(violations: Violation[]): string[] {
  if (violations.length === 0) return [];
  return [
    `CLA check failed. Merging this pull request would change ${REGISTER} in a way no commit of it may:`,
    ...violations.map(describeViolation),
    '',
    'A line can only be added by a commit authored with the address it gives: each contributor adds',
    'their own. A line can only be removed or changed by a commit of its holder, or of a maintainer;',
    'a maintainer\'s correction keeps the line\'s address. If a rebase on main brought back or dropped',
    'a line, leave the other lines as they are on main. The agreement is',
    `${CLA_URL}; the procedure is ${CONTRIBUTING_URL}`,
    '',
  ];
}

function offenderReport(offenders: Offender[]): string[] {
  if (offenders.length === 0) return [];
  return [
    'CLA check failed. These commit addresses are neither a maintainer\'s nor recorded in',
    `${REGISTER} as the merge of this pull request would leave it:`,
    ...offenders.map((offender) => `  - ${shown(offender.email)} (${offender.roles.join(', ')})`),
    '',
    `To fix it, read the Contributor License Agreement (${CLA_URL}), then add your line to`,
    `${REGISTER} in a commit whose author address is the listed one; it can be the commit of`,
    `your contribution. A different committer address must be signed the same way. See ${CONTRIBUTING_URL}`,
    '',
  ];
}

const HISTORY_TEXT: Record<HistoryProblem['problem'], {headline: string; item: string}> = {
  merge: {headline: 'rebase your branch on main; merge commits are not allowed in a pull request',
    item: 'is a merge commit'},
  root: {headline: 'commits without a parent are not allowed in a pull request', item: 'has no parent'},
  behind: {headline: `the pull request changes ${REGISTER} (or has no commit of its own) and its branch is not up to date with main: update it by rebasing it on main`,
    item: 'does not contain the tip of main'},
};

function historyReport(history: HistoryProblem[]): string[] {
  const kinds = [...new Set(history.map((item) => item.problem))];
  return kinds.flatMap((kind) => [
    `CLA check failed: ${HISTORY_TEXT[kind].headline}.`,
    ...history.filter((item) => item.problem === kind)
      .map((item) => `  - commit ${item.commit.slice(0, 12)} ${HISTORY_TEXT[kind].item}`),
    '',
    'Pull requests are integrated with "Rebase and merge", which replays ordinary commits and drops',
    'merge commits: the check judges only a straight line of commits, on top of main when it',
    `changes ${REGISTER}. Run`,
    '`git rebase main` (or use "Update with rebase" on the pull request), then push with',
    `--force-with-lease. The agreement is ${CLA_URL}; the procedure is ${CONTRIBUTING_URL}`,
    '',
  ]);
}

export function report(result: Result): string {
  const lines = [...historyReport(result.history), ...violationReport(result.violations), ...offenderReport(result.offenders)];
  if (lines.length === 0) return 'CLA check passed: every commit is by a maintainer or a CLA signatory.\n';
  return lines.join('\n');
}

function parseArgs(argv: string[]): {repo: string; base: string; head: string; merge: string} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!['--repo', '--base', '--head', '--merge'].includes(flag) || value === undefined) throw new CheckError(USAGE);
    values.set(flag, value);
  }
  const [base, head, merge] = ['--base', '--head', '--merge'].map((flag) => values.get(flag));
  if (!base || !head || !merge) throw new CheckError(USAGE);
  return {repo: values.get('--repo') ?? '.', base, head, merge};
}

function main(argv: string[]): number {
  try {
    const {repo, base, head, merge} = parseArgs(argv);
    const result = checkPullRequest(repo, base, head, merge);
    process.stdout.write(report(result));
    return result.history.length === 0 && result.offenders.length === 0 && result.violations.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    process.stderr.write(`cla-check: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
