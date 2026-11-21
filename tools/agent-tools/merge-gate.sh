#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# merge-gate.sh <pr> <head8> [--allow-new-python] — GO / NO-GO checklist before a merge.
# One "OK <control>: <detail>" / "KO <control>: <detail>" line per control ("WARN" where
# applicable), then "GO" or "NO-GO". Exit codes: 0 = GO, 1 = NO-GO, 2 = usage/environment.
# Env: REPO, AGENT_TOOLS_DENY_FILE (private deny list, one word per line, not in this repo;
# comments # and blank lines are ignored; a missing or empty list is a WARN).
# Leak rules: forbidden words and token-like strings (ghp_, github_pat_, sk-) fail the gate;
# home paths except /home/USER and /home/user, and long hexadecimal runs, are WARN only;
# in the diff only added lines are scanned.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}
DENY_FILE=${AGENT_TOOLS_DENY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/deny-words.txt}

if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "error: gh and jq are required." >&2
    exit 2
fi

allow_new_python=no
positional=()
for arg in "$@"; do
    case $arg in
        --allow-new-python) allow_new_python=yes ;;
        *) positional+=("$arg") ;;
    esac
done
if [ "${#positional[@]}" -ne 2 ] || [[ ! ${positional[1]} =~ ^[0-9a-f]{8}$ ]]; then
    echo "usage: $0 <pr number> <head8> [--allow-new-python]" >&2
    exit 2
fi
pr=${positional[0]}
head8=${positional[1]}

patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
if [ -f "$DENY_FILE" ]; then
    grep -v -e '^#' -e '^[[:space:]]*$' "$DENY_FILE" 2>/dev/null | tr -d '\r' > "$patterns" || true
fi

# Join lines into one detail line, "a; b".
join2() {
    awk '{ if (NR > 1) printf "; "; printf "%s", $0 } END { printf "\n" }'
}

verdict=GO
ok() { printf 'OK %s: %s\n' "$1" "$2"; }
ko() { printf 'KO %s: %s\n' "$1" "$2"; verdict=NO-GO; }
warn() { printf 'WARN %s: %s\n' "$1" "$2"; }

view=$(gh pr view "$pr" -R "$REPO" --json state,isDraft,headRefOid,baseRefName,mergeStateStatus,title,body,labels,commits)

state=$(jq -r .state <<< "$view")
is_draft=$(jq -r .isDraft <<< "$view")
head=$(jq -r .headRefOid <<< "$view")
base=$(jq -r .baseRefName <<< "$view")
merge_state=$(jq -r .mergeStateStatus <<< "$view")
title=$(jq -r .title <<< "$view")
body=$(jq -r .body <<< "$view")
commit_msgs=$(jq -r '.commits[] | .messageHeadline + "\n" + (.messageBody // "")' <<< "$view")

if [ "$state" = "OPEN" ] && [ "$is_draft" = "false" ]; then
    ok 'PR open' 'open, not a draft'
else
    ko 'PR open' "state $state, draft $is_draft"
fi

case $head in
    "$head8"*) ok 'head' "head $head matches $head8" ;;
    *) ko 'head' "head $head does not match $head8" ;;
esac

if [ "$merge_state" = "CLEAN" ]; then
    ok 'merge state' 'CLEAN'
else
    ko 'merge state' "$merge_state"
fi

# gh pr checks exits 0 when everything passes and 8 when some checks are pending;
# any other code with empty output means the check data could not be read at all.
checks_out=''
checks_rc=0
checks_out=$(gh pr checks "$pr" -R "$REPO" 2>/dev/null) && checks_rc=0 || checks_rc=$?
if [ -z "$checks_out" ] && [ "$checks_rc" -ne 0 ] && [ "$checks_rc" -ne 8 ]; then
    echo "error: could not read the CI checks of PR #$pr (gh exited with $checks_rc)." >&2
    exit 2
fi

# States that are fine: pass, and skipping (a job deliberately did not run).
# Anything else (fail, pending, cancel, unknown) fails, except the informational
# macos job and the ghost lines containing "matrix.shard".
bad_checks=''
tolerated=''
while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%%$'\t'*}
    state2=$(printf '%s\n' "$line" | awk -F'\t' '{print $2}')
    case $name in *matrix.shard*) continue ;; esac
    case $state2 in
        pass | skipping) continue ;;
    esac
    case $name in
        'macos (arm64, informational)') tolerated="$tolerated$name=$state2, " ;;
        *) bad_checks="$bad_checks$name=$state2, " ;;
    esac
done <<< "$checks_out"
bad_checks=${bad_checks%, }
tolerated=${tolerated%, }
if [ -n "$bad_checks" ]; then
    ko 'CI checks' "not green: $bad_checks"
elif [ -n "$tolerated" ]; then
    warn 'CI checks' "all green or skipped except the informational job: $tolerated"
else
    ok 'CI checks' 'all green'
fi

run=$(gh run list -R "$REPO" --branch "$base" --workflow public-ci --limit 1 --json status,conclusion)
run_status=$(jq -r '.[0].status // ""' <<< "$run")
run_concl=$(jq -r '.[0].conclusion // ""' <<< "$run")
if [ "$run_status" = "completed" ] && [ "$run_concl" = "success" ]; then
    ok 'base CI run' "completed/success on $base"
else
    ko 'base CI run' "$run_status/$run_concl on $base"
fi

# A diff gh refuses to render must be a KO, never a silent pass of the leak scan.
diff=''
if ! diff=$(gh pr diff "$pr" -R "$REPO" 2>/dev/null); then
    ko 'readable diff' 'diff unreadable; leak scan impossible'
    diff=''
else
    ok 'readable diff' 'readable'
fi

full_text=$(printf '%s\n%s\n%s\n%s\n' "$title" "$body" "$commit_msgs" "$diff")
# Only added lines of the diff (out of the +++ header) for the home-path and hex scan.
added_lines=$(printf '%s\n' "$diff" | awk '/^\+\+\+/ {next} /^\+/ {print substr($0, 2)}')

forbidden=$(printf '%s\n' "$full_text" \
    | grep -iE 'ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9][A-Za-z0-9_-]{20,}' \
    || true)
if [ -s "$patterns" ]; then
    forbidden=$forbidden$(grep -iF -f "$patterns" <<< "$full_text" || true)
fi
if [ -n "$forbidden" ]; then
    ko 'forbidden words and leaks' "$(printf '%s\n' "$forbidden" | head -n 3 | join2)"
fi

soft_scan=$(printf '%s\n%s\n%s\n%s\n' "$title" "$body" "$commit_msgs" "$added_lines")
soft_hits=$(printf '%s\n' "$soft_scan" \
    | grep -iE '[/]home[/]' | grep -ivE '[/]home[/]user' || true)
soft_hex=$(printf '%s\n' "$added_lines" | grep -iE '[a-f0-9]{40,}' || true)
if [ -n "$soft_hex" ]; then
    soft_hits="$soft_hits${soft_hits:+$'\n'}$soft_hex"
fi
if [ -z "$forbidden" ]; then
    if [ -n "$soft_hits" ]; then
        warn 'forbidden words and leaks' "non-blocking leaks (home paths, long hex): $(printf '%s\n' "$soft_hits" | head -n 2 | join2)"
    elif [ ! -s "$patterns" ]; then
        warn 'forbidden words and leaks' 'private deny list missing or empty; generic leaks: none'
    else
        ok 'forbidden words and leaks' 'none detected'
    fi
fi

attr=$(printf '%s\n' "$commit_msgs" | grep -i 'co-authored-by\|generated with' || true)
if [ -n "$attr" ]; then
    ko 'attribution footers' "$(printf '%s\n' "$attr" | head -n 3 | join2)"
else
    ok 'attribution footers' 'none'
fi

files=$(gh api --paginate "repos/$REPO/pulls/$pr/files?per_page=100" | jq -s 'add')

py_added=$(jq -r '.[] | select(.status == "added" and (.filename | endswith(".py"))) | .filename' <<< "$files")
if [ "${py_added:-}" ]; then
    if [ "$allow_new_python" = "yes" ]; then
        ok 'added Python files' "allowed by --allow-new-python: $py_added"
    else
        ko 'added Python files' "$py_added"
    fi
else
    ok 'added Python files' 'none'
fi

github_changed=$(jq -r '.[] | select(.filename | startswith(".github/")) | .filename' <<< "$files")
if [ "${github_changed:-}" ]; then
    warn '.github files' "$github_changed"
else
    ok '.github files' 'unchanged'
fi

label=$(jq -r '.labels[].name' <<< "$view" | grep -E '^(semver: (patch|minor))$' || true)
if [ -n "$label" ]; then
    ok 'semver label' "$label"
else
    ko 'semver label' 'neither semver: patch nor semver: minor'
fi

changelog_file=$(jq -r '.[] | select(.status == "added" and (.filename | startswith("changelog.d/"))) | .filename' <<< "$files")
if [ "${changelog_file:-}" ]; then
    ok 'changelog' "$changelog_file added"
elif printf '%s' "$body" | grep -q 'Changelog: none'; then
    ok 'changelog' 'the body contains Changelog: none'
else
    ko 'changelog' 'neither a changelog.d/ file added nor Changelog: none'
fi

printf '%s\n' "$verdict"
[ "$verdict" = "GO" ]
