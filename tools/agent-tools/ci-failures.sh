#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# ci-failures.sh <pr> — the failing jobs of the latest public-ci run of the PR head:
# if the run is in progress, the state of each job; otherwise, per failing job, at most
# 20 log lines matching this FIXED list (ANSI sequences, the BOM and the leading
# timestamp are stripped before matching):
#   - a line containing: ✖ , " FAILED " (space-delimited), AssertionError, TypeError, ##[error]
#   - a line starting with: not ok
# The run must belong to the PR head sha; runs of other heads are ignored.
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

read -r branch head < <(
    gh pr view "$pr" -R "$REPO" --json headRefName,headRefOid \
        --jq '"\(.headRefName) \(.headRefOid)"'
) || {
    echo "error: could not read PR #$pr (gh exited with $?)." >&2
    exit 2
}

runs=$(gh run list -R "$REPO" --branch "$branch" --workflow "$WORKFLOW" --limit 20 \
        --json databaseId,status,conclusion,headSha) || {
    echo "error: could not read the $WORKFLOW runs of branch '$branch' (gh exited with $?)." >&2
    exit 2
}
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

if [ "$status" != "completed" ]; then
    gh run view "$run_id" -R "$REPO" --json jobs \
        --jq '.jobs[] | "\(.name): \(.status)\(if .conclusion then " (\(.conclusion))" else "" end)"'
    exit 0
fi

failed_jobs=$(gh run view "$run_id" -R "$REPO" --json jobs \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled") | .name')

# The first line of a --log-failed dump starts with a BOM; strip it, the ANSI sequences,
# the leading tab fields and the leading timestamp before matching.
log=$(gh run view "$run_id" -R "$REPO" --log-failed 2>/dev/null | sed 's/^\xef\xbb\xbf//' | strip_ansi || true)

while IFS= read -r job; do
    [ -n "$job" ] || continue
    printf '=== %s ===\n' "$job"
    matched=$(printf '%s\n' "$log" \
        | awk -F'\t' -v job="$job" '$1 == job { sub(/^[^\t]*\t[^\t]*\t/, ""); sub(/^[^ ]+ /, ""); print }' \
        | grep -E '✖| FAILED |AssertionError|TypeError|##\[error\]|^not ok' || true)
    if [ -z "$matched" ]; then
        echo '(no log line matches the fixed patterns)'
    else
        printf '%s\n' "$matched" | head -n "$MAX_LINES"
    fi
done <<< "$failed_jobs"
