#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Stamp the release tag and the checksums of the other release assets into install.sh.
#   release-stamp-installer.sh <install.sh> <tag> <sums-file> <output>
# <install.sh> must hold exactly one stamp block, as committed:
#   # @release-stamp-begin
#   MESH_RELEASE_TAG=''
#   MESH_RELEASE_SUMS=''
#   # @release-stamp-end
# The block is replaced by the tag and the lines of <sums-file> (`<sha256>  <asset>`, as
# sha256sum prints them), single-quoted. Every value is checked first, so that nothing stamped
# can end a quote: a tag v<major>.<minor>.<patch>[-<suffix>], 64 lowercase hex digits, asset
# names of [A-Za-z0-9._-] only. Refuses a missing, duplicated or modified block, and a sums file
# that is empty or names install.sh itself. The output is written with mode 0755.
set -euo pipefail

TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
SUM_PATTERN='^[0-9a-f]{64}  [A-Za-z0-9._-]+$'
BEGIN='# @release-stamp-begin'
EMPTY_TAG="MESH_RELEASE_TAG=''"
EMPTY_SUMS="MESH_RELEASE_SUMS=''"
END='# @release-stamp-end'

fail() { echo "release-stamp-installer: $*" >&2; exit 1; }

# The line number of the only line equal to $2 in file $1; fails unless there is exactly one.
only_line() {
  local numbers
  numbers="$(grep -nxF -- "$2" "$1" | cut -d: -f1 || true)"
  [ -n "$numbers" ] || fail "$1 has no line '$2' (stamp block missing)"
  [ "$(printf '%s\n' "$numbers" | wc -l)" -eq 1 ] || fail "$1 has more than one line '$2' (stamp block duplicated)"
  printf '%s\n' "$numbers"
}

check_sums() {
  [ -s "$1" ] || fail "$1 is empty"
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ $SUM_PATTERN ]] || fail "not a '<sha256>  <asset>' line: $line"
    [ "${line#*  }" != install.sh ] || fail "$1 must not list install.sh itself"
  done <"$1"
}

if [ "$#" -ne 4 ] || [ ! -f "$1" ] || [ ! -f "$3" ]; then
  echo "usage: release-stamp-installer.sh <install.sh> <tag> <sums-file> <output>" >&2
  exit 2
fi
installer="$1" tag="$2" sums="$3" output="$4"
[[ "$tag" =~ $TAG_PATTERN ]] || fail "not a release tag: $tag"
check_sums "$sums"

begin="$(only_line "$installer" "$BEGIN")"
end="$(only_line "$installer" "$END")"
[ "$end" -eq $((begin + 3)) ] &&
  [ "$(sed -n "$((begin + 1))p" "$installer")" = "$EMPTY_TAG" ] &&
  [ "$(sed -n "$((begin + 2))p" "$installer")" = "$EMPTY_SUMS" ] ||
  fail "the stamp block of $installer is not the committed empty block"

staged="$(mktemp "$(dirname "$output")/.stamp.XXXXXX")"
trap 'rm -f "$staged"' EXIT
{
  head -n "$begin" "$installer"
  printf "MESH_RELEASE_TAG='%s'\n" "$tag"
  printf "MESH_RELEASE_SUMS='%s'\n" "$(cat "$sums")"
  tail -n +"$end" "$installer"
} >"$staged"
chmod 0755 "$staged"
mv -f "$staged" "$output"
trap - EXIT
