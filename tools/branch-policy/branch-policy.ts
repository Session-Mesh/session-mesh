// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Branch policy of pull requests, run by .github/workflows/branch-policy.yml (CONTRIBUTING.md,
// "Branches and versions"):
//
//   semver-label   A pull request to main carries exactly one of the labels `semver: patch` and
//                  `semver: minor`. Any other base branch is not judged by this command.
//   release-guard  A pull request whose base branch is release/** is a backport: it carries the
//                  label `semver: patch`, and its description says "Backport of #<number>" for each
//                  pull request it backports, every one merged to main with the label `semver: patch`.
//                  A backport that changes only the CLA register files (REGISTER_FILES) may also
//                  reference a merged pull request without that label that changed one of them.
//                  Any other base branch is not judged by this command.
//
// Usage: node --experimental-strip-types tools/branch-policy/branch-policy.ts semver-label|release-guard
// The pull request is read from the event file (GITHUB_EVENT_PATH), never from an expression of the
// workflow. The referenced pull requests and the lists of files are read through the GitHub API with
// GITHUB_TOKEN, which the workflow gives read access only (GITHUB_REPOSITORY names the repository).
// Exit status: 0 accepted, 1 refused, 2 usage error or an API or event file that cannot be read.
//
// Everything read from the event (labels, description, branch names) is data: it is matched with
// fixed patterns and never evaluated, and only constants and pull request numbers are printed.
// Self-contained (Node built-ins only).
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const PATCH_LABEL = 'semver: patch';
export const MINOR_LABEL = 'semver: minor';
export const MAIN_BRANCH = 'main';
export const RELEASE_PREFIX = 'release/';
// "Backport of #12": the line the backport workflow writes, which a manual backport repeats.
export const BACKPORT_REFERENCE = /\bBackport of #([0-9]+)\b/g;
// A description naming more pull requests than this is refused rather than looked up one by one.
export const MAX_REFERENCES = 5;
// The files the `cla` check reads on the base branch (.github/workflows/backport-register.yml): a
// backport of these alone follows main whatever the label of the pull request that changed them.
export const REGISTER_FILES = ['CONTRIBUTORS.md', 'CLA.md', 'CLA-SIGNATORIES.md', 'tools/cla-check/MAINTAINERS', '.github/CODEOWNERS'];
// GitHub lists at most 3000 files of a pull request, 100 per page.
const MAX_FILE_PAGES = 30;

export type PullRequestFacts = {baseRef: string; labels: string[]; body: string; number?: number};
export type SourcePull = {merged: boolean; baseRef: string; labels: string[]};
// The pull request of this repository with that number, or null when there is none.
export type LookupPull = (number: number) => Promise<SourcePull | null>;
// The paths a pull request changes, a renamed file under both names.
export type LookupFiles = (number: number) => Promise<string[]>;

export function semverLabelProblems(pull: PullRequestFacts): string[] {
  if (pull.baseRef !== MAIN_BRANCH) return [];
  const present = [PATCH_LABEL, MINOR_LABEL].filter((label) => pull.labels.includes(label));
  const rule = `a pull request to main must carry exactly one of the labels "${PATCH_LABEL}" (a fix, backported to the ` +
    `maintenance branch) and "${MINOR_LABEL}" (everything else)`;
  if (present.length === 1) return [];
  return [present.length === 0 ? `${rule}; it carries neither` : `${rule}; it carries both`];
}

export const isRegisterFile = (file: string): boolean => REGISTER_FILES.includes(file);

// A source without `semver: patch` is accepted only for a backport that changes the register files
// and nothing else, from a source that changed one of them.
async function sourceProblems(number: number, source: SourcePull | null, registerOnly: () => Promise<boolean>,
  sourceFiles: () => Promise<string[]>): Promise<string[]> {
  if (source === null) return [`#${number} is not a pull request of this repository`];
  if (!source.merged) return [`#${number} is not merged`];
  if (source.baseRef !== MAIN_BRANCH) return [`#${number} was not merged to ${MAIN_BRANCH}`];
  if (source.labels.includes(PATCH_LABEL)) return [];
  if (await registerOnly() && (await sourceFiles()).some(isRegisterFile)) return [];
  return [`#${number} does not carry the label "${PATCH_LABEL}"`];
}

// The files of the pull request itself are looked up only when a source lacks `semver: patch`.
// Without its number (an event file without one) or without a files lookup, it is not register-only.
export async function releaseGuardProblems(pull: PullRequestFacts, lookup: LookupPull,
  lookupFiles: LookupFiles = async () => []): Promise<string[]> {
  if (!pull.baseRef.startsWith(RELEASE_PREFIX)) return [];
  const problems: string[] = [];
  if (!pull.labels.includes(PATCH_LABEL)) {
    problems.push(`a pull request to a release branch is a backport and must carry the label "${PATCH_LABEL}"`);
  }
  const numbers = [...new Set([...pull.body.matchAll(BACKPORT_REFERENCE)].map((match) => Number(match[1])))];
  if (numbers.length === 0) {
    problems.push('the description must say "Backport of #<number>" for the pull request to main it backports');
  } else if (numbers.length > MAX_REFERENCES) {
    problems.push(`the description references ${numbers.length} pull requests, more than the ${MAX_REFERENCES} a backport may name`);
  } else {
    let registerOnly: Promise<boolean> | undefined;
    const isRegisterOnly = (): Promise<boolean> => registerOnly ??= pull.number === undefined ? Promise.resolve(false)
      : lookupFiles(pull.number).then((files) => files.length > 0 && files.every(isRegisterFile));
    for (const number of numbers) {
      problems.push(...await sourceProblems(number, await lookup(number), isRegisterOnly, () => lookupFiles(number)));
    }
  }
  return problems;
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
}

// The facts of the pull request in an event file, or null when it is not a pull request event.
export function factsFromEvent(event: unknown): PullRequestFacts | null {
  const pull = object(object(event)?.pull_request);
  const baseRef = object(pull?.base)?.ref;
  const labels = pull?.labels;
  if (!pull || typeof baseRef !== 'string' || !Array.isArray(labels)) return null;
  const names = labels.map((label) => object(label)?.name);
  if (!names.every((name): name is string => typeof name === 'string')) return null;
  const facts: PullRequestFacts = {baseRef, labels: names, body: typeof pull.body === 'string' ? pull.body : ''};
  if (Number.isSafeInteger(pull.number) && (pull.number as number) > 0) facts.number = pull.number as number;
  return facts;
}

const API_HEADERS = (token: string) => ({Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28'});

// Every page of the list, or an error: a partial list could call a pull request register-only.
export function githubFilesLookup(apiUrl: string, repository: string, token: string, fetchImpl: typeof fetch = fetch): LookupFiles {
  return async (number) => {
    const files: string[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const response = await fetchImpl(`${apiUrl}/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`, {headers: API_HEADERS(token)});
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for the files of pull request #${number}`);
      const entries: unknown = await response.json();
      if (!Array.isArray(entries)) throw new Error(`unexpected answer of GitHub for the files of pull request #${number}`);
      for (const entry of entries.map(object)) {
        if (typeof entry?.filename !== 'string') throw new Error(`unexpected answer of GitHub for the files of pull request #${number}`);
        files.push(entry.filename);
        if (typeof entry.previous_filename === 'string') files.push(entry.previous_filename);
      }
      if (entries.length < 100) return files;
    }
    throw new Error(`pull request #${number} changes more files than GitHub lists`);
  };
}

export function githubLookup(apiUrl: string, repository: string, token: string, fetchImpl: typeof fetch = fetch): LookupPull {
  return async (number) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/pulls/${number}`, {headers: API_HEADERS(token)});
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for pull request #${number}`);
    const body = object(await response.json());
    const labels = Array.isArray(body?.labels) ? body.labels.map((label) => object(label)?.name) : [];
    if (typeof body?.merged !== 'boolean' || typeof object(body.base)?.ref !== 'string' || !labels.every((name) => typeof name === 'string')) {
      throw new Error(`unexpected answer of GitHub for pull request #${number}`);
    }
    return {merged: body.merged, baseRef: object(body.base)?.ref as string, labels: labels as string[]};
  };
}

const USAGE = 'usage: branch-policy.ts semver-label|release-guard';
const DEFAULT_API_URL = 'https://api.github.com';
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

function report(command: string, problems: string[]): number {
  for (const problem of problems) console.log(`::error title=${command}::${problem}`);
  if (problems.length === 0) console.log(`${command}: ok`);
  return problems.length === 0 ? 0 : 1;
}

export async function run(argv: string[], env: NodeJS.ProcessEnv, lookup?: LookupPull, lookupFiles?: LookupFiles): Promise<number> {
  const [command, ...rest] = argv;
  if ((command !== 'semver-label' && command !== 'release-guard') || rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  let facts: PullRequestFacts | null = null;
  try {
    facts = factsFromEvent(JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')));
  } catch {
    // Reported below with the other unreadable-event case.
  }
  if (facts === null) {
    console.error(`${command}: GITHUB_EVENT_PATH is not the event file of a pull request`);
    return 2;
  }
  if (command === 'semver-label') return report(command, semverLabelProblems(facts));
  if (!facts.baseRef.startsWith(RELEASE_PREFIX)) return report(command, []);
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (lookup === undefined && (!REPOSITORY.test(repository) || !env.GITHUB_TOKEN)) {
    console.error(`${command}: GITHUB_REPOSITORY and GITHUB_TOKEN are required`);
    return 2;
  }
  const apiUrl = env.GITHUB_API_URL ?? DEFAULT_API_URL;
  const token = env.GITHUB_TOKEN ?? '';
  try {
    return report(command, await releaseGuardProblems(facts, lookup ?? githubLookup(apiUrl, repository, token),
      lookupFiles ?? githubFilesLookup(apiUrl, repository, token)));
  } catch (error) {
    console.error(`${command}: ${error instanceof Error ? error.message : 'cannot read the referenced pull requests'}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
