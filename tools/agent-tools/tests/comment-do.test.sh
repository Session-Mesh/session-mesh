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
if (cd "$TEST_LIB_SCRATCH" \
        && cp "$FIXTURES/good-comment.txt" . \
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
if (cd "$TEST_LIB_SCRATCH" \
        && "$tool" issue 7 good-comment.txt --yes \
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

# Refuse the leaky file: deny word and token, exit 1, no stdout.
rc=0
if (cd "$TEST_LIB_SCRATCH" \
        && cp "$FIXTURES/bad-comment.txt" . \
        && "$tool" issue 7 bad-comment.txt --yes \
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

# A comment that only quotes a long sha warns, and still posts with --yes.
if (cd "$TEST_LIB_SCRATCH" \
        && cp "$FIXTURES/hex-comment.txt" . \
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

if [ "$status" -eq 0 ]; then echo 'comment-do test: OK'; fi
exit "$status"
