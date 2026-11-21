#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
# shellcheck disable=SC1091
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/test-lib.sh"
setup_dir pr-status
"$here/../pr-status.sh" > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err"
if [ -s "$TEST_LIB_SCRATCH/err" ]; then
    echo 'pr-status: unexpected stderr' >&2
    status=1
else
    status=0
fi
if ! diff_expected "$FIXTURES/expected.txt" "$TEST_LIB_SCRATCH/out"; then
    status=1
fi
if [ "$status" -eq 0 ]; then echo 'pr-status test: OK'; fi
exit "$status"
