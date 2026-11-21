#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Runs every tests/*.test.sh and reports OK/KO per tool; exits non-zero if any is KO.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0
shopt -s nullglob
tests=("$here"/tests/*.test.sh)
if [ "${#tests[@]}" -eq 0 ]; then echo "no tests found in $here/tests"; exit 2; fi
for t in "${tests[@]}"; do
  name="$(basename "$t" .test.sh)"
  if bash "$t" >/dev/null 2>&1; then echo "OK  $name"; else echo "KO  $name"; status=1; fi
done
exit "$status"
