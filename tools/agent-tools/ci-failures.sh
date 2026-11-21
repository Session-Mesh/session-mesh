#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# ci-failures.sh <pr> — the failing jobs of the latest public-ci run of the PR head:
# - run in progress: the state of each job (a bare "in_progress", never "in_progress ()");
# - completed run: per failing job, at most 20 log lines matching this FIXED list
#   (documented here and in the README), applied after stripping the BOM, the ANSI
#   sequences and the leading timestamp, and after dropping the passing-test lines that
#   start with ✔:
#     lines starting with: FAILED , ERROR , not ok
#     a line containing:   " FAILED " (space-delimited), ✖ , AssertionError, TypeError, ##[error]
#   The leak tools (merge-gate.sh, comment-do.sh) treat these as token types:
#     ghp_ , gho_/ghu_/ghs_/ghr_ , github_pat_ , sk- (preceded by a non-alphanumeric
#     character), xoxb-/xoxp- , AKIA + 16 uppercase alphanumerics, and
#     "-----BEGIN ... PRIVATE KEY-----" blocks — never printed, type + line only.
# - a completed run with no failed job prints: no failed job in run <id>.
# The run must belong to the PR head sha; runs of other heads or other workflows are ignored.
# Env: REPO (default Session-Mesh/session-mesh).
# Exit codes: 0 = OK, 1 = not found (PR, run, head), 2 = usage or environment error.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}
WORKFLOW=public-ci
MAX_LINES=20

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required tool '$1' is missing." >&2
        exit 2
    fi
}
need gh
need jq

if [ $# -ne 1 ] || [[ ! $1 =~ ^[0-9]+$ ]]; then
    echo "usage: $0 <pr number>" >&2
    exit 2
fi
pr=$1

view_rc=0
view_out=$(gh pr view "$pr" -R "$REPO" --json headRefName,headRefOid \
    --jq '"\(.headRefName) \(.headRefOid)"') && view_rc=0 || view_rc=$?
if [ "$view_rc" -ne 0 ]; then
    echo "error: could not read PR #$pr (gh exited with $view_rc)." >&2
    exit 2
fi
read -r branch head <<< "$view_out"

runs_rc=0
runs=$(gh run list -R "$REPO" --branch "$branch" --workflow "$WORKFLOW" --limit 20 \
        --json databaseId,status,conclusion,headSha) && runs_rc=0 || runs_rc=$?
if [ "$runs_rc" -ne 0 ]; then
    echo "error: could not read the $WORKFLOW runs of branch '$branch' (gh exited with $runs_rc)." >&2
    exit 2
fi
read -r run_id status < <(
    jq -r --arg sha "$head" \
        '([.[] | select(.headSha == $sha)][0] // null |
          "\(.databaseId // "") \(.status // "")")' <<< "$runs"
) || run_id=''
latest_sha=$(jq -r '.[0].headSha // ""' <<< "$runs")

if [ -z "$run_id" ]; then
    echo "error: no $WORKFLOW run for head ${head:0:8}; latest known run is for ${latest_sha:0:8}." >&2
    exit 1
fi

strip_ansi() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }
strip_bom() { sed 's/^\xef\xbb\xbf//'; }

if [ "$status" != "completed" ]; then
    gh run view "$run_id" -R "$REPO" --json jobs \
        --jq '.jobs[] | "\(.name): \(.status)\(if (.conclusion // "") == "" then "" else " (\(.conclusion))" end)"'
    exit 0
fi

jobs_rc=0
failed_jobs=$(gh run view "$run_id" -R "$REPO" --json jobs \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled") | .name') \
    && jobs_rc=0 || jobs_rc=$?
if [ "$jobs_rc" -ne 0 ]; then
    echo "error: could not read the jobs of run $run_id (gh exited with $jobs_rc)." >&2
    exit 2
fi
if [ -z "$failed_jobs" ]; then
    printf 'no failed job in run %s\n' "$run_id"
    exit 0
fi

log_rc=0
log=$(gh run view "$run_id" -R "$REPO" --log-failed 2>/dev/null | strip_bom | strip_ansi) \
    && log_rc=0 || log_rc=$?
if [ "$log_rc" -ne 0 ]; then
    echo "error: could not read the failed log of run $run_id (gh exited with $log_rc)." >&2
    exit 2
fi

while IFS= read -r job; do
    [ -n "$job" ] || continue
    printf '=== %s ===\n' "$job"
    # head -n cuts here AFTER the capture: grep would only SIGPIPE (141) mid-pipeline and,
    # under pipefail, kill the loop and lose the following jobs. The || true keeps them.
    matched=$(printf '%s\n' "$log" \
        | awk -F'\t' -v job="$job" '$1 == job { sub(/^[^\t]*\t[^\t]*\t/, ""); sub(/^[^ ]+ /, ""); print }' \
        | grep -avE '^ *✔' \
        | grep -aE '✖| FAILED |AssertionError|TypeError|##\[error\]|^FAILED |^ERROR |^not ok' \
        | head -n "$MAX_LINES" || true)
    if [ -z "$matched" ]; then
        echo '(no log line matches the fixed patterns)'
    else
        printf '%s\n' "$matched"
    fi
done <<< "$failed_jobs"
