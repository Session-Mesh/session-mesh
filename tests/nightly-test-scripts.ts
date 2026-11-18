// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared helpers of the nightly workflow tests (tests/nightly-workflow*.test.ts): the committed
// nightly.yml and release.yml, the extraction of a step script as the runner sees it, and a harness
// that runs such a script with a recording gh in place of the real one.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before} from 'node:test';
import {parseLines, scriptOf} from './public-ci-workflow-lib.ts';

const WORKFLOWS = path.join(import.meta.dirname, '..', '.github', 'workflows');
export const text = fs.readFileSync(path.join(WORKFLOWS, 'nightly.yml'), 'utf8');
export const release = fs.readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8');

// The script of the step whose block holds a line matching the pattern, as the runner sees it.
export function stepScript(source: string, pattern: RegExp): string {
  const lines = parseLines(source);
  const index = lines.findIndex((line) => line.inBlock && pattern.test(line.raw));
  assert.ok(index >= 0, `no step script matches ${pattern}`);
  const block = scriptOf(lines, index).split('\n');
  const indent = Math.min(...block.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length));
  return block.map((line) => line.slice(indent)).join('\n') + '\n';
}

export interface Release {tag: string; id: number; draft?: boolean; prerelease?: boolean}
// tagRef, tagObject and compare describe an orphan tag for the decision job: the ref (object type and
// sha; null = unreadable), the tag object (tagger name, target type, target sha, tag name; null =
// unreadable) and the compare status of the tag's commit against main (null = unreadable). tagChecks
// are the check run pages of the tag's commit when it is not main's head; latestPages are what the
// API returns when it is NOT asked with filter=all (the default, filter=latest).
export interface TagObject {tagger?: string | null; type?: string; sha?: string; name?: string}
export interface Fixtures {commits?: Record<string, string>; pages?: object[][]; latestPages?: object[][]; tags?: string[]; latest?: string; previous?: string; releases?: Release[]; runs?: [string, string][]; releasesFail?: boolean;
  tagRef?: {type: string; sha: string} | null; tagObject?: TagObject | null; compare?: string | null; tagChecks?: object[][]}

// Registers the before/after hooks of the scratch directory in the describe that calls it.
export function useScriptHarness() {
  const SHA = 'a'.repeat(40);
  const TAG_OBJECT_SHA = 'e'.repeat(40);
  const PREVIOUS = 'b'.repeat(40);
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  let scratch = '';
  before(() => {
    scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nightly-workflow-'));
    fs.mkdirSync(path.join(scratch, 'bin'));
    // The scripts ask `date -u +%Y%m%d` for today: answered from the harness value, so a run that
    // straddles UTC midnight cannot disagree with the expectations. Every `date -d` (calendar
    // validation) goes to the real date.
    const realDate = spawnSync('sh', ['-c', 'command -v date'], {encoding: 'utf8'}).stdout.trim();
    fs.writeFileSync(path.join(scratch, 'bin', 'date'), [
      '#!/usr/bin/env bash',
      `for arg in "$@"; do if [ "$arg" = -d ]; then exec ${realDate} "$@"; fi; done`,
      `echo ${today}`,
      '',
    ].join('\n'), {mode: 0o755});
    // gh answers from JSON files of the fixtures directory and applies the --jq filter of the call
    // with the real jq (once per document of the file, as gh does once per page), so the filters of the
    // workflow are the ones under test. Every call that changes something is recorded.
    fs.writeFileSync(path.join(scratch, 'bin', 'gh'), [
      '#!/usr/bin/env bash',
      'fix="$FIXTURES"',
      'args="$*"',
      'filter=""; previous=""',
      'for arg in "$@"; do if [ "$previous" = --jq ]; then filter="$arg"; fi; previous="$arg"; done',
      // Without --paginate the real gh returns the first page only: the fixture files hold one page per line.
      'emit() { src="$1"; if [[ "$args" != *--paginate* ]]; then head -n 1 "$1" > "$fix/first-page"; src="$fix/first-page"; fi',
      '  if [ -n "$filter" ]; then jq -r "$filter" "$src"; else cat "$src"; fi; }',
      'case "$args" in',
      '  *"-X DELETE"*|*"-X POST"*|*"workflow run"*) echo "$args" >> "$fix/calls"; case "$args" in *git/tags*) echo "${TAG_OBJECT:-ccc}" ;; esac ;;',
      '  *check-runs*) echo "$args" >> "$fix/check-run-queries"; sha="${args#*commits/}"; sha="${sha%%/*}"',
      '     if [ -e "$fix/check-runs-$sha" ]; then emit "$fix/check-runs-$sha"; elif [[ "$args" == *filter=all* ]]; then emit "$fix/check-runs"; else emit "$fix/check-runs-latest"; fi ;;',
      '  *git/ref/tags/*) if [ -e "$fix/tagref-fail" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi; emit "$fix/tagref" ;;',
      '  *git/tags/*) if [ -e "$fix/tagobject-fail" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi; emit "$fix/tagobject" ;;',
      '  *"/compare/"*) if [ -e "$fix/compare-fail" ]; then echo "gh: Server Error (HTTP 500)" >&2; exit 1; fi; emit "$fix/compare" ;;',
      '  *matching-refs*) emit "$fix/refs" ;;',
      '  *"releases/latest"*) emit "$fix/latest" ;;',
      '  *"actions/workflows/release.yml/runs"*) emit "$fix/runs" ;;',
      // HIDE_DRAFTS=1 stands for the read-only token of the decision job, which cannot list drafts.
      '  *"/releases?"*) if [ -e "$fix/releases-fail" ]; then echo "gh: Server Error (HTTP 500)" >&2; exit 1; fi',
      '     if [ "${HIDE_DRAFTS:-}" = 1 ]; then jq -c "map(select(.draft | not))" "$fix/releases" > "$fix/releases-visible"; emit "$fix/releases-visible"; else emit "$fix/releases"; fi ;;',
      '  *"api repos/"*"/commits/"*) tag="${args#*commits/}"; tag="${tag%% *}"; if [ -e "$fix/commit-$tag" ]; then emit "$fix/commit-$tag"; else emit "$fix/previous-sha"; fi ;;',
      '  *) echo "unexpected gh call: $args" >&2; exit 9 ;;',
      'esac',
      '',
    ].join('\n'), {mode: 0o755});
  });
  after(() => fs.rmSync(scratch, {recursive: true, force: true}));
  const GITHUB_ACTIONS_APP = 15368;
  const checkRun = (name: string, status = 'completed', conclusion: string | null = 'success', app = GITHUB_ACTIONS_APP) => ({name, status, conclusion, app: {id: app}});
  const REQUIRED = ['cla', 'leak check (public rules)', 'OCaml build, tests and native ptyhost gate', 'frontend and Node tests',
    'ruff and pytest (without browser)', ...[0, 1, 2, 3].map((shard) => `browser tests (Chromium, shard ${shard} of 4)`)];
  const green = REQUIRED.map((name) => checkRun(name));
  const without = (name: string) => green.filter((entry) => entry.name !== name);

  // The check runs are given by pages, as the paginated API returns them.
  function fixtures(options: Fixtures = {}): string {
    const tagObject: TagObject = options.tagObject ?? {};
    const dir = fs.mkdtempSync(path.join(scratch, 'fix-'));
    const files: Record<string, string> = {
      'check-runs': (options.pages ?? [green]).map((page) => JSON.stringify({check_runs: page})).join('\n') + '\n',
      refs: JSON.stringify((options.tags ?? []).map((tag) => ({ref: `refs/tags/${tag}`}))) + '\n',
      latest: JSON.stringify({tag_name: options.latest ?? 'v0.1.0'}) + '\n',
      'previous-sha': JSON.stringify({sha: options.previous ?? PREVIOUS}) + '\n',
      releases: JSON.stringify((options.releases ?? []).map((release) => ({tag_name: release.tag, id: release.id, draft: release.draft ?? false, prerelease: release.prerelease ?? true}))) + '\n',
      runs: JSON.stringify({workflow_runs: (options.runs ?? []).map(([head_branch, status]) => ({head_branch, status}))}) + '\n',
      'check-runs-latest': (options.latestPages ?? options.pages ?? [green]).map((page) => JSON.stringify({check_runs: page})).join('\n') + '\n',
      tagref: JSON.stringify({object: options.tagRef ?? {type: 'tag', sha: TAG_OBJECT_SHA}}) + '\n',
      tagobject: JSON.stringify({tag: tagObject.name ?? `v0.2.0-nightly.${today}`, tagger: tagObject.tagger === null ? null : {name: tagObject.tagger ?? 'github-actions[bot]'}, object: {type: tagObject.type ?? 'commit', sha: tagObject.sha ?? SHA}}) + '\n',
      compare: JSON.stringify({status: options.compare ?? 'identical'}) + '\n',
      calls: '',
    };
    if (options.tagChecks) files[`check-runs-${tagObject.sha ?? SHA}`] = options.tagChecks.map((page) => JSON.stringify({check_runs: page})).join('\n') + '\n';
    for (const [tag, sha] of Object.entries(options.commits ?? {})) files[`commit-${tag}`] = JSON.stringify({sha}) + '\n';
    if (options.tagRef === null) files['tagref-fail'] = '';
    if (options.tagObject === null) files['tagobject-fail'] = '';
    if (options.compare === null) files['compare-fail'] = '';
    if (options.releasesFail) files['releases-fail'] = '';
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
  }

  function run(script: string, fix: string, env: Record<string, string> = {}) {
    const output = path.join(fix, 'output');
    const summary = path.join(fix, 'summary');
    fs.writeFileSync(output, '');
    fs.writeFileSync(summary, '');
    const file = path.join(fix, 'step.sh');
    fs.writeFileSync(file, script);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      encoding: 'utf8',
      env: {PATH: `${path.join(scratch, 'bin')}:${process.env.PATH ?? ''}`, FIXTURES: fix, GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'Session-Mesh/session-mesh',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: fix, NIGHTLY_TAG: `v0.2.0-nightly.${today}`, NIGHTLY_KEEP: '7', MAX_DELETIONS: '3', MAX_REDISPATCH: '2', REDISPATCH: 'false', ...env},
    });
    return {status: result.status, output: result.stdout + result.stderr, outputs: fs.readFileSync(output, 'utf8'), summary: fs.readFileSync(summary, 'utf8'),
      calls: fs.readFileSync(path.join(fix, 'calls'), 'utf8'), queries: fs.existsSync(path.join(fix, 'check-run-queries')) ? fs.readFileSync(path.join(fix, 'check-run-queries'), 'utf8') : ''};
  }

  return {SHA, PREVIOUS, today, scratch: () => scratch, checkRun, green, without, fixtures, run};
}
