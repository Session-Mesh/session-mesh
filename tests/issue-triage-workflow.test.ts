// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Invariants of .github/workflows/issue-triage.yml, read line by line (no YAML parser among the pinned
// dependencies; tests/workflow-yaml-plain-scalars.test.ts guards the YAML syntax).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {parseLines, usesOf} from './public-ci-workflow-lib.ts';
import {checkWorkflow} from './public-ci-workflow-checks.ts';

const FILE = path.join(import.meta.dirname, '..', '.github', 'workflows', 'issue-triage.yml');
const text = fs.readFileSync(FILE, 'utf8');
const lines = parseLines(text);
const code = lines.filter(line => !line.inBlock && line.text.trim() !== '');
// The step that runs the script, from its `- name:` line to the next step.
const scriptStart = lines.findIndex(line => line.raw.includes('- name: Classify the issue'));
// It stops at the next step (a `- ` line at the same indent), so that an `env:` of a later step cannot satisfy an assertion about this one.
const nextStep = lines.findIndex((line, index) => index > scriptStart && line.indent <= lines[scriptStart].indent && line.text.trim() !== '');
const scriptStep = lines.slice(scriptStart, nextStep < 0 ? undefined : nextStep).filter((line, index) => index === 0 || line.text.trim() === '' || line.indent > lines[scriptStart].indent);
const topKeys = (key: string) => code.filter(line => line.indent === 0 && line.key === key);

describe('issue-triage workflow', () => {
  test('triggers: issues opened and a manual dispatch, nothing else', () => {
    const onStart = lines.findIndex(line => line.indent === 0 && line.key === 'on');
    const triggers = lines.slice(onStart + 1).filter(line => line.text.trim() !== '' && line.indent === 2).map(line => line.key);
    const end = lines.findIndex((line, index) => index > onStart && line.indent === 0 && line.text.trim() !== '');
    const inOn = lines.slice(onStart + 1, end).filter(line => line.text.trim() !== '' && line.indent === 2).map(line => line.key);
    assert.deepEqual(inOn, ['issues', 'workflow_dispatch']);
    assert.ok(triggers.length >= 2);
    assert.match(text, /issues:\n {4}types: \[opened\]\n/);
    for (const forbidden of ['pull_request', 'pull_request_target', 'schedule', 'issue_comment', 'workflow_run', 'edited', 'reopened', 'labeled']) {
      assert.ok(!code.some(line => line.key === forbidden || line.text.includes(`[${forbidden}`)), forbidden);
    }
  });

  test('dispatch inputs: a required number and a boolean dry run defaulting to true', () => {
    assert.match(text, /issue_number:\n {8}description: .*\n {8}required: true\n {8}type: number\n/);
    assert.match(text, /dry_run:\n {8}description: .*\n {8}required: false\n {8}type: boolean\n {8}default: true\n/);
  });

  test('permissions: none at workflow level, actions: read, contents: read and issues: write on the job, nothing more', () => {
    assert.match(text, /^permissions: \{\}$/m);
    assert.equal(topKeys('permissions').length, 1);
    assert.match(text, /^ {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n {4}steps:/m);
    assert.equal(code.filter(line => line.key === 'permissions').length, 2);
    assert.ok(!/(write-all|read-all)/.test(text));
    assert.equal(code.filter(line => /^(contents|pull-requests|actions|checks|id-token|packages|statuses|security-events|deployments):/.test(line.text.trim()) && line.value === 'write').length, 0);
  });

  test('one job, 8 minutes, one global job-level concurrency group for issue events without cancelling, environment issue-triage', () => {
    assert.equal(code.filter(line => line.indent === 2 && line.key !== null && /^ {2}[a-z-]+:$/.test(line.text) && line.text.trim() === 'triage:').length, 1);
    assert.match(text, /^ {4}timeout-minutes: 8$/m);
    assert.match(text, /^ {4}environment: issue-triage$/m);
    assert.match(text, /^ {4}concurrency:\n {6}group: issue-triage-\$\{\{ github\.event_name == 'issues' && 'global' \|\| format\('dispatch-\{0\}-\{1\}', inputs\.issue_number, inputs\.dry_run\) \}\}\n {6}cancel-in-progress: false$/m);
    assert.equal(topKeys('concurrency').length, 0);
    assert.equal(code.filter(line => line.key === 'concurrency').length, 1);
    assert.equal(code.filter(line => line.key === 'cancel-in-progress' && line.value !== 'false').length, 0);
  });

  test('the abuse controls come from repository variables, nothing else is added to the step environment', () => {
    assert.match(text, /^ {10}TRIAGE_ENABLED: \$\{\{ vars\.TRIAGE_ENABLED \}\}$/m);
    assert.match(text, /^ {10}TRIAGE_DAILY_CAP: \$\{\{ vars\.TRIAGE_DAILY_CAP \}\}$/m);
    assert.match(text, /^ {10}TRIAGE_MIN_ACCOUNT_AGE_DAYS: \$\{\{ vars\.TRIAGE_MIN_ACCOUNT_AGE_DAYS \}\}$/m);
    const envKeys = scriptStep.filter(line => line.indent === 10 && line.key !== null).map(line => line.key);
    assert.deepEqual(envKeys, ['OLLAMA_API_KEY', 'OLLAMA_MODEL', 'OLLAMA_BASE_URL', 'TRIAGE_ENABLED', 'TRIAGE_DAILY_CAP', 'TRIAGE_MIN_ACCOUNT_AGE_DAYS', 'GITHUB_TOKEN']);
  });

  test('skips bots and maintainers on the issue event, not on dispatch', () => {
    const condition = lines.find(line => line.key === 'if')!.raw;
    assert.match(condition, /github\.event_name == 'workflow_dispatch' \|\|/);
    assert.match(condition, /^ {4}if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) && \(/);
    assert.match(condition, /github\.event\.issue\.user\.type != 'Bot'/);
    assert.match(condition, /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.issue\.author_association\)/);
  });

  test('every action is pinned by a full commit SHA with a tag comment', () => {
    const used = lines.flatMap(line => usesOf(line).map(use => ({use, raw: line.raw})));
    assert.equal(used.length, 2);
    for (const {use, raw} of used) {
      assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, use);
      assert.match(raw, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, raw);
    }
    assert.ok(text.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'));
    assert.ok(text.includes('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0'));
    assert.ok(!text.includes('persist-credentials: true'));
    assert.equal((text.match(/persist-credentials: false/g) ?? []).length, 1);
  });

  test('the secret is exposed to the script step only, through step-level env', () => {
    const rawLines = text.split('\n');
    const secretLines = rawLines.map((raw, index) => ({raw, number: index + 1})).filter(entry => /secrets\./.test(entry.raw) && !entry.raw.trimStart().startsWith('#'));
    assert.equal(secretLines.length, 1);
    assert.match(secretLines[0].raw, /^ {10}OLLAMA_API_KEY: \$\{\{ secrets\.OLLAMA_API_KEY \}\}$/);
    assert.ok(scriptStep.some(line => line.raw === secretLines[0].raw));
    assert.equal(topKeys('env').length, 1);
    const env = code.filter(line => line.indent === 2 && lines.indexOf(line) > lines.findIndex(entry => entry.indent === 0 && entry.key === 'env') && lines.indexOf(line) < lines.findIndex(entry => entry.key === 'jobs'));
    assert.deepEqual(env.map(line => line.key), ['NODE_VERSION']);
    assert.ok(!/secrets\.(?!OLLAMA_API_KEY)/.test(text));
    assert.ok(!/toJSON\(secrets\)|secrets\[/.test(text));
    assert.ok(!/OLLAMA_API_KEY/.test(text.replace(/^ {10}OLLAMA_API_KEY: .*$/m, '').split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')));
  });

  test('the model and the base URL come from repository variables', () => {
    assert.match(text, /^ {10}OLLAMA_MODEL: \$\{\{ vars\.OLLAMA_MODEL \}\}$/m);
    assert.match(text, /^ {10}OLLAMA_BASE_URL: \$\{\{ vars\.OLLAMA_BASE_URL \}\}$/m);
  });

  test('no expression of issue text anywhere, and none inside run', () => {
    const expressions = [...text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').matchAll(/\$\{\{([^}]*)\}\}/g)].map(match => match[1].trim());
    for (const expression of expressions) {
      assert.ok(!/github\.event\.issue\.(title|body|labels|user\.login)|inputs\.issue_number.*(title|body)|head_ref|comment/.test(expression), expression);
    }
    for (const line of lines.filter(entry => entry.inBlock || entry.key === 'run')) assert.ok(!line.raw.includes('${{'), line.raw);
    const run = lines.filter(line => line.key === 'run' && line.value !== '');
    assert.deepEqual(run.map(line => line.value), ['node --experimental-strip-types tools/issue-triage/issue-triage.ts']);
    assert.ok(!/github\.event\.issue\.(title|body)/.test(text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')));
  });

  test('the dispatch inputs are not passed to the script by expression either (it reads the event file)', () => {
    const outside = text.split('\n').filter(line => !line.trimStart().startsWith('#') && !line.includes('group: issue-triage-'));
    assert.ok(!outside.some(line => line.includes('inputs.')));
  });
});

// The `triage` profile of the public-CI checker: the committed file passes, and each mutation below is refused.
describe('the triage profile of the public-CI checker', () => {
  const mutate = (from: string | RegExp, to: string) => {
    const mutated = text.replace(from, to);
    assert.notEqual(mutated, text, String(from));
    return checkWorkflow(mutated, 'triage');
  };
  const refused = (problems: string[], pattern: RegExp) => assert.ok(problems.some(problem => pattern.test(problem)), problems.join('\n') || 'no problem reported');

  test('the committed workflow passes', () => {
    assert.deepEqual(checkWorkflow(text, 'triage'), []);
  });

  test('a broader permission, a missing one or a top-level one is refused', () => {
    refused(mutate('      actions: read\n', '      actions: write\n'), /permissions must be exactly/);
    refused(mutate('      actions: read\n', ''), /permissions must be exactly/);
    refused(mutate('      issues: write\n', '      issues: write\n      pull-requests: write\n'), /permissions must be exactly/);
    refused(mutate('permissions: {}', 'permissions:\n  contents: read'), /top-level permissions/);
  });

  test('the secret or the token anywhere else is refused', () => {
    refused(mutate('  NODE_VERSION: "24"', '  NODE_VERSION: "24"\n  LEAK: ${{ secrets.OLLAMA_API_KEY }}'), /secret/);
    refused(mutate('          GITHUB_TOKEN: ${{ github.token }}', '          GITHUB_TOKEN: ${{ github.token }}\n          OTHER: ${{ github.token }}'), /token/);
    refused(mutate('    environment: issue-triage\n', ''), /environment must be/);
  });

  test('event data in an expression anywhere but the job guard is refused', () => {
    refused(mutate('          OLLAMA_MODEL: ${{ vars.OLLAMA_MODEL }}', '          OLLAMA_MODEL: ${{ github.event.issue.title }}'), /untrusted event data/);
    refused(mutate("group: issue-triage-${{ github.event_name == 'issues' && 'global'", "group: issue-triage-${{ github.event.issue.number && 'global'"), /untrusted event data|concurrency/);
    refused(mutate("&& !contains(", "&& github.event.issue.title != 'x' && !contains("), /untrusted event data/);
    refused(mutate('          GITHUB_TOKEN: ${{ github.token }}', '          GITHUB_TOKEN: ${{ github.token }}\n          ISSUE_INPUT: ${{ inputs.issue_number }}'), /dispatch input/);
  });

  test('removing or weakening the default-branch guard is refused', () => {
    refused(mutate("github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && (", '('), /untrusted event data/);
    refused(mutate('github.event.repository.default_branch', "'main'"), /untrusted event data/);
  });

  test('workflow-level concurrency, or none, is refused', () => {
    const group = "      group: issue-triage-${{ github.event_name == 'issues' && 'global' || format('dispatch-{0}-{1}', inputs.issue_number, inputs.dry_run) }}\n      cancel-in-progress: false\n";
    refused(mutate('    concurrency:\n' + group, ''), /concurrency must be exactly/);
    refused(checkWorkflow(text.replace('    concurrency:\n' + group, '').replace('\ndefaults:', '\nconcurrency:\n  group: issue-triage-x\n  cancel-in-progress: false\n\ndefaults:'), 'triage'), /concurrency/);
  });

  test('a pull request trigger, an unpinned action or a cancelling group is refused', () => {
    refused(mutate('  workflow_dispatch:', '  pull_request:\n  workflow_dispatch:'), /triggers are/);
    refused(mutate('types: [opened]', 'types: [opened, edited]'), /types: \[opened\]/);
    refused(mutate(/actions\/setup-node@[0-9a-f]{40}/, 'actions/setup-node@v7'), /not pinned/);
    refused(mutate('cancel-in-progress: false', 'cancel-in-progress: true'), /concurrency/);
  });
});
