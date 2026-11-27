#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Compare a commit to the tracked working tree. Untracked files and unknown
# paths conservatively require the full suite.
set -euo pipefail
base="$(git rev-parse --verify --end-of-options "${1:?expected a base revision}^{commit}")"
local_files="${2:-}"
emit_scope() {
  if [ "$local_files" = --local-files ]; then
    printf '%s\0' "$@"
  else
    printf '%s\n' "$1"
  fi
}
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  emit_scope full
  exit 0
fi
git diff --no-renames --name-only -z "$base" -- | (
  scope=docs
  files=()
  while IFS= read -r -d '' file; do
    case "$file" in
      README.md|docs/*.md) ;;
      tests/node_modules/*|tests/*/node_modules/*) scope=full ;;
      tests/*.test.ts|tests/*.test.mjs|tests/*.test.cjs)
        if [ "$local_files" = --local-files ] && [ "$scope" != full ] &&
            [ -f "$file" ] && [ ! -L "$file" ]; then
          scope=node
          files+=("$file")
        else
          scope=full
        fi ;;
      *) scope=full ;;
    esac
  done
  if [ "$scope" = node ]; then
    emit_scope "$scope" "${files[@]}"
  else
    emit_scope "$scope"
  fi
)
