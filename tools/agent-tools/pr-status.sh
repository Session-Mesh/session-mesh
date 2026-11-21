#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# pr-status.sh — one line per open PR: number | title (40 bytes max) | author | draft |
# head sha (8) | mergeStateStatus | checks that are not "pass" (draft PRs: "-"; lines whose
# name contains "matrix.shard" are ignored). Last line: the time of the reading.
# Env: REPO (default Session-Mesh/session-mesh). Exit codes: 0 = OK, 1 = finding,
# 2 = usage or environment error (missing tool, gh error while reading the checks).

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
pr_rows() {
    gh pr list -R "$REPO" --state open \
        --json number,title,isDraft,headRefOid,mergeStateStatus,author \
        --jq 'sort_by(-.number)[] | [.number, .title, .isDraft, .headRefOid, .mergeStateStatus, .author.login] | @tsv'
}

# Checks of one PR that are not "pass" (gh pr checks exits non-zero when there are
# failures or pending checks: accepted).
non_pass_checks() {
    local pr=$1 line name state rc=0 out
    # gh pr checks exits 0 when everything passes and 8 when some checks are pending;
    # any other code with empty output means the check data could not be read at all
    # (network, authentication): report it instead of printing an empty column.
    out=$(gh pr checks "$pr" -R "$REPO" 2>/dev/null) && rc=0 || rc=$?
    if [ -z "$out" ] && [ "$rc" -ne 0 ] && [ "$rc" -ne 8 ]; then
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
        checks_col=$(non_pass_checks "$num" | paste -sd ';' - | sed 's/;/; /g')
        [ -n "$checks_col" ] || checks_col='(none)'
    fi
    printf '%s | %.40s | %s | %s | %.8s | %s | %s\n' \
        "$num" "$title" "$author" "$draft_col" "$sha" "$merge_state" "$checks_col"
done < <(pr_rows)

printf 'time of the reading: %s\n' "$(date)"
