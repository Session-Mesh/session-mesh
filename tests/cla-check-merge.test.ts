// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The CLA check against the scenarios of tests/cla-check-scenarios.ts, through its command line, and
// the step of the CI job replayed on a throwaway repository.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';
import {ADA, BOB, CHECKER, EVE, GIT_ENV, HEADER, MAINTAINER, Repo, ROOT, git, removeTempDirs, row, tempDir} from './cla-check-lib.ts';
import {SCENARIOS} from './cla-check-scenarios.ts';
import {jobBlocks, parseLines} from './public-ci-workflow-lib.ts';

afterEach(removeTempDirs);

describe('CLA check scenarios', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: ${scenario.title} (exit ${scenario.expected})`, () => {
      const {repo, base, head} = scenario.build();
      const args = ['--repo', repo.dir, '--base', base, '--head', head, '--merge', repo.testMerge(base, head)];
      const run = spawnSync(process.execPath, ['--experimental-strip-types', CHECKER, ...args], {env: GIT_ENV, encoding: 'utf8'});
      assert.equal(run.status, scenario.expected, run.stdout + run.stderr);
      const lines = (run.stdout + run.stderr).split('\n');
      assert.ok(lines.every((line) => !line.startsWith('::')), 'no line may be read as a workflow command');
      if (scenario.expected === 1) assert.match(run.stdout, /CLA\.md/);
      if (scenario.reason) assert.match(run.stdout, scenario.reason);
    });
  }
});

// "Rebase and merge" replays the commits of the pull request on `main`. For a linear pull request
// on the tip of `main`, the only kind the check accepts, what lands is the tree the check judged.
describe('what Rebase and merge lands', () => {
  test('R3: a linear pull request lands the tree of its test merge commit', () => {
    const repo = new Repo(HEADER + row(BOB));
    repo.commit(EVE, {'CLA-SIGNATORIES.md': HEADER + row(BOB) + row(EVE), 'f': 'code\n'});
    repo.commit(EVE, {'f': 'code2\n'});
    const merge = repo.testMerge();
    git(repo.dir, ['checkout', '-q', '-b', 'landed']);
    git(repo.dir, ['rebase', '-q', '--force-rebase', repo.base], {GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com'});
    assert.notEqual(repo.head(), git(repo.dir, ['rev-parse', 'pr']), 'the commits were rewritten');
    assert.equal(repo.tree(), repo.tree(merge));
  });
});

// The `run` script of the cla job, as written in the workflow, on a checkout of a test merge commit.
function claStep(): string {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'public-ci.yml'), 'utf8');
  const job = jobBlocks(parseLines(workflow)).find((item) => item.name === 'cla');
  assert.ok(job, 'no cla job');
  const all = job.block.filter((line) => line.inBlock).map((line) => line.raw).join('\n');
  // The first run block is the guard for events other than pull_request; replay the checker block.
  // The merge queue's step follows it (tests/merge-queue-workflow.test.ts replays that one).
  const queue = all.indexOf('head=$(git rev-parse --verify "$QUEUE_HEAD_SHA');
  assert.ok(queue > 0, 'no merge_group step');
  const script = all.slice(all.indexOf('# pull_request checks out'), queue);
  assert.match(script, /cla-check\.ts/);
  return script;
}

function runStep(repo: Repo): {status: number | null; output: string} {
  git(repo.dir, ['checkout', '-q', '--detach', repo.testMerge()]);
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', claStep()],
    {cwd: repo.dir, env: {...GIT_ENV, RUNNER_TEMP: tempDir('cla-runner-')}, encoding: 'utf8'});
  return {status: run.status, output: run.stdout + run.stderr};
}

describe('the cla step of the CI, replayed', () => {
  const checkerAtBase = {'tools/cla-check/cla-check.ts': fs.readFileSync(CHECKER, 'utf8')};

  test('accepts a signed pull request with the base branch\'s checker', () => {
    const repo = new Repo(HEADER, checkerAtBase);
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': HEADER + row(ADA)});
    const step = runStep(repo);
    assert.equal(step.status, 0, step.output);
    assert.match(step.output, /CLA check passed/);
  });

  test('a pull request that rewrites the checker and the maintainers is still judged by the base', () => {
    const repo = new Repo(HEADER, checkerAtBase);
    repo.commit(EVE, {'feature.txt': 'code\n', 'tools/cla-check/cla-check.ts': 'process.stdout.write("PWNED\\n");\n',
      'tools/cla-check/MAINTAINERS': `Eve Example <${EVE.email}>\n`});
    const step = runStep(repo);
    assert.equal(step.status, 1, step.output);
    assert.doesNotMatch(step.output, /PWNED/);
    assert.match(step.output, new RegExp(`- ${EVE.email.replace('+', '\\+')} \\(author, committer\\)`));
  });

  test('fails when the base branch has no checker', () => {
    const repo = new Repo(HEADER);
    repo.commit(MAINTAINER, {'tools/cla-check/cla-check.ts': 'process.exitCode = 0;\n'});
    assert.notEqual(runStep(repo).status, 0);
  });
});
