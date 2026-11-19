// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The `macos` profile (tests/public-ci-workflow-checks.ts): public-ci-macos.yml, the workflow of the
// informational macOS job alone. It is the public profile with one exception: this job may run on the
// pinned macOS arm64 runner and carry a job-level `continue-on-error: true`, under conditions that
// keep it informational and cheap: a named check that no ruleset lists, an explicit read-only token,
// the 45-minute safety net of the workflow header, no dependency on another job, no other job in the
// workflow, no merge queue trigger, and a concurrency group of its own. public-ci.yml (the public
// profile) holds no macOS job and no job that needs one, so its run never waits for the macOS runner.
import {blockOf, jobBlocks, type Line} from './public-ci-workflow-lib.ts';

export const MACOS_WORKFLOW = 'public-ci-macos.yml';
export const MACOS_WORKFLOW_NAME = 'public-ci-macos';
export const MACOS_JOB = 'macos';
export const MACOS_JOB_NAME = 'macos (arm64, informational)';
// public-ci.yml's group (`public-ci-${{ github.ref }}`) under a name of its own, with the same cancellation.
export const MACOS_CONCURRENCY = 'concurrency:\n  group: public-ci-macos-${{ github.ref }}\n' +
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n";
// macos-15 is an arm64 image (the Intel one is macos-15-intel); release.yml builds on the same label.
export const MACOS_RUNNER = 'macos-15';
export const MACOS_TIMEOUT_MINUTES = 45;
// The allow-list of the tests the job runs (one path per line, `#` comments; docs/development.md, "The macOS job").
export const MACOS_LIST_PATH = 'tests/macos-ci-tests.txt';

function macosBlock(lines: Line[]): Line[] {
  return jobBlocks(lines).find((job) => job.name === MACOS_JOB)?.block ?? [];
}

// The runner a `runs-on:` line must name: the macOS one inside the macOS job, the shared one elsewhere.
export function runnerFor(lines: Line[], shared: string): (line: Line) => string {
  const macos = new Set(macosBlock(lines));
  return (line) => (macos.has(line) ? MACOS_RUNNER : shared);
}

// The timeout cap of a job: 45 minutes (the header safety net) for the macOS job, `shared` for every other one.
export function timeoutCap(job: string, shared: number): number {
  return job === MACOS_JOB ? MACOS_TIMEOUT_MINUTES : shared;
}

// The job-level `continue-on-error: true` line of the macOS job: the only one that may be `true`.
export function allowedContinueOnError(lines: Line[]): Set<Line> {
  const block = macosBlock(lines);
  const jobIndent = block[0]?.indent;
  return new Set(block.filter((line) => !line.inBlock && line.indent === jobIndent && line.key === 'continue-on-error' && line.value === 'true'));
}

function directChild(block: Line[], key: string): Line | undefined {
  return block.find((line) => !line.inBlock && line.indent === block[0].indent && line.key === key);
}

// The public profile (public-ci.yml): no macOS job, and no job that needs one.
export function checkNoMacosJob(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const job of jobBlocks(lines)) {
    if (job.name === MACOS_JOB) problems.push(`job ${MACOS_JOB}: the informational macOS job belongs in ${MACOS_WORKFLOW}`);
    const needs = directChild(job.block, 'needs');
    const listed = needs ? [needs.value, ...blockOf(lines, lines.indexOf(needs)).map((item) => item.text)].join(' ') : '';
    if (new RegExp(`\\b${MACOS_JOB}\\b`).test(listed)) problems.push(`job ${job.name}: needs the informational macOS job`);
  }
  return problems;
}

// The `macos` profile: the workflow holds the macOS job alone, under its own name and concurrency
// group, and never runs on the merge queue.
export function checkMacosWorkflow(lines: Line[]): string[] {
  const problems: string[] = [];
  const names = jobBlocks(lines).map((job) => job.name);
  if (names.length !== 1 || names[0] !== MACOS_JOB) problems.push(`jobs ${names.join(', ') || '(none)'}: the workflow holds the ${MACOS_JOB} job alone`);
  if (!lines.some((line) => line.indent === 0 && line.key === 'name' && line.value === MACOS_WORKFLOW_NAME)) {
    problems.push(`workflow name is not ${MACOS_WORKFLOW_NAME}`);
  }
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  const triggers = onIndex < 0 ? [] : blockOf(lines, onIndex).filter((line) => line.indent === 2).map((line) => line.key);
  if (triggers.join(',') !== 'push,pull_request,workflow_dispatch') {
    problems.push(`triggers ${triggers.join(', ') || '(none)'}: expected push, pull_request, workflow_dispatch (no merge_group)`);
  }
  if (!lines.map((line) => line.raw).join('\n').includes(`\n${MACOS_CONCURRENCY}`)) {
    problems.push('concurrency is not the group public-ci-macos-${{ github.ref }}, cancelled on pull_request only');
  }
  const block = macosBlock(lines);
  return block.length === 0 ? [...problems, `no job ${MACOS_JOB}`] : [...problems, ...checkMacosJob(lines, block)];
}

// Conditions on the macOS job itself.
function checkMacosJob(lines: Line[], block: Line[]): string[] {
  const problems: string[] = [];
  const name = directChild(block, 'name');
  if (name?.value !== MACOS_JOB_NAME) problems.push(`job ${MACOS_JOB}: name is not "${MACOS_JOB_NAME}"`);
  if (directChild(block, 'continue-on-error')?.value !== 'true') problems.push(`job ${MACOS_JOB}: no job-level continue-on-error: true`);
  if (directChild(block, 'needs')) problems.push(`job ${MACOS_JOB}: needs another job (it must run alone, in parallel)`);
  // The workflow's triggers decide where the job runs; a condition would only turn the check into a skip.
  if (directChild(block, 'if')) problems.push(`job ${MACOS_JOB}: job-level condition (a skipped job would look like a pass)`);
  const permissions = directChild(block, 'permissions');
  const scopes = permissions ? blockOf(lines, lines.indexOf(permissions)).map((line) => `${line.key}: ${line.value}`) : [];
  if (scopes.length !== 1 || scopes[0] !== 'contents: read') problems.push(`job ${MACOS_JOB}: permissions must be exactly contents: read`);
  return [...problems, ...checkMacosStepTimeouts(block), ...checkMacosTests(block)];
}

// The long steps carry a `timeout-minutes` of their own, so that a hang fails the step (the job then
// ends in failure, which `continue-on-error` keeps from failing the run) instead of reaching the job
// timeout, which cancels the job and with it the run. Matched by the start of the step's label.
// Each entry: label, largest allowed budget, typical duration (minutes). The typical durations are
// deliberately generous cold-cache figures: the first run took 15 min 20 s in all (setup-ocaml 5.5,
// opam dependencies 5.5), and the warm run 44410847883 measured Node tests 125 s, pytest 82 s,
// setup-ocaml 41 s, Python dependencies 10 s, opam repository 20 s, build 13 s, link checks 2 s.
// `dune runtest` has no clean measurement (its one recorded run was the 15-minute hang), so 5 is
// an estimate. Their sum (28) plus the overhead below (30) is about twice the measured cold job.
export const MACOS_STEP_BUDGETS: [string, number, number][] = [
  ['uses: ocaml/setup-ocaml@', 15, 6], ['name: Install the test Python dependencies', 10, 1], ['name: Fix the opam repository commit', 10, 1],
  ['name: Install the OCaml dependencies', 15, 7], ['name: Build and install', 15, 2], ['name: Native tests', 15, 5],
  ['name: Check what the programs link', 10, 1], ['name: Node tests', 10, 3], ['name: pytest', 10, 2],
];
// Checkout, setup-node/python, the header and list steps, the opam cache restore, job set-up and tear-down.
export const MACOS_UNBUDGETED_OVERHEAD_MINUTES = 2;

function checkMacosStepTimeouts(block: Line[]): string[] {
  const body = block.map((line) => line.raw).join('\n');
  const steps = body.split(/\n {6}- /).slice(1);
  const problems: string[] = [];
  let typicalTotal = MACOS_UNBUDGETED_OVERHEAD_MINUTES;
  let worstOverrun = 0;
  for (const [label, maximum, typical] of MACOS_STEP_BUDGETS) {
    const step = steps.find((item) => item.startsWith(label));
    const minutes = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step ?? '')?.[1]);
    if (!step) problems.push(`job ${MACOS_JOB}: no step ${label}`);
    else if (!Number.isInteger(minutes) || minutes < 1 || minutes > maximum) {
      problems.push(`job ${MACOS_JOB}: the step ${label} has no timeout-minutes within 1..${maximum}`);
    } else worstOverrun = Math.max(worstOverrun, minutes - typical);
    typicalTotal += typical;
  }
  // One step hanging until its own budget must end that step before the job timeout cancels the job:
  // the typical durations of all the steps, plus the largest overrun of one step, fit in the timeout.
  const jobTimeout = Number(directChild(block, 'timeout-minutes')?.value);
  if (problems.length === 0 && typicalTotal + worstOverrun > jobTimeout) {
    problems.push(`job ${MACOS_JOB}: typical ${typicalTotal} min + largest step overrun ${worstOverrun} min exceeds the ${jobTimeout}-minute job timeout`);
  }
  return problems;
}

// The test steps: they run the allow-list of tests/macos-ci-tests.txt and nothing else (the other
// tests assume Linux), pytest runs whatever the Node step did, and the scripts run in the system
// bash 3.2 by absolute path.
function checkMacosTests(block: Line[]): string[] {
  const body = block.map((line) => line.raw).join('\n');
  const problems: string[] = [];
  if (!body.includes(`list=${MACOS_LIST_PATH}`)) problems.push(`job ${MACOS_JOB}: does not read ${MACOS_LIST_PATH}`);
  if (/\bfind tests\b/.test(body)) problems.push(`job ${MACOS_JOB}: discovers tests instead of reading the allow-list`);
  // The build step has an id; the native, link, Node and pytest steps run only when it succeeded, and
  // regardless of each other (a red native test does not hide the Node and pytest results).
  if (!/ {6}- name: Build and install[^\n]*\n {8}id: build\n/.test(body)) problems.push(`job ${MACOS_JOB}: the build step has no id: build`);
  for (const step of ['Native tests', 'Check what the programs link', 'Node tests', 'pytest']) {
    const guard = new RegExp(` {6}- name: ${step}[^\\n]*\\n {8}if: "!cancelled\\(\\) && steps\\.build\\.outcome == 'success'"\\n`);
    if (!guard.test(body)) problems.push(`job ${MACOS_JOB}: the ${step} step does not run on the build outcome only`);
  }
  // An absent or empty list is a hard failure, never "run everything".
  if ((body.match(/\[ -s "\$list" \] \|\| \{ echo [^\n]*exit 1; \}/g) ?? []).length < 3) {
    problems.push(`job ${MACOS_JOB}: a step does not refuse an absent or empty list`);
  }
  // The job itself validates each entry and ends the options before the paths.
  if (!body.includes("grep -Eq '^tests/[A-Za-z0-9._/-]+\\.(ts|py)$'") || !/case "\$line" in \*\.\.\*\)/.test(body)) {
    problems.push(`job ${MACOS_JOB}: the list entries are not validated against the strict pattern`);
  }
  if (!body.includes('--test --test-concurrency=4 -- "${files[@]}"') || !body.includes("-m 'not browser' -- \"${files[@]}\"")) {
    problems.push(`job ${MACOS_JOB}: the test runners are not given -- before the paths`);
  }
  if (!/list="\$RUNNER_TEMP\/macos-node-tests\.txt"/.test(body) || !/list="\$RUNNER_TEMP\/macos-pytest-tests\.txt"/.test(body)) {
    problems.push(`job ${MACOS_JOB}: the Node and pytest steps do not both read their part of the list`);
  }
  if (/(?<![/\w])bash scripts\//.test(body)) problems.push(`job ${MACOS_JOB}: runs a script with a bare bash (use /bin/bash)`);
  return problems;
}
