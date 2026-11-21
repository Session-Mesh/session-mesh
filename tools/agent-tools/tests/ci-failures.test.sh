#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir ci-failures
status=0
tool="$here/../ci-failures.sh"

# PR 14: completed run of the PR head; the newest run of the branch belongs to another
# workflow, the real pytest summary (FAILED/ERROR lines) must show up.
"$tool" 14 > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err"
if [ -s "$TEST_LIB_SCRATCH/err" ]; then
    echo 'ci-failures 14: unexpected stderr' >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected.txt" "$TEST_LIB_SCRATCH/out"; then
    status=1
fi

# PR 15: the run is still in progress: the state of each job, without "in_progress ()".
"$tool" 15 > "$TEST_LIB_SCRATCH/out15" 2> "$TEST_LIB_SCRATCH/err15"
[ -s "$TEST_LIB_SCRATCH/err15" ] && { echo 'ci-failures 15: unexpected stderr' >&2; status=1; }
if ! diff_expected "$FIXTURES/expected-inflight.txt" "$TEST_LIB_SCRATCH/out15"; then
    status=1
fi

# PR 16: a green run prints one explicit line instead of nothing.
"$tool" 16 > "$TEST_LIB_SCRATCH/out16" 2> "$TEST_LIB_SCRATCH/err16"
[ -s "$TEST_LIB_SCRATCH/err16" ] && { echo 'ci-failures 16: unexpected stderr' >&2; status=1; }
if ! diff_expected "$FIXTURES/expected-green.txt" "$TEST_LIB_SCRATCH/out16"; then
    status=1
fi

# PR 17: a 3000-line matched log must not kill, through SIGPIPE, the following jobs.
GEN_DIR=$TEST_LIB_SCRATCH; export GEN_DIR
awk 'BEGIN { for (i = 1; i <= 3000; i++) printf "jobA\tstep\t2026-11-21T10:00:00.000Z \342\234\226 leak scan line %d\n", i; printf "jobB\tstep\t2026-11-21T11:00:00.000Z \342\234\226 the last leak line\n" }' > "$GEN_DIR/log-failed-777888.txt"
"$tool" 17 > "$TEST_LIB_SCRATCH/out17" 2> "$TEST_LIB_SCRATCH/err17"
[ -s "$TEST_LIB_SCRATCH/err17" ] && { echo 'ci-failures 17: unexpected stderr' >&2; status=1; }
if ! diff_expected "$FIXTURES/expected-biglog.txt" "$TEST_LIB_SCRATCH/out17"; then
    status=1
fi

# PR 18: the log dump cannot be produced -> exit 2 with a clear message.
if "$tool" 18 > "$TEST_LIB_SCRATCH/out18" 2> "$TEST_LIB_SCRATCH/err18"; then
    echo 'ci-failures 18: expected exit 2, got 0' >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "ci-failures 18: expected exit 2, got $rc" >&2; status=1; }
fi
if ! grep -q 'could not read the failed log' "$TEST_LIB_SCRATCH/err18"; then
    echo 'ci-failures 18: missing error message' >&2
    status=1
fi

# A non-numeric PR argument is refused by usage.
if "$tool" 'https://github.com/Session-Mesh/session-mesh/pull/14' \
    > "$TEST_LIB_SCRATCH/ourl" 2> "$TEST_LIB_SCRATCH/eurl"; then
    echo 'ci-failures url: expected exit 2, got 0' >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "ci-failures url: expected exit 2, got $rc" >&2; status=1; }
fi
[ -s "$TEST_LIB_SCRATCH/ourl" ] && { echo 'ci-failures url: expected no stdout' >&2; status=1; }

# gh cannot even answer (view fails) -> exit 2, with the exact wording.
cp -r "$FIXTURES" "$TEST_LIB_SCRATCH/cf"
: > "$TEST_LIB_SCRATCH/cf/view-fails"
rc=0
if FIXTURES="$TEST_LIB_SCRATCH/cf" "$tool" 14 \
    > "$TEST_LIB_SCRATCH/out20" 2> "$TEST_LIB_SCRATCH/err20"; then
    echo 'ci-failures view-fails: expected exit 2, got 0' >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "ci-failures view-fails: expected exit 2, got $rc" >&2; status=1; }
fi
grep -q 'could not read PR #14 (gh exited with 3)' "$TEST_LIB_SCRATCH/err20" \
    || { echo 'ci-failures view-fails: missing message' >&2; status=1; }

if [ "$status" -eq 0 ]; then echo 'ci-failures test: OK'; fi
exit "$status"
