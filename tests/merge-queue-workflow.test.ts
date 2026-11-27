// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The workflows under GitHub's merge queue (CONTRIBUTING.md, "Merge queue"): every required check
// is reported on the `merge_group` event, no privileged workflow runs on it, the informational
// macOS job stays out, concurrency groups of the two events never cancel each other, and the `cla`
// job re-judges the queued commits with the same checker. The text of the workflows is read line
// by line, as in tests/public-ci-workflow.test.ts, whose checks (SHA pinning, read-only token) still
// apply to these files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import http from 'node:http';
import {after, before, describe, test} from 'node:test';
import {jobBlocks, parseLines} from './public-ci-workflow-lib.ts';
import {ADA, CHECKER, GIT_ENV, MAINTAINER, MAINTAINERS_FILE, REGISTER_FILE, HEADER, Repo, git, removeTempDirs, row, tempDir} from './cla-check-lib.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const read = (name: string): string => fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

// The twelve names of the ruleset "main and release" (CONTRIBUTING.md, "Required checks"), and the
// workflow whose job reports each. The four browser shards are one job with a matrix.
const REQUIRED: Record<string, string[]> = {
  'public-ci.yml': ['cla', 'leak check (public rules)', 'OCaml build, tests and native ptyhost gate', 'frontend and Node tests',
    'ruff and pytest (without browser)', 'browser tests (Chromium, shard ${{ matrix.shard }} of 4)'],
  'branch-policy.yml': ['semver label', 'release branch guard'],
  'pr-description.yml': ['PR description (no personal details)'],
};
const NO_MERGE_GROUP = ['public-ci-macos.yml', 'backport.yml', 'backport-register.yml', 'release.yml', 'site.yml', 'site-preview.yml', 'site-preview-cleanup.yml'];

function jobOf(workflow: string, checkName: string): string {
  const job = jobBlocks(parseLines(read(workflow))).find((item) => item.block.some((line) => line.raw === `    name: ${checkName}`));
  assert.ok(job, `no job named ${checkName} in ${workflow}`);
  return job.block.map((line) => line.raw).join('\n');
}

function triggersOf(text: string): string {
  const start = text.indexOf('\non:\n');
  return text.slice(start + 1, text.indexOf('\npermissions:', start));
}

after(removeTempDirs);

describe('merge queue: triggers', () => {
  for (const workflow of Object.keys(REQUIRED)) {
    test(`${workflow} runs on merge_group (checks_requested) and keeps pull_request`, () => {
      const triggers = triggersOf(read(workflow));
      assert.match(triggers, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/m);
      assert.match(triggers, /^ {2}pull_request:$/m);
    });
  }

  test('public-ci keeps push, pull_request and workflow_dispatch', () => {
    const triggers = triggersOf(read('public-ci.yml'));
    for (const trigger of ['push', 'pull_request', 'workflow_dispatch']) assert.match(triggers, new RegExp(`^ {2}${trigger}:`, 'm'));
  });

  for (const workflow of NO_MERGE_GROUP) {
    test(`${workflow} does not start on merge_group`, () => {
      assert.doesNotMatch(read(workflow).replace(/^\s*#.*$/gm, ''), /merge_group/);
    });
  }

  test('no workflow runs pull_request_target and merge_group together', () => {
    for (const name of fs.readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
      const code = read(name).replace(/^\s*#.*$/gm, '');
      if (/pull_request_target/.test(code)) assert.doesNotMatch(code, /merge_group/, name);
    }
  });
});

describe('merge queue: every required check name is reported', () => {
  for (const [workflow, names] of Object.entries(REQUIRED)) {
    for (const name of names) {
      test(`${name}: a job of ${workflow} with no job-level condition`, () => {
        const body = jobOf(workflow, name);
        const condition = /^ {4}if: (.*)$/m.exec(body)?.[1];
        // The only job-level condition a required job may carry is the one that keeps it running when
        // a job it needs failed: any other could evaluate false, and a skipped required check counts as passing.
        assert.ok(condition === undefined || condition === '"!cancelled()"' ||
          condition === "\"!cancelled() && (github.event_name != 'pull_request' || needs.scope.outputs.docs_only != 'true')\"", `a job-level condition could skip the job: ${condition}`);
        assert.doesNotMatch(body, /^ {4}needs:.*macos/m);
      });
    }
  }

  // A skipped required check satisfies the ruleset (GitHub: "Successful check statuses are success,
  // skipped, and neutral"), and a job whose `needs` failed is skipped. So a required job either needs
  // nothing outside the required set, or runs under `!cancelled()` and fails itself when a need is not a success.
  test('a required job that needs a non-required job runs on `!cancelled()` and fails on a need that did not succeed', () => {
    const requiredNames = new Set(Object.values(REQUIRED).flat());
    const nameOf = (block: string): string => /^ {4}name: (.*)$/m.exec(block)?.[1] ?? '';
    let checked = 0;
    for (const workflow of Object.keys(REQUIRED)) {
      const jobs = jobBlocks(parseLines(read(workflow)));
      for (const job of jobs) {
        const body = job.block.map((line) => line.raw).join('\n');
        const needs = /^ {4}needs: (.*)$/m.exec(body)?.[1];
        if (!requiredNames.has(nameOf(body)) || needs === undefined) continue;
        for (const need of needs.replace(/[[\]]/g, '').split(',').map((item) => item.trim())) {
          const target = jobs.find((item) => item.name === need);
          assert.ok(target, `${workflow}: ${job.name} needs unknown job ${need}`);
          if (need === 'scope' || requiredNames.has(nameOf(target.block.map((line) => line.raw).join('\n')))) continue;
          checked++;
          assert.ok(body.includes('    if: "!cancelled()"') || body.includes("    if: \"!cancelled() && (github.event_name != 'pull_request' || needs.scope.outputs.docs_only != 'true')\""), `${job.name} needs the non-required job ${need}: it would be skipped when ${need} fails`);
          const guard = /^ {6}- name: .*\n {8}env:\n(?: {10}DOCS_ONLY: .*\n)? {10}(\w+): \$\{\{ needs\.([\w-]+)\.result \}\}\n {8}run: \|\n((?: {10}.*\n?)+)/m.exec(body.split('    steps:\n')[1] ?? '');
          assert.ok(guard, `${job.name}: no guard step reading needs.${need}.result`);
          assert.equal(guard[2], need);
          assert.match(guard[3], new RegExp(`"\\$${guard[1]}" != success \\]\\]`));
          assert.match(guard[3], /exit 1/);
        }
      }
    }
    assert.equal(checked, 3, 'frontend and browser require guarded matrices; python needs native');
  });

  test('the three jobs that wait for the native PTY host carry the guard on needs.native.result', () => {
    const body = read('public-ci.yml');
    assert.equal((body.match(/^ {4}needs: \[scope, native\]$/gm) ?? []).length, 3);
    assert.equal((body.match(/^ {10}NATIVE_RESULT: \$\{\{ needs\.native\.result \}\}$/gm) ?? []).length, 3);
    assert.equal((body.match(/^ {10}if \[\[ "\$NATIVE_RESULT" != success \]\]; then$/gm) ?? []).length, 3);
  });

  test('the guard is the first step of each of those jobs and has no condition of its own', () => {
    for (const name of ['frontend and Node tests', 'ruff and pytest (without browser)', 'browser tests (Chromium, shard ${{ matrix.shard }} of 4)']) {
      const steps = jobOf('public-ci.yml', name).split('    steps:\n')[1];
      const guardName = name.startsWith('browser tests (Chromium')
        ? 'Require every browser test shard' : name === 'frontend and Node tests'
          ? 'Require both frontend shards' : 'Fail unless the native PTY host job succeeded';
      assert.ok(steps.startsWith(`      - name: ${guardName}\n        env:`));
      assert.doesNotMatch(steps.split(/^ {6}- /m)[1], /^ {8}if:/m);
    }
  });

  test('the non-required frontend matrix checks native before running either shard', () => {
    const name = 'frontend and Node tests (shard ${{ matrix.shard }} of 2)';
    const body = jobOf('public-ci.yml', name);
    assert.match(body, /^ {4}needs: \[scope, native\]$/m);
    assert.ok(body.includes("    if: \"!cancelled() && (github.event_name != 'pull_request' || needs.scope.outputs.docs_only != 'true')\""));
    const steps = body.split('    steps:\n')[1];
    assert.ok(steps.startsWith('      - name: Fail unless the native PTY host job succeeded\n        env:'));
    assert.match(steps, /NATIVE_RESULT: \$\{\{ needs\.native\.result \}\}/);
    assert.match(steps, /"\$NATIVE_RESULT" != success/);
    assert.doesNotMatch(steps.split(/^ {6}- /m)[1], /^ {8}if:/m);
  });

  // The names the ruleset requires, as CONTRIBUTING.md ("Required checks") lists them, with the
  // shard placeholder expanded by the matrix the workflow declares: neither side is computed from the other.
  const SHARD_NAME = 'browser tests (Chromium, shard ${{ matrix.shard }} of 4)';
  function expandShards(names: string[], matrix: number[]): string[] {
    return names.flatMap((name) => name === SHARD_NAME ? matrix.map((shard) => name.replace('${{ matrix.shard }}', String(shard))) : [name]);
  }
  function documentedRequiredNames(): string[] {
    const section = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').split('### Required checks')[1]?.split(/^#{2,3} /m)[0] ?? '';
    return [...section.matchAll(/^\| `([^`]+)` \| `[\w-]+\.yml` \|/gm)]
      .map((match) => match[1] === 'browser tests (Chromium, shard N of 4)' ? SHARD_NAME : match[1]);
  }
  function declaredShards(): number[] {
    const match = /^ {8}shard: \[([0-9, ]+)\]$/m.exec(jobOf('public-ci.yml', SHARD_NAME));
    assert.ok(match, 'no shard matrix in public-ci.yml');
    return match[1].split(',').map((item) => Number(item.trim()));
  }

  test('the whole ruleset is covered: the twelve documented names are the names the workflows report', () => {
    const documented = expandShards(documentedRequiredNames(), declaredShards());
    const reported = expandShards(Object.values(REQUIRED).flat(), declaredShards());
    assert.equal(documented.length, 12, documented.join('\n'));
    assert.deepEqual([...reported].sort(), [...documented].sort());
    assert.equal(new Set(documented).size, 12);
  });

  test('a job that reports no required name is a known one: a new job is a decision about the ruleset', () => {
    const reportedNames = new Set(Object.values(REQUIRED).flat());
    // Both helpers are non-required themselves; required jobs explicitly
    // guard their result, so neither failure can pass as a skipped check.
    const helpers = new Set(['Classify changed files', 'native PTY host (linux-x86_64)',
      'browser ${{ matrix.kind }} tests (Chromium, shard ${{ matrix.shard }} of 4)',
      'frontend and Node tests (shard ${{ matrix.shard }} of 2)']);
    for (const workflow of Object.keys(REQUIRED)) {
      for (const job of jobBlocks(parseLines(read(workflow)))) {
        const name = /^ {4}name: (.*)$/m.exec(job.block.map((line) => line.raw).join('\n'))?.[1] ?? '';
        assert.ok(reportedNames.has(name) || helpers.has(name), `${workflow}: job "${name}" is neither required nor a known guarded helper`);
      }
    }
  });

  test('the informational macOS job is excluded from the merge group: it is in a workflow without merge_group', () => {
    assert.ok(jobOf('public-ci-macos.yml', 'macos (arm64, informational)'));
    for (const workflow of Object.keys(REQUIRED)) assert.doesNotMatch(read(workflow), /^ {4}name: macos \(arm64, informational\)$/m, workflow);
  });

  test('no required job of public-ci needs the macOS job, so the queue never waits for it', () => {
    assert.doesNotMatch(read('public-ci.yml'), /^ {4}needs:.*\bmacos\b/m);
  });
});

describe('merge queue: jobs without a pull request to read', () => {
  // The description check is warning-only and is not re-read on the queue (CONTRIBUTING.md, "Merge queue").
  for (const workflow of ['pr-description.yml']) {
    test(`${workflow}: on merge_group a success step runs, every other step is skipped`, () => {
      const jobs = jobBlocks(parseLines(read(workflow)));
      assert.ok(jobs.length >= 1);
      for (const job of jobs) {
        const steps = job.block.map((line) => line.raw).join('\n').split(/^ {6}- /m).slice(1);
        assert.ok(steps.length >= 2, job.name);
        assert.match(steps[0], /^name: Merge queue, already judged on the pull request\n {8}if: github\.event_name == 'merge_group'\n {8}run: echo /);
        for (const step of steps.slice(1)) assert.match(step, /^ {8}if: github\.event_name != 'merge_group'$/m, step.split('\n')[0]);
      }
    });
  }

  test('no step that runs on merge_group reads the pull request', () => {
    for (const workflow of Object.keys(REQUIRED)) {
      for (const job of jobBlocks(parseLines(read(workflow)))) {
        const steps = job.block.map((line) => line.raw).join('\n').split(/^ {6}- /m).slice(1);
        for (const step of steps) {
          const conditional = /^ {8}if: github\.event_name (==|!=) '(pull_request|merge_group)'/m.test(step)
            && !/event_name == 'merge_group'/.test(step.split('\n').find((line) => /^ {8}if:/.test(line)) ?? '');
          if (/github\.event\.pull_request/.test(step)) assert.ok(conditional, `${workflow}/${job.name}: ${step.split('\n')[0]}`);
        }
      }
    }
  });
});

// The two jobs of branch-policy.yml on the queue: the queued pull request is read again and judged
// by the same tool (the base's copy), with the job's read-only token only on that step.
describe('merge queue: branch-policy re-reads the queued pull request', () => {
  const JOBS: [string, string, string][] = [['semver label', 'semver-label', 'semver-label'], ['release branch guard', 'release-guard', 'release-guard']];
  const TOOL_TEXT = fs.readFileSync(path.join(ROOT, 'tools', 'branch-policy', 'branch-policy.ts'), 'utf8');
  const stepsOf = (name: string): string[] => jobOf('branch-policy.yml', name).split(/^ {6}- /m).slice(1);
  const queueStep = (name: string): string => {
    const step = stepsOf(name).find((item) => /if: github\.event_name == 'merge_group'$/m.test(item) && /\n {8}run: \|/.test(item));
    assert.ok(step, `${name}: no merge_group script step`);
    return step;
  };
  const scriptOf = (step: string): string => step.slice(step.indexOf('run: |\n') + 'run: |\n'.length).replace(/^ {10}/gm, '');

  for (const [name, command] of JOBS) {
    test(`${name}: the merge_group step runs the base's copy of the tool with the token and the base commit id`, () => {
      const step = queueStep(name);
      assert.match(step, /^ {8}env:\n {10}QUEUE_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}\n {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}\n/m);
      assert.doesNotMatch(scriptOf(step), /\$\{\{/);
      assert.ok(scriptOf(step).includes('git cat-file blob "$QUEUE_BASE_SHA:tools/branch-policy/branch-policy.ts" > "$tool"'));
      assert.ok(scriptOf(step).trimEnd().endsWith(`node --experimental-strip-types "$tool" ${command}`));
      assert.match(jobOf('branch-policy.yml', name), /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read$/m);
    });

    test(`${name}: no job-level condition, no success-only step, and the pull request step does not run on the queue`, () => {
      const body = jobOf('branch-policy.yml', name);
      assert.doesNotMatch(body, /^ {4}if:/m);
      assert.doesNotMatch(body, /already judged on the pull request/);
      const pullStep = stepsOf(name).find((item) => item.includes(`branch-policy.ts ${command}`) && !item.includes('merge_group script'));
      assert.match(pullStep ?? '', /if: github\.event_name != 'merge_group'/);
    });
  }

  let server: http.Server;
  let apiUrl = '';
  let pulls: Record<string, unknown> = {};
  let seen: string[] = [];
  before(async () => {
    server = http.createServer((request, response) => {
      seen.push(request.url ?? '');
      const found = pulls[request.url ?? ''];
      response.statusCode = request.headers.authorization === 'Bearer secret' ? (found ? 200 : 404) : 401;
      response.end(JSON.stringify(found ?? {}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  });
  after(() => { server.close(); });

  const pullJson = (number: number, base: string, labels: string[], body = '') =>
    ({number, merged: false, base: {ref: base}, labels: labels.map((name) => ({name})), body});

  // The step's script, replayed on a repository whose `main` holds the tool: the event is a merge group event.
  function replay(name: string, headRef: string, pull: unknown, number = 7): Promise<{status: number | null; out: string}> {
    pulls = {[`/repos/o/r/pulls/${number}`]: pull,
      '/repos/o/r/pulls/12': {merged: true, base: {ref: 'main'}, labels: [{name: 'semver: patch'}]}};
    seen = [];
    const repo = new Repo(HEADER, {'tools/branch-policy/branch-policy.ts': TOOL_TEXT});
    const runnerTemp = tempDir('queue-runner-');
    const eventFile = path.join(runnerTemp, 'event.json');
    fs.writeFileSync(eventFile, JSON.stringify({merge_group: {head_ref: headRef, base_sha: repo.base}}));
    return new Promise((resolve) => {
      const child = spawn('bash', ['-eo', 'pipefail', '-c', scriptOf(queueStep(name))], {cwd: repo.dir, env: {...GIT_ENV, RUNNER_TEMP: runnerTemp,
        QUEUE_BASE_SHA: repo.base, GITHUB_TOKEN: 'secret', GITHUB_EVENT_PATH: eventFile, GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: apiUrl}});
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (status) => resolve({status, out}));
    });
  }
  const QUEUE_REF = (base: string, number: number) => `refs/heads/gh-readonly-queue/${base}/pr-${number}-${'a'.repeat(40)}`;

  test('semver label: a label removed after the entry was queued is refused (the old success-only step passed)', async () => {
    const result = await replay('semver label', QUEUE_REF('main', 7), pullJson(7, 'main', []));
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /carries neither/);
  });

  test('semver label: both labels after queueing is refused; exactly one passes', async () => {
    assert.equal((await replay('semver label', QUEUE_REF('main', 7), pullJson(7, 'main', ['semver: patch', 'semver: minor']))).status, 1);
    const ok = await replay('semver label', QUEUE_REF('main', 7), pullJson(7, 'main', ['semver: minor']));
    assert.equal(ok.status, 0, ok.out);
    assert.deepEqual(seen, ['/repos/o/r/pulls/7']);
  });

  test('both jobs: a base changed after queueing is an error, not an acceptance', async () => {
    for (const [name] of JOBS) {
      const result = await replay(name, QUEUE_REF('main', 7), pullJson(7, 'release/latest', ['semver: patch'], 'Backport of #12'));
      assert.equal(result.status, 2, `${name}: ${result.out}`);
      assert.match(result.out, /no longer targets the branch the queue built on/);
    }
  });

  test('release branch guard: the queued backport is judged again on its current description and label', async () => {
    const ref = QUEUE_REF('release/latest', 7);
    const ok = await replay('release branch guard', ref, pullJson(7, 'release/latest', ['semver: patch'], 'Backport of #12'));
    assert.equal(ok.status, 0, ok.out);
    const noLabel = await replay('release branch guard', ref, pullJson(7, 'release/latest', [], 'Backport of #12'));
    assert.equal(noLabel.status, 1, noLabel.out);
    const noReference = await replay('release branch guard', ref, pullJson(7, 'release/latest', ['semver: patch'], 'nothing'));
    assert.equal(noReference.status, 1, noReference.out);
  });

  test('both jobs fail closed on a branch name that is not a queue entry, or on a pull request that cannot be read', async () => {
    for (const [name] of JOBS) {
      for (const headRef of ['refs/heads/main', 'refs/heads/gh-readonly-queue/main/pr-07-' + 'a'.repeat(40), 'refs/heads/gh-readonly-queue/main/pr-7-xyz',
        'refs/heads/gh-readonly-queue/main/pr-7-' + 'a'.repeat(40) + '/x', 'refs/heads/other/gh-readonly-queue/main/pr-7-' + 'a'.repeat(40)]) {
        const result = await replay(name, headRef, pullJson(7, 'main', ['semver: patch']));
        assert.equal(result.status, 2, `${name} ${headRef}: ${result.out}`);
      }
      const missing = await replay(name, QUEUE_REF('main', 8), pullJson(7, 'main', ['semver: patch']), 7);
      assert.equal(missing.status, 2, `${name}: ${missing.out}`);
    }
  });
});

describe('merge queue: concurrency', () => {
  for (const workflow of Object.keys(REQUIRED)) {
    test(`${workflow}: the group is per ref and merge_group runs are never cancelled`, () => {
      const text = read(workflow);
      const match = /^concurrency:\n {2}group: (.*)\n {2}cancel-in-progress: (.*)$/m.exec(text);
      assert.ok(match, 'no concurrency block');
      // A ref of the queue (refs/heads/gh-readonly-queue/...) is its own group, apart from refs/pull/<n>/merge.
      assert.match(match[1], /\$\{\{ github\.ref \}\}$/);
      assert.ok(/github\.event_name == 'pull_request'/.test(match[2]) || /github\.event_name != 'merge_group'/.test(match[2]),
        `cancel-in-progress is ${match[2]}`);
    });
  }
});

describe('merge queue: the cla job', () => {
  const body = (): string => jobOf('public-ci.yml', 'cla');
  const queueScript = (): string => {
    const step = body().split(/^ {6}- /m).find((item) => /if: github\.event_name == 'merge_group'$/m.test(item));
    assert.ok(step, 'no merge_group step');
    return step.slice(step.indexOf('run: |\n') + 'run: |\n'.length).replace(/^ {10}/gm, '');
  };

  test('reads base and head from the event as commit ids in the environment, and runs the base\'s checker', () => {
    const step = body().split(/^ {6}- /m).find((item) => /if: github\.event_name == 'merge_group'$/m.test(item)) ?? '';
    assert.match(step, /QUEUE_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
    assert.match(step, /QUEUE_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/);
    assert.doesNotMatch(queueScript(), /\$\{\{/, 'no expression inside the script text');
    assert.ok(queueScript().includes('git cat-file blob "$base:tools/cla-check/cla-check.ts" > "$checker"'));
    assert.doesNotMatch(queueScript(), /--experimental-strip-types\s+tools\/cla-check/);
  });

  test('the checkout and the node setup run on pull_request and merge_group; the refusal guard on neither', () => {
    const steps = body().split(/^ {6}- /m).slice(1);
    assert.equal(steps.length, 5);
    assert.match(steps[0], /if: github\.event_name != 'pull_request' && github\.event_name != 'merge_group'$/m);
    for (const step of steps.slice(1, 3)) assert.match(step, /^if: github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'$/m);
    assert.match(steps[3], /if: github\.event_name == 'pull_request'$/m);
    assert.match(steps[4], /if: github\.event_name == 'merge_group'$/m);
  });

  // The script, replayed on a repository: `main` is the base, `pr` stands for the queue's head commit.
  function queued(prepare: (repo: Repo) => void): {status: number | null; out: string} {
    const checkerText = fs.readFileSync(CHECKER, 'utf8');
    const repo = new Repo(HEADER, {'tools/cla-check/cla-check.ts': checkerText});
    prepare(repo);
    const runnerTemp = tempDir('queue-runner-');
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', queueScript()], {cwd: repo.dir, encoding: 'utf8',
      env: {...GIT_ENV, RUNNER_TEMP: runnerTemp, QUEUE_BASE_SHA: repo.base, QUEUE_HEAD_SHA: repo.head()}});
    return {status: run.status, out: `${run.stdout}${run.stderr}`};
  }

  test('accepts linear commits of a maintainer and of a signatory', () => {
    const result = queued((repo) => {
      repo.commit(MAINTAINER, {'a.txt': 'a\n'});
      repo.commit(ADA, {[REGISTER_FILE]: HEADER + row(ADA), 'b.txt': 'b\n'});
    });
    assert.equal(result.status, 0, result.out);
  });

  test('accepts a base maintainer login-only noreply as queue committer', () => {
    const result = queued(repo => repo.commit(MAINTAINER, {'a.txt': 'a\n'},
      {name: 'mathiasbourgoin', email: 'mathiasbourgoin@users.noreply.github.com'}));
    assert.equal(result.status, 0, result.out);
  });

  test('rejects a login-only maintainer address as an author', () => {
    const result = queued(repo => repo.commit({name: 'mathiasbourgoin', email: 'mathiasbourgoin@users.noreply.github.com'},
      {'a.txt': 'a\n'}, MAINTAINER));
    assert.equal(result.status, 1, result.out);
  });

  test('does not derive queue committer aliases from CLA signatories', () => {
    const result = queued(repo => {
      repo.commit(ADA, {[REGISTER_FILE]: HEADER + row(ADA)}, ADA);
      repo.commit(ADA, {'a.txt': 'a\n'}, {name: 'ada', email: 'ada@users.noreply.github.com'});
    });
    assert.equal(result.status, 1, result.out);
  });

  test('rejects an unknown or mismatched queue committer', () => {
    for (const committer of [
      {name: 'someone', email: 'someone@users.noreply.github.com'},
      {name: 'someone', email: 'mathiasbourgoin@users.noreply.github.com'},
      {name: 'mathiasbourgoin', email: 'mathiasbourgoin@example.com'},
    ]) {
      const result = queued(repo => repo.commit(MAINTAINER, {'a.txt': 'a\n'}, committer));
      assert.equal(result.status, 1, result.out);
    }
  });

  test('does not derive queue committer aliases from a maintainer added by the queued commit', () => {
    const result = queued(repo => {
      const list = fs.readFileSync(path.join(ROOT, MAINTAINERS_FILE), 'utf8');
      repo.commit(MAINTAINER, {[MAINTAINERS_FILE]: `${list}Ada Example <1001+ada@users.noreply.github.com>\n`},
        {name: 'ada', email: 'ada@users.noreply.github.com'});
    });
    assert.equal(result.status, 1, result.out);
  });

  test('refuses a commit by an address that is neither a maintainer nor a signatory', () => {
    const result = queued((repo) => repo.commit(ADA, {'a.txt': 'a\n'}));
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /CLA\.md/);
  });

  test('refuses a head that holds a merge commit (a rebase would drop it)', () => {
    const result = queued((repo) => {
      repo.commit(MAINTAINER, {'a.txt': 'a\n'});
      repo.mergeSideBranch(MAINTAINER, HEADER);
    });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /merge commits are not allowed/);
  });

  test('reads the maintainers on the base: a queued commit cannot make its author a maintainer', () => {
    const result = queued((repo) => {
      const list = fs.readFileSync(path.join(ROOT, MAINTAINERS_FILE), 'utf8');
      repo.commit(MAINTAINER, {[MAINTAINERS_FILE]: `${list}${ADA.name} <${ADA.email}>\n`});
      repo.commit(ADA, {'a.txt': 'a\n'});
    });
    assert.equal(result.status, 1, result.out);
  });

  test('fails when the checkout is not the merge group\'s head commit', () => {
    const repo = new Repo(HEADER, {'tools/cla-check/cla-check.ts': fs.readFileSync(CHECKER, 'utf8')});
    const wrongHead = repo.commit(MAINTAINER, {'a.txt': 'a\n'});
    repo.commit(MAINTAINER, {'b.txt': 'b\n'});
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', queueScript()], {cwd: repo.dir, encoding: 'utf8',
      env: {...GIT_ENV, RUNNER_TEMP: tempDir('queue-runner-'), QUEUE_BASE_SHA: repo.base, QUEUE_HEAD_SHA: wrongHead}});
    assert.equal(run.status, 1);
    assert.match(run.stdout, /not the merge group's head commit/);
    assert.equal(git(repo.dir, ['rev-parse', 'HEAD']).length, 40);
  });
});
