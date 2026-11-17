#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Copy the publishable part of the showcase site into <directory>: everything in site/ except the
# maintenance tools (site/tools/) and the maintainers' README (site/README.md). Used by
# .github/workflows/site.yml; tests/site-workflow.test.ts runs it.
#   bash .github/scripts/site-stage.sh "$RUNNER_TEMP/site-stage"
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: site-stage.sh <directory>" >&2
  exit 2
fi
target="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -e "$target" ] && [ -n "$(ls -A "$target")" ]; then
  echo "site-stage: $target exists and is not empty" >&2
  exit 2
fi
mkdir -p "$target"
find "$root/site" -mindepth 1 -maxdepth 1 ! -name tools ! -name README.md -exec cp -a {} "$target"/ \;
test -f "$target/index.html"
