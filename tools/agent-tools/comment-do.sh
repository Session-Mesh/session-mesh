#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# comment-do.sh <pr|issue> <number> <file> --yes — post the file's content as a comment.
# Without --yes: prints what it would do and posts nothing. Refuses (exit 1) when the
# file contains a word of the private deny list, a token-like string, an absolute
# user-directory path (/home/, /Users/, /root/; only /home/user and /home/USER are
# excused) or an attribution footer; a long hexadecimal run (sha-like, 40+ characters)
# is only a WARN, since comments legitimately quote shas. A token is NEVER printed,
# only its type and the line; any displayed line has token shapes masked with [token].
# Token types: ghp_, gho_/ghu_/ghs_/ghr_, github_pat_, sk- (preceded by a
# non-alphanumeric character), xoxb-/xoxp- (Slack), AKIA + 16 uppercase alphanumerics
# (AWS), "-----BEGIN ... PRIVATE KEY-----". Zero-width characters (U+200B, U+200C,
# U+200D, U+2060, U+FEFF) are removed from the content before the checks, so they
# cannot hide a word from the list. The content is read ONCE into a temporary copy and
# that copy is posted. A path starting with "-" is refused (exit 2): never stdin.
# Without the deny file the generic checks still run and the tool says the private list
# is missing. Env: REPO, AGENT_TOOLS_DENY_FILE (private list, not in this repo;
# comments and blank lines are ignored). Exit codes: 0 = posted or dry run, 1 = refused,
# 2 = usage or environment error.

set -euo pipefail

REPO=${REPO:-Session-Mesh/session-mesh}
DENY_FILE=${AGENT_TOOLS_DENY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/deny-words.txt}

if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh is required." >&2
    exit 2
fi

target=${1:-}
number=${2:-}
file=${3:-}
yes_flag=no
for arg in "$@"; do
    [ "$arg" = "--yes" ] && yes_flag=yes
done
case ":$target:" in
    ":pr:" | ":issue:") ;;
    *) echo "usage: $0 <pr|issue> <number> <file> [--yes]" >&2; exit 2 ;;
esac
[[ $number =~ ^[0-9]+$ ]] || { echo "usage: $0 <pr|issue> <number> <file> [--yes]" >&2; exit 2; }
case $file in
    -*) echo "comment-do.sh refuses a path starting with '-': $file" >&2; exit 2 ;;
esac
if [ ! -r "$file" ]; then
    echo "error: file '$file' is not readable." >&2
    exit 2
fi

# The content is read once, cleaned and kept in a temporary copy that is also what gets
# posted (no second read, no race).
body_copy=$(mktemp)
trap 'rm -f "$body_copy"' EXIT
no_zero_width() {
    sed -e 's/\xe2\x80\x8b//g' -e 's/\xe2\x80\x8c//g' -e 's/\xe2\x80\x8d//g' \
        -e 's/\xe2\x81\xa0//g' -e 's/\xef\xbb\xbf//g'
}
content=$(no_zero_width < "$file")
printf '%s\n' "$content" > "$body_copy"

patterns=$(mktemp)
trap 'rm -f "$patterns" "$body_copy"' EXIT
if [ -f "$DENY_FILE" ]; then
    grep -v -e '^#' -e '^[[:space:]]*$' "$DENY_FILE" 2>/dev/null | tr -d '\r' > "$patterns" || true
fi

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

refusals=''
if [ -s "$patterns" ]; then
    deny_hits=$(printf '%s\n' "$content" \
        | grep -iF -f "$patterns" || true)
    if [ -n "$deny_hits" ]; then
        refusals="${refusals}KO forbidden word: $(printf '%s\n' "$deny_hits" | head -n 1 | mask)"$'\n'
    fi
else
    printf 'WARN private deny list missing or empty: the generic checks still run\n' >&2
fi

# Tokens are reported by TYPE and line, never by value. grep -E, POSIX portable.
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
for i in "${!TOKEN_NAMES[@]}"; do
    name=${TOKEN_NAMES[$i]}
    re=${TOKEN_RES[$i]}
    if printf '%s\n' "$content" | grep -nE -e "$re" >/dev/null 2>&1; then
        line=$(printf '%s\n' "$content" | grep -nE -e "$re" | cut -d: -f1 | head -n 1)
        refusals="${refusals}KO token-like string ($name) on line $line"$'\n'
    fi
done

home_paths=$(printf '%s\n' "$content" | grep -oE '[/](home|Users|root)[/][^[:space:]/"]*' || true)
home_hits=$(printf '%s\n' "$home_paths" | grep -vE '^[/]home[/](user|USER)$' || true)
if [ -n "$home_hits" ]; then
    shown=0
    while IFS= read -r hpath; do
        [ -n "$hpath" ] || continue
        [ "$shown" -lt 3 ] || break
        refusals="${refusals}KO user-directory path: $(printf '%s\n' "$hpath" | mask)"$'\n'
        shown=$((shown + 1))
    done <<< "$home_hits"
fi

attr_hits=$(printf '%s\n' "$content" \
    | grep -iE '^[[:space:]]*co-authored-by:|generated with \[claude|🤖[[:space:]]*generated with' || true)
if [ -n "$attr_hits" ]; then
    refusals="${refusals}KO attribution footer: $(printf '%s\n' "$attr_hits" | head -n 1 | mask)"$'\n'
fi

hex_hits=$(printf '%s\n' "$content" | grep -iE '[a-f0-9]{40,}' || true)
if [ -n "$hex_hits" ]; then
    printf 'WARN long hexadecimal string: %s\n' "$(printf '%s\n' "$hex_hits" | head -n 1 | mask)" >&2
fi

if [ -n "$refusals" ]; then
    printf '%s' "$refusals" >&2
    echo 'comment-do.sh refuses to post (see the KO above).' >&2
    exit 1
fi

if [ "$yes_flag" != "yes" ]; then
    echo "comment-do.sh (dry run, without --yes): I would post the contents of $file on $target $number."
    echo 'Nothing was posted.'
    exit 0
fi

gh "$target" comment "$number" -R "$REPO" --body-file "$body_copy" >/dev/null
printf 'OK comment posted (%s %s)\n' "$target" "$number"
