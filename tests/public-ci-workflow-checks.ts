// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Invariant checks of the workflows in .github/workflows/, shared by tests/public-ci-workflow.test.ts
// and tests/release-workflow.test.ts. No YAML parser is available without a new dependency: the checks
// read the text line by line and refuse every construct they do not resolve (see UNPARSED).
// Four profiles: `public` (public-ci.yml: one runner, read-only token, 15-minute jobs, docker
// commands through digest-pinned *_IMAGE variables), `description` (the public rules plus the one
// allowed use of the pull request body), `site` (site.yml: the public rules, except that the
// `deploy` job alone may hold `pages: write` and `id-token: write`; no secret) and `release` (release.yml: the
// shared rules plus the checks of tests/release-workflow-checks.ts).
import {blockOf, commandAt, continuation, jobBlocks, type Line, MAX_TIMEOUT_MINUTES, parseLines, permissionValues, stepOf, timeoutProblems,
  usesOf} from './public-ci-workflow-lib.ts';
import {checkReleasePermissions, checkReleaseRunners, checkReleaseTimeouts, RELEASE_CHECKS, releaseTokenLines} from './release-workflow-checks.ts';

export type Profile = 'public' | 'description' | 'release' | 'site';

// The one place where untrusted event text may enter an expression: the description workflow hands
// the pull request body to its script through an environment variable.
export const BODY_ENV_LINE = /^\s+BODY: \$\{\{ github\.event\.pull_request\.body \}\}\s*$/;
export const RUNNER = 'ubuntu-24.04';

// Every `${{ ... }}` of the raw text (comments included, possibly spanning lines), and every
// `if:` value with its continuation lines (folded `>-` included), which GitHub evaluates as an
// expression even without `${{ }}`.
function expressions(lines: Line[]): {number: number; body: string}[] {
  const text = lines.map((line) => line.raw).join('\n');
  const found: {number: number; body: string}[] = [];
  for (const match of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    found.push({number: text.slice(0, match.index).split('\n').length, body: match[1]});
  }
  lines.forEach((line, index) => {
    if (line.key !== 'if') return;
    found.push({number: line.number, body: [line.value, ...continuation(lines, index).map((item) => item.raw)].join('\n')});
  });
  return found;
}

// Property names read from the `github` context in an expression (case-insensitive, as GitHub
// reads them); null when the context is used whole (`toJSON(github)`) or by a computed index.
function githubProperties(body: string): (string | null)[] {
  return [...body.matchAll(/(?<![\w.-])github\b/gi)].map((match) => {
    const rest = body.slice((match.index ?? 0) + match[0].length);
    const property = /^\s*(?:\.\s*([\w-]+)|\[\s*(['"])(.*?)\2\s*\])/.exec(rest);
    return property ? (property[1] ?? property[3]).toLowerCase() : null;
  });
}

const UNPARSED: [RegExp, string, 'raw' | 'text'][] = [
  [/\\/, 'backslash outside a block scalar', 'raw'],
  [/(?:^|[\s{,[-])(['"])[^'"]*\1\s*:(?:\s|$)/, 'quoted key', 'text'],
  [/(?:^|[\s[{,:-])[&*][\w-]+/, 'anchor or alias', 'text'],
  [/(?:^|[\s{,])<<\s*:/, 'merge key', 'text'],
  [/(?:^|[:[{,-])\s*!/, 'tag', 'text'],
  [/^\s*(?:-\s+)?\?(?:\s|$)/, 'complex key', 'text'],
  [/^(?:---|\.\.\.)(?:\s|$)/, 'document marker', 'text'],
];

// Constructs a YAML parser would resolve and this line reader does not: refused outright.
function checkUnparsed(lines: Line[]): string[] {
  return lines.filter((line) => !line.inBlock).flatMap((line) => UNPARSED.filter(([pattern, , field]) => pattern.test(line[field]))
    .map(([, label]) => `line ${line.number}: unparsed YAML construct (${label})`));
}

// A failing step or job never passes as green.
function checkContinueOnError(lines: Line[]): string[] {
  return lines.filter((line) => !line.inBlock &&
      /(?:^|[\s{,])continue-on-error\s*:(?!\s*false\s*(?:[,}]|$))/.test(line.text))
    .map((line) => `line ${line.number}: continue-on-error other than false`);
}

const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

// Job containers, service containers and docker:// actions are pinned by image digest.
function checkImages(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    if (line.inBlock) continue;
    const images = [...line.text.matchAll(/(?:^|[\s{,])image\s*:\s*(['"]?)([^\s,}'"]*)\1/g)].map((match) => match[2]);
    if (line.key === 'container' && line.value !== '') images.push(line.value);
    if (line.key === 'services' && line.value !== '') problems.push(`line ${line.number}: services in flow form not analysed`);
    images.push(...usesOf(line).filter((action) => action.startsWith('docker://')));
    for (const image of images) {
      if (!PINNED_IMAGE.test(image)) problems.push(`line ${line.number}: image ${image || '(empty)'} not pinned by @sha256 digest`);
    }
  }
  return problems;
}

// A docker command of a run script names its image only through a `<NAME>_IMAGE` variable, and every
// such variable is declared with an @sha256 digest (release.yml runs no docker command: checkReleaseNoDocker).
function checkDockerImages(lines: Line[]): string[] {
  const problems: string[] = [];
  const pinned = new Set<string>();
  for (const line of lines) {
    if (line.inBlock || !line.key?.endsWith('_IMAGE')) continue;
    if (PINNED_IMAGE.test(line.value)) pinned.add(line.key);
    else problems.push(`line ${line.number}: ${line.key} not pinned by @sha256 digest`);
  }
  lines.forEach((line, index) => {
    if (/^\s*#/.test(line.raw) || !/\bdocker\s+(?:run|pull|create)\b/.test(line.raw)) return;
    const names = [...commandAt(lines, index).matchAll(/\$\{?([A-Z0-9_]+_IMAGE)\b/g)].map((match) => match[1]);
    if (names.length === 0 || names.some((name) => !pinned.has(name))) {
      problems.push(`line ${line.number}: docker command whose image is not a digest-pinned *_IMAGE variable`);
    }
  });
  return problems;
}

function checkRunners(lines: Line[]): string[] {
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.key !== 'runs-on') return;
    const value = line.value || blockOf(lines, index).map((item) => item.text.trim()).join(' ');
    if (/self-hosted/i.test(value)) problems.push(`line ${line.number}: self-hosted runner`);
    else if (value !== RUNNER) problems.push(`line ${line.number}: runner ${value || '(empty)'} is not ${RUNNER}`);
  });
  if (/self-hosted/i.test(lines.map((line) => line.text).join('\n')) &&
      problems.every((problem) => !problem.includes('self-hosted'))) problems.push('self-hosted label outside runs-on');
  return problems;
}

// `allowedToken`: lines where the run's own token may be named (the release profile's gh step).
function checkSecrets(lines: Line[], allowedToken: Set<Line> = new Set()): string[] {
  const problems = new Set<string>();
  for (const line of lines) {
    if (/\bsecrets\s*[.[]/i.test(line.raw) || line.key === 'secrets') problems.add(`line ${line.number}: secret reference`);
    if (/\bgithub\.token\b|\bGITHUB_TOKEN\b/i.test(line.raw) && !allowedToken.has(line)) problems.add(`line ${line.number}: explicit token`);
  }
  // Any use of the secrets context in an expression: toJSON(secrets), secrets['X'], conditions.
  for (const {number, body} of expressions(lines)) {
    if (/\bsecrets\b/i.test(body)) problems.add(`line ${number}: secret reference`);
    if (githubProperties(body).includes('token') && !allowedToken.has(lines[number - 1])) problems.add(`line ${number}: explicit token`);
  }
  return [...problems];
}

// Untrusted pull-request text (titles, branch names) never enters an expression, whether read
// with dots or brackets (`github.event.x`, `github.event['x']`, `github['event']`), and the
// github context is never read whole or by a computed index, which would hide which part.
function checkInjection(lines: Line[], allowBodyEnv = false): string[] {
  const problems: string[] = [];
  for (const {number, body} of expressions(lines)) {
    if (allowBodyEnv && body.trim() === 'github.event.pull_request.body' && BODY_ENV_LINE.test(lines[number - 1].raw)) continue;
    const properties = githubProperties(body);
    if (properties.includes(null)) problems.push(`line ${number}: github context read whole or by a computed index`);
    if (properties.some((name) => name === 'event' || name === 'head_ref')) {
      problems.push(`line ${number}: untrusted event data in an expression`);
    }
  }
  return problems;
}

const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

const FLOW_WITH_NO_CREDENTIALS = /\bwith\s*:\s*\{[^}]*persist-credentials\s*:\s*['"]?false['"]?\s*[,}]/;

// True unless `persist-credentials: false` is a direct input under the step's own `with:`.
function keepsCredentials(lines: Line[], index: number): boolean {
  const line = lines[index];
  if (/\{[^}]*\buses\s*:/.test(line.text)) return !FLOW_WITH_NO_CREDENTIALS.test(line.text);
  const withLine = stepOf(lines, index).find((item) => item.key === 'with' && item.column === line.column);
  if (!withLine) return true;
  if (withLine.value.startsWith('{')) return !FLOW_WITH_NO_CREDENTIALS.test(withLine.text);
  const inputs = blockOf(lines, lines.indexOf(withLine));
  const inputColumn = Math.min(...inputs.map((input) => input.column));
  return !inputs.some((input) => input.column === inputColumn && input.key === 'persist-credentials' && input.value === 'false');
}

function checkActions(lines: Line[]): string[] {
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.inBlock) return;
    for (const action of usesOf(line)) {
      if (action.startsWith('./') || action.startsWith('docker://')) continue;
      if (!PINNED_ACTION.test(action)) {
        problems.push(`line ${line.number}: action ${action} not pinned by full commit SHA`);
      } else if (action.startsWith('actions/checkout@') && keepsCredentials(lines, index)) {
        problems.push(`line ${line.number}: checkout without persist-credentials: false`);
      }
    }
  });
  return problems;
}

function checkTriggers(lines: Line[]): string[] {
  return lines.filter((line) => /\b(pull_request_target|workflow_run)\b/.test(line.text))
    .map((line) => `line ${line.number}: privileged trigger ${/pull_request_target/.test(line.text) ? 'pull_request_target' : 'workflow_run'}`);
}

function checkPermissions(lines: Line[]): string[] {
  const problems: string[] = [];
  let topLevel = false;
  lines.forEach((line, index) => {
    if (line.key !== 'permissions') return;
    if (line.indent === 0) topLevel = true;
    for (const {scope, value, number} of permissionValues(lines, index)) {
      const allowed = scope === '*' ? value === 'read-all' || value === '{}' : value === 'read' || value === 'none';
      if (!allowed) problems.push(`line ${number}: permission ${scope}: ${value || '(empty)'} is not read-only`);
    }
  });
  if (!topLevel) problems.push('no top-level permissions block');
  return problems;
}

// The `site` profile: the top-level token stays read-only, and the Pages deployment job (and no
// other job) may hold exactly `pages: write` and `id-token: write` in its own permissions block.
export const SITE_DEPLOY_JOB = 'deploy';
const SITE_DEPLOY_SCOPES = new Set(['pages', 'id-token']);

function checkSitePermissions(lines: Line[]): string[] {
  const deployLines = new Set(jobBlocks(lines).filter((job) => job.name === SITE_DEPLOY_JOB).flatMap((job) => job.block));
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.key !== 'permissions') return;
    const inDeploy = deployLines.has(line);
    for (const {scope, value, number} of permissionValues(lines, index)) {
      const readOnly = scope === '*' ? value === 'read-all' || value === '{}' : value === 'read' || value === 'none';
      const deployWrite = inDeploy && SITE_DEPLOY_SCOPES.has(scope) && value === 'write';
      if (!readOnly && !deployWrite) problems.push(`line ${number}: permission ${scope}: ${value || '(empty)'} is not read-only`);
    }
  });
  if (!lines.some((line) => line.key === 'permissions' && line.indent === 0)) problems.push('no top-level permissions block');
  return problems;
}

function checkTimeouts(lines: Line[]): string[] {
  return timeoutProblems(lines, () => MAX_TIMEOUT_MINUTES);
}

// The leak check never receives the private list (file, option or non-empty variable).
function checkLeakRules(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    if (/--private\b|rules\.private/.test(line.text)) problems.push(`line ${line.number}: private leak rules`);
    if (line.key === 'MESH_LEAK_PRIVATE_RULES' && line.value !== '') problems.push(`line ${line.number}: private leak rules variable`);
  }
  return problems;
}

export function checkWorkflow(text: string, profile: Profile = 'public'): string[] {
  const lines = parseLines(text);
  const release = profile === 'release';
  const secrets = (items: Line[]) => checkSecrets(items, release ? releaseTokenLines(items) : new Set());
  const checks: ((items: Line[]) => string[])[] = [checkUnparsed, release ? checkReleaseRunners : checkRunners, secrets,
    (items) => checkInjection(items, profile === 'description'), checkActions, checkImages, checkContinueOnError, checkTriggers,
    release ? checkReleasePermissions : profile === 'site' ? checkSitePermissions : checkPermissions, release ? checkReleaseTimeouts : checkTimeouts, checkLeakRules];
  if (!release) checks.push(checkDockerImages);
  if (release) checks.push(...RELEASE_CHECKS);
  return checks.flatMap((check) => check(lines));
}
