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
// after the separator is at least two words, and not the template's placeholder "<reason>".
const OPT_OUT_LINE = /^Changelog: none\b(.*)$/;

// The lines of a description that GitHub renders as text: fenced code blocks (``` or ~~~, closed
// or not) and HTML comment blocks (a line that starts with "<!--", up to the line holding "-->",
// closed or not) are dropped, so an example of the opt-out line does not count as one. A "<!--"
// inside a code span or a fence opens nothing, as in CommonMark.
function renderedLines(body: string): string[] {
  const kept: string[] = [];
  let block: {fence: string} | {comment: true} | null = null;
  for (const line of body.replace(/\r/g, '').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (block === null) {
      if (marker !== undefined) block = {fence: marker};
      else if (/^ {0,3}<!--/.test(line)) block = line.includes('-->', line.indexOf('<!--') + 4) ? null : {comment: true};
      else kept.push(line);
    } else if ('comment' in block) {
      if (line.includes('-->')) block = null;
    } else if (marker !== undefined && marker[0] === block.fence[0] && marker.length >= block.fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
      block = null;
    }
  }
  return kept;
}

export function hasOptOut(body: string): boolean {
  for (const line of renderedLines(body)) {
    const match = OPT_OUT_LINE.exec(line);
    if (!match) continue;
    const reason = match[1].replace(/^[ \t]*[:(—-]?[ \t]*/, '').replace(/[ \t)]*$/, '');
    if (/<[^>]*>/.test(reason)) continue;
    if (/^[^\s:(—-]\S*[ \t]+\S/.test(reason)) return true;
  }
  return false;
}

export type Change = {status: string; path: string};
export type PullFacts = {baseRef: string; labels: string[]; body: string; changes: Change[]};
export type Verdict = {ok: boolean; reason: string};

// The output of the merge-base diff, "<status>\t<path>" per line:
// git diff --name-status --no-renames "$BASE_SHA"..."$HEAD_SHA"
// (three dots: a two-dot diff lists the fragments a later cut deleted on main as added here).
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
