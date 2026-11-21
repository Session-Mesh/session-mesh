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
# Leak rules: forbidden words and token-like strings fail the gate, and a token is NEVER
# printed, only its type and the line; a token type is one of ghp_, gho_/ghu_/ghs_/ghr_,
# github_pat_, sk- (preceded by a non-alphanumeric character), xoxb-/xoxp- (Slack),
# AKIA + 16 uppercase alphanumerics (AWS) and a "-----BEGIN ... PRIVATE KEY-----" block;
# home-directory paths (only /home/user and /home/USER are excused; /Users/ and /root/
# are flagged like /home/) and long runs of hexadecimal characters are WARN only;
# in the diff the token scan only looks at added lines of a hunk; any zero-width
# character (U+200B, U+200C, U+200D, U+2060, U+FEFF) is removed from the scanned text
# so it cannot hide a word from the list.

set -euo pipefail
# Byte-wise scanning: a raw byte like 0xFF must not flip GNU grep into
# "binary file matches", and case-insensitive matching stays ASCII-only.
export LC_ALL=C

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

no_zero_width() {
    sed -e 's/\xe2\x80\x8b//g' -e 's/\xe2\x80\x8c//g' -e 's/\xe2\x80\x8d//g' \
        -e 's/\xe2\x81\xa0//g' -e 's/\xef\xbb\xbf//g' -e 's/\xc2\xad//g' \
        -e 's/\xe2\x81\xa3//g' -e 's/\xcc\x8f//g'
}
patterns=$(mktemp)
patterns2=$(mktemp)
trap 'rm -f "$patterns" "$patterns2"' EXIT
# Drop NUL bytes and invalid UTF-8, so the greps never see a "binary" line.
san() {
    local t
    t=$(cat)
    printf '%s' "$t" | tr -d '\000' | iconv -c -f UTF-8 -t UTF-8 2>/dev/null \
        || printf '%s' "$t"
}
if [ -f "$DENY_FILE" ]; then
    grep -v -e '^#' -e '^[[:space:]]*$' "$DENY_FILE" 2>/dev/null \
        | tr -d '\r\000' | no_zero_width > "$patterns" || true
fi

# Join lines into one detail line, "a; b".
join2() {
    awk '{ if (NR > 1) printf "; "; printf "%s", $0 } END { printf "\n" }'
}
# Control characters (except newline) never land in a printed filename.
clean() {
    tr '\000-\010\013\014\016-\037' '?'
}
# A token value is never printed: mask every token shape before showing a line.
# shellcheck disable=SC2016
mask() {
    sed -E \
        -e 's/gh[psour]_[A-Za-z0-9]+/[token]/g' \
        -e 's/github_pat_[A-Za-z0-9_]+/[token]/g' \
        -e 's/(^|[^A-Za-z0-9])(sk-[A-Za-z0-9][A-Za-z0-9_-]*)/\1[token]/g' \
        -e 's/xox[bp]-[A-Za-z0-9-]+/[token]/g' \
        -e 's/AKIA[0-9A-Z]+/[token]/g' \
        -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----[[:print:][:space:]]*-----END [A-Z ]*PRIVATE KEY-----/[private key]/g' \
        -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----/[private key]/g'
}
# Zero-width and invisible characters are invisible but defeat substring matching: drop
# them (U+200B, U+200C, U+200D, U+2060, U+FEFF, U+00AD, U+2063, U+034F).

# Token types, each with its detection expression (grep -E, POSIX portable: no awk
# interval that an old mawk silently ignores).
declare -a TOKEN_NAMES=(ghp_ gho_ github_pat_ sk- xoxb- AKIA 'private key')
declare -a TOKEN_RES=(
    'ghp_[A-Za-z0-9]{16,}'
    'gh[ours]_[A-Za-z0-9]{16,}'
    'github_pat_[A-Za-z0-9_]{20,}'
    '(^|[^A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}'
    'xox[bp]-[A-Za-z0-9-]{10,}'
    'AKIA[0-9A-Z]{16}'
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

report_tokens() { # report_tokens <text>: "token-like string (<type>) on line N" lines,
    # once per type (the first line where it appears)
    local text=$1 i name re ln
    for i in "${!TOKEN_NAMES[@]}"; do
        name=${TOKEN_NAMES[$i]}
        re=${TOKEN_RES[$i]}
        if printf '%s\n' "$text" | grep -anE -e "$re" >/dev/null 2>&1; then
            ln=$(printf '%s\n' "$text" | grep -anE -e "$re" | cut -d: -f1 | head -n 1)
            printf 'token-like string (%s) on line %s\n' "$name" "$ln"
        fi
    done
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
title=$(no_zero_width <<< "$(jq -r .title <<< "$view")")
body=$(no_zero_width <<< "$(jq -r .body <<< "$view")")
commit_msgs=$(no_zero_width <<< "$(jq -r '.commits[] | .messageHeadline + "\n" + (.messageBody // "")' <<< "$view")")

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

# gh pr checks exits 0 with everything green, 8 with pending checks, and 1 both for
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

if [ "$merge_state" = "CLEAN" ]; then
    ok 'merge state' 'CLEAN'
elif [ "$merge_state" = "UNSTABLE" ] && [ -z "$bad_checks" ] && [ -n "$tolerated" ]; then
    warn 'merge state' 'UNSTABLE only because of the informational macOS job'
elif [ "$merge_state" = "UNSTABLE" ]; then
    ko 'merge state' "UNSTABLE with not-green checks: $bad_checks"
else
    ko 'merge state' "$merge_state"
fi

if [ "$base" = "main" ] || [[ $base == release/* ]]; then
    ok 'base branch' "$base"
else
    ko 'base branch' "not main or release/*: $base"
fi

if [ -n "$bad_checks" ]; then
    ko 'CI checks' "not green: $bad_checks"
elif [ -n "$tolerated" ]; then
    warn 'CI checks' "all green or skipped except the informational job: $tolerated"
else
    ok 'CI checks' 'all green'
fi

# The public-ci run must belong to the current head of the base branch.
base_sha=$(gh api "repos/$REPO/branches/$base" --jq .commit.sha) || {
    echo "error: could not read branch $base (gh exited with $?)." >&2
    exit 2
}
runs_rc=0
runs=$(gh run list -R "$REPO" --branch "$base" --workflow public-ci --limit 20 \
        --json databaseId,status,conclusion,headSha) && runs_rc=0 || runs_rc=$?
if [ "$runs_rc" -ne 0 ]; then
    echo "error: could not read the public-ci runs of $base (gh exited with $runs_rc)." >&2
    exit 2
fi
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
# Binary and zero-width noise first, THEN the added lines are extracted
diff=$(no_zero_width <<< "$(san <<< "$diff")")

# Added lines are the "+" lines of a hunk. A "+++ " line only counts as a file header
# outside a hunk (before the first @@ of the file, right after a "--- " line), so a
# content line starting with "+++ " inside a hunk is still scanned as an added line.
added_lines=$(printf '%s\n' "$diff" | awk '
    /^diff --git/ { inhunk = 0; sawminus = 0; next }
    /^--- /       { sawminus = 1; next }
    /^\+\+\+ /    { if (!inhunk && sawminus) next }
    /^@@/         { inhunk = 1; next }
    /^\+/         { if (inhunk) print substr($0, 2) }
')

full_text=$(printf '%s\n%s\n%s\n%s\n' "$title" "$body" "$commit_msgs" "$diff")
token_scan=$(printf '%s\n%s\n%s\n%s\n' "$title" "$body" "$commit_msgs" "$added_lines")

# The missing private list is always announced as its own line, regardless of the
# verdict of the control.
private_list_missing=no
[ -s "$patterns" ] || private_list_missing=yes
if [ "$private_list_missing" = "yes" ]; then
    warn 'private list' 'private deny list missing or empty'
fi

token_reports=$(report_tokens "$token_scan")
forbidden=''
if [ -s "$patterns" ]; then
    forbidden=$(grep -aiF -f "$patterns" <<< "$full_text" || true)
    if [ -n "$forbidden" ]; then
        forbidden=$(printf '%s\n' "$forbidden" | head -n 3 | mask)
    fi
fi
combined=$(printf '%s\n%s\n' "$token_reports" "$forbidden" | awk 'length($0) > 0')
if [ -n "$combined" ]; then
    ko 'forbidden words and leaks' "$(printf '%s\n' "$combined" | head -n 8 | join2 | mask)"
else
    home_paths=$(printf '%s\n' "$full_text" \
        | grep -aoE '[/](home|Users|root)[/][^[:space:]/"]*' || true)
    home_paths=$(printf '%s\n' "$home_paths" | grep -avE '^[/]home[/](user|USER)$' || true)
    hex_hits=$(printf '%s\n' "$added_lines" | grep -aioE '[a-f0-9]{40,}' || true)
    soft_lines=$(printf '%s\n%s\n' "$home_paths" "$hex_hits" | awk 'length($0) > 0')
    if [ -n "$soft_lines" ]; then
        warn 'forbidden words and leaks' "non-blocking leaks (home paths, long hex): $(printf '%s\n' "$soft_lines" | head -n 4 | join2 | mask)"
    else
        ok 'forbidden words and leaks' 'none detected'
    fi
fi

attr=$(printf '%s\n' "$commit_msgs" \
    | grep -iE '^[[:space:]]*co-authored-by:|generated with \[claude|🤖[[:space:]]*generated with' || true)
if [ -n "$attr" ]; then
    ko 'attribution footers' "$(printf '%s\n' "$attr" | head -n 3 | join2 | mask)"
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

# A .py that arrived by rename is new Python unless the previous path was already .py.
py_added=$(jq -r '.[] | select(.status == "added" and (.filename | endswith(".py"))) | .filename' <<< "$files")
py_renamed_new=$(jq -r '.[] | select(.status == "renamed" and (.filename | endswith(".py")) and (((.previous_filename // "") | endswith(".py")) | not)) | .filename' <<< "$files")
py_moved=$(jq -r '.[] | select(.status == "renamed" and (.filename | endswith(".py")) and ((.previous_filename // "") | endswith(".py"))) | .filename + " moved from " + (.previous_filename // "?") + " (was already .py)"' <<< "$files")
py_list=$(printf '%s\n%s\n' "$py_added" "$py_renamed_new" | awk 'length($0) > 0' | clean | join2)
py_moved_list=$(printf '%s\n' "${py_moved:-}" | clean | join2)
if [ -n "$py_list" ] && [ "$allow_new_python" != "yes" ]; then
    ko 'added Python files' "$py_list"
    [ "${py_moved:-}" ] && warn 'added Python files' "$py_moved_list"
elif [ -n "$py_list" ]; then
    ok 'added Python files' "allowed by --allow-new-python: $py_list"
elif [ "${py_moved:-}" ]; then
    warn 'added Python files' "$py_moved_list"
else
    ok 'added Python files' 'none'
fi

# A workflow file that was renamed OUT of .github/workflows/ is still a workflow change.
workflows=$(jq -r '.[] | select(((.filename | startswith(".github/workflows/")) or ((.previous_filename // "") | startswith(".github/workflows/")))) | .filename' <<< "$files")
other_github=$(jq -r '.[] | select((.filename | startswith(".github/")) and ((.filename | startswith(".github/workflows/")) | not) and (((.previous_filename // "") | startswith(".github/workflows/")) | not)) | .filename' <<< "$files")
if [ "${workflows:-}" ] && [ "$allow_workflow" != "yes" ]; then
    ko '.github files' "workflow files changed: $(printf '%s\n' "$workflows" | clean | join2)"
elif [ "${workflows:-}" ]; then
    warn '.github files' "workflow changes allowed: $(printf '%s\n' "$workflows" | clean | join2)"
elif [ "${other_github:-}" ]; then
    warn '.github files' "outside workflows changed: $(printf '%s\n' "$other_github" | clean | join2)"
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
    ok 'changelog' "$(printf '%s' "$changelog_file" | clean) added"
elif printf '%s' "$body" | grep -q 'Changelog: none'; then
    ok 'changelog' 'the body contains Changelog: none'
else
    ko 'changelog' 'neither a changelog.d/ file added nor Changelog: none'
fi

printf '%s\n' "$verdict"
[ "$verdict" = "GO" ]
