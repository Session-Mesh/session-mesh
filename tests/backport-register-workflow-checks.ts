// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The checks of the `register` profile (.github/workflows/backport-register.yml), applied by
// checkWorkflow of tests/public-ci-workflow-checks.ts on top of the rules every profile shares. That
// workflow runs on `pull_request_target` like backport.yml and pushes to the repository, so these
// checks keep it from running code of a pull request: the trigger is exactly `pull_request_target`
// [closed] on main; the job that reads the list of files has a read-only token and the job that
// pushes has exactly the two write scopes of a backport; the checkout is the base branch with its
// history and nothing else; the scripts run git and gh subcommands from fixed lists and nothing of
// the checkout; the push goes to the backport branch only; the secrets are the GitHub App's; the event
// is read for booleans, numbers, the merge commit id and label names only.
import {blockOf, continuation, expressions, githubProperties, jobBlocks, type Line, permissionValues} from './public-ci-workflow-lib.ts';
import {actionOf, APP_TOKEN_ACTION, checkAppToken, checkBackportEvent, CHECKOUT_ACTION, HAS_APP_TOKEN, inputs, isComment, jobLines,
  SCRIPT_TOKEN_LINE, SECRET_LINES, steps, TOKEN_INPUT_LINE} from './backport-workflow-checks.ts';
import {REGISTER_FILES} from '../tools/branch-policy/branch-policy.ts';

export const FILES_JOB = 'register-files';
export const PUSH_JOB = 'register-backport';
export const FILES_CONDITION = 'github.event.pull_request.merged == true';
export const PUSH_CONDITION = `needs.${FILES_JOB}.outputs.changed == 'true'`;
export const REGISTER_EVENT_PATHS = ['pull_request.merged', 'pull_request.labels.*.name', 'pull_request.number',
  'pull_request.merge_commit_sha', 'pull_request.commits'];
// What each job's script may run: these git and gh subcommands, nothing else.
export const FILES_COMMANDS = ['gh api'];
export const PUSH_COMMANDS = ['git merge-base', 'git switch', 'git rev-list', 'git diff', 'git apply', 'git commit', 'git ls-files', 'git ls-remote', 'git fetch', 'git rev-parse', 'git push', 'git log', 'git ls-tree', 'git diff-tree', 'git patch-id', 'gh api', 'gh pr'];
// The only push: the backport branch, named from the pull request number.
export const BRANCH_LINE = 'branch="backport-$NUMBER-cla-register-to-release/latest"';
export const PUSH_LINE = 'git push --quiet origin "HEAD:refs/heads/$branch"';
// The checks the replay relies on, each a line of the script: the changed-files request paginated (a
// register file on a later page must be seen); the file names compared whole with jq; the answer written as
// the step output the job exposes;
// the landed commits matched with those of the pull request (a rebase merge); a replay without
// rename detection; the register paths checked exactly (each absent or a regular file) on every replayed
// commit before it is recorded and on the result; the branch reused or refused, never overwritten.
// The job output the push job's gate reads, as the detection step's output.
export const OUTPUT_LINE = 'changed: ${{ steps.files.outputs.changed }}';
export const CHECK_STAGED = 'check_register_paths --cached';
export const FILES_REQUIRED = ['files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$NUMBER/files")', 'echo "changed=$changed" >> "$GITHUB_OUTPUT"',
  '[[ "$(jq -n \'[inputs | .[]] | length\' <<< "$files")" -lt 3000 ]] || { echo "::error::the pull request lists 3000 files, the most the API returns; its register changes are backported by hand"; exit 1; }',
  'changed=$(jq -n \'[inputs | if type == "array" then .[] else error("not a file list") end | .filename, ' +
  '(.previous_filename // empty)] | any(IN($ARGS.positional[]))\' --args "${paths[@]}" <<< "$files")'];
// The push job's two API calls: a read of the commits of the pull request, and, for a commit of it that has
// no landed commit, a read of its files (it must have none: a rebase merge drops only empty commits).
export const COMMITS_LINE = 'pr_commits=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$NUMBER/commits" --jq \'.[] | "\\(.sha) \\(.commit.author.email) \\(.commit.author.date)"\')';
export const EMPTY_LINE = 'changed_files=$(gh api "repos/$GITHUB_REPOSITORY/commits/${pr_shas[$index]}" --jq \'.files | length\')';
export const PUSH_REQUIRED = [
  '[[ "$changed_files" == 0 ]] || { echo "::error::the landed commits are not those of the pull request as a rebase merge lands them"; exit 1; }',
  '[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::unexpected commit list"; exit 1; }',
  '[[ "${#pr_shas[@]}" -eq "$COUNT" ]] || { echo "::error::the commit list is not the number of commits of the event"; exit 1; }',
  'git fetch --quiet --no-tags origin "${landed_pr[$index]}" || { echo "::error::a commit of the pull request cannot be fetched; nothing is pushed"; exit 1; }',
  '[[ -n "$landed_id" && "$landed_id" == "$(patch_id "${landed_pr[$index]}")" ]] || { echo "::error::a landed commit does not carry the change of its commit of the pull request"; exit 1; }',
  'replayed=$(git ls-tree HEAD -- "$path")',
  'on_main=$(git ls-tree origin/main -- "$path")',
  '[[ "$replayed" == "$on_main" ]] || refuse_register "$path" "$replay_message"',
  'on_release=$(git ls-tree origin/release/latest -- "$path")',
  'before_range=$(git ls-tree "$range_base" -- "$path")',
  '[[ "$on_release" == "$before_range" ]] || refuse_register "$path" "$base_message"',
  'chain=$(git rev-list --first-parent --max-count="$COUNT" "$LANDED")',
  'git diff --binary --no-renames "$commit^" "$commit" -- "${paths[@]}" > "$patch"',
  'git diff --name-only -z --no-renames "$@" > "$RUNNER_TEMP/backported"',
  'check_register_paths origin/release/latest HEAD',
  'if [[ -z "$(git ls-remote origin "refs/heads/$branch" | cut -f1)" ]]; then',
  'echo "::error::the branch $branch exists and is not this replay; it is left as it is, a maintainer decides"',
  'git fetch --quiet origin "refs/heads/$branch"',
  'git merge-base --is-ancestor origin/release/latest FETCH_HEAD || same=false',
  '[[ -z "$(git rev-list --min-parents=2 origin/release/latest..FETCH_HEAD)" ]] || same=false',
  '[[ "${#existing[@]}" -eq "${#expected[@]}" ]] || same=false',
  `[[ "$(git rev-list --no-walk --no-commit-header --format='%T%n%an <%ae> %at%n%B' "\${expected[$index]}")" == "$(git rev-list --no-walk --no-commit-header --format='%T%n%an <%ae> %at%n%B' "\${existing[$index]}")" ]] || same=false`,
  '[[ "$known" == true ]] || { echo "::error::the replay changes a path other than the register files; nothing is pushed"; exit 1; }',
  '[[ -z "$mode" || "$mode" == 100644 || "$mode" == 100755 ]] || { echo "::error::$path is not a regular file; nothing is pushed"; exit 1; }',
];
const APP_TOKEN_SCRIPT_LINE = /^\s+GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \|\| github\.token \}\}\s*$/;
const RUNS_SOMETHING = /(?:^|[\s;&|(])(?:\.\/|bash\b|sh\b|node\b|npm\b|npx\b|python\d*\b|source\b|eval\b|exec\b|make\b|curl\b|wget\b)|\.\.?\//;

// A script step's `run:` must be a literal block: a folded block (`>`) joins lines with spaces and a plain
// scalar is one line, and the line-based checks would read either as the commands they were written as.
const literalRun = (job: string, step: Line[]): string[] => step.filter((line) => line.key === 'run' && !/^\|[-+0-9]*$/.test(line.value))
  .map((line) => `job ${job}: line ${line.number}: run: must be a literal block (|), not ${line.value.slice(0, 3) || 'empty'}`);

const scriptOf = (step: Line[]): string[] => [...step.filter((line) => line.key === 'run' && !/^[|>][-+0-9]*$/.test(line.value)).map((line) => line.value),
  ...step.filter((line) => line.inBlock).map((line) => line.raw.trim())].filter((line) => line !== '' && !line.startsWith('#'));

// `pull_request_target` on main for `closed`, and nothing else.
export function checkRegisterTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2);
  const names = triggers.map((line) => line.key).join(', ');
  const problems = names === 'pull_request_target' ? [] : [`triggers are ${names || '(none)'}, expected pull_request_target only`];
  const trigger = triggers.find((line) => line.key === 'pull_request_target');
  const keys = trigger ? blockOf(lines, lines.indexOf(trigger)).filter((line) => line.indent === 4) : [];
  const value = (key: string): string | undefined => keys.find((line) => line.key === key)?.value;
  if (keys.length !== 2 || value('types') !== '[closed]') problems.push('pull_request_target must have exactly the types [closed] and a branches filter');
  if (value('branches') !== '[main]') problems.push('pull_request_target must be limited to branches: [main]');
  return problems;
}

// Two jobs; read-only above them; the files job reads pull requests, the push job writes two scopes.
export function checkRegisterPermissions(lines: Line[]): string[] {
  const problems: string[] = [];
  const names = jobBlocks(lines).map((job) => job.name).join(', ');
  if (names !== `${FILES_JOB}, ${PUSH_JOB}`) problems.push(`the workflow must have the jobs ${FILES_JOB}, ${PUSH_JOB}, got ${names || 'none'}`);
  const top = lines.findIndex((line) => line.indent === 0 && line.key === 'permissions');
  const topValues = top < 0 ? [] : permissionValues(lines, top);
  if (topValues.length !== 1 || topValues[0].scope !== 'contents' || topValues[0].value !== 'read') problems.push('the top-level permissions must be exactly contents: read');
  const expected: [string, string][] = [[FILES_JOB, 'pull-requests: read'], [PUSH_JOB, 'contents: write, pull-requests: write']];
  for (const [job, scopes] of expected) {
    const inJob = new Set(jobLines(lines, job));
    const own = lines.filter((line) => line.key === 'permissions' && inJob.has(line));
    const granted = own.length === 1 ? permissionValues(lines, lines.indexOf(own[0])).map(({scope, value}) => `${scope}: ${value}`).sort().join(', ') : '';
    if (granted !== scopes) problems.push(`job ${job}: permissions must be exactly ${scopes}`);
  }
  return problems;
}

// The App's two secrets on their three lines; the run's token only as GH_TOKEN of the files script,
// as the checkout token, and (after the App token) as GH_TOKEN of the push script.
export function checkRegisterSecrets(lines: Line[]): string[] {
  const problems: string[] = [];
  const all = [...steps(lines, FILES_JOB).map((step) => ({job: FILES_JOB, step})), ...steps(lines, PUSH_JOB).map((step) => ({job: PUSH_JOB, step}))];
  const owner = (line: Line) => all.find((item) => item.step.includes(line));
  for (const line of lines.filter((item) => !isComment(item))) {
    if (line.key === 'secrets') problems.push(`line ${line.number}: secrets passed on`);
    if (/\$\{\{[^}]*\bsecrets\b/i.test(line.raw)) {
      const matched = [...SECRET_LINES.entries()].find(([pattern]) => pattern.test(line.raw));
      const found = owner(line);
      if (!matched) problems.push(`line ${line.number}: secret read outside the expected form`);
      else if (matched[1] === APP_TOKEN_ACTION && (!found || actionOf(found.step) !== APP_TOKEN_ACTION)) {
        problems.push(`line ${line.number}: secret handed to a step other than ${APP_TOKEN_ACTION}`);
      }
    }
    if (/\bgithub\.token\b|\bGITHUB_TOKEN\b/i.test(line.raw)) {
      const found = owner(line);
      const action = found ? actionOf(found.step) : 'none';
      const script = found !== undefined && action === undefined && found.step.some((item) => item.key === 'run');
      const allowed = (script && found.job === FILES_JOB && SCRIPT_TOKEN_LINE.test(line.raw)) ||
        (script && found.job === PUSH_JOB && APP_TOKEN_SCRIPT_LINE.test(line.raw)) ||
        (found?.job === PUSH_JOB && action === CHECKOUT_ACTION && TOKEN_INPUT_LINE.test(line.raw));
      if (!allowed) problems.push(`line ${line.number}: explicit token outside the expected form`);
    }
  }
  for (const {number, body} of expressions(lines)) {
    if (/\bsecrets\b(?!\.(?:BACKPORT_APP_ID|BACKPORT_APP_PRIVATE_KEY)\b)/i.test(body)) problems.push(`line ${number}: secret other than BACKPORT_APP_ID and BACKPORT_APP_PRIVATE_KEY`);
    if (githubProperties(body).includes('token') && !/\bgithub\.token\b/.test(body)) problems.push(`line ${number}: explicit token`);
  }
  return problems;
}

export const checkRegisterEvent = (lines: Line[]): string[] => checkBackportEvent(lines, REGISTER_EVENT_PATHS);

function gate(lines: Line[], job: string): string | undefined {
  const index = lines.findIndex((line) => line.key === 'if' && line.indent === 4 && jobLines(lines, job).includes(line));
  if (index < 0) return undefined;
  return [lines[index].value, ...continuation(lines, index).map((item) => item.raw.trim())].join(' ').replace(/^[>|][-+]?\s*/, '').trim();
}

function checkGates(lines: Line[]): string[] {
  const problems: string[] = [];
  if (gate(lines, FILES_JOB) !== FILES_CONDITION) problems.push(`job ${FILES_JOB}: if: must be exactly ${FILES_CONDITION}`);
  if (gate(lines, PUSH_JOB) !== PUSH_CONDITION) problems.push(`job ${PUSH_JOB}: if: must be exactly ${PUSH_CONDITION}`);
  if (!jobLines(lines, PUSH_JOB).some((line) => line.indent === 4 && line.key === 'needs' && line.value === FILES_JOB)) problems.push(`job ${PUSH_JOB}: needs: must be ${FILES_JOB}`);
  return problems;
}

// The git and gh subcommands of a script, and anything else it runs.
function checkScript(job: string, script: string[], commands: string[]): string[] {
  const problems: string[] = [];
  for (const line of script) {
    if (RUNS_SOMETHING.test(line)) problems.push(`job ${job}: the script runs something of the checkout or a shell: ${line.slice(0, 60)}`);
    for (const match of line.matchAll(/(?:^|[\s;&|(])(git|gh)\s+(\S+)/g)) {
      if (!commands.includes(`${match[1]} ${match[2]}`)) problems.push(`job ${job}: the script runs ${match[1]} ${match[2].slice(0, 20)}, not one of ${commands.join(', ')}`);
    }
  }
  return problems;
}

// Both scripts name exactly the register files of the release branch guard.
function checkRegisterLists(job: string, script: string[], pattern: RegExp, separator: string): string[] {
  const listed = script.map((line) => pattern.exec(line)?.[1]).filter((item) => item !== undefined);
  return listed.length === 1 && listed[0].split(separator).join(' ') === REGISTER_FILES.join(' ') ? []
    : [`job ${job}: the register files must be listed once, as ${REGISTER_FILES.join(' ')}`];
}

function checkFilesJob(lines: Line[]): string[] {
  const job = steps(lines, FILES_JOB);
  if (job.length !== 1 || actionOf(job[0]) !== undefined) return [`job ${FILES_JOB}: exactly one script step and no action`];
  const script = scriptOf(job[0]);
  const calls = script.filter((line) => /\bgh\s+api\b/.test(line));
  const detection = calls.length === 1 && calls[0] === FILES_REQUIRED[0] ? [] : [`job ${FILES_JOB}: the one API call must be ${FILES_REQUIRED[0]}`];
  return [...literalRun(FILES_JOB, job[0]), ...detection, ...checkFilesOutput(lines, job[0]), ...checkScript(FILES_JOB, script, FILES_COMMANDS), ...checkRegisterLists(FILES_JOB, script, /^paths=\(([^)]*)\)$/, ' '),
    ...missing(FILES_JOB, script, FILES_REQUIRED)];
}

// The push job's gate reads needs.register-files.outputs.changed: the job must export it from the step that
// writes it (id files), or the push job is skipped for a valid backport.
function checkFilesOutput(lines: Line[], step: Line[]): string[] {
  const problems: string[] = [];
  const inJob = jobLines(lines, FILES_JOB);
  const outputs = inJob.findIndex((line) => line.indent === 4 && line.key === 'outputs');
  const mapped = outputs < 0 ? [] : blockOf(inJob, outputs).filter((line) => line.indent === 6);
  if (mapped.length !== 1 || mapped[0].raw.trim() !== OUTPUT_LINE) problems.push(`job ${FILES_JOB}: outputs must be exactly ${OUTPUT_LINE}`);
  if (!step.some((line) => line.key === 'id' && line.value === 'files')) problems.push(`job ${FILES_JOB}: the detection step must have id: files`);
  return problems;
}

function missing(job: string, script: string[], required: string[]): string[] {
  return required.filter((line) => !script.includes(line)).map((line) => `job ${job}: the script must contain the line ${line.slice(0, 80)}`);
}

function checkPushJob(lines: Line[]): string[] {
  const problems: string[] = [];
  const job = steps(lines, PUSH_JOB);
  const order = job.map((step) => actionOf(step) ?? 'run').join(', ');
  if (order !== `${APP_TOKEN_ACTION}, ${CHECKOUT_ACTION}, run`) problems.push(`job ${PUSH_JOB}: steps must be ${APP_TOKEN_ACTION}, ${CHECKOUT_ACTION}, run, got ${order || 'none'}`);
  for (const step of job) {
    const action = actionOf(step);
    if (action === APP_TOKEN_ACTION) problems.push(...checkAppToken(lines, step));
    if (action === CHECKOUT_ACTION) {
      const given = inputs(lines, step);
      const names = [...given.keys()].sort().join(', ');
      if (names !== 'fetch-depth, token' || given.get('fetch-depth')?.value !== '0' || !TOKEN_INPUT_LINE.test(given.get('token')?.raw ?? '')) {
        problems.push(`line ${step[0].number}: the checkout takes exactly token and fetch-depth: 0 (the base branch and its history)`);
      }
    }
    if (action !== undefined) continue;
    const script = scriptOf(step);
    problems.push(...literalRun(PUSH_JOB, step));
    const commits = script.flatMap((line, index) => (/^git commit\b/.test(line) ? [index] : []));
    if (commits.length === 0 || commits.some((index) => index < 1 || script[index - 1] !== CHECK_STAGED)) problems.push(`job ${PUSH_JOB}: every commit must be preceded by ${CHECK_STAGED}`);
    problems.push(...checkScript(PUSH_JOB, script, PUSH_COMMANDS), ...checkRegisterLists(PUSH_JOB, script, /^paths=\(([^)]*)\)$/, ' '));
    problems.push(...missing(PUSH_JOB, script, PUSH_REQUIRED));
    // The local suite runs these scripts with the Bash 3.2 of macOS, which has no mapfile or readarray.
    if (script.some((line) => /\b(?:mapfile|readarray)\b/.test(line))) problems.push(`job ${PUSH_JOB}: no mapfile or readarray (Bash 3.2)`);
    const calls = script.filter((line) => /\bgh\s+api\b/.test(line));
    if (calls.length !== 2 || calls[0] !== COMMITS_LINE || calls[1] !== EMPTY_LINE) problems.push(`job ${PUSH_JOB}: the two API calls must be ${COMMITS_LINE} then ${EMPTY_LINE}`);
    if (!script.includes(BRANCH_LINE)) problems.push(`job ${PUSH_JOB}: the branch must be set by ${BRANCH_LINE}`);
    const pushes = script.filter((line) => /\bgit push\b/.test(line));
    if (pushes.length !== 1 || pushes[0] !== PUSH_LINE) problems.push(`job ${PUSH_JOB}: the one push must be ${PUSH_LINE}`);
    if (script.some((line) => /\bbranch=/.test(line) && line !== BRANCH_LINE)) problems.push(`job ${PUSH_JOB}: branch is set once`);
  }
  if (!jobLines(lines, PUSH_JOB).some((line) => line.raw.trim() === `HAS_APP_TOKEN: ${HAS_APP_TOKEN}`)) problems.push(`job ${PUSH_JOB}: env HAS_APP_TOKEN must be ${HAS_APP_TOKEN}`);
  return problems;
}

export const REGISTER_CHECKS: ((lines: Line[]) => string[])[] = [checkGates, checkFilesJob, checkPushJob];
