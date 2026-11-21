#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# ci-failures.sh <pr> — the failing jobs of the latest public-ci run of the PR branch:
# if the run is in progress, the state of each job; otherwise, per failing job, at most
# 20 log lines matching the fixed list below (ANSI sequences stripped).
# Env: REPO (default Session-Mesh/session-mesh).
# Exit codes: 0 = OK, 1 = not found (PR, run), 2 = usage or environment error.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}
WORKFLOW=public-ci
# Fixed pattern list: the tool only looks for these, and never prints anything else.
PATTERN='✖|FAILED|AssertionError|TypeError|##\[error\]|not ok|fail'
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

branch=$(gh pr view "$pr" -R "$REPO" --json headRefName --jq .headRefName 2>/dev/null) || {
    echo "error: PR #$pr not found on $REPO." >&2
    exit 1
}

read -r run_status run_id < <(
    gh run list -R "$REPO" --branch "$branch" --workflow "$WORKFLOW" --limit 1 \
        --json databaseId,status --jq '.[0] // empty | "\(.status) \(.databaseId)"'
) || true

if [ -z "${run_id:-}" ]; then
    echo "error: no $WORKFLOW run found for branch '$branch'." >&2
    exit 1
fi

strip_ansi() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

if [ "$run_status" != "completed" ]; then
    gh run view "$run_id" -R "$REPO" --json jobs \
        --jq '.jobs[] | "\(.name): \(.status)\(if .conclusion then " (\(.conclusion))" else "" end)"'
    exit 0
fi

failed_jobs=$(gh run view "$run_id" -R "$REPO" --json jobs \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled") | .name')

log=$(gh run view "$run_id" -R "$REPO" --log-failed 2>/dev/null | strip_ansi || true)

while IFS= read -r job; do
    [ -n "$job" ] || continue
    printf '=== %s ===\n' "$job"
    matched=$(printf '%s\n' "$log" | awk -F'\t' -v job="$job" '$1 == job { sub(/^[^\t]*\t[^\t]*\t/, ""); print }' \
        | grep -E "$PATTERN" || true)
    if [ -z "$matched" ]; then
        echo '(no log line matches the fixed patterns)'
    else
        printf '%s\n' "$matched" | head -n "$MAX_LINES"
    fi
done <<< "$failed_jobs"
