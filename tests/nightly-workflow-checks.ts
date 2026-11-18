// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The checks of the `nightly` profile (.github/workflows/nightly.yml), applied by checkWorkflow of
// tests/public-ci-workflow-checks.ts on top of the rules every profile shares. The workflow tags the
// tip of main once a night and starts release.yml on the tag, so these checks keep it small and
// closed: a schedule and a manual run only (never a pull request, a fork or a privileged trigger), no
// action at all (the gh CLI of the runner and the run's token only), a read-only decision job, one
// job with exactly the two write scopes it needs (contents, actions), the run's token named only as
// GH_TOKEN of a script step, no expression inside a script, strict bash in every script, one
// concurrency group that never cancels, and the exact nightly tag pattern, the deletion cap and the
// pre-release-only deletion in the script that removes old nightlies.
import {blockOf, jobBlocks, type Line, permissionValues, stepOf, usesOf} from './public-ci-workflow-lib.ts';

export const NIGHTLY_DECIDE_JOB = 'decide';
export const NIGHTLY_START_JOB = 'start';
// The only tag form the workflow creates, matches in the shell and deletes.
export const NIGHTLY_TAG_PATTERN = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}$`;
export const NIGHTLY_PERMISSIONS: Record<string, string> = {
  [NIGHTLY_DECIDE_JOB]: 'actions: read, checks: read, contents: read',
  [NIGHTLY_START_JOB]: 'actions: write, contents: write',
};
export const NIGHTLY_TOKEN_LINE = /^\s+GH_TOKEN: \$\{\{ github\.token \}\}\s*$/;

const jobOf = (lines: Line[], name: string): Line[] => jobBlocks(lines).find((job) => job.name === name)?.block ?? [];

// A schedule with one cron entry off the hour, and a manual run without inputs; nothing else.
export function checkNightlyTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const problems: string[] = [];
  const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2);
  const names = triggers.map((line) => line.key).sort().join(', ');
  if (names !== 'schedule, workflow_dispatch') problems.push(`triggers are ${names || '(none)'}, expected schedule, workflow_dispatch`);
  const schedule = triggers.find((line) => line.key === 'schedule');
  const crons = schedule ? blockOf(lines, lines.indexOf(schedule)).filter((line) => line.key === 'cron') : [];
  if (crons.length !== 1) problems.push('schedule must hold exactly one cron entry (one nightly per night)');
  for (const cron of crons) {
    const fields = cron.value.replace(/^["']|["']$/g, '').split(/\s+/);
    if (fields.length !== 5 || !/^\d+$/.test(fields[0]) || fields[0] === '0') problems.push(`line ${cron.number}: the cron minute must be a fixed minute other than 0 (not on the hour)`);
    if (fields.length === 5 && !/^\d+$/.test(fields[1])) problems.push(`line ${cron.number}: the cron hour must be a fixed hour (one run per night)`);
    if (fields.length === 5 && fields.slice(2).some((field) => field !== '*')) problems.push(`line ${cron.number}: the cron runs every day (day, month and weekday are *)`);
  }
  const dispatch = triggers.find((line) => line.key === 'workflow_dispatch');
  if (dispatch && (dispatch.value !== '' || blockOf(lines, lines.indexOf(dispatch)).some((line) => line.indent > 2))) problems.push('workflow_dispatch must take no inputs');
  if (lines.some((line) => !line.inBlock && /\bpull_request|\bworkflow_run\b|\bfork\b|\bpush\s*:/.test(line.text) && !/^\s*#/.test(line.raw))) problems.push('a pull request, fork, push or workflow_run trigger');
  if (lines.some((line) => /\binputs\./.test(line.text))) problems.push('the workflow reads inputs');
  return problems;
}

// Read-only above the jobs; each job exactly its own scopes (NIGHTLY_PERMISSIONS), written or read.
export function checkNightlyPermissions(lines: Line[]): string[] {
  const problems: string[] = [];
  const top = lines.findIndex((line) => line.indent === 0 && line.key === 'permissions');
  const topValues = top < 0 ? [] : permissionValues(lines, top).map(({scope, value}) => `${scope}: ${value}`).join(', ');
  if (topValues !== 'contents: read') problems.push('the top-level permissions must be exactly contents: read');
  const names = jobBlocks(lines).map((job) => job.name).join(', ');
  if (names !== `${NIGHTLY_DECIDE_JOB}, ${NIGHTLY_START_JOB}`) problems.push(`the workflow must have the jobs ${NIGHTLY_DECIDE_JOB}, ${NIGHTLY_START_JOB}, got ${names || 'none'}`);
  for (const [job, expected] of Object.entries(NIGHTLY_PERMISSIONS)) {
    const block = jobOf(lines, job);
    const own = block.filter((line) => line.key === 'permissions' && line.indent === 4);
    const granted = own.length === 1 ? permissionValues(lines, lines.indexOf(own[0])).map(({scope, value}) => `${scope}: ${value}`).sort().join(', ') : '';
    if (granted !== expected) problems.push(`job ${job}: permissions must be exactly ${expected}`);
  }
  return problems;
}

// The run's token only as GH_TOKEN in the env of a script step; no secret anywhere.
export function nightlyTokenLines(lines: Line[]): Set<Line> {
  const allowed = new Set<Line>();
  for (const env of lines.filter((line) => line.key === 'env' && !line.inBlock && line.indent === 8)) {
    const step = stepOf(lines, lines.indexOf(env));
    if (!step.some((item) => item.key === 'run') || step.some((item) => usesOf(item).length > 0)) continue;
    for (const line of blockOf(lines, lines.indexOf(env))) if (NIGHTLY_TOKEN_LINE.test(line.raw)) allowed.add(line);
  }
  return allowed;
}

// No action, so no third-party code ever holds a token; every script is strict bash and holds no
// expression (workflow values reach it through env); one concurrency group that never cancels.
export function checkNightlyScripts(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    if (!line.inBlock && usesOf(line).length > 0) problems.push(`line ${line.number}: an action in the nightly workflow (the gh CLI and the run's token only)`);
    if (line.inBlock && /\$\{\{/.test(line.raw)) problems.push(`line ${line.number}: an expression inside a script (use env)`);
  }
  for (const {name, block} of jobBlocks(lines)) {
    for (const run of block.filter((line) => line.key === 'run')) {
      if (!/^\|[-+0-9]*$/.test(run.value)) problems.push(`job ${name}: line ${run.number}: run: must be a literal block (|)`);
      const script = stepOf(lines, lines.indexOf(run)).filter((line) => line.inBlock).map((line) => line.raw.trim());
      if (script[0] !== 'set -euo pipefail') problems.push(`job ${name}: line ${run.number}: a script must start with set -euo pipefail`);
    }
  }
  const concurrency = lines.findIndex((line) => line.indent === 0 && line.key === 'concurrency');
  const keys = concurrency < 0 ? [] : blockOf(lines, concurrency).filter((line) => line.indent === 2).map((line) => `${line.key}: ${line.value}`).sort();
  if (keys.join('; ') !== 'cancel-in-progress: false; group: nightly') problems.push('concurrency must be exactly group: nightly and cancel-in-progress: false');
  return problems;
}

// The script that removes the old nightlies: the exact tag pattern is the only way a tag is deleted,
// the cap bounds the deletions, and a release is deleted only when it is a pre-release; no `gh release
// create`, no --latest, no deletion elsewhere in the workflow.
export function checkNightlyDeletion(lines: Line[]): string[] {
  const problems: string[] = [];
  const text = lines.filter((line) => !/^\s*#/.test(line.raw));
  const patternLines = text.filter((line) => /nightly_tag_pattern=/.test(line.raw));
  if (patternLines.length === 0 || patternLines.some((line) => line.raw.trim() !== `nightly_tag_pattern='${NIGHTLY_TAG_PATTERN}'`)) {
    problems.push(`nightly_tag_pattern must be exactly ${NIGHTLY_TAG_PATTERN} wherever it is set`);
  }
  const start = jobOf(lines, NIGHTLY_START_JOB);
  const deletions = start.filter((line) => /\bgh release delete\b|-X DELETE\b/.test(line.raw) && !/^\s*#/.test(line.raw));
  if (deletions.length !== 2) problems.push(`job ${NIGHTLY_START_JOB}: exactly two deletions expected (a pre-release and an orphan tag), got ${deletions.length}`);
  for (const line of lines.filter((item) => /\bgh release delete\b|-X DELETE\b/.test(item.raw))) {
    if (!start.includes(line)) problems.push(`line ${line.number}: a deletion outside the ${NIGHTLY_START_JOB} job`);
  }
  const body = start.map((line) => line.raw).join('\n');
  if (!/^\s+MAX_DELETIONS: "\d+"$/m.test(lines.map((line) => line.raw).join('\n'))) problems.push('MAX_DELETIONS must be set as a number in the workflow env');
  if (!/\[ "\$deleted" -ge "\$MAX_DELETIONS" \]/.test(body)) problems.push('the deletion loop must stop at MAX_DELETIONS');
  if (!/\[\[ "\$tag" =~ \$nightly_tag_pattern \]\] \|\| continue/.test(body)) problems.push('the deletion loop must skip every tag that does not match nightly_tag_pattern');
  if (!/\$4 != "true"/.test(body)) problems.push('a release is deleted only when it is a pre-release');
  if (/\bgh release (?:create|edit|upload)\b|--latest|--draft\b/.test(lines.map((line) => line.raw).join('\n'))) problems.push('the nightly workflow never creates or edits a release itself');
  return problems;
}

// The tag is created through the API with the run's token, in the start job only, as an annotated
// tag; release.yml is started on it; the decision job writes nothing.
export function checkNightlyTagging(lines: Line[]): string[] {
  const problems: string[] = [];
  const start = jobOf(lines, NIGHTLY_START_JOB).map((line) => line.raw).join('\n');
  const decide = jobOf(lines, NIGHTLY_DECIDE_JOB).map((line) => line.raw).join('\n');
  if (!/-X POST "repos\/\$GH_REPO\/git\/tags"/.test(start) || !/-X POST "repos\/\$GH_REPO\/git\/refs" -f ref="refs\/tags\/\$NIGHTLY_TAG"/.test(start)) {
    problems.push('the start job must create an annotated tag object and then its ref through the API');
  }
  if (!/gh workflow run release\.yml --ref "\$NIGHTLY_TAG"/.test(start)) problems.push('the start job must start release.yml on the nightly tag');
  if (/-X (?:POST|PUT|PATCH|DELETE)|workflow run|release (?:create|delete)/.test(decide)) problems.push('the decision job must only read');
  if (!/if: github\.repository == 'Session-Mesh\/session-mesh' && github\.ref == 'refs\/heads\/main'/.test(decide)) problems.push('the decision job must run on the repository and on main only');
  if (!/if: needs\.decide\.outputs\.publish == 'true'/.test(start)) problems.push('the start job must run only when the decision job says publish');
  // The gate counts the check runs of the app the ruleset requires only, and every run of a name must be green.
  if (!/--jq '\.check_runs\[\] \| select\(\.app\.id == 15368\)/.test(decide)) problems.push('the decision job must count only the check runs of the GitHub Actions app (integration_id 15368)');
  if (!/\$2 != "completed" \|\| \$3 != "success"/.test(decide) || !/runs == 0\) print "none"/.test(decide)) problems.push('the decision job must require every check run to be completed/success, and at least one');
  // The release is started before the retention, which may fail without failing the run.
  const dispatchAt = start.indexOf('gh workflow run release.yml');
  const retentionAt = start.indexOf('- name: Remove the nightlies beyond the newest ones');
  if (dispatchAt < 0 || retentionAt < 0 || dispatchAt > retentionAt) problems.push('the start job must start release.yml before the retention step');
  // The shared rules forbid continue-on-error: true, so the step ends itself with a warning.
  if (!/trap '[^']*::warning::[^']*exit 0' ERR/.test(start.slice(Math.max(retentionAt, 0)))) problems.push('the retention step must end with a warning, not a failure (an ERR trap that exits 0)');
  if (!/if \[ "\$REDISPATCH" = true \]/.test(start) || !/"\$total" -ge "\$MAX_REDISPATCH"/.test(decide)) problems.push('an orphan tag is started again (REDISPATCH) at most MAX_REDISPATCH times');
  return problems;
}

export const NIGHTLY_CHECKS: ((lines: Line[]) => string[])[] = [checkNightlyScripts, checkNightlyDeletion, checkNightlyTagging];
