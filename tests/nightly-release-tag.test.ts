// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The tag job of release.yml (its tag-name step and its branch check), run with a recording gh in
// place of the real one, and on a real repository for the branch check. Helpers:
// tests/nightly-test-scripts.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {before, describe, test} from 'node:test';
import {release, stepScript, useScriptHarness} from './nightly-test-scripts.ts';

describe('the tag job of release.yml, run with a recording gh', () => {
  const {SHA, scratch, fixtures, run} = useScriptHarness();

  describe('the tag job of release.yml', () => {
    const script = stepScript(release, /tag="v0\.0\.0-dryrun/);
    const name = (env: Record<string, string>) => {
      const fix = fixtures();
      const result = run(script, fix, {GITHUB_REF_TYPE: 'tag', ...env});
      return {status: result.status, output: result.output, outputs: result.outputs};
    };
    const NIGHTLY = 'v0.2.0-nightly.20261118';

    test('publishes a tag push, and refuses a push of a nightly tag', () => {
      assert.equal(name({GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.2.0'}).outputs, 'tag=v0.2.0\npublish=true\n');
      const refused = name({GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: NIGHTLY});
      assert.equal(refused.status, 1);
      assert.match(refused.output, /nightly pre-releases are published by nightly\.yml, never from a push/);
      assert.equal(refused.outputs, '');
    });

    test('refuses a pushed tag that contains -nightly, in or out of the exact nightly form', () => {
      for (const tag of ['v0.2.0-nightly.x', 'v0.2.0-nightly', 'v1.0.0-nightly.20261118', 'v0.2.0-rc.1-nightly.1']) {
        const refused = name({GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: tag});
        assert.equal(refused.status, 1, tag);
        assert.match(refused.output, /contains -nightly: nightly pre-releases are published by nightly\.yml, never from a push/, tag);
        assert.equal(refused.outputs, '', tag);
      }
      assert.equal(name({GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.1.1'}).outputs, 'tag=v0.1.1\npublish=true\n');
    });

    test('publishes a manual run on a nightly tag and no other manual run', () => {
      assert.equal(name({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: NIGHTLY}).outputs, `tag=${NIGHTLY}\npublish=true\n`);
      const dry = `tag=v0.0.0-dryrun.${SHA.slice(0, 12)}\npublish=false\n`;
      assert.equal(name({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'v0.2.0'}).outputs, dry);
      assert.equal(name({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'v0.2.0-nightly.2026111'}).outputs, dry);
      assert.equal(name({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: NIGHTLY, GITHUB_REF_TYPE: 'branch'}).outputs, dry);
    });
  });

  describe('the notes of a nightly', () => {
    test('the tag message is written whole before it is cut: no pipe into head under pipefail', () => {
      assert.doesNotMatch(release, /--jq \.message \|/);
      assert.match(release, /--jq \.message > "\$RUNNER_TEMP\/tag-message\.md"\n\s+head -c 60000 "\$RUNNER_TEMP\/tag-message\.md" > "\$RUNNER_TEMP\/nightly-notes\.md"/);
    });
  });

  // The check that the tag names a commit of main (a nightly) or of main or release/latest (a stable
  // tag), run on a real repository: main with c1 and c2, release/latest forked at c1 with r1.
  describe('the branch check of the tag job of release.yml', () => {
    const script = stepScript(release, /tagged="\$\(git rev-parse/);
    const gitEnv = {PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'n', GIT_AUTHOR_EMAIL: 'n@example.com',
      GIT_COMMITTER_NAME: 'n', GIT_COMMITTER_EMAIL: 'n@example.com'};
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', args, {cwd, encoding: 'utf8', env: gitEnv});
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    let runner = '';
    const commits: Record<string, string> = {};
    before(() => {
      const root = fs.mkdtempSync(path.join(scratch(), 'repo-'));
      const origin = path.join(root, 'origin.git');
      const work = path.join(root, 'work');
      fs.mkdirSync(work);
      git(root, 'init', '--bare', '-b', 'main', origin);
      git(work, 'init', '-b', 'main');
      git(work, 'remote', 'add', 'origin', origin);
      git(work, 'commit', '--allow-empty', '-m', 'c1');
      commits.c1 = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', '-b', 'release/latest');
      git(work, 'commit', '--allow-empty', '-m', 'r1');
      commits.r1 = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', 'main');
      git(work, 'commit', '--allow-empty', '-m', 'c2');
      commits.c2 = git(work, 'rev-parse', 'HEAD');
      for (const [tag, commit] of [['v0.2.0-nightly.20261101', 'c1'], ['v0.2.0-nightly.20261102', 'c2'], ['v0.2.0-nightly.20261103', 'r1'], ['v0.2.1', 'r1'], ['v0.3.0', 'c1']]) {
        git(work, 'tag', '-a', tag, commits[commit], '-m', tag);
      }
      git(work, 'push', 'origin', 'main', 'release/latest', '--tags');
      runner = path.join(root, 'runner');
      git(root, 'clone', origin, runner);
    });
    const check = (tag: string, commit: string) => {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {cwd: runner, encoding: 'utf8', env: {...gitEnv, RELEASE_TAG: tag, GITHUB_SHA: commits[commit]}});
      return {status: result.status, output: result.stdout + result.stderr};
    };

    test('accepts a nightly on main\'s head or on an ancestor of main', () => {
      assert.equal(check('v0.2.0-nightly.20261102', 'c2').status, 0);
      assert.equal(check('v0.2.0-nightly.20261101', 'c1').status, 0);
    });

    test('refuses a nightly on a commit that is only on release/latest', () => {
      const result = check('v0.2.0-nightly.20261103', 'r1');
      assert.equal(result.status, 1);
      assert.match(result.output, /is not on main: a nightly is a build of main/);
    });

    test('still accepts a stable tag on release/latest or on main, and refuses a tag that names another commit', () => {
      assert.equal(check('v0.2.1', 'r1').status, 0);
      assert.equal(check('v0.3.0', 'c1').status, 0);
      const wrong = check('v0.3.0', 'c2');
      assert.equal(wrong.status, 1);
      assert.match(wrong.output, /not the built commit/);
    });
  });
});
