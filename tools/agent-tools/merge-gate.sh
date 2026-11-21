#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# merge-gate.sh <pr> <head8> [--allow-new-python] [--allow-workflow-change] —
# GO / NO-GO checklist before a merge. One "OK <control>: <detail>" / "KO <control>: <detail>"
# line per control ("WARN" where applicable), then "GO" or "NO-GO".
# Exit codes: 0 = GO, 1 = NO-GO, 2 = usage or environment error (gh could not answer).
# Env: REPO, REQUIRED_CHECKS (one check name per line; the default below is used when
# unset), AGENT_TOOLS_DENY_FILE (private deny list, one word per line, not in this repo;
# comments and blank lines are ignored; a missing or empty list is a WARN).
# Leak rules: forbidden words and token-like strings (ghp_, github_pat_, sk- preceded by a
# non-alphanumeric character) fail the gate, and a token is NEVER printed, only its type
# and the line; home paths (only /home/user and /home/USER are excused) and long runs of
# hexadecimal characters are WARN only; in the diff the token scan only looks at added
# lines.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}
DENY_FILE=${AGENT_TOOLS_DENY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/deny-words.txt}

if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "error: gh and jq are required." >&2
    exit 2
fi

allow_new_python=no
allow_workflow=no
positional=()
for arg in "$@"; do
    case $arg in
        --allow-new-python) allow_new_python=yes ;;
        --allow-workflow-change) allow_workflow=yes ;;
        *) positional+=("$arg") ;;
    esac
done
if [ "${#positional[@]}" -ne 2 ] || [[ ! ${positional[0]} =~ ^[0-9]+$ ]] \
    || [[ ! ${positional[1]} =~ ^[0-9a-f]{8}$ ]]; then
    echo "usage: $0 <pr number> <head8> [--allow-new-python] [--allow-workflow-change]" >&2
    exit 2
fi
pr=${positional[0]}
head8=${positional[1]}

patterns=$(mktemp)
patterns2=$(mktemp)
trap 'rm -f "$patterns" "$patterns2"' EXIT
if [ -f "$DENY_FILE" ]; then
    grep -v -e '^#' -e '^[[:space:]]*$' "$DENY_FILE" 2>/dev/null | tr -d '\r' > "$patterns" || true
fi

# Join lines into one detail line, "a; b".
join2() {
    awk '{ if (NR > 1) printf "; "; printf "%s", $0 } END { printf "\n" }'
}

view_rc=0
view=$(gh pr view "$pr" -R "$REPO" \
    --json state,isDraft,headRefOid,baseRefName,mergeStateStatus,title,body,labels,commits) \
    && view_rc=0 || view_rc=$?
if [ "$view_rc" -ne 0 ]; then
    echo "error: could not read PR #$pr (gh exited with $view_rc)." >&2
    exit 2
fi

state=$(jq -r .state <<< "$view")
is_draft=$(jq -r .isDraft <<< "$view")
head=$(jq -r .headRefOid <<< "$view")
base=$(jq -r .baseRefName <<< "$view")
merge_state=$(jq -r .mergeStateStatus <<< "$view")
title=$(jq -r .title <<< "$view")
body=$(jq -r .body <<< "$view")
commit_msgs=$(jq -r '.commits[] | .messageHeadline + "\n" + (.messageBody // "")' <<< "$view")

verdict=GO
ok() { printf 'OK %s: %s\n' "$1" "$2"; }
ko() { printf 'KO %s: %s\n' "$1" "$2"; verdict=NO-GO; }
warn() { printf 'WARN %s: %s\n' "$1" "$2"; }

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

if [ "$base" = "main" ] || [[ $base == release/* ]]; then
    ok 'base branch' "$base"
else
    ko 'base branch' "not main or release/*: $base"
fi

# gh pr checks exits 0 when everything passes, 8 with pending checks, and 1 both for
# failing checks and for a PR without any check (output empty). Any other code means the
# check data could not be read at all (network, authentication).
checks_out=''
checks_rc=0
checks_out=$(gh pr checks "$pr" -R "$REPO" 2>/dev/null) && checks_rc=0 || checks_rc=$?
if [ "$checks_rc" -ne 0 ] && [ "$checks_rc" -ne 1 ] && [ "$checks_rc" -ne 8 ]; then
    echo "error: could not read the CI checks of PR #$pr (gh exited with $checks_rc)." >&2
    exit 2
fi

# States that are fine: pass, and skipping (a job deliberately did not run).
# Anything else (fail, pending, cancel, unknown) fails, except the informational
# macos job; the only ignored name is one containing literally "${{ matrix.shard }}".
bad_checks=''
tolerated=''
ghost="\${{ matrix.shard }}"
while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%%$'\t'*}
    state2=$(printf '%s\n' "$line" | awk -F'\t' '{print $2}')
    case $name in *"$ghost"*) continue ;; esac
    case $state2 in
        pass | skipping) continue ;;
    esac
    case $name in
        'macos (arm64, informational)') tolerated="$tolerated$name=$state2"$'\n' ;;
        *) bad_checks="$bad_checks$name=$state2"$'\n' ;;
    esac
done <<< "$checks_out" || true
if [ -n "$bad_checks" ]; then bad_checks=$(printf '%s' "$bad_checks" | join2); fi
if [ -n "$tolerated" ]; then tolerated=$(printf '%s' "$tolerated" | join2); fi
if [ -n "$bad_checks" ]; then
    bad_checks=$(printf '%s' "$bad_checks" | join2)
    ko 'CI checks' "not green: $bad_checks"
elif [ -n "$tolerated" ]; then
    tolerated=$(printf '%s' "$tolerated" | join2)
    warn 'CI checks' "all green or skipped except the informational job: $tolerated"
else
    ok 'CI checks' 'all green'
fi

# The public-ci run must belong to the current head of the base branch.
base_sha=$(gh api "repos/$REPO/branches/$base" --jq .commit.sha) || {
    echo "error: could not read branch $base (gh exited with $?)." >&2
    exit 2
}
runs=$(gh run list -R "$REPO" --branch "$base" --workflow public-ci --limit 20 \
        --json databaseId,status,conclusion,headSha) || {
    echo "error: could not read the public-ci runs of $base (gh exited with $?)." >&2
    exit 2
}
read -r run_status run_concl < <(
    jq -r --arg sha "$base_sha" \
        '([.[] | select(.headSha == $sha)][0] // null |
          "\(.status // "") \(.conclusion // "")")' <<< "$runs"
) || run_status=''
if [ -z "$run_status" ]; then
    ko 'base CI run' "no public-ci run for head ${base_sha:0:8} on $base"
elif [ "$run_status" = "completed" ] && [ "$run_concl" = "success" ]; then
    ok 'base CI run' "completed/success on $base"
else
    ko 'base CI run' "$run_status/$run_concl on $base"
fi

# The checks that must exist for this tool's verdict to mean anything.
if [ -n "${REQUIRED_CHECKS:-}" ]; then
    required=$REQUIRED_CHECKS
else
    required=$(cat <<'EOF'
cla
ruff and pytest (without browser)
frontend and Node tests
OCaml build, tests and native ptyhost gate
native PTY host (linux-x86_64)
leak check (public rules)
CodeRabbit
EOF
)
fi
missing=''
if [ -n "$checks_out" ]; then
    printf '%s\n' "$checks_out" | cut -f1 > "$patterns2"
else
    : > "$patterns2"
fi
while IFS= read -r req; do
    [ -n "$req" ] || continue
    if ! grep -Fxq -- "$req" "$patterns2"; then
        missing="$missing$req"$'\n'
    fi
done <<< "$required" || true
if [ -n "$missing" ]; then
    ko 'required checks' "missing: $(printf '%s' "$missing" | join2)"
else
    ok 'required checks' 'all present'
fi

# A diff gh refuses to render cannot be scanned: a transport error is fatal (exit 2).
diff_rc=0
diff=$(gh pr diff "$pr" -R "$REPO" 2>/dev/null) && diff_rc=0 || diff_rc=$?
if [ "$diff_rc" -ne 0 ]; then
    echo "error: could not read the diff of PR #$pr (gh exited with $diff_rc)." >&2
    exit 2
fi

# Only added lines of the diff (out of the +++ header) enter the leak scans.
added_lines=$(printf '%s\n' "$diff" | awk '/^\+\+\+/ {next} /^\+/ {print substr($0, 2)}')

full_text=$(printf '%s\n%s\n%s\n%s\n' "$title" "$body" "$commit_msgs" "$diff")
token_scan=$(printf '%s\n%s\n%s\n%s\n' "$title" "$body" "$commit_msgs" "$added_lines")

# Tokens are reported by TYPE and line, never by value.
token_re='(^|[^A-Za-z0-9])(ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9][A-Za-z0-9_-]{19,})'
token_hits=$(printf '%s\n' "$token_scan" \
    | awk -v re="$token_re" \
        '$0 ~ re {
            if ($0 ~ /ghp_[A-Za-z0-9]{16,}/) t = "ghp_"
            else if ($0 ~ /github_pat_[A-Za-z0-9_]{20,}/) t = "github_pat_"
            else t = "sk-"
            print "token-like string (" t ") on line " NR
        }' || true)
forbidden=''
if [ -s "$patterns" ]; then
    forbidden=$(grep -iF -f "$patterns" <<< "$full_text" || true)
    if [ -n "$forbidden" ]; then
        forbidden=$(printf '%s\n' "$forbidden" | head -n 3)
    fi
fi
report=$(printf '%s\n%s\n' "$token_hits" "$forbidden" | awk 'length($0) > 0 {print}' || true)
if [ -n "$report" ]; then
    ko 'forbidden words and leaks' "$(printf '%s\n' "$report" | head -n 3 | join2)"
else
    home_paths=$(printf '%s\n' "$full_text" \
        | grep -oE '[/]home[/][^[:space:]/"]*' || true)
    home_paths=$(printf '%s\n' "$home_paths" | grep -vE '^[/]home[/](user|USER)$' || true)
    hex_hits=$(printf '%s\n' "$added_lines" | grep -ioE '[a-f0-9]{40,}' || true)
    soft_lines=$(printf '%s\n%s\n' "$home_paths" "$hex_hits" | awk 'length($0) > 0 {print}' || true)
    if [ -n "$soft_lines" ]; then
        warn 'forbidden words and leaks' "non-blocking leaks (home paths, long hex): $(printf '%s\n' "$soft_lines" | head -n 4 | join2)"
    elif [ ! -s "$patterns" ]; then
        warn 'forbidden words and leaks' 'private deny list missing or empty; generic leaks: none'
    else
        ok 'forbidden words and leaks' 'none detected'
    fi
fi

attr=$(printf '%s\n' "$commit_msgs" \
    | grep -iE '^[[:space:]]*co-authored-by:|generated with \[claude|🤖[[:space:]]*generated with' || true)
if [ -n "$attr" ]; then
    ko 'attribution footers' "$(printf '%s\n' "$attr" | head -n 3 | join2)"
else
    ok 'attribution footers' 'none'
fi

files_rc=0
files_raw=$(gh api --paginate "repos/$REPO/pulls/$pr/files?per_page=100") \
    && files_rc=0 || files_rc=$?
if [ "$files_rc" -ne 0 ]; then
    echo "error: could not read the files of PR #$pr (gh exited with $files_rc)." >&2
    exit 2
fi
files=$(jq -s 'add' <<< "$files_raw")

py_added=$(jq -r '.[] | select((.status == "added" and (.filename | endswith(".py"))) or (.status == "renamed" and (.previous_filename == null) and (.filename | endswith(".py")))) | .filename' <<< "$files")
if [ "${py_added:-}" ]; then
    if [ "$allow_new_python" = "yes" ]; then
        ok 'added Python files' "allowed by --allow-new-python: $(printf '%s\n' "$py_added" | join2)"
    else
        ko 'added Python files' "$(printf '%s\n' "$py_added" | join2)"
    fi
else
    ok 'added Python files' 'none'
fi

workflows=$(jq -r '.[] | select(.filename | startswith(".github/workflows/")) | .filename' <<< "$files")
other_github=$(jq -r '.[] | select((.filename | startswith(".github/")) and ((.filename | startswith(".github/workflows/")) | not)) | .filename' <<< "$files")
if [ "${workflows:-}" ] && [ "$allow_workflow" != "yes" ]; then
    ko '.github files' "workflow files changed: $(printf '%s\n' "$workflows" | join2)"
elif [ "${workflows:-}" ]; then
    warn '.github files' "workflow changes allowed: $(printf '%s\n' "$workflows" | join2)"
elif [ "${other_github:-}" ]; then
    warn '.github files' "outside workflows changed: $(printf '%s\n' "$other_github" | join2)"
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
