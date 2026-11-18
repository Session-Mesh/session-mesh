// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The checks of the `preview` and `preview-cleanup` profiles (.github/workflows/site-preview.yml and
// site-preview-cleanup.yml), applied by checkWorkflow of tests/public-ci-workflow-checks.ts on top of
// the rules every profile shares (GitHub's runner, read-only token, bounded jobs, no ignored
// failure, no private leak rules). These are the `pull_request` workflows that hold secrets: the two
// of a GitHub App installed on the staging repository of the site previews. These checks keep them
// where they belong. site-preview.yml: the triggers are exactly `pull_request` (on main, for the
// site's files, opened/synchronize/reopened), a daily `schedule` and a manual run; the jobs are
// build, publish and expire. site-preview-cleanup.yml: `pull_request` closed on main, no `paths`,
// one job `remove`. In both: the secrets are read on three forms of line only, in jobs that run in
// the `site-preview` environment, and handed to nothing but the App token step, whose inputs scope
// the token to site-staging with Contents write; that token goes to the checkout of the staging
// repository and nowhere else; a job that holds it runs the preview script from a checkout of main
// (path base, no credentials) and never from the pull request's files; every other checkout drops
// its credentials; the build job holds no secret and no environment; the per-pull-request jobs share
// one concurrency group; the event is read for the pull request number and head revision only; the
// token of the run is named once, read-only, in the guard step of the publish job (the only job that
// may hold `pull-requests: read`).
import {blockOf, expressions, githubProperties, jobBlocks, type Line, permissionValues, stepOf, usesOf} from './public-ci-workflow-lib.ts';

export const PREVIEW_SECRETS = ['SITE_PREVIEW_APP_ID', 'SITE_PREVIEW_APP_PRIVATE_KEY'];
export const PREVIEW_ENVIRONMENT = 'site-preview';
export const STAGING_REPOSITORY = 'Session-Mesh/site-staging';
export const STAGING_PATH = 'staging';
export const PREVIEW_BUILD_JOB = 'build';
export const PREVIEW_PUBLISH_JOB = 'publish';
export const PREVIEW_PATHS = ['site/**', '.github/workflows/site-preview.yml', '.github/workflows/site-preview-cleanup.yml', '.github/scripts/site-stage.sh', '.github/scripts/site-csp-check.mjs', '.github/scripts/site-preview.sh'];
export const PREVIEW_TYPES = '[opened, synchronize, reopened]';
export const CLEANUP_TYPES = '[closed]';
export const PREVIEW_CRON = '23 4 * * *';
// The jobs of each workflow, in order, and the concurrency group of each (one group per pull request).
export const PREVIEW_JOBS = ['build', 'publish', 'expire'];
export const CLEANUP_JOBS = ['remove'];
export const PR_GROUP = 'site-preview-pr-${{ github.event.pull_request.number }}';
export const PREVIEW_GROUPS: Record<string, string> = {build: PR_GROUP, publish: PR_GROUP, remove: PR_GROUP, expire: 'site-preview-expire'};
// What the workflow may read of the event: the pull request number and its head revision (a
// hexadecimal SHA); no title, description, branch name, user or action.
export const PREVIEW_EVENT_PATHS = ['pull_request.number', 'pull_request.head.sha'];
// The run token appears once, as the env of the guard step of the publish job: a read-only call to
// GitHub for the state and head of the pull request.
export const GUARD_TOKEN = 'GH_TOKEN: ${{ github.token }}';
export const GUARD_STEP_ID = 'guard';
// The if of the App token step: the credentials gate, and in the publish job the outcome of the guard.
export const APP_TOKEN_CONDITIONS = ["env.HAS_APP_TOKEN == 'true'", "env.HAS_APP_TOKEN == 'true' && steps.guard.outputs.proceed == 'true'"];
// The only checkout that is neither the staging repository nor the plain one of the build job: main,
// in base/, whose preview script the jobs that hold the App token run.
export const BASE_CHECKOUT = {ref: 'main', path: 'base'};
export const BASE_SCRIPT_DIR = 'base/.github/scripts/';
// The actions the workflow may use, each pinned by full commit SHA.
export const APP_TOKEN_ACTION = 'actions/create-github-app-token';
export const PREVIEW_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact', APP_TOKEN_ACTION];
// The inputs of the App token step, exactly: the token can write the contents of site-staging only.
export const APP_TOKEN_INPUTS: Record<string, string> = {
  'app-id': '${{ secrets.SITE_PREVIEW_APP_ID }}',
  'private-key': '${{ secrets.SITE_PREVIEW_APP_PRIVATE_KEY }}',
  owner: 'Session-Mesh',
  repositories: 'site-staging',
  'permission-contents': 'write',
};
export const APP_TOKEN = '${{ steps.app-token.outputs.token }}';

const HAS_APP_TOKEN = "${{ secrets.SITE_PREVIEW_APP_ID != '' && secrets.SITE_PREVIEW_APP_PRIVATE_KEY != '' }}";
const HAS_APP_TOKEN_LINE = /^\s+HAS_APP_TOKEN: \$\{\{ secrets\.SITE_PREVIEW_APP_ID != '' && secrets\.SITE_PREVIEW_APP_PRIVATE_KEY != '' \}\}\s*$/;
const APP_ID_LINE = /^\s+app-id: \$\{\{ secrets\.SITE_PREVIEW_APP_ID \}\}\s*$/;
const PRIVATE_KEY_LINE = /^\s+private-key: \$\{\{ secrets\.SITE_PREVIEW_APP_PRIVATE_KEY \}\}\s*$/;
const TOKEN_INPUT_LINE = /^\s+token: \$\{\{ steps\.app-token\.outputs\.token \}\}\s*$/;
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

const isComment = (line: Line): boolean => /^\s*#/.test(line.raw);
const actionOf = (step: Line[]): string | undefined => step.flatMap(usesOf)[0]?.split('@')[0];

// The direct inputs of a step's `with:` block.
function inputs(lines: Line[], step: Line[]): Map<string, Line> {
  const withLine = step.find((line) => line.key === 'with');
  if (!withLine) return new Map();
  const block = blockOf(lines, lines.indexOf(withLine));
  if (block.length === 0) return new Map();
  const column = Math.min(...block.map((line) => line.column));
  return new Map(block.filter((line) => line.column === column && line.key).map((line) => [line.key as string, line]));
}

// The environment name of a job (`environment: name` or `environment:` with a `name:` below).
function environmentOf(lines: Line[], block: Line[]): string | undefined {
  const line = block.find((item) => item.key === 'environment' && !item.inBlock);
  if (!line) return undefined;
  if (line.value !== '') return line.value;
  return blockOf(lines, lines.indexOf(line)).find((item) => item.key === 'name')?.value;
}

// The step (a `- ` item) that holds the line at `index`, however deep the line is nested in it.
function enclosingStep(lines: Line[], index: number): Line[] {
  const indent = lines[index].indent;
  for (let start = index; start >= 0; start--) {
    const line = lines[start];
    if (line.inBlock || line.text.trim() === '') continue;
    if (/^\s*-\s/.test(line.text) && (start === index || line.indent < indent)) return [line, ...blockOf(lines, start)];
  }
  return [lines[index]];
}

const isStagingCheckout = (lines: Line[], step: Line[]): boolean =>
  actionOf(step) === 'actions/checkout' && inputs(lines, step).get('repository')?.value === STAGING_REPOSITORY;

// The two secrets are read on three forms of line only: `HAS_APP_TOKEN: <both non-empty>` in a
// job's env, and the `app-id` and `private-key` inputs of the App token step; all in jobs that run
// in the site-preview environment. The App token goes to the `token` input of the staging checkout
// only. No other secret, no secrets passed on, no token of the run.
export function checkPreviewSecrets(lines: Line[]): string[] {
  const problems: string[] = [];
  const jobs = jobBlocks(lines);
  const jobOf = (line: Line) => jobs.find((job) => job.block.includes(line));
  const guardTokenLines = guardTokenLinesOf(lines, problems);
  const guardTokenNumbers = new Set([...guardTokenLines].map((line) => line.number));
  for (const line of lines.filter((item) => !isComment(item))) {
    if (line.key === 'secrets') problems.push(`line ${line.number}: secrets passed on`);
    if (/\bgithub\.token\b|\bGITHUB_TOKEN\b/i.test(line.raw) && !guardTokenLines.has(line)) problems.push(`line ${line.number}: explicit token`);
    if (/steps\s*(?:\.|\[)\s*['"]?app-token['"]?\s*\]?\s*\.\s*outputs\s*(?:\.|\[)\s*['"]?token\b/.test(line.raw)) {
      const step = enclosingStep(lines, lines.indexOf(line));
      if (!TOKEN_INPUT_LINE.test(line.raw) || !isStagingCheckout(lines, step) || inputs(lines, step).get('token') !== line) {
        problems.push(`line ${line.number}: the App token used elsewhere than as the token of the checkout of ${STAGING_REPOSITORY}`);
      }
    }
    if (!/\bsecrets\b/i.test(line.raw)) continue;
    const job = jobOf(line);
    if (!job) { problems.push(`line ${line.number}: secret read outside a job`); continue; }
    if (environmentOf(lines, job.block) !== PREVIEW_ENVIRONMENT) {
      problems.push(`line ${line.number}: secret read in job ${job.name}, which does not run in the ${PREVIEW_ENVIRONMENT} environment`);
    }
    if (HAS_APP_TOKEN_LINE.test(line.raw)) {
      const jobIndent = Math.min(...job.block.map((item) => item.indent));
      const env = job.block.find((item) => item.key === 'env' && item.indent === jobIndent);
      if (!env || !blockOf(lines, lines.indexOf(env)).includes(line)) problems.push(`line ${line.number}: HAS_APP_TOKEN outside the job env`);
    } else if (APP_ID_LINE.test(line.raw) || PRIVATE_KEY_LINE.test(line.raw)) {
      const step = enclosingStep(lines, lines.indexOf(line));
      if (actionOf(step) !== APP_TOKEN_ACTION || inputs(lines, step).get(line.key ?? '') !== line) {
        problems.push(`line ${line.number}: secret handed to a step other than ${APP_TOKEN_ACTION}`);
      }
    } else {
      problems.push(`line ${line.number}: secret read outside the expected form`);
    }
  }
  for (const {number, body} of expressions(lines)) {
    if (/\bsecrets\b(?!\.(?:SITE_PREVIEW_APP_ID|SITE_PREVIEW_APP_PRIVATE_KEY)\b)/i.test(body)) {
      problems.push(`line ${number}: secret other than ${PREVIEW_SECRETS.join(' and ')}`);
    }
    if (githubProperties(body).includes('token') && !guardTokenNumbers.has(number)) problems.push(`line ${number}: explicit token`);
  }
  return problems;
}

// The one place the run token may be named: `GH_TOKEN: ${{ github.token }}` in the env of the step
// with id guard of the publish job, a run step that calls the script's guard command. Any other
// occurrence is reported by the caller, and a second one here too.
function guardTokenLinesOf(lines: Line[], problems: string[]): Set<Line> {
  const allowed = new Set<Line>();
  const publish = jobBlocks(lines).find((job) => job.name === PREVIEW_PUBLISH_JOB)?.block ?? [];
  for (const line of lines.filter((item) => !isComment(item) && item.raw.trim() === GUARD_TOKEN)) {
    const step = enclosingStep(lines, lines.indexOf(line));
    const env = step.find((item) => item.key === 'env');
    const runs = step.find((item) => item.key === 'run');
    const ok = publish.includes(line) && env !== undefined && blockOf(lines, lines.indexOf(env)).includes(line) &&
      step.some((item) => item.key === 'id' && item.value === GUARD_STEP_ID) && step.every((item) => usesOf(item).length === 0) &&
      /site-preview\.sh guard\b/.test(runs?.value ?? '');
    if (!ok) { problems.push(`line ${line.number}: the run token is allowed only as the env of the ${GUARD_STEP_ID} step of the ${PREVIEW_PUBLISH_JOB} job`); continue; }
    if (allowed.size > 0) { problems.push(`line ${line.number}: the run token named more than once`); continue; }
    allowed.add(line);
  }
  return allowed;
}

// The event is read for the paths of PREVIEW_EVENT_PATHS only, by dots; no part of the pull
// request's head but its revision is named anywhere, comments aside.
export function checkPreviewEvent(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const {number, body, unparsable} of expressions(lines)) {
    if (unparsable) problems.push(`line ${number}: expression never closed (a quoted }} is not its end)`);
    const properties = githubProperties(body);
    if (properties.includes(null)) problems.push(`line ${number}: github context read whole or by a computed index`);
    if (properties.includes('head_ref')) problems.push(`line ${number}: untrusted event data in an expression (head_ref)`);
    const reads = [...body.matchAll(/(?<![\w.-])github\.event\.([\w.*-]+)/g)].map((match) => match[1]);
    if (reads.length !== properties.filter((name) => name === 'event').length) {
      problems.push(`line ${number}: github.event read in a form other than github.event.<path>`);
    }
    for (const path of reads.filter((item) => !PREVIEW_EVENT_PATHS.includes(item))) {
      problems.push(`line ${number}: untrusted event data in an expression (github.event.${path})`);
    }
  }
  for (const line of lines.filter((item) => !isComment(item))) {
    // The head revision is the one part of the head that may be named: a hexadecimal SHA.
    const named = line.raw.replace(/github\.event\.pull_request\.head\.sha(?![\w.-])/g, '');
    if (/refs\/pull\/|\bhead\.(?:sha|ref|repo)\b|\bhead_ref\b|\bpull_request\.head\b/.test(named)) {
      problems.push(`line ${line.number}: the pull request's head is named`);
    }
  }
  return problems;
}

// The App token step: id app-token, guarded by HAS_APP_TOKEN, with exactly the inputs of
// APP_TOKEN_INPUTS, so that the token is scoped to the contents of site-staging.
function checkAppTokenStep(lines: Line[], step: Line[], number: number): string[] {
  const problems: string[] = [];
  const given = inputs(lines, step);
  const expected = Object.keys(APP_TOKEN_INPUTS).sort().join(', ');
  const keys = [...given.keys()].sort().join(', ');
  if (keys !== expected) problems.push(`line ${number}: ${APP_TOKEN_ACTION} takes exactly ${expected}, got ${keys || 'none'}`);
  for (const [key, value] of Object.entries(APP_TOKEN_INPUTS)) {
    if (given.has(key) && given.get(key)?.value !== value) problems.push(`line ${given.get(key)?.number}: ${key} must be ${value}`);
  }
  if (!step.some((line) => line.key === 'id' && line.value === 'app-token')) problems.push(`line ${number}: the App token step must have id: app-token`);
  if (!step.some((line) => line.key === 'if' && APP_TOKEN_CONDITIONS.includes(line.value))) {
    problems.push(`line ${number}: the App token step must be guarded by if: ${APP_TOKEN_CONDITIONS[0]} (and, after the guard step, its proceed output)`);
  }
  return problems;
}

// Only the actions of PREVIEW_ACTIONS, pinned by full commit SHA. The checkout of the staging
// repository takes exactly repository, token (the App token) and path, and keeps its credentials
// (the script pushes with them); every other checkout drops them, and is either plain or the base
// checkout (ref: main, path: base).
export function checkPreviewActions(lines: Line[]): string[] {
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.inBlock) return;
    for (const action of usesOf(line)) {
      if (!PINNED_ACTION.test(action)) { problems.push(`line ${line.number}: action ${action} not pinned by full commit SHA`); continue; }
      const name = action.split('@')[0];
      if (!PREVIEW_ACTIONS.includes(name)) { problems.push(`line ${line.number}: action ${name} is not one of ${PREVIEW_ACTIONS.join(', ')}`); continue; }
      const step = stepOf(lines, index);
      if (name === APP_TOKEN_ACTION) { problems.push(...checkAppTokenStep(lines, step, line.number)); continue; }
      if (name !== 'actions/checkout') continue;
      const given = inputs(lines, step);
      if (given.has('repository')) {
        const keys = [...given.keys()].sort().join(', ');
        if (given.get('repository')?.value !== STAGING_REPOSITORY) problems.push(`line ${line.number}: checkout of ${given.get('repository')?.value}, not ${STAGING_REPOSITORY}`);
        else if (keys !== 'path, repository, token') problems.push(`line ${line.number}: the staging checkout takes exactly path, repository and token, got ${keys}`);
        else if (given.get('path')?.value !== STAGING_PATH) problems.push(`line ${line.number}: the staging checkout must take path: ${STAGING_PATH}, where the script commands look for it`);
        else if (!TOKEN_INPUT_LINE.test(given.get('token')?.raw ?? '')) problems.push(`line ${line.number}: the staging checkout must take token: ${APP_TOKEN}`);
      } else if (given.get('persist-credentials')?.value !== 'false') {
        problems.push(`line ${line.number}: checkout without persist-credentials: false`);
      } else if (given.has('ref') || given.has('path')) {
        const keys = [...given.keys()].sort().join(', ');
        const exact = given.get('ref')?.value === BASE_CHECKOUT.ref && given.get('path')?.value === BASE_CHECKOUT.path;
        if (keys !== 'path, persist-credentials, ref' || !exact) {
          problems.push(`line ${line.number}: the base checkout takes exactly ref: ${BASE_CHECKOUT.ref}, path: ${BASE_CHECKOUT.path} and persist-credentials: false, got ${keys}`);
        }
      }
    }
  });
  return problems;
}

// `pull_request` on main for the four types and the site's files, a `schedule`, and a manual run
// without inputs; nothing else.
export function checkPreviewTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const problems: string[] = [];
  const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2);
  const names = triggers.map((line) => line.key).join(', ');
  if (names !== 'pull_request, schedule, workflow_dispatch') problems.push(`triggers are ${names || '(none)'}, expected pull_request, schedule, workflow_dispatch`);
  const block = (key: string): Line[] => {
    const trigger = triggers.find((line) => line.key === key);
    return trigger ? blockOf(lines, lines.indexOf(trigger)) : [];
  };
  const pullRequest = block('pull_request');
  const value = (key: string): string | undefined => pullRequest.find((line) => line.indent === 4 && line.key === key)?.value;
  if (pullRequest.filter((line) => line.indent === 4).map((line) => line.key).join(', ') !== 'types, branches, paths') {
    problems.push('pull_request must have exactly types, branches and paths');
  }
  if (value('types') !== PREVIEW_TYPES) problems.push(`pull_request types must be ${PREVIEW_TYPES}`);
  if (value('branches') !== '[main]') problems.push('pull_request must be limited to branches: [main]');
  const pathsLine = pullRequest.find((line) => line.indent === 4 && line.key === 'paths');
  const paths = pathsLine ? blockOf(lines, lines.indexOf(pathsLine)).map((line) => line.text.trim().replace(/^-\s+/, '')) : [];
  if (paths.join(', ') !== PREVIEW_PATHS.join(', ')) problems.push(`pull_request paths must be ${PREVIEW_PATHS.join(', ')}`);
  const crons = block('schedule').filter((line) => line.key === 'cron');
  if (crons.length !== 1) problems.push('schedule must hold exactly one cron');
  else if (crons[0].value !== PREVIEW_CRON) problems.push(`schedule cron must be ${PREVIEW_CRON}, the daily run`);
  if (block('workflow_dispatch').length > 0 || (triggers.find((line) => line.key === 'workflow_dispatch')?.value ?? '') !== '') {
    problems.push('workflow_dispatch takes no input');
  }
  return problems;
}

// The cleanup workflow: `pull_request` closed on main with no `paths`, and nothing else.
export function checkCleanupTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const problems: string[] = [];
  const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2);
  const names = triggers.map((line) => line.key).join(', ');
  if (names !== 'pull_request') problems.push(`triggers are ${names || '(none)'}, expected pull_request only`);
  const trigger = triggers.find((line) => line.key === 'pull_request');
  const pullRequest = trigger ? blockOf(lines, lines.indexOf(trigger)) : [];
  const own = pullRequest.filter((line) => line.indent === 4);
  const value = (key: string): string | undefined => own.find((line) => line.key === key)?.value;
  if (own.map((line) => line.key).join(', ') !== 'types, branches') problems.push('pull_request must have exactly types and branches (no paths filter)');
  if (value('types') !== CLEANUP_TYPES) problems.push(`pull_request types must be ${CLEANUP_TYPES}`);
  if (value('branches') !== '[main]') problems.push('pull_request must be limited to branches: [main]');
  return problems;
}

// The text of a job's concurrency group and whether it cancels runs in progress.
function concurrencyOf(lines: Line[], block: Line[]): {group?: string | undefined; cancel?: string | undefined} {
  const line = block.find((item) => item.key === 'concurrency' && !item.inBlock);
  if (!line) return {};
  const inner = blockOf(lines, lines.indexOf(line));
  return {group: inner.find((item) => item.key === 'group')?.value, cancel: inner.find((item) => item.key === 'cancel-in-progress')?.value};
}

// Permission scopes in a job's own block, other than `contents: read`: only `pull-requests: read`
// in the publish job (the guard step reads the pull request).
function checkPreviewPermissions(lines: Line[], job: {name: string; block: Line[]}): string[] {
  const problems: string[] = [];
  for (const line of job.block.filter((item) => item.key === 'permissions' && !item.inBlock)) {
    for (const {scope, value, number} of permissionValues(lines, lines.indexOf(line))) {
      if (scope === 'contents' && value === 'read') continue;
      if (scope === 'pull-requests' && value === 'read' && job.name === PREVIEW_PUBLISH_JOB) continue;
      problems.push(`line ${number}: job ${job.name} may not hold ${scope}: ${value || '(empty)'}`);
    }
  }
  return problems;
}

// A job that holds the App token runs the preview script from the checkout of main in base/, and
// every checkout it makes is the staging repository or that one: no file of the pull request is
// code there.
function checkBaseScripts(lines: Line[], job: {name: string; block: Line[]}): string[] {
  const problems: string[] = [];
  const steps = job.block.filter((line) => usesOf(line).length > 0).map((line) => stepOf(lines, lines.indexOf(line)));
  const checkouts = steps.filter((step) => actionOf(step) === 'actions/checkout');
  const bases = checkouts.filter((step) => inputs(lines, step).get('ref')?.value === BASE_CHECKOUT.ref && inputs(lines, step).get('path')?.value === BASE_CHECKOUT.path);
  if (bases.length === 0) problems.push(`job ${job.name} holds the App token without a checkout of ${BASE_CHECKOUT.ref} in ${BASE_CHECKOUT.path}/`);
  for (const step of checkouts) {
    if (!isStagingCheckout(lines, step) && !bases.includes(step)) {
      problems.push(`line ${step[0].number}: job ${job.name} holds the App token and checks out files other than main or ${STAGING_REPOSITORY}`);
    }
  }
  for (const line of job.block.filter((item) => !isComment(item) && /\.github\/scripts\//.test(item.raw))) {
    if (/(?<!base\/)\.github\/scripts\//.test(line.raw) || !line.raw.includes(BASE_SCRIPT_DIR)) {
      problems.push(`line ${line.number}: job ${job.name} holds the App token and runs a script that is not ${BASE_SCRIPT_DIR}...`);
    }
  }
  return problems;
}

// The jobs of the file are exactly `expected`. The build job runs the pull request's code: it holds
// no secret and runs in no environment. Every job that creates the App token or checks out the
// staging repository runs in the site-preview environment, with the HAS_APP_TOKEN gate in its env,
// takes its scripts from main, and has the concurrency group of PREVIEW_GROUPS without cancelling.
function checkJobsOf(expected: string[]): (lines: Line[]) => string[] {
  return (lines) => {
    const problems: string[] = [];
    const jobs = jobBlocks(lines);
    const names = jobs.map((job) => job.name).join(', ');
    if (names !== expected.join(', ')) problems.push(`jobs are ${names || '(none)'}, expected ${expected.join(', ')}`);
    const build = jobs.find((job) => job.name === PREVIEW_BUILD_JOB);
    if (build) {
      if (environmentOf(lines, build.block) !== undefined) problems.push(`job ${PREVIEW_BUILD_JOB} must run in no environment`);
      if (build.block.some((line) => !isComment(line) && /\bsecrets\b/i.test(line.raw))) problems.push(`job ${PREVIEW_BUILD_JOB} must hold no secret`);
    } else if (expected.includes(PREVIEW_BUILD_JOB)) problems.push(`no ${PREVIEW_BUILD_JOB} job`);
    const publish = jobs.find((job) => job.name === PREVIEW_PUBLISH_JOB);
    if (publish && !publish.block.some((line) => line.key === 'needs' && line.value === PREVIEW_BUILD_JOB)) {
      problems.push(`job ${PREVIEW_PUBLISH_JOB} must declare needs: ${PREVIEW_BUILD_JOB}, the job that makes its artifact`);
    }
    for (const job of jobs) {
      problems.push(...checkPreviewPermissions(lines, job));
      const {group, cancel} = concurrencyOf(lines, job.block);
      if (job.name in PREVIEW_GROUPS && group !== PREVIEW_GROUPS[job.name]) problems.push(`job ${job.name}: concurrency group must be ${PREVIEW_GROUPS[job.name]}`);
      if (job.name in PREVIEW_GROUPS && cancel !== 'false') problems.push(`job ${job.name}: concurrency must set cancel-in-progress: false`);
      const uses = job.block.filter((line) => usesOf(line).length > 0).map((line) => stepOf(lines, lines.indexOf(line)));
      const writes = uses.some((step) => isStagingCheckout(lines, step) || actionOf(step) === APP_TOKEN_ACTION);
      if (!writes) continue;
      if (environmentOf(lines, job.block) !== PREVIEW_ENVIRONMENT) {
        problems.push(`job ${job.name} writes ${STAGING_REPOSITORY} outside the ${PREVIEW_ENVIRONMENT} environment`);
      }
      if (!job.block.some((line) => line.raw.trim() === `HAS_APP_TOKEN: ${HAS_APP_TOKEN}`)) problems.push(`job ${job.name}: env HAS_APP_TOKEN must be ${HAS_APP_TOKEN}`);
      problems.push(...checkBaseScripts(lines, job));
    }
    return problems;
  };
}

// The policy gate's reference is main's, never the pull request's: the build job takes a read-only
// checkout of main in base/ and passes it to the staging script, and the publish job re-runs the gate
// from base/ on the downloaded artifact, after the artifact is downloaded and before the App token
// exists.
export const BUILD_STAGE_RUN = 'bash .github/scripts/site-stage.sh "$RUNNER_TEMP/site-stage" base';
export const PUBLISH_GATE_RUN = 'node base/.github/scripts/site-csp-check.mjs base/site/index.html "$RUNNER_TEMP/site-stage" base/site';
export function checkGateReference(lines: Line[]): string[] {
  const problems: string[] = [];
  const jobs = jobBlocks(lines);
  const build = jobs.find((job) => job.name === PREVIEW_BUILD_JOB);
  if (build) {
    const steps = build.block.filter((line) => usesOf(line).length > 0).map((line) => stepOf(lines, lines.indexOf(line)));
    const hasBase = steps.some((step) => actionOf(step) === 'actions/checkout' && inputs(lines, step).get('ref')?.value === BASE_CHECKOUT.ref && inputs(lines, step).get('path')?.value === BASE_CHECKOUT.path);
    if (!hasBase) problems.push(`job ${PREVIEW_BUILD_JOB} must check out ${BASE_CHECKOUT.ref} in ${BASE_CHECKOUT.path}/, the reference of the policy gate`);
    if (!build.block.some((line) => !isComment(line) && line.raw.includes(`run: ${BUILD_STAGE_RUN}`))) {
      problems.push(`job ${PREVIEW_BUILD_JOB} must stage with the reference of main: ${BUILD_STAGE_RUN}`);
    }
  }
  const publish = jobs.find((job) => job.name === PREVIEW_PUBLISH_JOB);
  if (publish) {
    const gate = publish.block.findIndex((line) => !isComment(line) && line.raw.includes(`run: ${PUBLISH_GATE_RUN}`));
    const download = publish.block.findIndex((line) => usesOf(line).some((action) => action.startsWith('actions/download-artifact@')));
    const token = publish.block.findIndex((line) => usesOf(line).some((action) => action.startsWith(`${APP_TOKEN_ACTION}@`)));
    if (gate < 0) problems.push(`job ${PREVIEW_PUBLISH_JOB} must re-run the gate from main on the artifact: ${PUBLISH_GATE_RUN}`);
    else if (download < 0 || download > gate || (token >= 0 && gate > token)) {
      problems.push(`job ${PREVIEW_PUBLISH_JOB} must run the gate after downloading the artifact and before creating the App token`);
    }
  }
  return problems;
}

export const PREVIEW_CHECKS: ((lines: Line[]) => string[])[] = [checkJobsOf(PREVIEW_JOBS), checkGateReference];
export const CLEANUP_CHECKS: ((lines: Line[]) => string[])[] = [checkJobsOf(CLEANUP_JOBS)];
