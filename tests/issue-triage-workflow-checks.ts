// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The checks of the `triage` profile (.github/workflows/issue-triage.yml), applied by checkWorkflow of
// tests/public-ci-workflow-checks.ts on top of the rules every profile shares (pinned actions, runner,
// timeouts, no continue-on-error, no unparsed YAML). The workflow classifies new issues, whose text is
// written by strangers, and writes one label, so these checks keep it closed: it is started by
// `issues: opened` and a manual run only; the job has exactly `actions: read`, `contents: read` and
// `issues: write`; the one secret (OLLAMA_API_KEY) and the run's token (as GITHUB_TOKEN) are named in the
// env of the one script step of the job that declares `environment: issue-triage`, and nowhere else;
// event data enters an expression in two places only (the job's `if:` guard: default branch, author type and
// association; and, through `github.event_name`, the job's concurrency group), never a `run:` script; the
// concurrency group never cancels.
import {blockOf, expressions, githubProperties, jobBlocks, type Line, permissionValues, stepOf, usesOf} from './public-ci-workflow-lib.ts';

export const TRIAGE_JOB = 'triage';
export const TRIAGE_ENVIRONMENT = 'issue-triage';
export const TRIAGE_PERMISSIONS = 'actions: read, contents: read, issues: write';
export const TRIAGE_SECRET_LINE = /^ {10}OLLAMA_API_KEY: \$\{\{ secrets\.OLLAMA_API_KEY \}\}$/;
export const TRIAGE_TOKEN_LINE = /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/;
// The only expression that reads event data besides github.event_name: the job's guard.
export const TRIAGE_GUARD = `github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && ` +
  `(github.event_name == 'workflow_dispatch' || (github.event.issue.user.type != 'Bot' && ` +
  `!contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.issue.author_association)))`;
export const TRIAGE_GROUP = `issue-triage-\${{ github.event_name == 'issues' && 'global' || format('dispatch-{0}-{1}', inputs.issue_number, inputs.dry_run) }}`;
const COMMENT = /^\s*#/;

const triageJob = (lines: Line[]): Line[] => jobBlocks(lines).find((job) => job.name === TRIAGE_JOB)?.block ?? [];

// The script step of the triage job: a step with a `run:` and no action.
function scriptStep(lines: Line[]): Line[] {
  const run = triageJob(lines).find((line) => line.key === 'run' && !line.inBlock);
  return run ? stepOf(lines, lines.indexOf(run)) : [];
}

// `issues: opened` and a manual run; no pull request, privileged, scheduled or comment trigger.
export function checkTriageTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const problems: string[] = [];
  const names = blockOf(lines, onIndex).filter((line) => line.indent === 2).map((line) => line.key).sort().join(', ');
  if (names !== 'issues, workflow_dispatch') problems.push(`triggers are ${names || '(none)'}, expected issues, workflow_dispatch`);
  const issues = lines.find((line) => line.indent === 2 && line.key === 'issues');
  const types = issues ? blockOf(lines, lines.indexOf(issues)).map((line) => line.text.trim()) : [];
  if (types.join('') !== 'types: [opened]') problems.push('the issues trigger must be exactly types: [opened]');
  for (const line of lines) {
    if (!line.inBlock && !COMMENT.test(line.raw) && /\bpull_request|\bworkflow_run\b|\bschedule\b|\bissue_comment\b|\bpush\s*:/.test(line.text)) {
      problems.push(`line ${line.number}: a pull request, privileged, scheduled, comment or push trigger`);
    }
  }
  return problems;
}

// Nothing at the top; the triage job exactly TRIAGE_PERMISSIONS; one job.
export function checkTriagePermissions(lines: Line[]): string[] {
  const problems: string[] = [];
  const top = lines.findIndex((line) => line.indent === 0 && line.key === 'permissions');
  if (top < 0 || lines[top].value !== '{}') problems.push('the top-level permissions must be exactly {}');
  const names = jobBlocks(lines).map((job) => job.name).join(', ');
  if (names !== TRIAGE_JOB) problems.push(`the workflow must have the one job ${TRIAGE_JOB}, got ${names || 'none'}`);
  const block = triageJob(lines);
  const index = block.findIndex((line) => line.key === 'permissions' && line.indent === 4);
  const values = index < 0 ? [] : permissionValues(lines, lines.indexOf(block[index])).map(({scope, value}) => `${scope}: ${value}`).sort().join(', ');
  if (values !== TRIAGE_PERMISSIONS) problems.push(`job ${TRIAGE_JOB}: permissions must be exactly ${TRIAGE_PERMISSIONS}, got ${values || 'none'}`);
  return problems;
}

// The secret and the run's token appear on their one line each, in the env of the script step of the job
// that declares the environment; no other mention, in a line or in an expression.
export function checkTriageSecrets(lines: Line[]): string[] {
  const problems: string[] = [];
  const step = scriptStep(lines);
  if (!triageJob(lines).some((line) => line.indent === 4 && line.key === 'environment' && line.value === TRIAGE_ENVIRONMENT)) {
    problems.push(`job ${TRIAGE_JOB}: environment must be ${TRIAGE_ENVIRONMENT}`);
  }
  if (step.some((line) => usesOf(line).length > 0)) problems.push('the script step must not be an action');
  const secretLines = lines.filter((line) => !COMMENT.test(line.raw) && /\bsecrets\b/i.test(line.raw));
  if (secretLines.length !== 1 || !TRIAGE_SECRET_LINE.test(secretLines[0].raw) || !step.includes(secretLines[0])) {
    problems.push('the secret must be named once, as OLLAMA_API_KEY in the env of the script step');
  }
  const tokenLines = lines.filter((line) => !COMMENT.test(line.raw) && /\bgithub\.token\b|\bGITHUB_TOKEN\b/i.test(line.raw));
  if (tokenLines.length !== 1 || !TRIAGE_TOKEN_LINE.test(tokenLines[0].raw) || !step.includes(tokenLines[0])) {
    problems.push('the run\'s token must be named once, as GITHUB_TOKEN in the env of the script step');
  }
  for (const {number, body} of expressions(lines)) {
    if (/\bsecrets\b/i.test(body) && number !== secretLines[0]?.number) problems.push(`line ${number}: secret reference outside the script step`);
    if (githubProperties(body).includes('token') && number !== tokenLines[0]?.number) problems.push(`line ${number}: explicit token outside the script step`);
  }
  return problems;
}

// Event data only in the job guard (exactly TRIAGE_GROUP's github.event_name apart); the github context is
// never read whole; the dispatch input only in the concurrency group; no expression inside a script.
export function checkTriageEvent(lines: Line[]): string[] {
  const problems: string[] = [];
  const guard = triageJob(lines).find((line) => line.key === 'if' && line.indent === 4);
  for (const {number, body, unparsable} of expressions(lines)) {
    if (unparsable) problems.push(`line ${number}: expression never closed`);
    const properties = githubProperties(body);
    if (properties.includes(null)) problems.push(`line ${number}: github context read whole or by a computed index`);
    if (properties.includes('head_ref')) problems.push(`line ${number}: head_ref in an expression`);
    const readsEvent = properties.includes('event');
    if (readsEvent && !(guard && number === guard.number && body.trim() === TRIAGE_GUARD)) problems.push(`line ${number}: untrusted event data in an expression`);
    const raw = lines[number - 1]?.raw ?? '';
    if (/\binputs\b/.test(body) && raw.trim() !== `group: ${TRIAGE_GROUP}`) problems.push(`line ${number}: a dispatch input outside the concurrency group`);
  }
  if (!guard) problems.push(`job ${TRIAGE_JOB}: no if: guard`);
  for (const line of lines) {
    if (line.inBlock && /\$\{\{/.test(line.raw)) problems.push(`line ${line.number}: an expression inside a script (use env)`);
    if (line.key === 'run' && line.value !== '' && /\$\{\{/.test(line.value)) problems.push(`line ${line.number}: an expression in run:`);
  }
  return problems;
}

// One concurrency group for all issue events and one per dispatched issue, never cancelling a run, declared on the
// job (not the workflow) so that a skipped job does not take the pending slot of another run.
export function checkTriageConcurrency(lines: Line[]): string[] {
  const job = triageJob(lines);
  const index = job.findIndex((line) => line.indent === 4 && line.key === 'concurrency');
  const keys = index < 0 ? [] : blockOf(lines, lines.indexOf(job[index])).filter((line) => line.indent === 6).map((line) => `${line.key}: ${line.raw.trim().slice((line.key ?? '').length + 2)}`).sort();
  const expected = ['cancel-in-progress: false', `group: ${TRIAGE_GROUP}`];
  if (keys.join('; ') !== expected.join('; ')) return ['concurrency must be exactly the shared group of the issue events and cancel-in-progress: false, on the job'];
  return lines.filter((line) => line.key === 'concurrency').length === 1 ? [] : ['concurrency must be set once, on the job'];
}

export const TRIAGE_CHECKS: ((lines: Line[]) => string[])[] = [checkTriageConcurrency];
