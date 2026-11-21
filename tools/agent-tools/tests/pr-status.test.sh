#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir pr-status
status=0
tool="$here/../pr-status.sh"

# Case A: the ordinary listing of 35 PRs (the --limit must not cap at 30).
"$tool" > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err"
if [ -s "$TEST_LIB_SCRATCH/err" ]; then
    echo 'pr-status A: unexpected stderr' >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected.txt" "$TEST_LIB_SCRATCH/out"; then
    status=1
fi

# Case B: an API error of gh pr checks -> exit 2 with the message (not "(no checks yet)").
cp -r "$FIXTURES" "$TEST_LIB_SCRATCH/psb"
saved=$FIXTURES
: > "$TEST_LIB_SCRATCH/psb/checks-7-apifail"
FIXTURES="$TEST_LIB_SCRATCH/psb"
rc=0
if "$tool" > "$TEST_LIB_SCRATCH/outb" 2> "$TEST_LIB_SCRATCH/errb" && rc=0 || rc=$?; then
    :
else
    rc=$?
fi
[ "$rc" -eq 2 ] || { echo "pr-status B: expected exit 2, got $rc" >&2; status=1; }
grep -q 'could not read the CI checks of PR #7 (gh exited with 1)' "$TEST_LIB_SCRATCH/errb" \
    || { echo 'pr-status B: missing message' >&2; status=1; }
FIXTURES=$saved

# Case C: an API error of gh pr list -> exit 2 with the message.
cp -r "$FIXTURES" "$TEST_LIB_SCRATCH/psc"
: > "$TEST_LIB_SCRATCH/psc/pr-list-fails"
FIXTURES="$TEST_LIB_SCRATCH/psc"
rc=0
if "$tool" > "$TEST_LIB_SCRATCH/outc" 2> "$TEST_LIB_SCRATCH/errc" && rc=0 || rc=$?; then
    :
else
    rc=$?
fi
[ "$rc" -eq 2 ] || { echo "pr-status C: expected exit 2, got $rc" >&2; status=1; }
grep -q 'could not list the pull requests (gh exited with 2)' "$TEST_LIB_SCRATCH/errc" \
    || { echo 'pr-status C: missing message' >&2; status=1; }
FIXTURES=$saved

if [ "$status" -eq 0 ]; then echo 'pr-status test: OK'; fi
exit "$status"
