// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The site previews (.github/workflows/site-preview.yml and site-preview-cleanup.yml): the
// `pull_request` workflows that hold secrets, the two of a GitHub App that writes the staging
// repository. Their profiles (tests/site-preview-workflow-checks.ts) keep them in the App token step
// of the jobs of the site-preview environment, and the App token in the checkout of the staging
// repository: each fault below is an edit of the committed file that the profile must report, so a
// weakened rule fails here even if the file still looks fine.
// The second part runs .github/scripts/site-preview.sh against throwaway git repositories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {after, describe, test} from 'node:test';
import {checkWorkflow} from './public-ci-workflow-checks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'site-preview.yml'), 'utf8');
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'site-preview.sh');
const cleanupText = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'site-preview-cleanup.yml'), 'utf8');
const problems = (workflow: string): string => checkWorkflow(workflow, 'preview').join('\n');
const cleanupProblems = (workflow: string): string => checkWorkflow(workflow, 'preview-cleanup').join('\n');

// The committed file with `from` replaced by `to` (the first occurrence); `from` must exist, so that
// a renamed line breaks this test instead of silently turning a fault into a no-op.
function edit(from: string, to: string): string {
  assert.ok(text.includes(from), `the workflow no longer contains: ${from}`);
  return text.replace(from, to);
}

const KEY = '${{ secrets.SITE_PREVIEW_APP_PRIVATE_KEY }}';
const APP_TOKEN = '${{ steps.app-token.outputs.token }}';
const HAS_APP_TOKEN = "HAS_APP_TOKEN: ${{ secrets.SITE_PREVIEW_APP_ID != '' && secrets.SITE_PREVIEW_APP_PRIVATE_KEY != '' }}";
const SCOPE = '          repositories: site-staging\n';
const BUILD_PERMISSIONS = "    if: github.event_name == 'pull_request'\n";
const STAGING = '          repository: Session-Mesh/site-staging\n';
const BASE_USES = "      - if: env.HAS_APP_TOKEN == 'true'\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n";
const BASE_CHECKOUT = BASE_USES + '        with:\n          ref: main\n          path: base\n          persist-credentials: false\n';
const GUARD_ENV = '        env:\n          GH_TOKEN: ${{ github.token }}\n';
const PR_ENV = '      PR_NUMBER: ${{ github.event.pull_request.number }}\n';
const PR_GROUP = '      group: site-preview-pr-${{ github.event.pull_request.number }}\n';

// The cleanup workflow with `from` replaced by `to` (the first occurrence).
function editCleanup(from: string, to: string): string {
  assert.ok(cleanupText.includes(from), `the cleanup workflow no longer contains: ${from}`);
  return cleanupText.replace(from, to);
}

describe('the site preview workflows as committed', () => {
  test('satisfy every invariant of the preview profiles', () => {
    assert.equal(problems(text), '');
    assert.equal(cleanupProblems(cleanupText), '');
  });

  test('the preview workflow neither listens to closed pull requests nor has a remove job; the cleanup one has no paths', () => {
    assert.ok(!/^\s+types:.*closed/m.test(text));
    assert.ok(!/^ {2}remove:/m.test(text));
    assert.ok(!/^\s+paths:/m.test(cleanupText));
  });

  test('is refused by the profiles that allow no secret', () => {
    assert.match(checkWorkflow(text, 'public').join('\n'), /secret reference/);
    assert.match(checkWorkflow(text, 'site').join('\n'), /secret reference/);
  });
});

describe('the preview profile reports', () => {
  const faults: [string, string, RegExp][] = [
    ['a privileged trigger', edit('  pull_request:\n', '  pull_request_target:\n'), /pull_request_target/],
    ['another pull_request type', edit('[opened, synchronize, reopened]', '[opened, synchronize, reopened, labeled]'), /types must be/],
    ['the closed type back in the preview workflow', edit('[opened, synchronize, reopened]', '[opened, synchronize, reopened, closed]'), /types must be/],
    ['a pull_request on any branch', edit('    branches: [main]\n', ''), /types, branches and paths/],
    ['a path beyond the site', edit('      - site/**\n', '      - site/**\n      - static/**\n'), /paths must be/],
    ['a second cron', edit('    - cron: "23 4 * * *"\n', '    - cron: "23 4 * * *"\n    - cron: "0 0 * * *"\n'), /exactly one cron/],
    ['an input of the manual run', edit('  workflow_dispatch:\n', '  workflow_dispatch:\n    inputs:\n      days:\n        type: string\n'), /takes no input/],
    ['a write permission', edit('    environment:\n      name: site-preview\n      url:', '      pull-requests: write\n    environment:\n      name: site-preview\n      url:'), /pull-requests: write is not read-only/],
    ['the key in the build job', edit(BUILD_PERMISSIONS, `${BUILD_PERMISSIONS}    env:\n      ${HAS_APP_TOKEN}\n`), /build must hold no secret[\s\S]*|does not run in the site-preview environment/],
    ['a job holding the key outside the environment', edit('    environment:\n      name: site-preview\n    concurrency:\n      group: site-preview-expire', '    concurrency:\n      group: site-preview-expire'), /does not run in the site-preview environment/],
    ['another secret', edit("      PR_NUMBER: ${{ github.event.pull_request.number }}\n", "      PR_NUMBER: ${{ github.event.pull_request.number }}\n      OTHER: ${{ secrets.OTHER }}\n"), /secret other than SITE_PREVIEW_APP_ID and SITE_PREVIEW_APP_PRIVATE_KEY/],
    ['secrets passed on', edit('    needs: build\n', '    needs: build\n    secrets: inherit\n'), /secrets passed on/],
    ['the key in a step env', edit('      - name: Publish the preview\n        id: publish\n', `      - name: Publish the preview\n        id: publish\n        env:\n          KEY: ${KEY}\n`), /secret read outside the expected form/],
    ['the private key handed to the checkout of this repository', edit('          persist-credentials: false\n      - if: env.HAS_APP_TOKEN', `          private-key: ${KEY}\n          persist-credentials: false\n      - if: env.HAS_APP_TOKEN`), /secret handed to a step other than actions\/create-github-app-token/],
    ['the App token handed to another step', edit('      - name: Publish the preview\n        id: publish\n', `      - name: Publish the preview\n        id: publish\n        env:\n          TOKEN: ${APP_TOKEN}\n`), /App token used elsewhere than as the token of the checkout/],
    ['the App token for the checkout of this repository', edit('          persist-credentials: false\n      - if: env.HAS_APP_TOKEN', `          token: ${APP_TOKEN}\n          persist-credentials: false\n      - if: env.HAS_APP_TOKEN`), /App token used elsewhere than as the token of the checkout/],
    ['an App token for every repository of the App', edit(SCOPE, ''), /takes exactly app-id, owner, permission-contents, private-key, repositories/],
    ['an App token for another repository', edit(SCOPE, '          repositories: session-mesh\n'), /repositories must be site-staging/],
    ['an App token with more permissions', edit('          permission-contents: write\n', '          permission-contents: write\n          permission-workflows: write\n'), /takes exactly/],
    ['an App token for another owner', edit('          owner: Session-Mesh\n', '          owner: someone-else\n'), /owner must be Session-Mesh/],
    ['an unguarded App token step', edit("        id: app-token\n        if: env.HAS_APP_TOKEN == 'true'\n", "        id: app-token\n"), /must be guarded by if: env.HAS_APP_TOKEN/],
    ['a job without the HAS_APP_TOKEN gate', edit(`      ${HAS_APP_TOKEN}\n      PR_NUMBER`, '      PR_NUMBER'), /env HAS_APP_TOKEN must be/],
    ['a checkout of another repository with the key', edit(STAGING, '          repository: Session-Mesh/session-mesh\n'), /checkout of Session-Mesh\/session-mesh/],
    ['an extra input of the staging checkout', edit(STAGING, `${STAGING}          ref: main\n`), /exactly path, repository and token/],
    ['the staging checkout at another path', edit('          path: staging\n', '          path: preview-output\n'), /must take path: staging/],
    ['a publish job that does not wait for the build', edit('    needs: build\n', ''), /must declare needs: build/],
    ['a checkout that keeps its credentials', edit('          path: base\n          persist-credentials: false\n      - uses: actions/setup-node', '          path: base\n          fetch-depth: 1\n      - uses: actions/setup-node'), /without persist-credentials: false/],
    ['an unpinned action', edit('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'actions/setup-node@v7'), /not pinned by full commit SHA/],
    ['an action not on the list', edit('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', `actions/cache@${'a'.repeat(40)}`), /is not one of/],
    ['the run token', edit('      PR_NUMBER: ${{ github.event.pull_request.number }}\n', '      PR_NUMBER: ${{ github.event.pull_request.number }}\n      GH_TOKEN: ${{ github.token }}\n'), /explicit token/],
    ['a title in an expression', edit('      PR_NUMBER: ${{ github.event.pull_request.number }}\n', '      PR_NUMBER: ${{ github.event.pull_request.number }}\n      TITLE: ${{ github.event.pull_request.title }}\n'), /github\.event\.pull_request\.title/],
    ['the head branch', edit('      PR_NUMBER: ${{ github.event.pull_request.number }}\n', '      PR_NUMBER: ${{ github.event.pull_request.number }}\n      BRANCH: ${{ github.head_ref }}\n'), /head_ref/],
    ['the build job in the environment', edit(BUILD_PERMISSIONS, `${BUILD_PERMISSIONS}    environment: site-preview\n`), /build must run in no environment/],
    ['a monthly schedule instead of the daily one', edit('"23 4 * * *"', '"23 4 1 * *"'), /cron must be 23 4 \* \* \*/],
    ['the App token read through an indexed form', edit('      - name: Publish the preview\n        id: publish\n', "      - name: Publish the preview\n        id: publish\n        env:\n          TOKEN: ${{ steps['app-token'].outputs.token }}\n"), /App token used elsewhere than as the token of the checkout/],
    ['the App token read through an indexed output', edit('      - name: Publish the preview\n        id: publish\n', "      - name: Publish the preview\n        id: publish\n        env:\n          TOKEN: ${{ steps.app-token.outputs['token'] }}\n"), /App token used elsewhere than as the token of the checkout/],
    ['the build job outside the per-pull-request concurrency group', edit(`    concurrency:\n${PR_GROUP}      cancel-in-progress: false\n`, ''), /job build: concurrency group must be/],
    ['the publish job in another concurrency group', edit(`    concurrency:\n${PR_GROUP}      cancel-in-progress: false\n    env:`, '    concurrency:\n      group: site-preview-other\n      cancel-in-progress: false\n    env:'), /job build: concurrency group must be|job publish: concurrency group must be/],
    ['a publish job that cancels runs in progress', edit(`${PR_GROUP}      cancel-in-progress: false\n    env:\n      # Only`, `${PR_GROUP}      cancel-in-progress: true\n    env:\n      # Only`), /cancel-in-progress: false/],
    ['a script run from the pull request checkout in a job that holds the token', edit('run: bash base/.github/scripts/site-preview.sh expire-push', 'run: bash .github/scripts/site-preview.sh expire-push'), /runs a script that is not base\/\.github\/scripts\//],
    ['a plain checkout of the pull request in a job that holds the token', edit(BASE_CHECKOUT, BASE_USES + '        with:\n          persist-credentials: false\n'), /checks out files other than main|without a checkout of main/],
    ['a base checkout of the head revision', edit('          ref: main\n', '          ref: ${{ github.event.pull_request.head.sha }}\n'), /base checkout takes exactly ref: main/],
    ['a base checkout that keeps its credentials', edit(BASE_CHECKOUT, BASE_USES + '        with:\n          ref: main\n          path: base\n'), /without persist-credentials: false/],
    ['a base checkout with an extra input', edit(BASE_CHECKOUT, `${BASE_CHECKOUT}          fetch-depth: 0\n`), /base checkout takes exactly/],
    ['the run token outside the guard step', edit('      - name: Publish the preview\n        id: publish\n', `      - name: Publish the preview\n        id: publish\n${GUARD_ENV}`), /run token is allowed only as the env of the guard step/],
    ['the run token in the build job', edit(BUILD_PERMISSIONS, `${BUILD_PERMISSIONS}    env:\n      GH_TOKEN: \${{ github.token }}\n`), /run token is allowed only as the env of the guard step/],
    ['the run token named twice in the guard step', edit(GUARD_ENV, `${GUARD_ENV}          GH_TOKEN: \${{ github.token }}\n`), /named more than once/],
    ['the run token under another name', edit(GUARD_ENV, '        env:\n          TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'), /explicit token/],
    ['pull-requests: read in a job other than publish', edit('    permissions:\n      contents: read\n    environment:\n      name: site-preview\n    concurrency:\n      group: site-preview-expire', '    permissions:\n      contents: read\n      pull-requests: read\n    environment:\n      name: site-preview\n    concurrency:\n      group: site-preview-expire'), /job expire may not hold pull-requests: read/],
    ['another read scope in the publish job', edit('      pull-requests: read\n', '      pull-requests: read\n      issues: read\n'), /job publish may not hold issues: read/],
    ['the App token step not gated on the guard outcome or the credentials', edit("        if: env.HAS_APP_TOKEN == 'true' && steps.guard.outputs.proceed == 'true'\n        uses: actions/create", "        if: steps.guard.outputs.proceed == 'true'\n        uses: actions/create"), /must be guarded by if: env.HAS_APP_TOKEN/],
    ['the pull request head branch name', edit(PR_ENV, `${PR_ENV}      BRANCH: \${{ github.event.pull_request.head.ref }}\n`), /github\.event\.pull_request\.head\.ref/],
    ['the head repository', edit(PR_ENV, `${PR_ENV}      REPO: \${{ github.event.pull_request.head.repo.full_name }}\n`), /github\.event\.pull_request\.head\.repo\.full_name/],
    ['the event action', edit(BUILD_PERMISSIONS, "    if: github.event.action != 'closed'\n"), /github\.event\.action/],
    ['a head revision followed by another property', edit(PR_ENV, `${PR_ENV}      X: \${{ github.event.pull_request.head.sha.foo }}\n`), /head\.sha\.foo|head is named/],
    ['a build job whose gate reference is the pull request own copy', edit('site-stage.sh "$RUNNER_TEMP/site-stage" base\n', 'site-stage.sh "$RUNNER_TEMP/site-stage"\n'), /must stage with the reference of main/],
    ['a build job without the checkout of main', edit('      # Read-only checkout of main, the reference of the policy gate: the pull request cannot weaken the\n      # policy it is checked against.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: main\n          path: base\n          persist-credentials: false\n', ''), /must check out main in base\//],
    ['a publish job that does not re-run the gate', edit('run: node base/.github/scripts/site-csp-check.mjs base/site/index.html "$RUNNER_TEMP/site-stage" base/site', 'run: echo skipped'), /must re-run the gate from main on the artifact/],
    ['a publish gate whose reference is the artifact itself', edit('base/site/index.html "$RUNNER_TEMP/site-stage" base/site', '"$RUNNER_TEMP/site-stage/index.html" "$RUNNER_TEMP/site-stage" "$RUNNER_TEMP/site-stage"'), /must re-run the gate from main on the artifact/],
    ['a publish gate that runs the pull request copy of the script', edit('run: node base/.github/scripts/site-csp-check.mjs', 'run: node .github/scripts/site-csp-check.mjs'), /must re-run the gate from main|runs a script that is not base/],
    ['a publish gate that runs after the App token exists', edit("      # The artifact is data from the pull request: check it again, with the gate and the reference of\n      # main, before the token exists.\n      - name: Check the artifact against main\n        if: env.HAS_APP_TOKEN == 'true' && steps.guard.outputs.proceed == 'true'\n        run: node base/.github/scripts/site-csp-check.mjs base/site/index.html \"$RUNNER_TEMP/site-stage\" base/site\n", '').replace('      - name: Publish the preview\n', "      - name: Check the artifact against main\n        run: node base/.github/scripts/site-csp-check.mjs base/site/index.html \"$RUNNER_TEMP/site-stage\" base/site\n      - name: Publish the preview\n"), /after downloading the artifact and before creating the App token/],
    ['a second remove job',edit('  expire:\n', '  remove:\n    runs-on: ubuntu-24.04\n  expire:\n'), /jobs are build, publish, remove, expire/],
    ['a job without a timeout',edit('    name: remove expired previews\n    if: github.event_name == \'schedule\' || github.event_name == \'workflow_dispatch\'\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n', '    name: remove expired previews\n    if: github.event_name == \'schedule\' || github.event_name == \'workflow_dispatch\'\n    runs-on: ubuntu-24.04\n'), /job expire: no timeout-minutes/],
  ];
  for (const [name, workflow, expected] of faults) {
    test(name, () => assert.match(problems(workflow), expected));
  }
});

describe('the preview-cleanup profile reports', () => {
  const faults: [string, string, RegExp][] = [
    ['a paths filter', editCleanup('    branches: [main]\n', '    branches: [main]\n    paths:\n      - site/**\n'), /exactly types and branches/],
    ['another type', editCleanup('[closed]', '[closed, opened]'), /types must be \[closed\]/],
    ['no closed type', editCleanup('[closed]', '[opened]'), /types must be \[closed\]/],
    ['a pull_request on any branch', editCleanup('    branches: [main]\n', ''), /exactly types and branches/],
    ['a privileged trigger', editCleanup('  pull_request:\n', '  pull_request_target:\n'), /pull_request_target/],
    ['a schedule beside the closing trigger', editCleanup('permissions:\n  contents: read\n\ndefaults', '  schedule:\n    - cron: "1 1 * * *"\n\npermissions:\n  contents: read\n\ndefaults'), /expected pull_request only/],
    ['another job name', editCleanup('  remove:\n', '  cleanup:\n'), /jobs are cleanup, expected remove/],
    ['the script run from the pull request checkout', editCleanup('bash base/.github/scripts/site-preview.sh remove', 'bash .github/scripts/site-preview.sh remove'), /runs a script that is not base\/\.github\/scripts\//],
    ['no checkout of main', editCleanup(BASE_CHECKOUT, BASE_USES + '        with:\n          persist-credentials: false\n'), /checks out files other than main|without a checkout of main/],
    ['another concurrency group than the publishing jobs', editCleanup(PR_GROUP, '      group: site-preview-cleanup\n'), /concurrency group must be site-preview-pr-/],
    ['the run token', editCleanup(PR_ENV, `${PR_ENV}      GH_TOKEN: \${{ github.token }}\n`), /explicit token/],
    ['a read of the head revision beside a title', editCleanup(PR_ENV, `${PR_ENV}      T: \${{ github.event.pull_request.title }}\n`), /github\.event\.pull_request\.title/],
    ['the key outside the environment', editCleanup('    environment:\n      name: site-preview\n', ''), /does not run in the site-preview environment/],
    ['a job without a timeout', editCleanup('    timeout-minutes: 10\n', ''), /job remove: no timeout-minutes/],
  ];
  for (const [name, workflow, expected] of faults) {
    test(name, () => assert.match(cleanupProblems(workflow), expected));
  }
});

// ---------------------------------------------------------------- the script

type Run = {status: number | null; stdout: string; stderr: string};

const GIT_ENV = {...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {cwd, env: GIT_ENV, encoding: 'utf8'});
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function preview(...args: string[]): Run {
  const result = spawnSync('bash', [SCRIPT, ...args], {env: GIT_ENV, encoding: 'utf8'});
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
}

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, {recursive: true, force: true}); });

// A bare staging repository with one commit on main, and a clone of it.
function staging(): {dir: string; remote: string; checkout: string; staged: string} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-preview-'));
  temporary.push(dir);
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', remote, 'main');
  const checkout = path.join(dir, 'checkout');
  git(dir, 'clone', '-q', remote, checkout);
  const staged = path.join(dir, 'staged');
  fs.mkdirSync(path.join(staged, 'assets'), {recursive: true});
  fs.writeFileSync(path.join(staged, 'index.html'), '<!doctype html>\n<head>\n<meta charset="utf-8">\n<title>t</title>\n</head>\n');
  fs.writeFileSync(path.join(staged, 'assets', 'a.txt'), 'a\n');
  return {dir, remote, checkout, staged};
}

const subject = (checkout: string): string => git(checkout, 'log', '-1', '--format=%s');
const commits = (checkout: string): number => Number(git(checkout, 'rev-list', '--count', 'HEAD'));

describe('site-preview.sh publish', () => {
  test('copies the staged site into pr-<n>/ with a noindex tag and its publication time, in one commit', () => {
    const {checkout, staged} = staging();
    const run = preview('publish', staged, checkout, '29', '1000');
    assert.equal(run.status, 0, run.stderr);
    const home = fs.readFileSync(path.join(checkout, 'pr-29', 'index.html'), 'utf8');
    assert.match(home, /<meta charset="utf-8">\n<meta name="robots" content="noindex">\n/);
    assert.equal(fs.readFileSync(path.join(checkout, 'pr-29', '.published'), 'utf8').trim(), '1000');
    assert.equal(fs.readFileSync(path.join(checkout, 'pr-29', 'assets', 'a.txt'), 'utf8'), 'a\n');
    assert.equal(subject(checkout), 'Publish the preview of pull request #29');
    assert.equal(git(checkout, 'log', '-1', '--format=%an <%ae>'), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
    assert.equal(git(checkout, 'status', '--porcelain'), '');
  });

  test('replaces an earlier preview: a file gone from the site is gone from the preview', () => {
    const {checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '29', '1000').status, 0);
    fs.rmSync(path.join(staged, 'assets', 'a.txt'));
    fs.writeFileSync(path.join(staged, 'b.txt'), 'b\n');
    assert.equal(preview('publish', staged, checkout, '29', '2000').status, 0);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-29', 'assets', 'a.txt')), false);
    assert.equal(fs.readFileSync(path.join(checkout, 'pr-29', 'b.txt'), 'utf8'), 'b\n');
    assert.equal(git(checkout, 'ls-files', 'pr-29/assets/a.txt'), '');
  });

  test('never writes a CNAME into the preview', () => {
    const {checkout, staged} = staging();
    fs.writeFileSync(path.join(staged, 'CNAME'), 'session-mesh.com\n');
    assert.equal(preview('publish', staged, checkout, '7', '1000').status, 0);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-7', 'CNAME')), false);
  });

  for (const bad of ['0', '../x', '1a', '', '-1', '12345678901']) {
    test(`refuses the pull request number '${bad}' and changes nothing`, () => {
      const {checkout, staged} = staging();
      const run = preview('publish', staged, checkout, bad, '1000');
      assert.equal(run.status, 2);
      assert.equal(commits(checkout), 1);
      assert.deepEqual(fs.readdirSync(checkout).filter((name) => name !== '.git').sort(), ['robots.txt']);
    });
  }

  test('refuses a staged directory without a home page', () => {
    const {dir, checkout} = staging();
    fs.mkdirSync(path.join(dir, 'empty'));
    assert.equal(preview('publish', path.join(dir, 'empty'), checkout, '3', '1000').status, 2);
    assert.equal(commits(checkout), 1);
  });
});

describe('site-preview.sh remove', () => {
  test('deletes pr-<n>/ in one commit and leaves the other previews', () => {
    const {checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '29', '1000').status, 0);
    assert.equal(preview('publish', staged, checkout, '30', '1000').status, 0);
    const run = preview('remove', checkout, '29');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-29')), false);
    assert.ok(fs.existsSync(path.join(checkout, 'pr-30', 'index.html')));
    assert.equal(subject(checkout), 'Remove the preview of pull request #29');
    assert.equal(git(checkout, 'status', '--porcelain'), '');
  });

  test('is a no-op without a preview', () => {
    const {checkout} = staging();
    const run = preview('remove', checkout, '29');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(commits(checkout), 1);
  });
});

describe('site-preview.sh expire', () => {
  const DAY = 86400;

  test('deletes the previews older than the limit, or without a valid publication time, and keeps the others', () => {
    const {checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '1', String(1000)).status, 0);
    assert.equal(preview('publish', staged, checkout, '2', String(1000 + 10 * DAY)).status, 0);
    assert.equal(preview('publish', staged, checkout, '3', String(1000)).status, 0);
    fs.writeFileSync(path.join(checkout, 'pr-3', '.published'), 'soon\n');
    fs.mkdirSync(path.join(checkout, 'pr-notes'));
    fs.writeFileSync(path.join(checkout, 'pr-notes', 'keep.txt'), 'k\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'fixture');
    const run = preview('expire', checkout, '14', String(1000 + 15 * DAY));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-1')), false);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-3')), false);
    assert.ok(fs.existsSync(path.join(checkout, 'pr-2', 'index.html')));
    assert.ok(fs.existsSync(path.join(checkout, 'pr-notes', 'keep.txt')), 'a folder not named pr-<number> is left alone');
    assert.equal(subject(checkout), 'Expire 2 preview(s) older than 14 days');
    assert.equal(git(checkout, 'status', '--porcelain'), '');
  });

  test('makes no commit when nothing is old enough', () => {
    const {checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '1', String(1000)).status, 0);
    const before = commits(checkout);
    assert.equal(preview('expire', checkout, '14', String(1000 + 13 * DAY)).status, 0);
    assert.equal(commits(checkout), before);
  });

  test('refuses a number of days that is not a positive number', () => {
    const {checkout} = staging();
    assert.equal(preview('expire', checkout, 'x').status, 2);
    assert.equal(preview('expire', checkout, '0').status, 2);
  });
});

describe('site-preview.sh push', () => {
  test('pushes, and rebases on a concurrent push that changed another preview', () => {
    const {dir, remote, checkout, staged} = staging();
    const other = path.join(dir, 'other');
    git(dir, 'clone', '-q', remote, other);
    assert.equal(preview('publish', staged, other, '41', '1000').status, 0);
    assert.equal(preview('push', other).status, 0);
    assert.equal(preview('publish', staged, checkout, '42', '1000').status, 0);
    const run = preview('push', checkout);
    assert.equal(run.status, 0, run.stderr);
    const files = git(dir, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main');
    assert.match(files, /^pr-41\/index\.html$/m);
    assert.match(files, /^pr-42\/index\.html$/m);
  });

  test('fails on a conflict with a concurrent change of the same preview', () => {
    const {dir, remote, checkout, staged} = staging();
    const other = path.join(dir, 'other');
    git(dir, 'clone', '-q', remote, other);
    assert.equal(preview('publish', staged, other, '41', '1000').status, 0);
    assert.equal(preview('push', other).status, 0);
    assert.equal(preview('publish', staged, checkout, '41', '2000').status, 0);
    const run = preview('push', checkout);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /conflict/);
  });
});

describe('site-preview.sh checkout argument', () => {
  test('must be the root of a worktree: a sub-folder is refused by every command and nothing is written', () => {
    const {checkout, staged} = staging();
    fs.mkdirSync(path.join(checkout, 'sub'));
    const sub = path.join(checkout, 'sub');
    for (const run of [preview('publish', staged, sub, '5', '1000'), preview('remove', sub, '5'), preview('expire', sub, '14', '1000'),
      preview('expire-push', sub, '14', '1000'), preview('push', sub)]) {
      assert.equal(run.status, 2);
      assert.match(run.stderr, /not the root of its git worktree/);
    }
    assert.equal(fs.existsSync(path.join(sub, 'pr-5')), false);
    assert.equal(commits(checkout), 1);
  });

  test('may be given by a path with a trailing slash or a symbolic link to the root', () => {
    const {dir, checkout, staged} = staging();
    const link = path.join(dir, 'link');
    fs.symlinkSync(checkout, link);
    assert.equal(preview('publish', staged, `${checkout}/`, '5', '1000').status, 0);
    assert.equal(preview('remove', link, '5').status, 0);
  });

  test('must have an empty index: staged changes are not committed with a preview, and nothing changes', () => {
    const {checkout, staged} = staging();
    fs.writeFileSync(path.join(checkout, 'robots.txt'), 'User-agent: *\nAllow: /\n');
    git(checkout, 'add', 'robots.txt');
    for (const run of [preview('publish', staged, checkout, '5', '1000'), preview('remove', checkout, '5'), preview('expire', checkout, '14', '1000')]) {
      assert.equal(run.status, 2);
      assert.match(run.stderr, /staged changes/);
    }
    assert.equal(commits(checkout), 1);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-5')), false);
    assert.equal(git(checkout, 'diff', '--cached', '--name-only'), 'robots.txt');
  });
});

describe('site-preview.sh publish, building the replacement first', () => {
  const homeWith = (head: string): string => `<!doctype html>\n${head}\n<title>t</title>\n`;

  // The tag lands right after the charset line, or after <head> when there is none.
  const variants: [string, string, RegExp][] = [
    ['an upper-case charset', '<head>\n<META CHARSET="UTF-8">', /<META CHARSET="UTF-8">\n<meta name="robots" content="noindex">\n/],
    ['a self-closing charset with spaces', '<head>\n<meta  charset = "utf-8" />', /<meta {2}charset = "utf-8" \/>\n<meta name="robots" content="noindex">\n/],
    ['no charset line, a head with an attribute', '<head lang="en">\n<link rel="icon" href="x">', /<head lang="en">\n<meta name="robots" content="noindex">\n/],
    ['an upper-case head', '<HEAD>', /<HEAD>\n<meta name="robots" content="noindex">\n/],
  ];
  for (const [name, head, expected] of variants) {
    test(`inserts the robots tag with ${name}, once`, () => {
      const {checkout, staged} = staging();
      fs.writeFileSync(path.join(staged, 'index.html'), homeWith(head));
      const run = preview('publish', staged, checkout, '8', '1000');
      assert.equal(run.status, 0, run.stderr);
      const home = fs.readFileSync(path.join(checkout, 'pr-8', 'index.html'), 'utf8');
      assert.match(home, expected);
      assert.equal(home.split('name="robots"').length, 2);
    });
  }

  test('does not anchor the robots tag in a comment, with a charset or a head in it', () => {
    for (const head of ['<!-- <meta charset="utf-8"> -->\n<head>\n<meta charset="UTF-8">', '<!--\n<head>\n-->\n<head>', '<!-->\n<head>']) {
      const {checkout, staged} = staging();
      fs.writeFileSync(path.join(staged, 'index.html'), homeWith(head));
      assert.equal(preview('publish', staged, checkout, '8', '1000').status, 0);
      const home = fs.readFileSync(path.join(checkout, 'pr-8', 'index.html'), 'utf8');
      assert.equal(home.split('name="robots"').length, 2);
      assert.match(home, /\n(<meta charset="UTF-8">|<head>)\n<meta name="robots" content="noindex">\n/);
      assert.doesNotMatch(home, /<!--[^]*name="robots"[^]*-->\n<head>/);
    }
  });

  test('a header element is not the head', () => {
    const {checkout, staged} = staging();
    fs.writeFileSync(path.join(staged, 'index.html'), '<header>x</header>\n<head>\n</head>\n');
    assert.equal(preview('publish', staged, checkout, '8', '1000').status, 0);
    assert.match(fs.readFileSync(path.join(checkout, 'pr-8', 'index.html'), 'utf8'), /<head>\n<meta name="robots" content="noindex">\n/);
  });

  test('a home page with no head leaves the earlier preview, the index and the history untouched', () => {
    const {checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '8', '1000').status, 0);
    const before = git(checkout, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(staged, 'index.html'), '<p>no head here</p>\n');
    fs.writeFileSync(path.join(staged, 'new.txt'), 'n\n');
    const run = preview('publish', staged, checkout, '8', '2000');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no <head>/);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(git(checkout, 'status', '--porcelain'), '');
    assert.match(fs.readFileSync(path.join(checkout, 'pr-8', 'index.html'), 'utf8'), /<title>t<\/title>/);
    assert.equal(fs.readFileSync(path.join(checkout, 'pr-8', '.published'), 'utf8').trim(), '1000');
    assert.equal(fs.existsSync(path.join(checkout, 'pr-8', 'new.txt')), false);
    assert.deepEqual(fs.readdirSync(path.join(checkout, '.git')).filter((name) => name.startsWith('preview-')), []);
  });

  test('refuses a symbolic link in the staged site and changes nothing', () => {
    const {checkout, staged} = staging();
    fs.symlinkSync('/etc/passwd', path.join(staged, 'link.txt'));
    const run = preview('publish', staged, checkout, '8', '1000');
    assert.equal(run.status, 2);
    assert.match(run.stderr, /symbolic link/);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-8')), false);
  });
});

describe('site-preview.sh expire-push', () => {
  const DAY = 86400;

  test('expires and pushes in one command', () => {
    const {dir, remote, checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '1', '1000').status, 0);
    assert.equal(preview('push', checkout).status, 0);
    const run = preview('expire-push', checkout, '14', String(1000 + 15 * DAY));
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(git(dir, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'), /pr-1\//);
  });

  test('when a concurrent run refreshed one of the previews, keeps it and still removes the others', () => {
    const {dir, remote, checkout, staged} = staging();
    const other = path.join(dir, 'other');
    assert.equal(preview('publish', staged, checkout, '29', '1000').status, 0);
    assert.equal(preview('publish', staged, checkout, '30', '1000').status, 0);
    assert.equal(preview('push', checkout).status, 0);
    git(dir, 'clone', '-q', remote, other);
    // The other run republishes pr-29 (a new .published) and pushes first.
    assert.equal(preview('publish', staged, other, '29', String(1000 + 14 * DAY)).status, 0);
    assert.equal(preview('push', other).status, 0);
    const run = preview('expire-push', checkout, '14', String(1000 + 15 * DAY));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /expiring again on the new tip/);
    const files = git(dir, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main');
    assert.match(files, /^pr-29\/index\.html$/m);
    assert.doesNotMatch(files, /pr-30\//);
    assert.equal(git(dir, '--git-dir', remote, 'show', 'main:pr-29/.published'), String(1000 + 14 * DAY));
    assert.equal(git(checkout, 'status', '--porcelain'), '');
  });

  test('refuses a checkout that holds a commit not on origin, which the retry would drop', () => {
    const {checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '1', '1000').status, 0);
    const run = preview('expire-push', checkout, '14', String(1000 + 15 * DAY));
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not on origin\/main/);
    assert.equal(fs.existsSync(path.join(checkout, 'pr-1')), true);
  });

  test('a push refused three times fails the run', () => {
    const {dir, checkout, staged} = staging();
    assert.equal(preview('publish', staged, checkout, '1', '1000').status, 0);
    assert.equal(preview('push', checkout).status, 0);
    // A hook that refuses every push: the remote is bare, so it lives in its hooks folder.
    const hook = path.join(dir, 'remote.git', 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', {mode: 0o755});
    const run = preview('expire-push', checkout, '14', String(1000 + 15 * DAY));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /still refused after 3 attempts/);
  });
});

describe('site-preview.sh guard', () => {
  const HEAD = 'a'.repeat(40);

  // A fake `gh` that prints what GH_FAKE says, or fails.
  function withFakeGh(output: string, fail = false): {env: NodeJS.ProcessEnv; out: string; dir: string} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-preview-gh-'));
    temporary.push(dir);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" > "${dir}/args"\n${fail ? 'exit 1\n' : `printf '%s\\n' '${output}'\n`}`, {mode: 0o755});
    const out = path.join(dir, 'out');
    fs.writeFileSync(out, '');
    return {env: {...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'Session-Mesh/session-mesh', GITHUB_OUTPUT: out}, out, dir};
  }

  function guard(pr: string, head: string, fake: ReturnType<typeof withFakeGh>, env: NodeJS.ProcessEnv = {}): Run {
    const result = spawnSync('bash', [SCRIPT, 'guard', pr, head], {env: {...fake.env, ...env}, encoding: 'utf8'});
    return {status: result.status, stdout: result.stdout, stderr: result.stderr};
  }

  test('proceeds when the pull request is open at the revision of the run, asking for that pull request only', () => {
    const fake = withFakeGh(`open\t${HEAD}`);
    const run = guard('34', HEAD, fake);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(fake.out, 'utf8'), 'proceed=true\n');
    assert.equal(fs.readFileSync(path.join(fake.dir, 'args'), 'utf8').trim(), "api repos/Session-Mesh/session-mesh/pulls/34 -q [.state,.head.sha]|@tsv");
  });

  test('does not proceed when the pull request is closed (a run that finishes after the removal)', () => {
    const fake = withFakeGh(`closed\t${HEAD}`);
    const run = guard('34', HEAD, fake);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(fake.out, 'utf8'), 'proceed=false\n');
    assert.match(run.stdout, /pull request #34 is closed/);
  });

  test('does not proceed when the head moved on (an older revision finishing after a newer one)', () => {
    const fake = withFakeGh(`open\t${'b'.repeat(40)}`);
    const run = guard('34', HEAD, fake);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(fake.out, 'utf8'), 'proceed=false\n');
  });

  test('fails closed when GitHub cannot be asked, writing no decision', () => {
    const fake = withFakeGh('', true);
    const run = guard('34', HEAD, fake);
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(fake.out, 'utf8'), '');
  });

  test('refuses a number, a revision or a repository that is not well formed', () => {
    const fake = withFakeGh(`open\t${HEAD}`);
    assert.equal(guard('../34', HEAD, fake).status, 2);
    assert.equal(guard('34', 'main', fake).status, 2);
    assert.equal(guard('34', HEAD.toUpperCase(), fake).status, 2);
    assert.equal(guard('34', HEAD, fake, {GITHUB_REPOSITORY: 'a/b/../c'}).status, 2);
    assert.equal(fs.readFileSync(fake.out, 'utf8'), '');
  });
});

test('site-preview.sh refuses an unknown command or missing arguments', () => {
  assert.equal(preview().status, 2);
  assert.equal(preview('deploy').status, 2);
  assert.equal(preview('remove', os.tmpdir()).status, 2);
});
