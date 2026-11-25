// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Invariants of the public CI (.github/workflows/): GitHub-hosted runners only, no secret, a
// read-only token, third-party actions pinned by full commit SHA, `pull_request` and never
// `pull_request_target`, no ignored failure, container images pinned by digest, bounded jobs,
// and the leak check with the public rules only. The release workflow has its own profile and
// tests (tests/release-workflow.test.ts); the checks are in tests/public-ci-workflow-checks.ts.
// No YAML parser is available without a new dependency: the checker reads the text line by line,
// refuses every construct it does not resolve (see UNPARSED), and is shown to reject faults below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, test} from 'node:test';
import {blockOf, jobBlocks, parseLines, stepOf, usesOf} from './public-ci-workflow-lib.ts';
import {checkWorkflow, type Profile} from './public-ci-workflow-checks.ts';
import {gitleaksAvailable} from '../tools/leak-guard/gitleaks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const PUBLIC_WORKFLOW = 'public-ci.yml';
// The informational macOS job, alone in its workflow: the `macos` profile, its own rules in
// tests/public-ci-workflow-macos.test.ts.
const MACOS_WORKFLOW = 'public-ci-macos.yml';
const DESCRIPTION_WORKFLOW = 'pr-description.yml';
// The site deployment: the `site` profile here, its own rules in tests/site-workflow.test.ts.
const SITE_WORKFLOW = 'site.yml';
// The site previews (the one `pull_request` workflow with a secret, a deploy key): the `preview` profile,
// its own rules in tests/site-preview-workflow.test.ts.
const PREVIEW_WORKFLOW = 'site-preview.yml';
const PREVIEW_CLEANUP_WORKFLOW = 'site-preview-cleanup.yml';
// The backport workflows (the `pull_request_target` workflows: the `backport` profile, tests/backport-workflow.test.ts,
// and the `register` profile, tests/backport-register-workflow.test.ts) and the branch policy checks (the `policy` profile, tests/branch-policy.test.ts).
const BACKPORT_WORKFLOW = 'backport.yml';
const REGISTER_WORKFLOW = 'backport-register.yml';
const POLICY_WORKFLOW = 'branch-policy.yml';
// The nightly pre-release: the `nightly` profile, its own rules in tests/nightly-workflow.test.ts.
const NIGHTLY_WORKFLOW = 'nightly.yml';
// The issue triage: the `triage` profile, its own rules in tests/issue-triage-workflow-checks.ts.
const TRIAGE_WORKFLOW = 'issue-triage.yml';
// Checked by tests/release-workflow.test.ts, with its own profile.
const RELEASE_WORKFLOW = 'release.yml';

function workflowFiles(): string[] {
  if (!fs.existsSync(WORKFLOWS)) return [];
  return fs.readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).sort();
}

const FAULTY = `name: faulty
on:
  pull_request_target:
  push:
permissions:
  contents: write
jobs:
  build:
    runs-on: [self-hosted, linux]
    permissions: write-all
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4.2.0 # a tag, not a SHA
      - run: echo "\${{ secrets.DEPLOY_KEY }}" "\${{ github.event.pull_request.title }}"
        env:
          MESH_LEAK_PRIVATE_RULES: /etc/rules.private.json
  other:
    runs-on: \${{ matrix.os }}
    timeout-minutes: 90
    permissions: {contents: read, pull-requests: write}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
`;

describe('public CI workflow checker', () => {
  test('rejects each faulty construct of a bad workflow', () => {
    const problems = checkWorkflow(FAULTY);
    const expected: [string, RegExp][] = [
      ['self-hosted runner', /line 9: self-hosted runner/],
      ['runner outside ubuntu-24.04', /runner \$\{\{ matrix\.os \}\} is not ubuntu-24\.04/],
      ['pull_request_target', /line 3: privileged trigger pull_request_target/],
      ['top-level write permission', /line 6: permission contents: write is not read-only/],
      ['write-all on a job', /permission \*: write-all is not read-only/],
      ['inline write permission', /permission pull-requests: write is not read-only/],
      ['action pinned by major tag', /actions\/checkout@v4 not pinned/],
      ['action pinned by full tag', /actions\/setup-node@v4\.2\.0 not pinned/],
      ['secret reference', /line 14: secret reference/],
      ['event text in an expression', /line 14: untrusted event data/],
      ['private leak rules', /private leak rules/],
      ['checkout keeping credentials', /checkout without persist-credentials: false/],
      ['missing timeout', /job build: no timeout-minutes/],
      ['excessive timeout', /job other: timeout-minutes 90/],
    ];
    for (const [label, pattern] of expected) {
      assert.ok(problems.some((problem) => pattern.test(problem)), `${label} not reported:\n${problems.join('\n')}`);
    }
  });

  const GOOD_HEAD = 'on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-24.04\n' +
    '    timeout-minutes: 5\n    steps:\n';
  // Constructs that a comment-stripping, dot-only reading let through, and constructs a YAML
  // parser would resolve (quotes, escapes, anchors), refused since no parser is available.
  const JOB_HEAD = GOOD_HEAD.slice(0, GOOD_HEAD.indexOf('    steps:\n'));
  const JOB_TAIL = '    steps:\n      - run: echo hi\n';
  const PINNED = `actions/checkout@${'a'.repeat(40)}`;
  const BACKSLASH = /line 10: unparsed YAML construct \(backslash outside a block scalar\)/;
  const bypasses: [string, string, RegExp][] = [
    ['event text after a # inside a run block (GitHub substitutes before bash)',
      GOOD_HEAD + '      - run: |\n          echo hello # ${{ github.event.pull_request.title }}\n', /line 11: untrusted event data/],
    ['event text after a quoted }} in the expression',
      GOOD_HEAD + '      - run: echo "${{ format(\'}}{0}\', github.event.pull_request.title) }}"\n', /line 10: untrusted event data/],
    ['an expression that never closes', GOOD_HEAD + '      - run: echo "${{ format(\'}}\', github.event.pull_request.title) "\n', /line 10: expression never closed/],
    ['event text read with brackets',
      GOOD_HEAD + '      - run: echo "${{ github.event[\'pull_request\'][\'title\'] }}"\n', /line 10: untrusted event data/],
    ['the whole secrets context serialised',
      GOOD_HEAD + '      - run: echo "${{ toJSON(secrets) }}"\n', /line 10: secret reference/],
    ['secrets in a condition',
      GOOD_HEAD + '      - run: echo hi\n        if: secrets != null\n', /line 11: secret reference/],
    ['an action in an inline mapping',
      GOOD_HEAD + '      - {uses: actions/setup-node@v4}\n', /line 10: action actions\/setup-node@v4 not pinned/],
    ['the whole github context serialised', GOOD_HEAD + '      - run: echo "${{ toJSON(github) }}"\n',
      /line 10: github context read whole or by a computed index/],
    ['the github context read by a computed index', GOOD_HEAD + '      - run: echo "${{ github[matrix.k] }}"\n',
      /line 10: github context read whole or by a computed index/],
    ['event text with an upper-case context name', GOOD_HEAD + '      - run: echo "${{ GITHUB.EVENT.pull_request.title }}"\n',
      /line 10: untrusted event data/],
    ['secrets with an upper-case context name', GOOD_HEAD + '      - run: echo "${{ Secrets.KEY }}"\n',
      /line 10: secret reference/],
    ['${{ written \\x24{{ in a double-quoted string',
      GOOD_HEAD + '      - name: "\\x24{{ github.event.pull_request.title }}"\n        run: echo hi\n',
      BACKSLASH],
    ['${{ written \\u0024{{ in a double-quoted string',
      GOOD_HEAD + '      - name: "\\u0024{{ github.event.pull_request.title }}"\n        run: echo hi\n',
      BACKSLASH],
    ['${{ split by an escaped line break in a double-quoted string',
      GOOD_HEAD + '      - name: "$\\\n          {{ github.event.pull_request.title }}"\n        run: echo hi\n',
      BACKSLASH],
    ['a quoted uses key', GOOD_HEAD + '      - "uses": actions/checkout@v4\n',
      /line 10: unparsed YAML construct \(quoted key\)/],
    ['a quoted permissions key', JOB_HEAD + '    "permissions": write-all\n' + JOB_TAIL,
      /line 9: unparsed YAML construct \(quoted key\)/],
    ['an escaped pull_request_target key',
      'on:\n  "pull_request\\x5Ftarget":\n' + GOOD_HEAD.slice('on:\n  pull_request:\n'.length) + '      - run: echo hi\n',
      /line 2: unparsed YAML construct/],
    ['an anchor and an alias', GOOD_HEAD + `      - &step {uses: ${PINNED}}\n      - *step\n`,
      /line 10: unparsed YAML construct \(anchor or alias\)/],
    ['persist-credentials outside with:', GOOD_HEAD + `      - uses: ${PINNED}\n        env:\n          persist-credentials: false\n`,
      /line 10: checkout without persist-credentials: false/],
    ['continue-on-error on a step', GOOD_HEAD + '      - run: echo hi\n        continue-on-error: true\n',
      /line 11: continue-on-error/],
    ['continue-on-error on a job', JOB_HEAD + '    continue-on-error: true\n' + JOB_TAIL, /line 9: continue-on-error/],
    ['a container image by tag', JOB_HEAD + '    container: node:24\n' + JOB_TAIL,
      /line 9: image node:24 not pinned by @sha256 digest/],
    ['a container image block by tag', JOB_HEAD + '    container:\n      image: node:24\n' + JOB_TAIL,
      /line 10: image node:24 not pinned by @sha256 digest/],
    ['a service image by tag', JOB_HEAD + '    services:\n      db:\n        image: postgres:17\n' + JOB_TAIL,
      /line 11: image postgres:17 not pinned by @sha256 digest/],
    ['a docker:// action by tag', GOOD_HEAD + '      - uses: docker://alpine:3.20\n',
      /line 10: image docker:\/\/alpine:3\.20 not pinned by @sha256 digest/],
    ['secrets in a folded condition', GOOD_HEAD + '      - run: echo hi\n        if: >-\n          secrets != null\n',
      /line 11: secret reference/],
    ['the token read with brackets', GOOD_HEAD + '      - run: echo "${{ github[\'token\'] }}"\n',
      /line 10: explicit token/],
    ['a docker run of an image by tag', GOOD_HEAD + '      - run: docker run --rm bash:3.2 bash -n install.sh\n',
      /line 10: docker command whose image is not a digest-pinned \*_IMAGE variable/],
    ['a docker pull by tag in a run block', GOOD_HEAD + '      - run: |\n          docker pull -q bash:3.2\n',
      /line 11: docker command whose image is not a digest-pinned \*_IMAGE variable/],
    ['an image variable by tag', GOOD_HEAD + '      - run: docker pull "$TOOL_IMAGE"\n        env:\n          TOOL_IMAGE: bash:3.2\n',
      /line 12: TOOL_IMAGE not pinned by @sha256 digest/],
  ];
  for (const [label, text, pattern] of bypasses) {
    test(`rejects ${label}`, () => {
      const problems = checkWorkflow(text);
      assert.ok(problems.some((problem) => pattern.test(problem)), `not reported:\n${problems.join('\n')}`);
    });
  }

  test('accepts event_name, a pinned inline action, digest-pinned images, continue-on-error: false', () => {
    const digest = `@sha256:${'c'.repeat(64)}`;
    const text = JOB_HEAD + `    container: node${digest}\n    services:\n      db:\n        image: postgres${digest}\n` +
      `    continue-on-error: false\n    steps:\n      - uses: docker://alpine${digest}\n` +
      `      - uses: ${PINNED}\n        with: {persist-credentials: false}\n` +
      `      - {uses: actions/setup-node@${'b'.repeat(40)}}\n      - run: echo "\${{ github.event_name }}"\n`;
    assert.deepEqual(checkWorkflow(text), []);
  });

  test('accepts docker commands through a digest-pinned image variable', () => {
    const text = GOOD_HEAD + `      - run: |\n          docker pull -q "$TOOL_IMAGE"\n          docker run --rm \\\n` +
      `            "\${TOOL_IMAGE}" true\n        env:\n          TOOL_IMAGE: bash:3.2@sha256:${'d'.repeat(64)}\n`;
    assert.deepEqual(checkWorkflow(text), []);
  });

  test('accepts a minimal conforming workflow', () => {
    const good = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-24.04\n` +
      `    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v1\n` +
      `        with:\n          persist-credentials: false\n`;
    assert.deepEqual(checkWorkflow(good), []);
  });
});

describe('the public CI as committed', () => {
  test('only the public workflows exist (no private workflow left)', () => {
    assert.deepEqual(workflowFiles(), [REGISTER_WORKFLOW, BACKPORT_WORKFLOW, POLICY_WORKFLOW, TRIAGE_WORKFLOW, NIGHTLY_WORKFLOW, DESCRIPTION_WORKFLOW, MACOS_WORKFLOW, PUBLIC_WORKFLOW, RELEASE_WORKFLOW, PREVIEW_CLEANUP_WORKFLOW, PREVIEW_WORKFLOW, SITE_WORKFLOW]);
  });

  for (const name of workflowFiles().filter((file) => file !== RELEASE_WORKFLOW)) {
    const profiles: Record<string, Profile> = {[DESCRIPTION_WORKFLOW]: 'description', [SITE_WORKFLOW]: 'site', [PREVIEW_WORKFLOW]: 'preview', [PREVIEW_CLEANUP_WORKFLOW]: 'preview-cleanup', [BACKPORT_WORKFLOW]: 'backport',
      [REGISTER_WORKFLOW]: 'register',
      [POLICY_WORKFLOW]: 'policy', [NIGHTLY_WORKFLOW]: 'nightly', [TRIAGE_WORKFLOW]: 'triage', [MACOS_WORKFLOW]: 'macos'};
    const profile: Profile = profiles[name] ?? 'public';
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

    test(`${name} satisfies every invariant`, () => {
      assert.deepEqual(checkWorkflow(text, profile), []);
    });

    if (name !== PUBLIC_WORKFLOW) continue;

    test(`${name} runs on push and pull_request, with a read-only token`, () => {
      const lines = parseLines(text);
      const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
      assert.ok(onIndex >= 0, 'no on: block');
      const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2).map((line) => line.key);
      assert.ok(triggers.includes('push') && triggers.includes('pull_request'), `triggers: ${triggers.join(', ')}`);
      assert.match(text, /^permissions:\n {2}contents: read\n/m);
    });

    // main and the maintenance branches are tested after every push (CONTRIBUTING.md, "Branches and versions").
    test(`${name} also runs on every push to a release/** branch`, () => {
      assert.match(text, /^ {2}push:\n(?: {4}#.*\n)* {4}branches: \[main, "release\/\*\*"\]\n/m);
    });

    test(`${name} gives the Node tests a bash 3.2 (MESH_BASH32), so the installer parse test runs`, () => {
      const frontend = jobBlocks(parseLines(text)).find((job) => job.name === 'frontend_parts');
      assert.ok(frontend, 'no frontend job');
      const raw = frontend.block.map((line) => line.raw);
      const exported = raw.findIndex((line) => line.includes('echo "MESH_BASH32=$wrapper" >> "$GITHUB_ENV"'));
      const nodeTests = raw.findIndex((line) => line.includes('- name: Node tests'));
      assert.ok(exported >= 0 && exported < nodeTests, `MESH_BASH32 at ${exported}, Node tests at ${nodeTests}`);
      assert.ok(raw.some((line) => line.includes('docker run --rm -v "$PWD:$PWD:ro" -w "$PWD" "$BASH32_IMAGE" bash "$@"')));
      assert.match(text, /^ {2}BASH32_IMAGE: bash:3\.2@sha256:[0-9a-f]{64}$/m);
    });

    test(`${name} saves the opam state from main only, before the project build`, () => {
      const guard = "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || " +
        "github.event_name == 'workflow_dispatch') && steps.opam-cache.outputs.cache-hit != 'true'";
      const lines = parseLines(text);
      const save = lines.findIndex((line) => usesOf(line).some((action) => action.startsWith('actions/cache/save@')));
      const trim = lines.findIndex((line) => line.text.includes('opam clean'));
      const deps = lines.findIndex((line) => line.text.includes('--deps-only'));
      const build = lines.findIndex((line) => line.text.includes('bash scripts/bootstrap.sh') && !line.text.includes('--deps-only'));
      assert.ok(deps >= 0 && deps < trim && trim < save && save < build, `order: deps ${deps}, trim ${trim}, save ${save}, build ${build}`);
      for (const step of [trim, save]) {
        const conditions = stepOf(lines, step).filter((line) => line.key === 'if').map((line) => line.text.trim());
        assert.deepEqual(conditions, [guard]);
      }
    });

    // The Node tests that start server.py (MESH_PYTHON) and the demo compiler test (bubblewrap)
    // find what they need in the job that runs them, set up before they run.
    test(`${name} gives the Node tests their Python and a working bubblewrap`, () => {
      const runner = 'node --experimental-strip-types --test --test-concurrency=4 "${selected[@]}"';
      const job = jobBlocks(parseLines(text)).find((item) => item.block.some((line) => line.raw.includes(runner)));
      assert.ok(job, 'no job runs the Node test files');
      const body = job.block.map((line) => line.raw).join('\n');
      const at = (needle: string): number => body.indexOf(needle);
      const before = (needle: string, limit: string): void =>
        assert.ok(at(needle) >= 0 && at(needle) < at(limit), `${needle} missing before ${limit} in job ${job.name}`);
      for (const needle of ['actions/setup-python@', 'pip install -r requirements-dev.txt', "python -c 'import aiohttp, cryptography'",
        'MESH_PYTHON=$(command -v python)" >> "$GITHUB_ENV"']) before(needle, runner);
      for (const needle of ['bash .github/scripts/apt-install.sh bubblewrap apparmor-profiles',
        'apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict', '/usr/bin/bwrap --unshare-all']) {
        before(needle, 'npm test --prefix demo-compiler');
      }
    });

    test(`${name} runs the local suite and the leak check with public rules`, () => {
      for (const needle of ['scripts/bootstrap.sh', 'scripts/test-ptyhost-t41.sh', 'npm run check', 'pytest -q',
        'ruff check', 'node --experimental-strip-types --test', 'tools/leak-guard/cli.ts worktree']) {
        assert.ok(text.includes(needle), `${needle} missing`);
      }
      assert.match(text, /^ {2}MESH_LEAK_PRIVATE_RULES: ""$/m);
    });

    // The Node tests that drive a Chromium skip themselves wherever there is none (the frontend
    // job). Every shard of the browser job has one: it runs its part of them, discovered by the
    // same grep this test applies, and fails rather than skips.
    test(`${name} runs every Node browser test in each Chromium shard, failing rather than skipping`, () => {
      const lines = parseLines(text);
      const at = lines.findIndex((line) => line.key === 'name' && line.value.startsWith('Node browser tests'));
      assert.ok(at >= 0, 'no Node browser tests step');
      const step = stepOf(lines, at);
      assert.deepEqual(step.filter((line) => line.key === 'if').map(line => line.value), ["matrix.kind == 'node'"], 'the step runs on every Node shard');
      const body = step.map((line) => line.raw).join('\n');
      for (const needle of ['MESH_REQUIRE_BROWSER=1', 'MESH_PYTHON="$(command -v python)"',
        "grep -lZE 'MESH_CHROMIUM|terminal-browser-lib' -- tests/*.test.ts", 'xargs -0 -r grep -LZ MESH_NATIVE_PTYHOST --',
        'LC_ALL=C sort -z', "mapfile -d '' -t candidates", 'set -o pipefail',
        "grep -qx '# skipped 0'", "grep -Eqx '# pass [1-9][0-9]*'"]) {
        assert.ok(body.includes(needle), `${needle} missing from the step`);
      }
      const tests = fs.readdirSync(path.join(ROOT, 'tests')).filter((file) => file.endsWith('.test.ts'));
      const source = (file: string): string => fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
      const needsChromium = tests.filter((file) => /MESH_CHROMIUM|terminal-browser-lib/.test(source(file)));
      assert.ok(needsChromium.length >= 16, `only ${needsChromium.length} Chromium tests found: the discovery grep is broken`);
    });

    test(`${name} retains the required browser checks and partitions both test sets exactly once`, () => {
      const jobs = jobBlocks(parseLines(text));
      const body = (name: string) => jobs.find(job => job.name === name)!.block.map(line => line.raw).join('\n');
      const parts = body('browser_parts'), gate = body('browser');
      assert.match(parts, /shard: \[0, 1, 2, 3\]/);
      assert.match(parts, /kind: \[python, node\]/);
      assert.match(parts, /if: matrix\.kind == 'python'/);
      assert.match(parts, /if: matrix\.kind == 'node'/);
      assert.match(gate, /name: browser tests \(Chromium, shard \$\{\{ matrix\.shard \}\} of 4\)/);
      assert.match(gate, /needs: browser_parts/);
      assert.match(gate, /needs\.browser_parts\.result/);
      assert.match(gate, /\"\$PARTS_RESULT\" != success/);
      assert.match(gate, /if: \"!cancelled\(\)\"/);
      const guard = (gate + '\n').match(/run: \|\n((?:          .*\n)+)/)?.[1];
      assert.ok(guard, 'missing required-check guard');
      for (const [parts, expected] of [['success', 0], ['failure', 1], ['skipped', 1], ['cancelled', 1]]) {
        const result = spawnSync('bash', ['-c', guard], {env: {...process.env, PARTS_RESULT: String(parts)}});
        assert.equal(result.status, expected, `guard accepted ${parts}`);
      }
      assert.match(parts, /needs: native/);
      assert.match(parts, /needs\.native\.result/);
      assert.match(parts, /\"\$NATIVE_RESULT\" != success/);
      const files = fs.readdirSync(path.join(ROOT, 'tests')).filter(file => file.endsWith('.test.ts'));
      const read = (file: string) => fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
      const candidates = files.filter(file => /MESH_CHROMIUM|terminal-browser-lib/.test(read(file)))
        .filter(file => !/MESH_NATIVE_PTYHOST/.test(read(file))).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const shards = Array.from({length: 4}, (_, shard) => candidates.filter((_, index) => index % 4 === shard));
      assert.ok(shards.every(shard => shard.length > 0));
      assert.deepEqual(shards.flat().sort(), [...candidates].sort());
      assert.equal(new Set(shards.flat()).size, candidates.length);
      // Exercise the exact awk assignment used by the Python step with uneven
      // weights: all collected files must reach one and only one shard.
      const collected = '25 tests/a.py\n8 tests/b.py\n7 tests/c.py\n5 tests/d.py\n1 tests/e.py\n';
      const pythonShards = Array.from({length: 4}, (_, shard) => {
        const script = `awk -v n=4 -v k=${shard} '{best = 0; for (i = 1; i < n; i++) if (load[i] < load[best]) best = i; load[best] += $1; if (best == k) print $2}'`;
        const result = spawnSync('bash', ['-c', script], {input: collected, encoding: 'utf8'});
        assert.equal(result.status, 0);
        return result.stdout.trim().split('\n').filter(Boolean);
      });
      assert.deepEqual(pythonShards.flat().sort(), ['tests/a.py', 'tests/b.py', 'tests/c.py', 'tests/d.py', 'tests/e.py']);
      assert.equal(new Set(pythonShards.flat()).size, 5);
    });

    test(`${name} partitions all Node files and gates the required check`, () => {
      const jobs = jobBlocks(parseLines(text));
      const body = (id: string) => jobs.find(job => job.name === id)!.block.map(line => line.raw).join('\n');
      const parts = body('frontend_parts'), gate = body('frontend');
      assert.match(parts, /shard: \[0, 1\]/);
      assert.match(parts, /fail-fast: false/);
      assert.match(parts, /i % 2 == shard/);
      assert.match(parts, /\$\{#selected\[@\]\} > 0/);
      assert.match(gate, /name: frontend and Node tests/);
      assert.match(gate, /needs: frontend_parts/);
      assert.match(gate, /if: "!cancelled\(\)"/);
      const guard = (gate + '\n').match(/run: \|\n((?:          .*\n)+)/)?.[1];
      assert.ok(guard);
      for (const [result, status] of [['success', 0], ['failure', 1], ['skipped', 1], ['cancelled', 1]]) {
        assert.equal(spawnSync('bash', ['-c', guard], {env: {...process.env, PARTS_RESULT: String(result)}}).status, status);
      }
      // Enumerate portably: this test is also run by the macOS job, whose
      // bash 3.2 has no mapfile and whose sort has no -z option.
      const discover = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})
        .flatMap(entry => {
          const relative = `${dir}/${entry.name}`;
          if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : discover(relative);
          return entry.isFile() && /\.test\.(?:ts|mjs|cjs)$/.test(entry.name) ? [relative] : [];
        });
      const all = discover('tests').sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const shards = [0, 1].map(shard => all.filter((_, index) => index % 2 === shard));
      assert.ok(shards.every(shard => shard.length > 0));
      assert.deepEqual(shards.flat().sort(), all.sort());
      assert.equal(new Set(shards.flat()).size, all.length);
    });

    test(`${name} runs the native catalog ratchet in the job that builds the native host`, () => {
      const job = jobBlocks(parseLines(text)).find((item) => item.block.some((line) => line.raw.includes('scripts/test-ptyhost-t41.sh')));
      assert.ok(job, 'no job builds the native host');
      const body = job.block.map((line) => line.raw).join('\n');
      for (const needle of ['tests/project-native-catalog-ratchet.test.ts', 'MESH_REQUIRE_NATIVE_PROJECTS=1',
        'MESH_NATIVE_PTYHOST="$(opam var bin)/mesh-ptyhost"', "grep -qx '# skipped 0'"]) {
        assert.ok(body.includes(needle), `${needle} missing from job ${job.name}`);
      }
    });

    // mesh-history is built by the same bootstrap.sh: its protocol test must run against that build,
    // failing rather than skipping, after the build and in the same job.
    test(`${name} runs the History index protocol test against the built mesh-history, failing rather than skipping`, () => {
      const lines = parseLines(text);
      const job = jobBlocks(lines).find((item) => item.block.some((line) => line.raw.includes('scripts/test-ptyhost-t41.sh')));
      assert.ok(job, 'no job builds the native host');
      const body = job.block.map((line) => line.raw).join('\n');
      for (const needle of ['name: History index protocol', 'MESH_HISTORY_CMD="$(opam var bin)/mesh-history"', 'MESH_REQUIRE_NATIVE_HISTORY=1',
        'tests/history-db-protocol.test.ts', "grep -qx '# skipped 0'", "grep -Eqx '# pass [1-9][0-9]*'"]) {
        assert.ok(body.includes(needle), `${needle} missing from job ${job.name}`);
      }
      assert.ok(body.indexOf('bash scripts/bootstrap.sh') < body.indexOf('name: History index protocol'), 'the step runs after the build');
    });

    // The Projects tests (work-read and work-write behind the server) skip without the programs: the
    // native job hands them over, and the jobs that run those tests require them, failing rather than skipping.
    test(`${name} hands work-read and work-write to the frontend and browser jobs, failing rather than skipping`, () => {
      const jobs = jobBlocks(parseLines(text));
      const body = (jobName: string): string => {
        const job = jobs.find((item) => item.name === jobName);
        assert.ok(job, `no ${jobName} job`);
        return job.block.map((line) => line.raw).join('\n');
      };
      const native = body('native');
      for (const needle of ['native-host/work-read', 'native-host/work-write', 'name: mesh-work-programs-linux-x86_64',
        'key: native-programs-']) {
        assert.ok(native.includes(needle), `${needle} missing from the native job`);
      }
      for (const jobName of ['frontend_parts', 'browser_parts']) {
        const job = body(jobName);
        for (const needle of ['name: mesh-work-programs-linux-x86_64', 'MESH_WORK_READ_CMD=$RUNNER_TEMP/native-work/work-read',
          'MESH_WORK_WRITE_CMD=$RUNNER_TEMP/native-work/work-write', 'MESH_REQUIRE_WORK_READ=1']) {
          assert.ok(job.includes(needle), `${needle} missing from the ${jobName} job`);
        }
      }
    });

    // The account alias and update image tests skip without mesh-platform: it travels with the work programs,
    // the cache key prefix changed when it joined (an older entry lacks it), and the test jobs require it.
    test(`${name} hands mesh-platform to the frontend and browser jobs, failing rather than skipping`, () => {
      const jobs = jobBlocks(parseLines(text));
      const body = (jobName: string): string => {
        const job = jobs.find((item) => item.name === jobName);
        assert.ok(job, `no ${jobName} job`);
        return job.block.map((line) => line.raw).join('\n');
      };
      const native = body('native');
      for (const needle of ['cp -L ocaml/_build/install/default/bin/mesh-platform native-host/mesh-platform',
        'test -x native-host/mesh-platform', '            native-host/mesh-platform', 'key: native-programs-v3-']) {
        assert.ok(native.includes(needle), `${needle} missing from the native job`);
      }
      for (const jobName of ['frontend_parts', 'browser_parts']) {
        const job = body(jobName);
        for (const needle of ['MESH_MESH_PLATFORM_CMD=$RUNNER_TEMP/native-work/mesh-platform', 'MESH_REQUIRE_MESH_PLATFORM=1',
          'MESH_REQUIRE_UPDATE_IMAGE=1']) {
          assert.ok(job.includes(needle), `${needle} missing from the ${jobName} job`);
        }
      }
    });

    // The backend profile tests (tests/backend-profiles.test.ts) skip without mesh-profile: it travels with the
    // work programs, the cache key prefix changed when it joined, and the frontend job (which runs them) requires it.
    test(`${name} hands mesh-profile to the frontend job, failing rather than skipping`, () => {
      const jobs = jobBlocks(parseLines(text));
      const body = (jobName: string): string => {
        const job = jobs.find((item) => item.name === jobName);
        assert.ok(job, `no ${jobName} job`);
        return job.block.map((line) => line.raw).join('\n');
      };
      const native = body('native');
      for (const needle of ['cp -L ocaml/_build/install/default/bin/mesh-profile native-host/mesh-profile',
        'test -x native-host/mesh-profile', '            native-host/mesh-profile', 'key: native-programs-v3-']) {
        assert.ok(native.includes(needle), `${needle} missing from the native job`);
      }
      const frontend = body('frontend_parts');
      for (const needle of ['"$RUNNER_TEMP/native-work/mesh-profile"', 'MESH_PROFILE_CMD=$RUNNER_TEMP/native-work/mesh-profile',
        'MESH_REQUIRE_MESH_PROFILE=1']) {
        assert.ok(frontend.includes(needle), `${needle} missing from the frontend job`);
      }
    });
    test(`${name} requires the real account helper for the running-app browser tests`, () => {
      const browser = jobBlocks(parseLines(text)).find(item => item.name === 'browser_parts');
      assert.ok(browser);
      const body = browser.block.map(line => line.raw).join('\n');
      for (const needle of ['"$RUNNER_TEMP/native-work/mesh-profile"',
        'MESH_PROFILE_CMD=$RUNNER_TEMP/native-work/mesh-profile', 'MESH_REQUIRE_MESH_PROFILE=1',
        'MESH_BACKEND_ACCOUNT_HELPER=$RUNNER_TEMP/native-work/mesh-profile', 'MESH_REQUIRE_BACKEND_ACCOUNT_APP=1']) {
        assert.ok(body.includes(needle), `${needle} missing from browser helper staging`);
      }
    });
  }
});

describe('the PR description workflow', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, DESCRIPTION_WORKFLOW), 'utf8');
  const jobs = jobBlocks(parseLines(text)).map((item) => item.block.map((line) => line.raw).join('\n'));

  test('the body expression is allowed on the BODY line of this workflow only', () => {
    assert.ok(checkWorkflow(text).some((problem) => /untrusted event data/.test(problem)), 'strict mode refuses it');
    const elsewhere = text + '      - run: echo "${{ github.event.pull_request.body }}"\n';
    assert.ok(checkWorkflow(elsewhere, 'description').some((problem) => /untrusted event data/.test(problem)));
    const title = text.replace('github.event.pull_request.body', 'github.event.pull_request.title');
    assert.ok(checkWorkflow(title, 'description').some((problem) => /untrusted event data/.test(problem)));
  });

  test('triggers on pull_request and the merge queue only, with the four types and a read-only token', () => {
    assert.match(text, /^on:\n {2}pull_request:\n {4}types: \[opened, edited, reopened, synchronize\]\n(?: {2}#.*\n)* {2}merge_group:\n {4}types: \[checks_requested\]\n/m);
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /pull_request_target|workflow_run|pull-requests|issues:/);
  });

  test('has one job with the exact check name', () => {
    assert.equal(jobs.length, 1);
    assert.match(jobs[0], /^ {4}name: PR description \(no personal details\)$/m);
  });

  test('hands the body over in the environment and writes it with printf, never in script text', () => {
    const body = jobs[0];
    assert.match(body, /^ {10}BODY: \$\{\{ github\.event\.pull_request\.body \}\}$/m);
    assert.ok(body.includes('printf \'%s\' "$BODY" > "$RUNNER_TEMP/pr-body.md"'));
    assert.doesNotMatch(body.split(/^ {8}run: \|\n/m).slice(-1)[0], /\$\{\{/);
    assert.ok(body.includes('cli.ts pr-body "$RUNNER_TEMP/pr-body.md"'));
    assert.doesNotMatch(body, /--private/);
  });

  // Warning mode is explicit: the step captures the tool status, exits 0 on findings (status 1) and
  // fails on a tool error (status 2 or more, secrets not checked, status 1 without a finding line),
  // instead of hiding a failure with continue-on-error.
  test('warning mode is explicit: status captured, findings exit 0, tool errors fail, no continue-on-error', () => {
    const body = jobs[0];
    assert.doesNotMatch(body, /continue-on-error/);
    for (const needle of ['warn_only=true', '|| status=$?', 'cat "$RUNNER_TEMP/report.txt"',
      'if [[ "$status" -ne 0 && "$status" -ne 1 ]]; then', 'exit "$status"', "grep -q 'secrets were NOT checked'",
      "if ! grep -q '^<pr-body>'",
      '::warning title=PR description::', '>> "$GITHUB_STEP_SUMMARY"', '.github/pull_request_template.md',
      'if [[ "$warn_only" == true ]]; then']) assert.ok(body.includes(needle), `${needle} missing`);
  });

  // Runs the step script with `node` replaced by `node` (default: this Node) and extra environment.
  function withStep(check: (run: (bodyText: string, node?: string, env?: NodeJS.ProcessEnv) =>
    {status: number | null; out: string; summary: string}, dir: string) => void): void {
    const body = jobs[0];
    const script = body.slice(body.indexOf('          warn_only=true')).replace(/^ {10}/gm, '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-desc-'));
    try {
      check((bodyText, node = process.execPath, env = {}) => {
        const summary = path.join(dir, 'summary.md');
        fs.writeFileSync(summary, '');
        const bin = path.join(dir, 'fakebin');
        fs.rmSync(bin, {recursive: true, force: true});
        fs.mkdirSync(bin);
        fs.symlinkSync(node, path.join(bin, 'node'));
        const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {cwd: ROOT, encoding: 'utf8',
          env: {...process.env, PATH: `${bin}:${process.env.PATH}`, BODY: bodyText, RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: summary, MESH_LEAK_PRIVATE_RULES: '', ...env}});
        return {status: result.status, out: result.stdout, summary: fs.readFileSync(summary, 'utf8')};
      }, dir);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }

  test('the step script behaves: clean and empty pass, a finding warns with exit 0, a tool failure fails',
    {skip: gitleaksAvailable() ? false : 'gitleaks is not installed'}, () => {
      withStep((run, dir) => {
        assert.equal(run('').status, 0);
        const clean = run('## What\n\nA clean description.');
        assert.equal(clean.status, 0, clean.out);
        assert.match(clean.out, /^leak-guard pr-body: 0 finding\(s\)$/m, 'the report is printed');
        const leaky = run('## What\n\nSee /ho' + 'me/zed/projects');
        assert.equal(leaky.status, 0, leaky.out);
        assert.match(leaky.out, /^leak-guard pr-body: 1 finding\(s\)$/m, 'the report is printed');
        assert.match(leaky.out, /^::warning title=PR description::<pr-body>:3 /m);
        assert.match(leaky.summary, /pull_request_template\.md/);
        const broken = path.join(dir, 'broken-node');
        fs.writeFileSync(broken, '#!/bin/sh\nexit 2\n', {mode: 0o755});
        assert.equal(run('text', broken).status, 2);
      });
    });

  test('the step script fails when secrets were not checked, or on exit 1 without a finding line', () => {
    withStep((run, dir) => {
      for (const bodyText of ['## What\n\nA clean description.', '## What\n\nSee /ho' + 'me/zed/projects']) {
        const unchecked = run(bodyText, process.execPath, {MESH_LEAK_GITLEAKS: path.join(dir, 'no-gitleaks')});
        assert.equal(unchecked.status, 2, unchecked.out);
        assert.match(unchecked.out, /^warning: gitleaks not found .*: secrets were NOT checked$/m, 'the report is printed');
        assert.match(unchecked.out, /could not check secrets: tool failure/);
      }
      const silent = path.join(dir, 'silent-node');
      fs.writeFileSync(silent, '#!/bin/sh\necho "leak-guard pr-body: 1 finding(s)"\nexit 1\n', {mode: 0o755});
      const noFinding = run('text', silent);
      assert.equal(noFinding.status, 2, noFinding.out);
      assert.match(noFinding.out, /exited 1 without any finding line: tool failure/);
      assert.doesNotMatch(noFinding.out, /::warning/);
    });
  });
});
