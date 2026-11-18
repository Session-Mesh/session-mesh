// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The nightly pre-release workflow (.github/workflows/nightly.yml) as committed, the faults its
// profile (tests/nightly-workflow-checks.ts) must report (each is an edit of the committed file, so a
// weakened rule fails here even if the file still looks fine), and the pre-release flag of release.yml.
// Its scripts are tested in tests/nightly-decision-scripts.test.ts and
// tests/nightly-retention-scripts.test.ts and tests/nightly-release-tag.test.ts, with the helpers of tests/nightly-test-scripts.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {release, text} from './nightly-test-scripts.ts';
import {checkWorkflow} from './public-ci-workflow-checks.ts';

const WORKFLOWS = path.join(import.meta.dirname, '..', '.github', 'workflows');
const problems = (workflow: string): string => checkWorkflow(workflow, 'nightly').join('\n');

function edit(from: string, to: string): string {
  assert.ok(text.includes(from), `the workflow no longer contains: ${from}`);
  return text.replace(from, to);
}

describe('the nightly workflow as committed', () => {
  test('satisfies the nightly profile', () => {
    assert.deepEqual(checkWorkflow(text, 'nightly'), []);
  });

  test('runs on a schedule and on a manual run, never on a pull request, a fork or a push', () => {
    assert.match(text, /^on:\n {2}schedule:\n {4}# [^\n]*\n {4}- cron: "17 2 \* \* \*"\n {2}workflow_dispatch:\n\npermissions:/m);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /pull_request|\bworkflow_run\b|\bpush\s*:|\bfork/);
  });

  test('has no action and no secret, and names the token only as GH_TOKEN of a script step', () => {
    assert.doesNotMatch(text, /^\s*(?:-\s+)?uses:/m);
    assert.doesNotMatch(text, /secrets\./);
    assert.equal(text.match(/github\.token/g)?.length, 4);
    assert.equal(text.match(/^ {10}GH_TOKEN: \$\{\{ github\.token }}$/gm)?.length, 4);
  });

  test('gives the decision job a read-only token and the start job the two write scopes it needs', () => {
    assert.match(text, /^ {2}decide:\n[^]*?\n {4}permissions:\n {6}contents: read\n {6}checks: read\n {6}actions: read\n/m);
    assert.match(text, /^ {2}start:\n[^]*?\n {4}permissions:\n {6}contents: write\n {6}actions: write\n/m);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ""), /id-token|attestations|packages:|pull-requests:/);
  });

  test('never overlaps two runs and never cancels one', () => {
    assert.match(text, /^concurrency:\n {2}group: nightly\n {2}cancel-in-progress: false\n/m);
  });

  test('tags a nightly 0.<next minor>.0-nightly.<date>, from the latest stable release', () => {
    assert.match(text, /gh api "repos\/\$GH_REPO\/releases\/latest" --jq \.tag_name/);
    assert.match(text, /tag="v\$\{BASH_REMATCH\[1\]\}\.\$\(\(10#\$\{BASH_REMATCH\[2\]\} \+ 1\)\)\.0-nightly\.\$today"/);
  });

  test('requires the checks of the ruleset that run on main', () => {
    for (const name of ['cla', 'leak check (public rules)', 'OCaml build, tests and native ptyhost gate', 'frontend and Node tests',
      'ruff and pytest (without browser)']) assert.ok(text.includes(`"${name}"`), name);
    for (const shard of [0, 1, 2, 3]) assert.ok(text.includes(`"browser tests (Chromium, shard ${shard} of 4)"`), `shard ${shard}`);
    // These names are those of public-ci.yml.
    const ci = fs.readFileSync(path.join(WORKFLOWS, 'public-ci.yml'), 'utf8');
    for (const name of ['frontend and Node tests', 'ruff and pytest (without browser)', 'OCaml build, tests and native ptyhost gate',
      'leak check (public rules)']) assert.ok(ci.includes(`name: ${name}`), `public-ci.yml has no job named ${name}`);
    assert.ok(ci.includes('name: browser tests (Chromium, shard ${{ matrix.shard }} of 4)'));
    assert.match(ci, /^ {2}cla:\n {4}name: cla\n/m);
  });

  const faults: [string, string, string, RegExp][] = [
    ['a pull_request trigger', '  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n', /triggers are pull_request, schedule, workflow_dispatch|pull request, fork/],
    ['a pull_request_target trigger', '  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target:\n', /privileged trigger|pull request, fork/],
    ['a push trigger', '  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n', /triggers are push, schedule, workflow_dispatch/],
    ['a cron on the hour', '"17 2 * * *"', '"0 2 * * *"', /not on the hour/],
    ['a second cron', '    - cron: "17 2 * * *"\n', '    - cron: "17 2 * * *"\n    - cron: "47 14 * * *"\n', /exactly one cron entry/],
    ['an hourly cron', '"17 2 * * *"', '"17 * * * *"', /fixed hour/],
    ['a manual run with inputs', '  workflow_dispatch:\n', '  workflow_dispatch:\n    inputs:\n      tag:\n        type: string\n', /workflow_dispatch must take no inputs/],
    ['a write permission at the top level', 'permissions:\n  contents: read\n\nconcurrency', 'permissions:\n  contents: write\n\nconcurrency', /top-level permissions must be exactly contents: read/],
    ['a write scope in the decision job', '      contents: read\n      checks: read', '      contents: write\n      checks: read', /job decide: permissions must be exactly/],
    ['attestation scopes in the start job', '      contents: write\n      actions: write', '      contents: write\n      actions: write\n      id-token: write', /job start: permissions must be exactly/],
    ['a third job', '  start:\n', '  extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: true\n  start:\n', /must have the jobs decide, start/],
    ['an action', '      - name: Decide whether', '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - name: Decide whether', /an action in the nightly workflow/],
    ['a secret', '          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          nightly_tag_pattern',
      '          GH_TOKEN: ${{ secrets.TOKEN }}\n        run: |\n          set -euo pipefail\n          nightly_tag_pattern', /secret reference/],
    ['an expression in a script', '          echo "release.yml started on $NIGHTLY_TAG:', '          echo "${{ github.sha }} release.yml started on $NIGHTLY_TAG:', /an expression inside a script/],
    ['untrusted event text', '          export GH_REPO="$GITHUB_REPOSITORY"\n          gh workflow run', '          export GH_REPO="${{ github.event.head_commit.message }}"\n          gh workflow run', /untrusted event data in an expression|an expression inside a script/],
    ['a script without strict bash', '          set -euo pipefail\n          export GH_REPO="$GITHUB_REPOSITORY"\n          gh workflow run', '          export GH_REPO="$GITHUB_REPOSITORY"\n          gh workflow run', /must start with set -euo pipefail/],
    ['no concurrency group', 'concurrency:\n  group: nightly\n', 'concurrency:\n  group: other\n', /concurrency must be exactly/],
    ['a cancelling concurrency group', 'cancel-in-progress: false', 'cancel-in-progress: true', /concurrency must be exactly/],
    ['a runner other than ubuntu-24.04', '  decide:\n    name: decide nightly\n    if: github.repository == \'Session-Mesh/session-mesh\' && github.ref == \'refs/heads/main\'\n    runs-on: ubuntu-24.04',
      '  decide:\n    name: decide nightly\n    if: github.repository == \'Session-Mesh/session-mesh\' && github.ref == \'refs/heads/main\'\n    runs-on: self-hosted', /self-hosted/],
    ['no timeout', '    timeout-minutes: 10\n    permissions:\n      contents: read', '    permissions:\n      contents: read', /job decide: no timeout-minutes/],
    ['a looser tag pattern in the decision job', "nightly_tag_pattern='^v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\.[0-9]{8}$'\n          export GH_REPO=\"$GITHUB_REPOSITORY\"\n          skip()",
      "nightly_tag_pattern='-nightly\\.'\n          export GH_REPO=\"$GITHUB_REPOSITORY\"\n          skip()", /nightly_tag_pattern must be exactly/],
    ['a deletion cap removed', '            if [ "$deleted" -ge "$MAX_DELETIONS" ]; then', '            if false; then', /must stop at MAX_DELETIONS/],
    ['a deletion without the pattern guard', '            [[ "$tag" =~ $nightly_tag_pattern ]] || continue\n', '', /skip every tag that does not match nightly_tag_pattern/],
    ['a deletion of a release that is not a pre-release', '$1 == wanted && $4 != "true" {n++}', '$1 == wanted && $4 == "never" {n++}', /only when it is a pre-release/],
    ['a deletion in the decision job', '          tag="v${BASH_REMATCH[1]}', '          gh release delete "$previous" --yes\n          tag="v${BASH_REMATCH[1]}', /a deletion outside the start job|must only read/],
    ['a release created by the nightly itself', '          gh workflow run release.yml --ref "$NIGHTLY_TAG"', '          gh release create "$NIGHTLY_TAG" --latest', /never creates or edits a release itself/],
    ['a release.yml run on the branch instead of the tag', 'gh workflow run release.yml --ref "$NIGHTLY_TAG"', 'gh workflow run release.yml --ref main', /must start release\.yml on the nightly tag/],
    ['a start job that runs without the decision', "    if: needs.decide.outputs.publish == 'true'\n", '', /run only when the decision job says publish/],
    ['a decision job that runs on any branch', " && github.ref == 'refs/heads/main'", '', /on the repository and on main only/],
    ['a CI gate that accepts a neutral check', '$3 != "success"', '$3 != "neutral"', /require every check run to be completed\/success/],
    ['a CI gate that counts the check runs of any app', 'select(.app.id == 15368) | ', '', /only the check runs of the GitHub Actions app/],
    ['a CI gate on another app', 'select(.app.id == 15368)', 'select(.app.id == 1)', /only the check runs of the GitHub Actions app/],
    ['a CI gate that accepts a name without any run', 'if (runs == 0) print "none"; else if', 'if (runs == 0) print ""; else if', /and at least one/],
    ['an orphan loop without a bound', '"$total" -ge "$MAX_REDISPATCH"', 'false', /at most MAX_REDISPATCH times/],
    ['a retention that may fail the run', '; exit 0\' ERR', '\' ERR', /retention step must end with a warning/],
  ];
  for (const [label, from, to, expected] of faults) {
    test(`reports ${label}`, () => {
      assert.match(problems(edit(from, to)), expected);
    });
  }

  test('reports a retention that runs before release.yml is started', () => {
    const marker = '      # Last, and allowed to fail';
    const dispatch = '      - name: Start the release workflow on the tag\n';
    assert.ok(text.includes(marker) && text.includes(dispatch));
    const retention = text.slice(text.indexOf(marker));
    const beforeRetention = text.slice(0, text.indexOf(marker));
    const swapped = beforeRetention.replace(dispatch, () => retention + dispatch);
    assert.match(problems(swapped), /must start release\.yml before the retention step/);
  });
});

describe('release.yml publishes a nightly tag as a pre-release, never as the latest release', () => {
  test('a tag with a suffix gets --prerelease and no latest lookup', () => {
    assert.match(release, /if \[\[ "\$RELEASE_TAG" == \*-\* \]\]; then kind=\(--prerelease\); fi/);
    assert.match(release, /latest=\(\)\n {10}if \[ "\$\{#kind\[@\]\}" -eq 0 \]; then/);
    assert.doesNotMatch(release, /--latest(?!=false)/);
  });

  test('a nightly release opens with the message of its annotated tag, and a lightweight nightly tag is refused', () => {
    assert.match(release, /if \[\[ "\$RELEASE_TAG" == \*-nightly\.\* \]\]; then\n {12}if \[ "\$\(printf '%s\\n' "\$refs" \| wc -l\)" -ne 2 \]; then/);
    assert.match(release, /gh api "repos\/\$GH_REPO\/git\/tags\/\$tag_object" --jq \.message/);
  });

  test('the tag job accepts a nightly tag only from a manual run on that tag and checks it names a commit of main', () => {
    assert.match(release, /elif \[ "\$GITHUB_EVENT_NAME" = workflow_dispatch \] && \[ "\$GITHUB_REF_TYPE" = tag \] && \[\[ "\$GITHUB_REF_NAME" =~ \$nightly \]\]; then/);
    assert.match(release, /name: Check that the tag names a commit of main or of release\/latest\n {8}if: steps\.name\.outputs\.publish == 'true'/);
  });
});
