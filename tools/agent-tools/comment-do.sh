#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# comment-do.sh <pr|issue> <number> <file> --yes — post the file's content as a comment.
# Without --yes: prints what it would do and posts nothing. Refuses (exit 1) when the file
# contains a word of the private deny list, a token-like string, an absolute /home/ path
# (only /home/user and /home/USER are excused) or an attribution footer; a long hexa-
# decimal run (sha-like, 40+ characters) is only a WARN, since comments legitimately
# quote shas. A token is NEVER printed: only its type and the line. A path starting with
# "-" is refused (exit 2), it is never read from stdin.
# Without the deny file the generic checks still run and the tool says the private list is
# missing. Env: REPO, AGENT_TOOLS_DENY_FILE (private list, not in this repo; comments and
# blank lines are ignored). Exit codes: 0 = posted or dry run, 1 = refused,
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

content=$(cat -- "$file")

patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
if [ -f "$DENY_FILE" ]; then
    grep -v -e '^#' -e '^[[:space:]]*$' "$DENY_FILE" 2>/dev/null | tr -d '\r' > "$patterns" || true
fi

refusals=''
if [ -s "$patterns" ]; then
    deny_hits=$(printf '%s\n' "$content" | grep -iF -f "$patterns" || true)
    if [ -n "$deny_hits" ]; then
        refusals="${refusals}KO forbidden word: $(printf '%s\n' "$deny_hits" | head -n 1)"$'\n'
    fi
else
    printf 'WARN private deny list missing or empty: the generic checks still run\n' >&2
fi

# Tokens are reported by TYPE and line, never by value.
token_hits=$(printf '%s\n' "$content" \
    | awk -v re='(^|[^A-Za-z0-9])(ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9][A-Za-z0-9_-]{19,})' \
        '$0 ~ re {
            if ($0 ~ /ghp_[A-Za-z0-9]{16,}/) t = "ghp_"
            else if ($0 ~ /github_pat_[A-Za-z0-9_]{20,}/) t = "github_pat_"
            else t = "sk-"
            print "KO token-like string (" t ") on line " NR
        }' || true)
if [ -n "$token_hits" ]; then
    refusals="${refusals}$(printf '%s\n' "$token_hits" | head -n 1)"$'\n'
fi

home_paths=$(printf '%s\n' "$content" | grep -oE '[/]home[/][^[:space:]/"]*' || true)
home_hits=$(printf '%s\n' "$home_paths" | grep -vE '^[/]home[/](user|USER)$' || true)
if [ -n "$home_hits" ]; then
    refusals="${refusals}KO /home/ path: $(printf '%s\n' "$home_hits" | head -n 1)"$'\n'
fi

attr_hits=$(printf '%s\n' "$content" \
    | grep -iE '^[[:space:]]*co-authored-by:|generated with \[claude|🤖[[:space:]]*generated with' || true)
if [ -n "$attr_hits" ]; then
    refusals="${refusals}KO attribution footer: $(printf '%s\n' "$attr_hits" | head -n 1)"$'\n'
fi

hex_hits=$(printf '%s\n' "$content" | grep -iE '[a-f0-9]{40,}' || true)
if [ -n "$hex_hits" ]; then
    printf 'WARN long hexadecimal string: %s\n' "$(printf '%s\n' "$hex_hits" | head -n 1)" >&2
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

gh "$target" comment "$number" -R "$REPO" --body-file "$file" >/dev/null
printf 'OK comment posted (%s %s)\n' "$target" "$number"
