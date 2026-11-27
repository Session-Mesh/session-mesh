#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# The Node tests of scripts/test-local.sh, which sources this file and calls node_tests
# (tests/test-local-node.test.ts drives it with a stand-in find and node). Runs every
# tests/**/*.test.{ts,mjs,cjs}; a failing `find` fails the run, so no test is silently left out.
# Written for bash 3.2 (macOS): no mapfile, and the status of find is captured through a
# temporary file rather than a process substitution, whose status is lost.

# Node runs cpus-1 test files at once by default; each browser test file starts its own server and
# Chromium, which starves a small machine. MESH_TEST_CONCURRENCY sets how many files run at once (a
# positive integer); without it, one less than the CPU count, between 1 and 4 (the cap CI uses).
test_concurrency() {
  local cpus value="${MESH_TEST_CONCURRENCY-}"
  if [ -n "$value" ]; then
    case "$value" in
      *[!0-9]*|0|0[0-9]*)
        echo "test-local: MESH_TEST_CONCURRENCY must be a positive integer, got '$value'." >&2
        return 1 ;;
    esac
    printf '%s\n' "$value"
    return 0
  fi
  cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  case "$cpus" in ''|*[!0-9]*) cpus=2 ;; esac
  value=$((cpus - 1))
  [ "$value" -ge 1 ] || value=1
  [ "$value" -le 4 ] || value=4
  printf '%s\n' "$value"
}

node_tests() {
  local files=() file list concurrency
  concurrency="$(test_concurrency)" || return 1
  if [ "$#" -gt 0 ]; then
    for file in "$@"; do
      while [[ "$file" == ./* ]]; do file="${file#./}"; done
      case "$file" in
        */../*|*/node_modules/*) ;;
        tests/*.test.ts|tests/*.test.mjs|tests/*.test.cjs)
          if [ -f "$file" ]; then files+=("$file"); continue; fi ;;
      esac
      printf 'test-local: expected an existing Node test under tests/: %s\n' "$file" >&2
      return 1
    done
  else
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
  fi
  # The interface language follows the environment of the browsers, and the tests assert English labels
  # (a test of another language sets its own locale): run them under a fixed locale, whatever the caller's.
  [ "${#files[@]}" -eq 0 ] ||
    LC_ALL=C.UTF-8 LANG=C.UTF-8 LANGUAGE=en_US:en \
      node --experimental-strip-types --test "--test-concurrency=$concurrency" "${files[@]}"
}
