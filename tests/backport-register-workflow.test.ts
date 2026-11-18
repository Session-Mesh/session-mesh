// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The register backport workflow (.github/workflows/backport-register.yml) as committed, and the
// faults its profile (tests/backport-register-workflow-checks.ts) must report: each is an edit of
// the committed file, so that a weakened rule fails here even if the file still looks fine. What
// its scripts do on a repository is in tests/backport-register-replay.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {PUSH_LINE} from './backport-register-workflow-checks.ts';

const FILE = path.join(import.meta.dirname, '..', '.github', 'workflows', 'backport-register.yml');
const text = fs.readFileSync(FILE, 'utf8');
const problems = (workflow: string): string => checkWorkflow(workflow, 'register').join('\n');

function edit(from: string, to: string): string {
  assert.ok(text.includes(from), `the workflow no longer contains: ${from}`);
  return text.replace(from, to);
}

// The same edit on the last occurrence (the push job, when both jobs have the line).
function editLast(from: string, to: string): string {
  const index = text.lastIndexOf(from);
  assert.ok(index >= 0, `the workflow no longer contains: ${from}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

const CHECKOUT_INPUTS = '          fetch-depth: 0\n';
const FILES_SCRIPT = '          changed=false\n';
const PUSH_SCRIPT = '          git merge-base';
const REGISTER_LIST = 'paths=(CONTRIBUTORS.md CLA.md CLA-SIGNATORIES.md tools/cla-check/MAINTAINERS .github/CODEOWNERS)';

describe('the register backport workflow as committed', () => {
  test('says that a maintainer with write access approves the workflow runs of a pull request opened with the run\'s token', () => {
    assert.match(text, /A maintainer with write access starts it with 'Approve workflows to run' on this pull request; closing and reopening it is not needed\./);
    assert.doesNotMatch(text, /starts no workflow for such a pull request/);
  });

  test('satisfies the register profile', () => {
    assert.deepEqual(checkWorkflow(text, 'register'), []);
  });

  test('runs when a pull request to main is closed, and holds a write token only for a register change', () => {
    assert.match(text, /^ {4}types: \[closed\]$/m);
    assert.match(text, /^ {4}branches: \[main\]$/m);
    assert.match(text, /^ {4}if: github\.event\.pull_request\.merged == true$/m);
    assert.match(text, /^ {4}needs: register-files\n {4}if: needs\.register-files\.outputs\.changed == 'true'$/m);
    assert.match(text, /^ {4}permissions:\n {6}pull-requests: read\n {4}outputs:/m);
  });

  test('leaves a semver: patch pull request to backport.yml, which backports it whole', () => {
    assert.match(text, /^ {10}PATCH: "\$\{\{ contains\(github\.event\.pull_request\.labels\.\*\.name, 'semver: patch'\) \}\}"$/m);
  });

  test('opens the pull request with the label and the reference the release branch guard reads', () => {
    assert.match(text, /--base release\/latest --head "\$branch" --label "semver: patch"/);
    assert.match(text, /body="Backport of #\$NUMBER to/);
    assert.ok(text.includes(PUSH_LINE));
  });
});

describe('the register profile rejects what would run a pull request\'s code or push elsewhere', () => {
  const faults: [string, string, RegExp][] = [
    ['a checkout of the pull request head', edit(CHECKOUT_INPUTS, `${CHECKOUT_INPUTS}          ref: \${{ github.event.pull_request.head.sha }}\n`),
      /github\.event\.pull_request\.head\.sha|the pull request's head is named/],
    ['a checkout of another repository', edit(CHECKOUT_INPUTS, `${CHECKOUT_INPUTS}          repository: someone/fork\n`), /checkout takes exactly token and fetch-depth: 0/],
    ['a shallow checkout', edit(CHECKOUT_INPUTS, '          fetch-depth: 1\n'), /checkout takes exactly/],
    ['the pull request title in an expression', edit('          COUNT:', '          TITLE: ${{ github.event.pull_request.title }}\n          COUNT:'),
      /untrusted event data in an expression \(github\.event\.pull_request\.title\)/],
    ['the head commit id in an expression', edit('          COUNT:', '          HEAD: ${{ github.event.pull_request.head.sha }}\n          COUNT:'),
      /github\.event\.pull_request\.head\.sha/],
    ['another secret', edit('          COUNT:', '          X: ${{ secrets.DEPLOY_KEY }}\n          COUNT:'), /secret other than BACKPORT_APP_ID/],
    ['the run\'s token under another name', edit('          COUNT:', '          GITHUB_TOKEN: ${{ github.token }}\n          COUNT:'), /explicit token outside the expected form/],
    ['the App token in the files job', edit('          GH_TOKEN: ${{ github.token }}', '          GH_TOKEN: ${{ steps.app-token.outputs.token || github.token }}'),
      /explicit token outside the expected form/],
    ['a labeled trigger', edit('types: [closed]', 'types: [closed, labeled]'), /exactly the types \[closed\]/],
    ['any base branch', edit('    branches: [main]\n', '    branches: [main, "release/**"]\n'), /limited to branches: \[main\]/],
    ['a workflow_dispatch trigger', edit('    branches: [main]\n', '    branches: [main]\n  workflow_dispatch:\n'), /expected pull_request_target only/],
    ['a write token in the files job', edit('      pull-requests: read\n', '      pull-requests: write\n'), /job register-files: permissions must be exactly pull-requests: read/],
    ['an extra write scope in the push job', edit('      pull-requests: write\n', '      pull-requests: write\n      actions: write\n'), /job register-backport: permissions must be exactly/],
    ['a top-level write token', edit('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'), /top-level permissions must be exactly contents: read/],
    ['a push job that does not wait for the files', edit('    needs: register-files\n', ''), /needs: must be register-files/],
    ['a push job without its gate', edit("    if: needs.register-files.outputs.changed == 'true'\n", ''), /if: must be exactly needs/],
    ['a files job that also runs on an unmerged pull request', edit('    if: github.event.pull_request.merged == true\n', ''), /job register-files: if: must be exactly/],
    ['a script that runs node', edit(FILES_SCRIPT, `${FILES_SCRIPT}          node tools/x.ts\n`), /runs something of the checkout/],
    ['a script that runs a file of the checkout', edit(PUSH_SCRIPT, `          bash scripts/x.sh\n${PUSH_SCRIPT}`), /runs something of the checkout/],
    ['git with a configuration override', edit(PUSH_SCRIPT, `          git -c core.hooksPath=x status\n${PUSH_SCRIPT}`), /runs git -c/],
    ['a git subcommand outside the list', edit(PUSH_SCRIPT, `          git config alias.x '!sh'\n${PUSH_SCRIPT}`), /runs git config/],
    ['git in the files job', edit(FILES_SCRIPT, `${FILES_SCRIPT}          git log\n`), /runs git log/],
    ['another gh command', edit(PUSH_SCRIPT, `          gh workflow run x.yml\n${PUSH_SCRIPT}`), /runs gh workflow/],
    ['a push to release/latest', edit(PUSH_LINE, 'git push --quiet origin "HEAD:refs/heads/release/latest"'), /the one push must be/],
    ['a second push', edit(PUSH_LINE, `${PUSH_LINE}\n          git push --quiet origin HEAD:main`), /the one push must be/],
    ['another branch name', edit('branch="backport-$NUMBER-cla-register-to-release/latest"', 'branch="release/latest"'), /the branch must be set by/],
    ['a register list without MAINTAINERS', editLast(REGISTER_LIST, 'paths=(CONTRIBUTORS.md CLA.md CLA-SIGNATORIES.md .github/CODEOWNERS)'),
      /register-backport: the register files must be listed once/],
    ['a register list with another file', edit(REGISTER_LIST, REGISTER_LIST.replace('CLA.md ', 'CLA.md src/x.ts ')), /register-files: the register files must be listed once/],
    ['file names split into lines', edit('any(IN($ARGS.positional[]))', 'map(select(IN($ARGS.positional[]))) | length > 0'),
      /register-files: the script must contain the line changed=\$\(jq/],
    ['no check that a commit without landed commit is empty', edit('[[ "$changed_files" == 0 ]]', '[[ -n "$changed_files" ]]'), /the script must contain the line \[\[ "\$changed_files"/],
    ['no check of the number of listed commits', edit('[[ "${#pr_shas[@]}" -eq "$COUNT" ]]', 'true'), /the script must contain the line \[\[ "\$\{#pr_shas/],
    ['an unvalidated commit id from the API', edit('[[ "$sha" =~ ^[0-9a-f]{40}$ ]]', 'true'), /the script must contain the line \[\[ "\$sha"/],
    ['a replay accepted whatever main holds', edit('[[ "$replayed" == "$on_main" ]] ||', 'true ||'), /the script must contain the line \[\[ "\$replayed"/],
    ['a release file taken for any state before the range', edit('[[ "$on_release" == "$before_range" ]] ||', 'true ||'), /the script must contain the line \[\[ "\$on_release"/],
    ['the base of the range read from main now', edit('before_range=$(git ls-tree "$range_base" -- "$path")', 'before_range=$(git ls-tree origin/main -- "$path")'), /the script must contain the line before_range=/],
    ['the blobs of main read from the wrong ref', edit('on_main=$(git ls-tree origin/main -- "$path")', 'on_main=$(git ls-tree origin/release/latest -- "$path")'), /the script must contain the line on_main=/],
    ['a git error of the landed list read as a shorter list', edit('chain=$(git rev-list --first-parent --max-count="$COUNT" "$LANDED")', 'chain=$(git rev-list --first-parent --max-count="$COUNT" "$LANDED" || true)'), /the script must contain the line chain=/],
    ['no comparison of the landed commit with the commit of the pull request by change', edit('[[ -n "$landed_id" && "$landed_id" == ', '[[ -n "$landed_id" || '),
      /the script must contain the line \[\[ -n "\$landed_id"/],
    ['no fetch of the commits of the pull request', edit('git fetch --quiet --no-tags origin "${landed_pr[$index]}" ||', 'true ||'), /the script must contain the line git fetch --quiet --no-tags/],
    ['a replay with rename detection', edit('git diff --binary --no-renames', 'git diff --binary'), /the script must contain the line git diff --binary --no-renames/],
    ['no exact check of the replayed paths', edit('[[ "$known" == true ]] ||', 'true ||'), /the script must contain the line \[\[ "\$known"/],
    ['the replayed paths read by line', edit('git diff --name-only -z --no-renames', 'git diff --name-only --no-renames'), /the script must contain the line git diff --name-only -z/],
    ['a symbolic link accepted', edit('|| "$mode" == 100755 ]]', '|| "$mode" == 100755 || "$mode" == 120000 ]]'), /the script must contain the line \[\[ -z "\$mode"/],
    ['another API call in the push job', edit(PUSH_SCRIPT, `          gh api -X DELETE repos/x\n${PUSH_SCRIPT}`), /the two API calls must be pr_commits=/],
    ['a changed-files request without --paginate', edit('gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$NUMBER/files"', 'gh api "repos/$GITHUB_REPOSITORY/pulls/$NUMBER/files"'),
      /register-files: the one API call must be files=/],
    ['a files job that no longer exports changed', edit('      changed: ${{ steps.files.outputs.changed }}\n', '      other: ${{ steps.files.outputs.changed }}\n'), /register-files: outputs must be exactly changed/],
    ['a files job output read from another step', edit('changed: ${{ steps.files.outputs.changed }}', 'changed: ${{ steps.other.outputs.changed }}'), /register-files: outputs must be exactly changed/],
    ['a files job output from another name of the detection step', edit('changed: ${{ steps.files.outputs.changed }}', 'changed: ${{ steps.files.outputs.found }}'), /register-files: outputs must be exactly changed/],
    ['a detection step without its id', edit('        id: files\n', ''), /the detection step must have id: files/],
    ['a detection step that writes another output', edit('echo "changed=$changed" >> "$GITHUB_OUTPUT"', 'echo "found=$changed" >> "$GITHUB_OUTPUT"'),
      /register-files: the script must contain the line echo "changed=/],
    ['a folded run block in the files job', edit('        run: |\n          set -euo pipefail\n          [[ "$NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::unexpected pull request number"',
      '        run: >\n          set -euo pipefail\n          [[ "$NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::unexpected pull request number"'), /register-files: line \d+: run: must be a literal block/],
    ['a folded run block in the push job', editLast('        run: |\n', '        run: >\n'), /register-backport: line \d+: run: must be a literal block/],
    ['no check of the paths before a commit', edit('            check_register_paths --cached\n', ''), /every commit must be preceded by check_register_paths --cached/],
    ['the staged paths checked after the commit', edit('            check_register_paths --cached\n            git commit --quiet --reuse-message="$commit"\n',
      '            git commit --quiet --reuse-message="$commit"\n            check_register_paths --cached\n'), /every commit must be preceded by check_register_paths --cached/],
    ['a second commit without the staged-path check', edit('          done\n          check_register_paths origin/release/latest HEAD\n',
      '            git commit --quiet --allow-empty -m extra\n          done\n          check_register_paths origin/release/latest HEAD\n'), /every commit must be preceded by check_register_paths --cached/],
    ['no commit at all', edit('            check_register_paths --cached\n            git commit --quiet --reuse-message="$commit"\n', ''), /every commit must be preceded by check_register_paths --cached/],
    ['mapfile in the push job', edit('            expected=()\n', '            mapfile -t expected < <(git rev-list origin/release/latest..HEAD)\n'), /no mapfile or readarray/],
    ['no limit on the changed-files list', edit('-lt 3000 ]]', '-lt 3000000 ]]'), /register-files: the script must contain the line \[\[ "\$\(jq -n/],
    ['no check of the whole result', edit('          check_register_paths origin/release/latest HEAD\n', ''), /the script must contain the line check_register_paths origin\/release\/latest HEAD/],
    ['a force push over an existing branch', edit('git fetch --quiet origin "refs/heads/$branch"', 'git push --force --quiet origin "HEAD:refs/heads/$branch"'),
      /the one push must be|the script must contain the line git fetch/],
    ['no reuse check of an existing branch', edit('if [[ -z "$(git ls-remote origin "refs/heads/$branch" | cut -f1)" ]]; then', 'if true; then'),
      /the script must contain the line if \[\[ -z "\$\(git ls-remote/],
    ['an existing branch accepted whatever it holds', edit('echo "::error::the branch $branch exists and is not this replay; it is left as it is, a maintainer decides"', 'echo "::warning::reusing it"'),
      /the script must contain the line echo "::error::the branch/],
    ['an existing branch compared without the trees of its commits', edit("--format='%T%n%an <%ae> %at%n%B' \"${existing[$index]}\")\" ]] || same=false", "--format='%an <%ae> %at%n%B' \"${existing[$index]}\")\" ]] || same=false"),
      /the script must contain the line \[\[ "\$\(git rev-list --no-walk/],
    ['an existing branch with another number of commits accepted', edit('[[ "${#existing[@]}" -eq "${#expected[@]}" ]] || same=false', 'true'), /the script must contain the line \[\[ "\$\{#existing/],
    ['an existing branch with merge commits accepted', edit('[[ -z "$(git rev-list --min-parents=2 origin/release/latest..FETCH_HEAD)" ]] || same=false', 'true'), /the script must contain the line \[\[ -z "\$\(git rev-list --min-parents=2/],
    ['an unguarded app token step', edit("        if: env.HAS_APP_TOKEN == 'true'\n", ''), /guarded by if: env\.HAS_APP_TOKEN/],
    ['the backport action instead of the script', edit('      - name: Open the pull request of the register changes\n',
      '      - uses: korthout/backport-action@ad272ff24e4a8593bf18a951a154ae6af93b26b8 # v5.0.0\n      - name: Open the pull request of the register changes\n'), /steps must be/],
    ['an action by tag', edit('actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510', 'actions/create-github-app-token@v3'), /not pinned by full commit SHA/],
    ['an ignored failure', edit('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    continue-on-error: true\n'), /continue-on-error/],
  ];
  for (const [label, workflow, pattern] of faults) {
    test(`rejects ${label}`, () => {
      const found = problems(workflow);
      assert.ok(pattern.test(found), `not reported (${pattern}):\n${found || '(no problem)'}`);
    });
  }
});
