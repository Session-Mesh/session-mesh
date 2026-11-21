#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir merge-do
export REPO=Session-Mesh/session-mesh
export AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words.txt"
status=0
label='merge-do'

# Without --yes: dry run, nothing is merged, exit 0.
if "$here/../merge-do.sh" 401 f9c45553 \
    > "$TEST_LIB_SCRATCH/dry" 2> "$TEST_LIB_SCRATCH/dry.err"; then
    :
else
    echo "$label dry: expected exit 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-dryrun.txt" "$TEST_LIB_SCRATCH/dry"; then
    status=1
fi

# With --yes: the gate gives GO, the merge happens, the merge sha is printed.
if "$here/../merge-do.sh" 401 f9c45553 --yes \
    > "$TEST_LIB_SCRATCH/merge" 2> "$TEST_LIB_SCRATCH/merge.err"; then
    :
else
    echo "$label merge: expected exit 0" >&2
    status=1
fi
if [ -s "$TEST_LIB_SCRATCH/merge.err" ]; then
    echo "$label merge: unexpected stderr" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-merge.txt" "$TEST_LIB_SCRATCH/merge"; then
    status=1
fi

# Head mismatch: the full head is read BEFORE the gate; it must start with <head8>.
if "$here/../merge-do.sh" 403 f9c45553 --yes \
    > "$TEST_LIB_SCRATCH/mismatch" 2> "$TEST_LIB_SCRATCH/mismatch.err"; then
    echo "$label mismatch: expected exit 1, got 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-mismatch.err" "$TEST_LIB_SCRATCH/mismatch.err"; then
    status=1
fi

# The stubbed gh pr merge fails (as it does when the head moved between the gate and
# the merge): the tool must tell it and exit 1 while the gate said GO.
if "$here/../merge-do.sh" 404 f9c45553 --yes \
    > "$TEST_LIB_SCRATCH/failmerge.out" 2> "$TEST_LIB_SCRATCH/failmerge.err"; then
    echo "$label fail-merge: expected exit 1, got 0" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-failmerge.out" "$TEST_LIB_SCRATCH/failmerge.out"; then
    status=1
fi
if ! diff_expected "$FIXTURES/expected-failmerge.err" "$TEST_LIB_SCRATCH/failmerge.err"; then
    status=1
fi

# The head moves between the reading and the merge: the gate sees the moved head (which
# still starts with <head8>), and the merge must stay pinned to the head read before.
if "$here/../merge-do.sh" 405 f9c45553 --yes \
    > "$TEST_LIB_SCRATCH/moves.out" 2> "$TEST_LIB_SCRATCH/moves.err"; then
    :
else
    echo "$label moves: expected exit 0" >&2
    status=1
fi
if [ -s "$TEST_LIB_SCRATCH/moves.err" ]; then
    echo "$label moves: unexpected stderr" >&2
    status=1
fi
if ! diff_expected "$FIXTURES/expected-moves.out" "$TEST_LIB_SCRATCH/moves.out"; then
    status=1
fi

if [ "$status" -eq 0 ]; then echo 'merge-do test: OK'; fi
exit "$status"
