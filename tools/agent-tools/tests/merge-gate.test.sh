#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir merge-gate
export REPO=Session-Mesh/session-mesh
status=0

run_case() {
    # run_case <pr> <head8> <deny file or "none"> <expected file> <expected rc>
    local pr=$1 head8=$2 deny=$3 expected=$4 rc_want=$5 rc=0
    if [ "$deny" = "none" ]; then
        AGENT_TOOLS_DENY_FILE="$TEST_LIB_SCRATCH/no-such-deny-words.txt" \
            "$here/../merge-gate.sh" "$pr" "$head8" \
            > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err.err" || rc=$?
    else
        AGENT_TOOLS_DENY_FILE="$FIXTURES/$deny" \
            "$here/../merge-gate.sh" "$pr" "$head8" \
            > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err.err" || rc=$?
    fi
    local label="merge-gate $pr"
    if [ "$rc" -ne "$rc_want" ]; then
        echo "$label: expected exit $rc_want, got $rc" >&2
        status=1
    fi
    if [ -s "$TEST_LIB_SCRATCH/err.err" ]; then
        echo "$label: unexpected stderr" >&2
        cat "$TEST_LIB_SCRATCH/err.err" >&2
        status=1
    fi
    if ! diff_expected "$FIXTURES/$expected" "$TEST_LIB_SCRATCH/out"; then
        status=1
    fi
}

# 401: green PR -> GO (exit 0).
run_case 401 f9c45553 deny-words.txt expected-go.txt 0
# 402: blocked merge, pending check, added .py, no deny list -> NO-GO (exit 1).
run_case 402 a1b2c3d4 none expected-nogo.txt 1
# 403: a paginated files API (added .py on page 2) must be seen -> NO-GO (exit 1).
run_case 403 f9c45553 deny-words.txt expected-403.txt 1
# 404: unreadable diff -> KO readable diff, NO-GO (exit 1).
run_case 404 f9c45553 deny-words.txt expected-404.txt 1
# 405: a deny file of comments and blank lines matches nothing -> WARN, GO (exit 0).
run_case 405 f9c45553 deny-words-blanks.txt expected-405.txt 0
# 406: the PR targets release/latest: the base branch decides which run is checked -> GO.
run_case 406 f9c45553 deny-words.txt expected-406.txt 0
# 407: /home/user and a long hex in added lines are WARN only; still GO (exit 0).
run_case 407 f9c45553 deny-words.txt expected-407.txt 0

if [ "$status" -eq 0 ]; then echo 'merge-gate test: OK'; fi
exit "$status"
