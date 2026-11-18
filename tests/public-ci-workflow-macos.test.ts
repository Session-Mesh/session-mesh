// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The informational macOS job of public-ci.yml: its structure, and the mutations that the public
// profile of tests/public-ci-workflow-checks.ts must reject (a paid runner, a blocking job, a
// write token, an unpinned action, a longer timeout, a dependency on another job). The one
// exception to the profile's single runner and its no-`continue-on-error` rule is in
// tests/public-ci-macos-checks.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {jobBlocks, parseLines, usesOf} from './public-ci-workflow-lib.ts';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {MACOS_JOB, MACOS_JOB_NAME, MACOS_LIST_PATH,MACOS_RUNNER, MACOS_TIMEOUT_MINUTES} from './public-ci-macos-checks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'public-ci.yml'), 'utf8');

function macosBody(): string {
  const job = jobBlocks(parseLines(text)).find((item) => item.name === MACOS_JOB);
  assert.ok(job, 'no macos job in public-ci.yml');
  return job.block.map((line) => line.raw).join('\n');
}

// The workflow with `from` replaced by `to` once, inside the macOS job only.
function mutated(from: string, to: string): string {
  const start = text.indexOf('\n  macos:\n');
  assert.ok(start >= 0, 'no macos job in public-ci.yml');
  const job = text.slice(start);
  assert.ok(job.includes(from), `${from} not found in the macos job`);
  return text.slice(0, start) + job.replace(from, () => to);
}

describe('the informational macOS job', () => {
  test('is the exception, and nothing else of the workflow changes: the committed file satisfies every invariant', () => {
    assert.deepEqual(checkWorkflow(text), []);
  });

  test('has the pinned name, an arm64 runner, continue-on-error, a 45-minute timeout and a read-only token', () => {
    const body = macosBody();
    assert.match(body, new RegExp(`^ {4}name: ${MACOS_JOB_NAME.replace(/[()]/g, '\\$&')}$`, 'm'));
    assert.match(body, new RegExp(`^ {4}runs-on: ${MACOS_RUNNER}$`, 'm'));
    assert.match(body, /^ {4}continue-on-error: true$/m);
    assert.match(body, new RegExp(`^ {4}timeout-minutes: ${MACOS_TIMEOUT_MINUTES}$`, 'm'));
    assert.match(body, /^ {4}permissions:\n {6}contents: read\n/m);
    assert.doesNotMatch(body, /^ {4}(?:needs|if):/m, 'the job runs alone, on every event');
  });

  test('pins every action by SHA, builds with the release toolchain and runs no browser', () => {
    const lines = parseLines(text);
    const job = jobBlocks(lines).find((item) => item.name === MACOS_JOB);
    const actions = (job?.block ?? []).flatMap((line) => usesOf(line));
    for (const action of actions) assert.match(action, /@[0-9a-f]{40}$/, action);
    for (const prefix of ['actions/checkout@', 'actions/setup-node@', 'actions/setup-python@', 'actions/cache/restore@',
      'actions/cache/save@', 'ocaml/setup-ocaml@']) assert.ok(actions.some((action) => action.startsWith(prefix)), `${prefix} missing`);
    const body = macosBody();
    for (const needle of ['MACOSX_DEPLOYMENT_TARGET: "13.0"', 'scripts/bootstrap.sh --deps-only', 'bash scripts/bootstrap.sh --install-only 2>&1', 'dune runtest --root ocaml',
      'release-check-macos.sh links', 'scripts/check-copyright.sh', "pytest -q -m 'not browser'", 'shell: /bin/bash -eo pipefail {0}']) {
      assert.ok(body.includes(needle), `${needle} missing from the macos job`);
    }
    assert.doesNotMatch(body, /chromium|playwright|requirements-browser|MESH_CHROMIUM/i);
  });

  test('saves its opam state from main only, as the Linux job does, and keys it on the pins', () => {
    const body = macosBody();
    const guard = "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && " +
      "steps.opam-cache.outputs.cache-hit != 'true'";
    assert.equal(body.split(guard).length - 1, 2, 'trim and save are guarded');
    assert.ok(body.includes("hashFiles('ocaml/session_mesh.opam', 'ocaml/dune-project', 'scripts/bootstrap.sh', 'scripts/release-pins.sh'"));
  });

  test('its name collides with no required check of CONTRIBUTING.md and no other job name', () => {
    const required = [...fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').matchAll(/^\| `([^`]+)` \| `[\w.-]+\.yml` \|/gm)]
      .map((match) => match[1]);
    assert.ok(required.length >= 8, `only ${required.length} required checks read`);
    assert.ok(!required.includes(MACOS_JOB_NAME));
    const names = jobBlocks(parseLines(text)).map((job) => job.block.find((line) => line.key === 'name' && line.indent === 4)?.value);
    assert.equal(names.filter((name) => name === MACOS_JOB_NAME).length, 1);
  });

  describe('is rejected when', () => {
    const wf = (from: string, to: string): string[] => checkWorkflow(mutated(from, to));
    const mutations: [string, string, string, RegExp][] = [
      ['it runs on a Linux runner', 'runs-on: macos-15', 'runs-on: ubuntu-24.04', /is not macos-15/],
      ['it runs on a larger paid runner', 'runs-on: macos-15', 'runs-on: macos-15-xlarge', /is not macos-15/],
      ['it runs on an Intel runner', 'runs-on: macos-15', 'runs-on: macos-13', /is not macos-15/],
      ['it runs on a self-hosted runner', 'runs-on: macos-15', 'runs-on: [self-hosted, macOS]', /self-hosted runner/],
      ['it blocks (continue-on-error removed)', '    continue-on-error: true\n', '', /no job-level continue-on-error: true/],
      ['it blocks (continue-on-error: false)', 'continue-on-error: true', 'continue-on-error: false', /no job-level continue-on-error: true/],
      ['a step ignores its failure', '      - name: pytest (macOS list, without browser)\n', '      - name: pytest (macOS list, without browser)\n        continue-on-error: true\n',
        /continue-on-error other than false/],
      ['the timeout exceeds the 45-minute safety net', 'timeout-minutes: 45', 'timeout-minutes: 46', /timeout-minutes 46 outside 1\.\.45/],
      ['the token may write', '      contents: read\n', '      contents: write\n', /permission contents: write is not read-only/],
      ['the job permissions are not explicit', '    permissions:\n      contents: read\n', '', /permissions must be exactly contents: read/],
      ['the job takes another scope', '      contents: read\n', '      contents: read\n      id-token: read\n', /permissions must be exactly/],
      ['an action is pinned by tag', 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'actions/setup-node@v4',
        /actions\/setup-node@v4 not pinned/],
      ['the job waits for another job', '    timeout-minutes: 45\n', '    timeout-minutes: 45\n    needs: native\n', /needs another job/],
      ['the job is conditional', '    timeout-minutes: 45\n', '    timeout-minutes: 45\n    if: github.event_name == \'push\'\n', /job-level condition/],
      ['the job is renamed', 'name: macos (arm64, informational)', 'name: macos (arm64)', /name is not/],
      ['the allow-list is not read', 'list=tests/macos-ci-tests.txt', 'list=/dev/null', /does not read tests\/macos-ci-tests\.txt/],
      ['the Node step discovers its tests', 'list="$RUNNER_TEMP/macos-node-tests.txt"', 'list="$(find tests -name \'*.test.ts\')"',
        /discovers tests|do not both read/],
      ['the pytest step ignores the list', 'list="$RUNNER_TEMP/macos-pytest-tests.txt"', 'list=/dev/null', /do not both read/],
      ['the pytest step runs although the build failed', "        if: \"!cancelled() && steps.build.outcome == 'success'\"\n        run: |\n          list=\"$RUNNER_TEMP/macos-pytest-tests.txt\"", "        if: '!cancelled()'\n        run: |\n          list=\"$RUNNER_TEMP/macos-pytest-tests.txt\"",
        /pytest step does not run on the build outcome only/],
      ['the native tests no longer run on the build outcome', "- name: Native tests (dune runtest)\n        if: \"!cancelled() && steps.build.outcome == 'success'\"\n", '- name: Native tests (dune runtest)\n',
        /Native tests step does not run on the build outcome only/],
      ['the build step loses its id', '        id: build\n', '', /no id: build/],
      ['an empty node list is tolerated', '[ -s "$list" ] || { echo "empty or absent list: $list" >&2; exit 1; }\n          npm ci', 'npm ci', /does not refuse an absent or empty list/],
      ['the entry pattern is loosened', "grep -Eq '^tests/[A-Za-z0-9._/-]+\\.(ts|py)$'", "grep -Eq '.*'", /not validated against the strict pattern/],
      ['pytest gets no -- before the paths', "-m 'not browser' -- \"${files[@]}\"", "-m 'not browser' \"${files[@]}\"", /-- before the paths/],
      ['a script runs with a bare bash', 'run: /bin/bash scripts/check-copyright.sh', 'run: bash scripts/check-copyright.sh', /bare bash/],
      ['a secret is used', 'persist-credentials: false', 'persist-credentials: false\n          token: ${{ secrets.MAC_TOKEN }}', /secret reference/],
    ];
    for (const [label, from, to, pattern] of mutations) {
      test(label, () => {
        const problems = wf(from, to);
        assert.ok(problems.some((problem) => pattern.test(problem)), `not reported:\n${problems.join('\n')}`);
      });
    }

    test('another job takes a macOS runner', () => {
      const problems = checkWorkflow(text.replace('runs-on: ubuntu-24.04', 'runs-on: macos-15'));
      assert.ok(problems.some((problem) => /runner macos-15 is not ubuntu-24\.04/.test(problem)), problems.join('\n'));
    });

    test('another job ignores its failure', () => {
      const problems = checkWorkflow(text.replace('  leaks:\n    name: leak check (public rules)\n',
        '  leaks:\n    name: leak check (public rules)\n    continue-on-error: true\n'));
      assert.ok(problems.some((problem) => /continue-on-error other than false/.test(problem)), problems.join('\n'));
    });

    test('another job needs the macOS job', () => {
      const problems = checkWorkflow(text.replace('  leaks:\n    name: leak check (public rules)\n',
        '  leaks:\n    name: leak check (public rules)\n    needs: macos\n'));
      assert.ok(problems.some((problem) => /job leaks: needs the informational macOS job/.test(problem)), problems.join('\n'));
    });
  });

  test('the exception is the public profile only: other profiles refuse a macOS runner and continue-on-error', () => {
    for (const profile of ['description', 'site', 'policy'] as const) {
      const problems = checkWorkflow(text, profile);
      assert.ok(problems.some((problem) => /runner macos-15 is not ubuntu-24\.04/.test(problem)), `${profile}: ${problems.join('\n')}`);
      assert.ok(problems.some((problem) => /continue-on-error other than false/.test(problem)), profile);
    }
  });

  describe('the allow-list tests/macos-ci-tests.txt', () => {
    // Same grammar as the job's read loop: `#` starts a comment, blanks are removed, empty lines skipped.
    const entries = fs.readFileSync(path.join(ROOT, MACOS_LIST_PATH), 'utf8').split('\n')
      .map((line) => line.replace(/#.*/, '').replace(/\s+/g, '')).filter((line) => line !== '');

    test('lists tests, each once, and every listed path exists', () => {
      assert.ok(entries.length >= 10, `only ${entries.length} entries`);
      assert.deepEqual(entries.filter((entry, index) => entries.indexOf(entry) !== index), [], 'duplicate entries');
      for (const entry of entries) assert.ok(fs.statSync(path.join(ROOT, entry)).isFile(), `${entry} does not exist`);
    });

    test('names Node tests and pytest files of tests/ only, none of the browser ones', () => {
      for (const entry of entries) {
        assert.match(entry, /^tests\/[A-Za-z0-9._\/-]+\.(?:test\.(?:ts|mjs|cjs)|py)$/, `${entry} is neither a Node test nor a pytest file of tests/`);
        assert.doesNotMatch(entry, /browser/, `${entry} drives a browser`);
        // The job refuses anything else (public-ci.yml, "Read the macOS test list").
        assert.match(entry, /^tests\/[A-Za-z0-9._/-]+\.(?:ts|py)$/);
        assert.doesNotMatch(entry, /\.\./);
      }
      assert.ok(entries.some((entry) => entry.endsWith('.py')), 'no pytest file');
      assert.ok(entries.some((entry) => !entry.endsWith('.py')), 'no Node test');
    });
  });
});
