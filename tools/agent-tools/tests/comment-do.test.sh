#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir comment-do
export REPO=Session-Mesh/session-mesh
export AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words.txt"
status=0
label='comment-do'
tool="$here/../comment-do.sh"
reject() { # reject <file args...> <expected rc>
    local want=$1; shift
    local rc=0
    if (cd "$TEST_LIB_SCRATCH" && "$tool" "$@") > "$TEST_LIB_SCRATCH/o" 2> "$TEST_LIB_SCRATCH/e"; then
        rc=0
    else
        rc=$?
    fi
    [ "$rc" -eq "$want" ] || { echo "$label $2: expected exit $want, got $rc" >&2; status=1; }
}

# Dry run on a clean file: print the plan, post nothing.
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/good-comment.txt" . \
        && "$tool" issue 7 good-comment.txt \
        > "$TEST_LIB_SCRATCH/dry" 2> "$TEST_LIB_SCRATCH/dry.err"); then
    :
else
    echo "$label dry: expected exit 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-dryrun.txt" "$TEST_LIB_SCRATCH/dry"; then
    status=1
fi

# Post the clean file with --yes.
if (cd "$TEST_LIB_SCRATCH" && "$tool" issue 7 good-comment.txt --yes \
        > "$TEST_LIB_SCRATCH/post" 2> "$TEST_LIB_SCRATCH/post.err"); then
    :
else
    echo "$label post: expected exit 0" >&2
    status=1
fi
if [ -s "$TEST_LIB_SCRATCH/post.err" ]; then
    echo "$label post: unexpected stderr" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-post.txt" "$TEST_LIB_SCRATCH/post"; then
    status=1
fi

# A leaky file built at runtime: deny word with a token on the same line (the displayed
# line must be masked), a bare token, and a /home/ path. Never any token value.
tok1="ghp_$(printf 'x%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20)"
printf 'A word: Example-Private-Repository %s\nSee %s in the logs\npaths: /home/alice/x\n' "$tok1" "$tok1" \
    > "$TEST_LIB_SCRATCH/bad-comment.txt"
reject 1 issue 7 bad-comment.txt --yes
if ! diff_expected "$FIXTURES/expected-refuse.txt" "$TEST_LIB_SCRATCH/e"; then
    status=1
fi
if grep -qE 'ghp_[A-Za-z0-9]' "$TEST_LIB_SCRATCH/e" "$TEST_LIB_SCRATCH/o"; then
    echo "$label refuse: a token value leaked" >&2
    status=1
fi

# A long sha only warns, and the comment still posts with --yes.
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/hex-comment.txt" . \
        && "$tool" issue 7 hex-comment.txt --yes \
        > "$TEST_LIB_SCRATCH/hex.out" 2> "$TEST_LIB_SCRATCH/hex.err"); then
    :
else
    echo "$label hex: expected exit 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-hexwarn.out" "$TEST_LIB_SCRATCH/hex.out"; then
    status=1
fi
if ! diff_expected "$FIXTURES/expected-hexwarn.err" "$TEST_LIB_SCRATCH/hex.err"; then
    status=1
fi

# Several token kinds, built at runtime: each is reported by type, never by value.
tok2="ghp_$(printf 'y%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20)"
slack_t="xox""b-1234-5678-abcdefghijklmnop"; aws_t="AK""IA""ABCDEFGHIJKLMNOP"; pem_t="-----BEGIN RSA PRIVATE ""KEY-----"
printf 'slack key: %s\naws key: %s\n%s\nsee %s\n' "$slack_t" "$aws_t" "$pem_t" "$tok2" \
    > "$TEST_LIB_SCRATCH/types-comment.txt"
reject 1 issue 7 types-comment.txt --yes
for t in 'token-like string (xoxb-)' 'token-like string (AKIA)' 'token-like string (private key)' 'token-like string (ghp_)'; do
    grep -q "$t" "$TEST_LIB_SCRATCH/e" \
        || { echo "$label types: missing report '$t'" >&2; status=1; }
done
if grep -qE 'xoxb-1234|AKIA[A-Z]|BEGIN RSA|ghp_[A-Za-z0-9]' "$TEST_LIB_SCRATCH/e" "$TEST_LIB_SCRATCH/o"; then
    echo "$label types: a token value leaked" >&2
    status=1
fi

# A zero-width character inside the forbidden word does not defeat the list.
printf 'A word: Exam\xe2\x80\x8bple-Private-Repository\n' > "$TEST_LIB_SCRATCH/zw-comment.txt"
reject 1 issue 7 zw-comment.txt --yes
grep -q 'KO forbidden word' "$TEST_LIB_SCRATCH/e" \
    || { echo "$label zero-width: the forbidden word slipped through" >&2; status=1; }

# A sha-like hex plus a token on the same line: the WARN masks the token.
printf 'Reference: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000 and %s\n' \
    "ghp_$(printf 'z%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20)" \
    > "$TEST_LIB_SCRATCH/hexmask-comment.txt"
reject 1 issue 7 hexmask-comment.txt --yes
grep -q 'WARN long hexadecimal string:' "$TEST_LIB_SCRATCH/e" \
    || { echo "$label hexmask: missing WARN" >&2; status=1; }
grep -q '\[token\]' "$TEST_LIB_SCRATCH/e" \
    || { echo "$label hexmask: the token was not masked in the WARN" >&2; status=1; }
if grep -qE 'ghp_[A-Za-z0-9]' "$TEST_LIB_SCRATCH/e" "$TEST_LIB_SCRATCH/o"; then
    echo "$label hexmask: the token value leaked" >&2
    status=1
fi

# A deny file made only of comments and blank lines warns but does not blanket-match.
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/good-comment.txt" . \
        && AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words-blanks.txt" \
        "$tool" issue 7 good-comment.txt --yes \
        > "$TEST_LIB_SCRATCH/blank.out" 2> "$TEST_LIB_SCRATCH/blank.err"); then
    :
else
    echo "$label blank deny list: expected exit 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-blanklist.out" "$TEST_LIB_SCRATCH/blank.out"; then
    status=1
fi
if ! diff_expected "$FIXTURES/expected-blanklist.err" "$TEST_LIB_SCRATCH/blank.err"; then
    status=1
fi

# An attribution footer in the comment is refused.
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/attribution-comment.txt" . \
        && "$tool" issue 7 attribution-comment.txt --yes \
        > "$TEST_LIB_SCRATCH/attr.out" 2> "$TEST_LIB_SCRATCH/attr.err"); then
    echo "$label attribution: expected exit 1, got 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-attr.err" "$TEST_LIB_SCRATCH/attr.err"; then
    status=1
fi

# /Users/ and /root/ are flagged like /home/.
printf 'See /Users/alice/x and /root/alice/y\n' > "$TEST_LIB_SCRATCH/prefix-comment.txt"
reject 1 issue 7 prefix-comment.txt --yes
grep -q 'user-directory path: /Users/alice' "$TEST_LIB_SCRATCH/e" \
    || { echo "$label prefixes: missing /Users report" >&2; status=1; }
grep -q '/root/alice' "$TEST_LIB_SCRATCH/e" \
    || { echo "$label prefixes: missing /root report" >&2; status=1; }

# A file named like an option is refused, not read from stdin.
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/good-comment.txt" ./-n \
        && "$tool" issue 7 -n --yes > "$TEST_LIB_SCRATCH/dash.out" 2> "$TEST_LIB_SCRATCH/dash.err"); then
    echo "$label dash file: expected exit 2, got 0" >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "$label dash file: expected exit 2, got $rc" >&2; status=1; }
fi

if [ "$status" -eq 0 ]; then echo 'comment-do test: OK'; fi
exit "$status"
