#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# pr-status.sh — one line per open PR: number | title (40 bytes max) | author | draft |
# head sha (8) | mergeStateStatus | checks that are not "pass" (draft PRs: "-"; a PR
# without any check: "(no checks yet)"; lines whose name contains "matrix.shard" are
# ignored). Last line: the time of the reading.
# Env: REPO (default Session-Mesh/session-mesh). Exit codes: 0 = OK, 2 = environment or
# usage error (this tool never exits 1: it lists, it does not judge); gh pr list is given
# --limit 200 so the count is not silently capped at 30.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "error: required tool '$1' is missing." >&2
        exit 2
    fi
}
need gh
need jq

# One line per open PR, sorted by descending number, as TSV:
# number<TAB>title<TAB>draft<TAB>sha<TAB>mergeState<TAB>author
errtmp=$(mktemp)
trap 'rm -f "$errtmp"' EXIT

pr_rows() {
    gh pr list -R "$REPO" --state open --limit 200 \
        --json number,title,isDraft,headRefOid,mergeStateStatus,author \
        --jq 'sort_by(-.number)[] | [.number, .title, .isDraft, .headRefOid, .mergeStateStatus, .author.login] | @tsv'
}

rows_rc=0
rows=$(pr_rows) && rows_rc=0 || rows_rc=$?
if [ "$rows_rc" -ne 0 ]; then
    echo "error: could not list the pull requests (gh exited with $rows_rc)." >&2
    exit 2
fi

# Checks of one PR that are not "pass" (gh pr checks exits 0 with failures, 8 with
# pending checks and 1 both for a PR without any check (output empty) and for other
# failures; a PR without checks just gets a column.
non_pass_checks() {
    local pr=$1 line name state rc=0 out
    out=$(gh pr checks "$pr" -R "$REPO" 2> "$errtmp") && rc=0 || rc=$?
    if [ -z "$out" ]; then
        if [ "$rc" -eq 1 ] && grep -aq 'no checks reported' "$errtmp"; then
            printf '%s\n' '(no checks yet)'
            return 0
        fi
        echo "error: could not read the CI checks of PR #$pr (gh exited with $rc)." >&2
        exit 2
    fi
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        name=${line%%$'\t'*}
        state=$(printf '%s\n' "$line" | awk -F'\t' '{print $2}')
        case $name in *matrix.shard*) continue ;; esac
        if [ "$state" != "pass" ]; then
            printf '%s=%s\n' "$name" "$state"
        fi
    done <<< "$out"
}
while IFS=$'\t' read -r num title draft sha merge_state author; do
    [ -n "${num:-}" ] || continue
    if [ "$draft" = "true" ]; then
        draft_col=yes
        checks_col='-'
    else
        draft_col=no
        checks_rc=0
        checks_col=$(non_pass_checks "$num") && checks_rc=0 || checks_rc=$?
        if [ "$checks_rc" -ne 0 ]; then
            # non_pass_checks already printed the exact error on stderr.
            exit 2
        fi
        checks_col=$(printf '%s\n' "$checks_col" | paste -sd ';' - | sed 's/;/; /g')
        [ -n "$checks_col" ] || checks_col='(none)'
    fi
    printf '%s | %.40s | %s | %s | %.8s | %s | %s\n' \
        "$num" "$title" "$author" "$draft_col" "$sha" "$merge_state" "$checks_col"
done <<< "$rows"

printf 'time of the reading: %s\n' "$(date)"
