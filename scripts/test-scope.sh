#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Compare a commit to the tracked working tree. Untracked files and unknown
# paths conservatively require the full suite.
set -euo pipefail
base="$(git rev-parse --verify --end-of-options "${1:?expected a base revision}^{commit}")"
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo full
  exit 0
fi
git diff --no-renames --name-only -z "$base" -- | (
  scope=docs
  while IFS= read -r -d '' file; do
    case "$file" in
      README.md|docs/*.md) ;;
      *) scope=full ;;
    esac
  done
  echo "$scope"
)
