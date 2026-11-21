#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# test-lib.sh — shared setup for the tests: a stub gh (and a fixed date) placed first on
# PATH, with FIXTURES pointing at fixtures/<tool>/. Source it, then call setup_dir <tool>.

setup_dir() {
    local here dir
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    dir=$(mktemp -d)
    TEST_LIB_SCRATCH=$dir
    export TEST_LIB_SCRATCH
    trap 'rm -rf "$TEST_LIB_SCRATCH"' EXIT
    cp "$here/fake-gh" "$dir/gh"
    printf '#!/usr/bin/env bash\nprintf "fixed-time\\n"\n' > "$dir/date"
    chmod +x "$dir/gh" "$dir/date"
    export PATH="$dir:$PATH"
    export FIXTURES="$here/../fixtures/$1"
}

# diff_expected <expected file> <actual text file>: compare; prints a diff on failure.
diff_expected() {
    diff -u "$1" "$2"
}
