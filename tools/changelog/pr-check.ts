// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The changelog rule of a pull request to main (CONTRIBUTING.md, "Changelog"): it adds or changes a
// changelog fragment under changelog.d/, or its description holds a line
// "Changelog: none: <reason>" (tests, CI, internal documentation, a release cut). The fragments it
// adds are validated by `check`, separately. A pull request to another base is not judged here
// (a backport carries the fragment of the pull request it backports).
import {FRAGMENT_DIR, NON_FRAGMENTS} from './fragments.ts';

export const MAIN_BRANCH = 'main';
export const SEMVER_LABELS = ['semver: patch', 'semver: minor'];
// "Changelog: none: tests only" or "Changelog: none (CI only)", at the start of a line: the reason
// after the separator is at least two words.
const OPT_OUT_LINE = /^Changelog: none\b(.*)$/gm;

export function hasOptOut(body: string): boolean {
  for (const match of body.replace(/\r/g, '').matchAll(OPT_OUT_LINE)) {
    const reason = match[1].replace(/^[ \t]*[:(—-]?[ \t]*/, '').replace(/[ \t)]*$/, '');
    if (/^[^\s:(—-]\S*[ \t]+\S/.test(reason)) return true;
  }
  return false;
}

export type Change = {status: string; path: string};
export type PullFacts = {baseRef: string; labels: string[]; body: string; changes: Change[]};
export type Verdict = {ok: boolean; reason: string};

// `git diff --name-status --no-renames <base> <head>` output: "<status>\t<path>" per line.
export function parseNameStatus(text: string): Change[] {
  return text.split('\n').filter((line) => line !== '').map((line) => {
    const match = /^([ACDMRTUX][0-9]*)\t(.+)$/.exec(line);
    if (!match) throw new Error(`not a --name-status line: ${JSON.stringify(line.slice(0, 80))}`);
    return {status: match[1][0], path: match[2]};
  });
}

export const isFragmentPath = (filePath: string): boolean => {
  const parts = filePath.split('/');
  return parts.length === 2 && parts[0] === FRAGMENT_DIR && parts[1].endsWith('.md') && !NON_FRAGMENTS.includes(parts[1]);
};

export function judgePull(pull: PullFacts): Verdict {
  if (pull.baseRef !== MAIN_BRANCH) return {ok: true, reason: `base ${pull.baseRef} is not ${MAIN_BRANCH}: not judged`};
  if (!pull.labels.some((label) => SEMVER_LABELS.includes(label))) {
    return {ok: true, reason: 'no semver label: not judged here (the "semver label" check refuses it)'};
  }
  const fragments = pull.changes.filter((change) => (change.status === 'A' || change.status === 'M') && isFragmentPath(change.path));
  if (fragments.length > 0) return {ok: true, reason: `changelog fragment: ${fragments.map((change) => change.path).join(', ')}`};
  if (hasOptOut(pull.body)) return {ok: true, reason: 'the description says "Changelog: none" with a reason'};
  return {
    ok: false,
    reason: `no changelog fragment: add one file ${FRAGMENT_DIR}/<number>-<slug>.md (see ${FRAGMENT_DIR}/README.md), ` +
      'or, for a change no user sees, a line "Changelog: none: <reason>" in the description',
  };
}
