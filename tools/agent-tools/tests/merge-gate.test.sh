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
tool="$here/../merge-gate.sh"

run_case() {
    # run_case <pr> <head8> <deny file or "none"> <expected stdout or ""> <expected rc>
    local pr=$1 head8=$2 deny=$3 expected=$4 rc_want=$5 rc=0
    if [ "$deny" = "none" ]; then
        AGENT_TOOLS_DENY_FILE="$TEST_LIB_SCRATCH/no-such-deny-words.txt" \
            "$tool" "$pr" "$head8" \
            > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err" || rc=$?
    else
        AGENT_TOOLS_DENY_FILE="$FIXTURES/$deny" \
            "$tool" "$pr" "$head8" \
            > "$TEST_LIB_SCRATCH/out" 2> "$TEST_LIB_SCRATCH/err" || rc=$?
    fi
    local label="merge-gate $pr"
    if [ "$rc" -ne "$rc_want" ]; then
        echo "$label: expected exit $rc_want, got $rc" >&2
        status=1
    fi
    if [ "$rc_want" -eq 2 ]; then
        # Environment errors: no stdout, and the message explains what gh could not give.
        [ -s "$TEST_LIB_SCRATCH/out" ] && { echo "$label: expected no stdout" >&2; status=1; }
        grep -q 'error:' "$TEST_LIB_SCRATCH/err" || { echo "$label: expected an error message" >&2; status=1; }
    else
        [ -s "$TEST_LIB_SCRATCH/err" ] && { echo "$label: unexpected stderr" >&2; cat "$TEST_LIB_SCRATCH/err" >&2; status=1; }
        if ! diff_expected "$FIXTURES/$expected" "$TEST_LIB_SCRATCH/out"; then
            status=1
        fi
    fi
}

run_case 401 f9c45553 deny-words.txt expected-go.txt 0
run_case 402 a1b2c3d4 none expected-nogo.txt 1
run_case 403 f9c45553 deny-words.txt expected-403.txt 1
run_case 405 f9c45553 deny-words-blanks.txt expected-405.txt 0
run_case 407 f9c45553 deny-words.txt expected-407.txt 0
run_case 408 f9c45553 deny-words.txt expected-408.txt 0
run_case 410 f9c45553 deny-words.txt expected-nogo-410.txt 1
run_case 411 f9c45553 deny-words.txt expected-nogo-411.txt 1
run_case 412 f9c45553 deny-words.txt expected-nogo-412.txt 1
run_case 413 f9c45553 deny-words.txt expected-nogo-413.txt 1
run_case 414 f9c45553 deny-words.txt expected-nogo-414.txt 1
run_case 415 f9c45553 deny-words.txt expected-415.txt 0
run_case 418 f9c45553 deny-words.txt expected-418.txt 0
run_case 419 f9c45553 deny-words.txt expected-nogo-419.txt 1
run_case 421 f9c45553 deny-words.txt expected-nogo-421.txt 1

# A non-numeric PR argument (a URL) is refused by usage; the fake gh would follow it.
rc=0
if "$tool" "https://github.com/Session-Mesh/session-mesh/pull/14" f9c45553 \
    > "$TEST_LIB_SCRATCH/ourl" 2> "$TEST_LIB_SCRATCH/eurl"; then
    echo "merge-gate url: expected exit 2, got 0" >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "merge-gate url: expected exit 2, got $rc" >&2; status=1; }
fi

# 404: gh cannot render the diff -> exit 2, no stdout, a clear error on stderr.
rc=0
AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words.txt" "$tool" 404 f9c45553 \
    > "$TEST_LIB_SCRATCH/o404" 2> "$TEST_LIB_SCRATCH/e404" || rc=$?
if [ "$rc" -ne 2 ]; then
    echo 'merge-gate 404: expected exit 2 with no stdout' >&2
    status=1
fi
grep -q 'could not read the diff of PR #404' "$TEST_LIB_SCRATCH/e404" \
    || { echo 'merge-gate 404: missing diff error message' >&2; status=1; }

# 406: the base branch is release/latest; a copy of the fixtures makes the main run a
# failure for the same sha, so running the check against main (hardcoded branch) goes red.
cp -r "$FIXTURES" "$TEST_LIB_SCRATCH/fg406"
printf '%s\n' \
  '[{"databaseId":9,"status":"completed","conclusion":"failure","headSha":"f9c45553deadbeefdeadbeefdeadbeefdeadbeef"}]' \
  > "$TEST_LIB_SCRATCH/fg406/run-main.json"
saved_fixtures=$FIXTURES
FIXTURES="$TEST_LIB_SCRATCH/fg406"
rc=0
AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words.txt" "$tool" 406 f9c45553 \
    > "$TEST_LIB_SCRATCH/o406" 2> "$TEST_LIB_SCRATCH/e406" || rc=$?
if [ "$rc" -ne 0 ]; then
    echo 'merge-gate 406: expected exit 0' >&2
    status=1
fi
if [ -s "$TEST_LIB_SCRATCH/e406" ]; then
    echo 'merge-gate 406: unexpected stderr' >&2
    status=1
fi
if ! diff_expected "$saved_fixtures/expected-406.txt" "$TEST_LIB_SCRATCH/o406"; then
    status=1
fi
FIXTURES=$saved_fixtures

# 409: tokens built at runtime (no token literal in the fixtures) of several kinds ->
# KO by type with line numbers, and no value must ever reach the output. The diff also
# exercises: a raw non-UTF-8 byte on the token line, a content line starting with "+++",
# a token cut by a zero-width character, and the deny word masked next to a token.
cp -r "$FIXTURES" "$TEST_LIB_SCRATCH/fg409"
tok="ghp_$(printf 'x%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20)"
gho="gho_$(printf 'o%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18)"
aws="AK""IA""ABCDEFGHIJKLMNOP"
slack="xox""b-1234-5678-abcdefghijklmnop"
pem='-----BEGIN RSA PRIVATE ''KEY-----'
zwsp=$'\xe2\x80\x8b'
base=$(cat "$TEST_LIB_SCRATCH/fg409/pr-view-401.json")
printf '%s\n' "$base" \
    | jq --arg b "The bot published $tok on the tracker. AWS key: $aws. Slack: $slack. $pem. A word: Example-Private-Repository $tok. Hidden: gh${zwsp}o_$gho and ${tok:0:9}${zwsp}${tok:9}" \
        '.body = $b' > "$TEST_LIB_SCRATCH/fg409/pr-view-409.json"
zw_tok="${tok:0:9}${zwsp}${tok:9}"
printf 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+raw byte: %b and %s\n+++ %s inside a hunk\n+split token %s and %s\n' \
    '\377' "$tok" "$tok" "$zw_tok" "$gho" > "$TEST_LIB_SCRATCH/fg409/diff-409.txt"
saved_fixtures=$FIXTURES
FIXTURES="$TEST_LIB_SCRATCH/fg409"
rc=0
AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words.txt" "$tool" 409 f9c45553 --allow-new-python \
    > "$TEST_LIB_SCRATCH/o409" 2> "$TEST_LIB_SCRATCH/e409" || rc=$?
if [ "$rc" -ne 1 ]; then
    echo 'merge-gate 409: expected exit 1' >&2
    status=1
fi
for t in 'token-like string (ghp_) on line 2' 'token-like string (AKIA) on line 2' 'token-like string (xoxb-) on line 2' 'token-like string (private key) on line 2' 'token-like string (gho_)' 'A word: Example-Private-Repository [token]'; do
    grep -qF "$t" "$TEST_LIB_SCRATCH/o409" \
        || { echo "merge-gate 409: missing report '$t'" >&2; status=1; }
done
if grep -qE "$tok|$gho|$aws|$slack|BEGIN RSA" "$TEST_LIB_SCRATCH/o409" "$TEST_LIB_SCRATCH/e409"; then
    echo 'merge-gate 409: a token value leaked into the output' >&2
    status=1
fi
FIXTURES=$saved_fixtures

# gh cannot even answer (view fails) -> exit 2, with the exact wording.
cp -r "$FIXTURES" "$TEST_LIB_SCRATCH/fgvf"
: > "$TEST_LIB_SCRATCH/fgvf/view-fails"
saved_fixtures=$FIXTURES
FIXTURES="$TEST_LIB_SCRATCH/fgvf"
rc=0
if AGENT_TOOLS_DENY_FILE="$FIXTURES/deny-words.txt" "$tool" 401 f9c45553 \
    > "$TEST_LIB_SCRATCH/ovf" 2> "$TEST_LIB_SCRATCH/evf"; then
    echo 'merge-gate view-fails: expected exit 2, got 0' >&2
    status=1
else
    rc=$?
    [ "$rc" -eq 2 ] || { echo "merge-gate view-fails: expected exit 2, got $rc" >&2; status=1; }
fi
grep -q 'could not read PR #401 (gh exited with 3)' "$TEST_LIB_SCRATCH/evf" \
    || { echo 'merge-gate view-fails: missing message' >&2; status=1; }
FIXTURES=$saved_fixtures

if [ "$status" -eq 0 ]; then echo 'merge-gate test: OK'; fi
exit "$status"
