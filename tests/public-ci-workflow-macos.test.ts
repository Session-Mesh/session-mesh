// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The informational macOS job, alone in public-ci-macos.yml: its structure, and the mutations that the
// `macos` profile of tests/public-ci-workflow-checks.ts must reject (a paid runner, a blocking job, a
// write token, an unpinned action, a longer timeout, a dependency on another job, a merge queue
// trigger, a shared concurrency group). The one exception to the public rules' single runner and
// their no-`continue-on-error` rule is in tests/public-ci-macos-checks.ts; public-ci.yml (the public
// profile) must not hold the job.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {blockOf, jobBlocks, type Line, parseLines, usesOf} from './public-ci-workflow-lib.ts';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {MACOS_CONCURRENCY, MACOS_JOB, MACOS_JOB_NAME, MACOS_LIST_PATH, MACOS_RUNNER, MACOS_STEP_BUDGETS, MACOS_TIMEOUT_MINUTES,
  MACOS_WORKFLOW} from './public-ci-macos-checks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const text = fs.readFileSync(path.join(WORKFLOWS, MACOS_WORKFLOW), 'utf8');
const publicText = fs.readFileSync(path.join(WORKFLOWS, 'public-ci.yml'), 'utf8');

function macosBody(): string {
  const job = jobBlocks(parseLines(text)).find((item) => item.name === MACOS_JOB);
  assert.ok(job, `no macos job in ${MACOS_WORKFLOW}`);
  return job.block.map((line) => line.raw).join('\n');
}

// The workflow with `from` replaced by `to` once, inside the macOS job only.
function mutated(from: string, to: string): string {
  const start = text.indexOf('\n  macos:\n');
  assert.ok(start >= 0, `no macos job in ${MACOS_WORKFLOW}`);
  const job = text.slice(start);
  assert.ok(job.includes(from), `${from} not found in the macos job`);
  return text.slice(0, start) + job.replace(from, () => to);
}

// The trigger lines of a workflow (comments and blank lines dropped), without merge_group and its types.
function triggerLines(workflow: string): string[] {
  const lines = parseLines(workflow);
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  assert.ok(onIndex >= 0, 'no on: block');
  const block = blockOf(lines, onIndex);
  const queue = block.find((line) => line.key === 'merge_group');
  const dropped = new Set<Line>(queue ? [queue, ...blockOf(lines, lines.indexOf(queue))] : []);
  return block.filter((line) => !dropped.has(line) && line.text.trim() !== '').map((line) => line.text.trim());
}

describe('the informational macOS job', () => {
  test('is the exception, and nothing else of its workflow changes: the committed file satisfies every invariant', () => {
    assert.deepEqual(checkWorkflow(text, 'macos'), []);
  });

  test('public-ci.yml no longer holds it and no job there needs it, so the public-ci run never waits for macOS', () => {
    assert.deepEqual(checkWorkflow(publicText, 'public'), []);
    assert.ok(!jobBlocks(parseLines(publicText)).some((job) => job.name === MACOS_JOB));
    assert.ok(!publicText.includes(`name: ${MACOS_JOB_NAME}`));
  });

  test('runs on the triggers of public-ci.yml but the merge queue, with the same concurrency rule under its own group', () => {
    assert.deepEqual(triggerLines(text), triggerLines(publicText));
    assert.match(triggerLines(publicText).join('\n'), /^push:\nbranches: \[main, "release\/\*\*"\]\npull_request:\ntypes: \[/);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /merge_group/);
    assert.ok(text.includes(`\n${MACOS_CONCURRENCY}`), 'concurrency group');
    // public-ci.yml's group is public-ci-${{ github.ref }}, with the same cancel-in-progress.
    assert.ok(publicText.includes(`\n${MACOS_CONCURRENCY.replace('public-ci-macos-', 'public-ci-')}`), 'public-ci.yml concurrency changed');
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
    // The environment its tests had inside public-ci.yml.
    for (const variable of ['MESH_LEAK_PRIVATE_RULES', 'PYTHON_VERSION', 'NODE_VERSION']) {
      const line = new RegExp(`^ {2}${variable}: .*$`, 'm');
      assert.equal(line.exec(text)?.[0], line.exec(publicText)?.[0], variable);
    }
  });

  test('has the pinned name, an arm64 runner, continue-on-error, a 45-minute timeout and a read-only token', () => {
    const body = macosBody();
    assert.match(body, new RegExp(`^ {4}name: ${MACOS_JOB_NAME.replace(/[()]/g, '\\$&')}$`, 'm'));
    assert.match(body, new RegExp(`^ {4}runs-on: ${MACOS_RUNNER}$`, 'm'));
    assert.match(body, /^ {4}continue-on-error: true$/m);
    assert.match(body, new RegExp(`^ {4}timeout-minutes: ${MACOS_TIMEOUT_MINUTES}$`, 'm'));
    assert.match(body, /^ {4}permissions:\n {6}contents: read\n/m);
    assert.doesNotMatch(body, /^ {4}needs:/m, 'the job runs alone');
    assert.doesNotMatch(body, /^ {4}if:/m, 'the workflow triggers decide where it runs');
  });

  test('every long step has a timeout of its own below the job timeout, so a hang fails the step instead of cancelling the job', () => {
    const steps = macosBody().split(/\n {6}- /).slice(1);
    for (const [label, maximum] of MACOS_STEP_BUDGETS) {
      const step = steps.find((item) => item.startsWith(label));
      assert.ok(step, `${label} missing`);
      const minutes = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
      assert.ok(minutes >= 1 && minutes <= maximum && maximum < MACOS_TIMEOUT_MINUTES, `${label}: ${minutes}`);
    }
    assert.match(macosBody(), /^ {4}continue-on-error: true$/m);
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
    const wf = (from: string, to: string): string[] => checkWorkflow(mutated(from, to), 'macos');
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
      ['the native tests lose their step timeout', '        timeout-minutes: 15\n        run: |\n          source scripts/test-tmpdir.sh', '        run: |\n          source scripts/test-tmpdir.sh', /step name: Native tests has no timeout-minutes/],
      ['the native tests get a step timeout above their budget', 'timeout-minutes: 15\n        run: |\n          source scripts/test-tmpdir.sh', 'timeout-minutes: 30\n        run: |\n          source scripts/test-tmpdir.sh', /step name: Native tests has no timeout-minutes within 1\.\.15/],
      ['setup-ocaml loses its step timeout', '        timeout-minutes: 15\n', '', /step uses: ocaml\/setup-ocaml@ has no timeout-minutes/],
      ['the Node step loses its step timeout', '- name: Node tests (macOS list)\n        if: "!cancelled() && steps.build.outcome == \'success\'"\n        timeout-minutes: 10\n',
        '- name: Node tests (macOS list)\n        if: "!cancelled() && steps.build.outcome == \'success\'"\n', /has no timeout-minutes within 1\.\.10/],
      ['the job timeout is shortened below the worst case of one hanging step', '    timeout-minutes: 45\n', '    timeout-minutes: 40\n',
        /exceeds the 40-minute job timeout/],
      ['the token may write', '      contents: read\n', '      contents: write\n', /permission contents: write is not read-only/],
      ['the job permissions are not explicit', '    permissions:\n      contents: read\n', '', /permissions must be exactly contents: read/],
      ['the job takes another scope', '      contents: read\n', '      contents: read\n      id-token: read\n', /permissions must be exactly/],
      ['an action is pinned by tag', 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'actions/setup-node@v4',
        /actions\/setup-node@v4 not pinned/],
      ['the job waits for another job', '    timeout-minutes: 45\n', '    timeout-minutes: 45\n    needs: native\n', /needs another job/],
      ['the job is conditional on an event', '    runs-on: macos-15\n', '    if: github.event_name == \'push\'\n    runs-on: macos-15\n', /job-level condition/],
      ['the job is renamed', 'name: macos (arm64, informational)', 'name: macos (arm64)', /name is not/],
      ['the allow-list is not read', 'list=tests/macos-ci-tests.txt', 'list=/dev/null', /does not read tests\/macos-ci-tests\.txt/],
      ['the Node step discovers its tests', 'list="$RUNNER_TEMP/macos-node-tests.txt"', 'list="$(find tests -name \'*.test.ts\')"',
        /discovers tests|do not both read/],
      ['the pytest step ignores the list', 'list="$RUNNER_TEMP/macos-pytest-tests.txt"', 'list=/dev/null', /do not both read/],
      ['the pytest step runs although the build failed', "        if: \"!cancelled() && steps.build.outcome == 'success'\"\n        timeout-minutes: 10\n        run: |\n          list=\"$RUNNER_TEMP/macos-pytest-tests.txt\"", "        if: '!cancelled()'\n        timeout-minutes: 10\n        run: |\n          list=\"$RUNNER_TEMP/macos-pytest-tests.txt\"",
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

    // Mutations of the workflow around the job.
    const around: [string, string, string, RegExp][] = [
      ['it runs on the merge queue', '  workflow_dispatch:\n', '  merge_group:\n    types: [checks_requested]\n  workflow_dispatch:\n', /no merge_group/],
      ['it shares the concurrency group of public-ci.yml', 'group: public-ci-macos-', 'group: public-ci-', /concurrency is not/],
      ['a push run is cancelled too', "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true', /concurrency is not/],
      ['the workflow is renamed', 'name: public-ci-macos\n', 'name: public-ci\n', /workflow name is not public-ci-macos/],
      ['another job joins it', 'jobs:\n', `jobs:\n  lint:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: 'true'\n`,
        /holds the macos job alone/],
    ];
    for (const [label, from, to, pattern] of around) {
      test(label, () => {
        assert.ok(text.includes(from), `${from} not found`);
        const problems = checkWorkflow(text.replace(from, () => to), 'macos');
        assert.ok(problems.some((problem) => pattern.test(problem)), `not reported:\n${problems.join('\n')}`);
      });
    }

    test('it moves back into public-ci.yml', () => {
      const problems = checkWorkflow(`${publicText}${text.slice(text.indexOf('\n  macos:\n') + 1)}`, 'public');
      assert.ok(problems.some((problem) => /belongs in public-ci-macos\.yml/.test(problem)), problems.join('\n'));
      assert.ok(problems.some((problem) => /runner macos-15 is not ubuntu-24\.04/.test(problem)), problems.join('\n'));
      assert.ok(problems.some((problem) => /continue-on-error other than false/.test(problem)), problems.join('\n'));
    });

    test('a public-ci job takes a macOS runner', () => {
      const problems = checkWorkflow(publicText.replace('runs-on: ubuntu-24.04', 'runs-on: macos-15'), 'public');
      assert.ok(problems.some((problem) => /runner macos-15 is not ubuntu-24\.04/.test(problem)), problems.join('\n'));
    });

    test('a public-ci job ignores its failure', () => {
      const problems = checkWorkflow(publicText.replace('  leaks:\n    name: leak check (public rules)\n',
        '  leaks:\n    name: leak check (public rules)\n    continue-on-error: true\n'), 'public');
      assert.ok(problems.some((problem) => /continue-on-error other than false/.test(problem)), problems.join('\n'));
    });

    test('a public-ci job needs the macOS job', () => {
      const problems = checkWorkflow(publicText.replace('  leaks:\n    name: leak check (public rules)\n',
        '  leaks:\n    name: leak check (public rules)\n    needs: macos\n'), 'public');
      assert.ok(problems.some((problem) => /job leaks: needs the informational macOS job/.test(problem)), problems.join('\n'));
    });
  });

  test('the exception is the macos profile only: other profiles refuse a macOS runner and continue-on-error', () => {
    for (const profile of ['public', 'description', 'site', 'policy'] as const) {
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
        // The job refuses anything else (public-ci-macos.yml, "Read the macOS test list").
        assert.match(entry, /^tests\/[A-Za-z0-9._/-]+\.(?:ts|py)$/);
        assert.doesNotMatch(entry, /\.\./);
      }
      assert.ok(entries.some((entry) => entry.endsWith('.py')), 'no pytest file');
      assert.ok(entries.some((entry) => !entry.endsWith('.py')), 'no Node test');
    });
  });
});
