#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# The Node tests of scripts/test-local.sh, which sources this file and calls node_tests
# (tests/test-local-node.test.ts drives it with a stand-in find and node). Runs every
# tests/**/*.test.{ts,mjs,cjs}; a failing `find` fails the run, so no test is silently left out.
# Written for bash 3.2 (macOS): no mapfile, and the status of find is captured through a
# temporary file rather than a process substitution, whose status is lost.

node_tests() {
  local files=() file list
  list="$(mktemp)" || return 1
  if ! find tests -type f \( -name '*.test.ts' -o -name '*.test.mjs' -o -name '*.test.cjs' \) \
      -not -path '*/node_modules/*' -print0 > "$list"; then
    rm -f "$list"
    echo 'test-local: find failed while listing the Node tests.' >&2
    return 1
  fi
  if ! sort -z "$list" > "$list.sorted"; then
    rm -f "$list" "$list.sorted"
    echo 'test-local: sort failed while listing the Node tests.' >&2
    return 1
  fi
  while IFS= read -r -d '' file; do files+=("$file"); done < "$list.sorted"
  rm -f "$list" "$list.sorted"
  [ "${#files[@]}" -eq 0 ] || node --experimental-strip-types --test "${files[@]}"
}
