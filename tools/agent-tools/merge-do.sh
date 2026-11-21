#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# merge-do.sh <pr> <head8> --yes [--allow-new-python] — rebase-merge a PR after a GO.
# Without --yes: prints what it would do and merges nothing. With --yes: reads the full
# head FIRST, refuses when it does not start with <head8>, runs merge-gate.sh, refuses on
# anything but GO, then gh pr merge <pr> --rebase --match-head-commit <the head read before
# the gate> and prints the merge sha. If the head moved between the gate and the merge,
# gh refuses and the tool reports it. Exit codes: 0 = merged (or dry run), 1 = refused,
# 2 = usage or environment error.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "error: gh and jq are required." >&2
    exit 2
fi

yes_flag=no
gate_args=()
for arg in "$@"; do
    case $arg in
        --yes) yes_flag=yes ;;
        *) gate_args+=("$arg") ;;
    esac
done
if [ "${#gate_args[@]}" -lt 2 ]; then
    echo "usage: $0 <pr number> <head8> --yes [--allow-new-python]" >&2
    exit 2
fi
pr=${gate_args[0]}
head8=${gate_args[1]}

if [ "$yes_flag" != "yes" ]; then
    echo "merge-do.sh (dry run, without --yes): I would run:"
    echo "  gh pr merge $pr --rebase --match-head-commit <$head8...>"
    echo "after a GO from merge-gate.sh $pr $head8. Nothing was done."
    exit 0
fi

# Read the full head BEFORE the gate and pin the merge to exactly this commit, so a push
# during the gate cannot make us merge something else than what was reviewed.
full_head=$(gh pr view "$pr" -R "$REPO" --json headRefOid --jq .headRefOid) || {
    echo "error: could not read the head of PR #$pr on $REPO." >&2
    exit 2
}
case $full_head in
    "$head8"*) ;;
    *)
        echo "merge-do.sh refuses: the full head $full_head does not start with $head8; nothing was merged." >&2
        exit 1
        ;;
esac

if ! bash "$here/merge-gate.sh" "${gate_args[@]}"; then
    echo "NO-GO: merge-do.sh refuses to merge (see the KO above)." >&2
    exit 1
fi

if ! gh pr merge "$pr" -R "$REPO" --rebase --match-head-commit "$full_head" >/dev/null; then
    echo "merge-do.sh: gh pr merge failed (the branch head may have moved); nothing was merged." >&2
    exit 1
fi

merge_sha=$(gh pr view "$pr" -R "$REPO" --json mergeCommit --jq .mergeCommit.oid)
printf 'OK merge: %s\n' "$merge_sha"
