#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$here/test-lib.sh"
setup_dir pr-status
"$here/../pr-status.sh" > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err"
[ -s "$TEST_LIB_SCRATCH/err" ] && { echo "pr-status: unexpected stderr" >&2; exit 1; }
diff_expected "$FIXTURES/expected.txt" "$TEST_LIB_SCRATCH/out"
echo 'pr-status test: OK'
