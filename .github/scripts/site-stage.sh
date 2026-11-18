#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Copy the publishable part of the showcase site into <directory>: everything in site/ except the
# maintenance tools (site/tools/) and the maintainers' README (site/README.md). Used by
# .github/workflows/site.yml and site-preview.yml; tests/site-workflow.test.ts runs it. It refuses a
# staged page that does not start with the Content Security Policy head of the reference home page and
# any SVG, XML or XHTML file that is not byte-identical to the reference one (see site-csp-check.mjs).
# The reference is the checkout given as the optional second argument (a preview passes the checkout of
# main, so a pull request cannot weaken its own policy); without it, this checkout (site.yml, after a merge).
#   bash .github/scripts/site-stage.sh "$RUNNER_TEMP/site-stage" [<checkout of main>]
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: site-stage.sh <directory> [<reference checkout>]" >&2
  exit 2
fi
target="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
reference="$(cd "${2:-$root}" && pwd)"

if [ -e "$target" ] && [ -n "$(ls -A "$target")" ]; then
  echo "site-stage: $target exists and is not empty" >&2
  exit 2
fi
mkdir -p "$target"
find "$root/site" -mindepth 1 -maxdepth 1 ! -name tools ! -name README.md -exec cp -a {} "$target"/ \;
test -f "$target/index.html"

# Every published page starts with the head of the home page up to its policy tag (the policy is a
# per-page <meta> tag, so the browser must read it first), and nothing else that could run a script
# is published (see site-csp-check.mjs). It needs node.
command -v node >/dev/null || { echo "site-stage: node is required for the Content-Security-Policy check" >&2; exit 2; }
node "$(dirname "${BASH_SOURCE[0]}")/site-csp-check.mjs" "$reference/site/index.html" "$target" "$reference/site"
