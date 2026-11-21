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

# A leaky file built at runtime (no token literal in the fixtures): deny word, token,
# /home/ path -> three refusals, and the token value must not reach the output.
cat > "$TEST_LIB_SCRATCH/bad-comment.txt" <<BAD
A word: Example-Private-Repository
See ghp_$(printf 'x%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20) in the logs
paths: /home/alice/x
BAD
rc=0
if (cd "$TEST_LIB_SCRATCH" && "$tool" issue 7 bad-comment.txt --yes \
        > "$TEST_LIB_SCRATCH/refuse" 2> "$TEST_LIB_SCRATCH/refuse.err"); then
    echo "$label refuse: expected exit 1, got 0" >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 1 ] || { echo "$label refuse: expected exit 1, got $rc" >&2; status=1; }
fi
if [ -s "$TEST_LIB_SCRATCH/refuse" ]; then
    echo "$label refuse: expected no stdout" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-refuse.txt" "$TEST_LIB_SCRATCH/refuse.err"; then
    status=1
fi
if grep -q "ghp_xxxxxxxx" "$TEST_LIB_SCRATCH/refuse.err"; then
    echo "$label refuse: the token value leaked" >&2
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
rc=0
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/attribution-comment.txt" . \
        && "$tool" issue 7 attribution-comment.txt --yes \
        > "$TEST_LIB_SCRATCH/attr.out" 2> "$TEST_LIB_SCRATCH/attr.err"); then
    echo "$label attribution: expected exit 1, got 0" >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 1 ] || { echo "$label attribution: expected exit 1, got $rc" >&2; status=1; }
fi
if ! diff_expected "$FIXTURES/expected-attr.err" "$TEST_LIB_SCRATCH/attr.err"; then
    status=1
fi

# A file named like an option is refused, not read from stdin.
rc=0
if (cd "$TEST_LIB_SCRATCH" && cp "$FIXTURES/good-comment.txt" ./-n \
        && "$tool" issue 7 -n --yes > "$TEST_LIB_SCRATCH/dash.out" 2> "$TEST_LIB_SCRATCH/dash.err"); then
    echo "$label dash file: expected exit 2, got 0" >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "$label dash file: expected exit 2, got $rc" >&2; status=1; }
fi
if [ -s "$TEST_LIB_SCRATCH/dash.out" ]; then
    echo "$label dash file: expected no stdout" >&2
    status=1
fi
if ! grep -q 'refuse' "$TEST_LIB_SCRATCH/dash.err"; then
    echo "$label dash file: missing refusal message" >&2
    status=1
fi

if [ "$status" -eq 0 ]; then echo 'comment-do test: OK'; fi
exit "$status"
