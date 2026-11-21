#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir ci-failures
status=0

# PR 14: completed run for the PR head (the newest run belongs to another head).
"$here/../ci-failures.sh" 14 > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err"
if [ -s "$TEST_LIB_SCRATCH/err" ]; then
    echo 'ci-failures 14: unexpected stderr' >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected.txt" "$TEST_LIB_SCRATCH/out"; then
    status=1
fi

# PR 15: the run is still in progress: print the state of each job, no empty conclusion.
"$here/../ci-failures.sh" 15 > "$TEST_LIB_SCRATCH/out15" 2> "$TEST_LIB_SCRATCH/err15"
if [ -s "$TEST_LIB_SCRATCH/err15" ]; then
    echo 'ci-failures 15: unexpected stderr' >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-inflight.txt" "$TEST_LIB_SCRATCH/out15"; then
    status=1
fi

# A PR number that is not numeric is refused by usage.
if "$here/../ci-failures.sh" 'https://github.com/Session-Mesh/session-mesh/pull/14' \
    > "$TEST_LIB_SCRATCH/ourl" 2> "$TEST_LIB_SCRATCH/eurl"; then
    echo 'ci-failures url: expected exit 2' >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "ci-failures url: expected exit 2, got $rc" >&2; status=1; }
fi
[ -s "$TEST_LIB_SCRATCH/ourl" ] && { echo 'ci-failures url: expected no stdout' >&2; status=1; }

if [ "$status" -eq 0 ]; then echo 'ci-failures test: OK'; fi
exit "$status"
