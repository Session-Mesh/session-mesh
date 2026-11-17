#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Black-box gate of the native host. Call only after building/installing it;
# no opam writes, services, or ambient runtime sockets are used.
set -euo pipefail
cd "$(dirname "$0")/.."
# The hosts take MESH_RUNTIME_DIR before XDG_RUNTIME_DIR; the fixtures set XDG_RUNTIME_DIR only.
unset MESH_RUNTIME_DIR
if [ "$#" -ne 1 ] || [[ "$1" != /* ]] || [ ! -f "$1" ] || [ ! -x "$1" ]; then
  echo 'ptyhost-t41: absolute candidate executable is required' >&2
  exit 2
fi
python="${PYTHON:-python3}"
report="$(mktemp /tmp/mesh-t41-junit.XXXXXX)"
trap 'rm -f -- "$report"' EXIT
# Scope selection to this invocation: the marked subset only. Do not pass caller
# filters that could omit security cases. MESH_PTYHOST_CMD is the executable's path, as it is
# (one path, no quoting: see CONTRIBUTING.md, "Which PTY host the tests run"). The lifecycle
# ITF adapter (built by scripts/bootstrap.sh) is required here: its test fails, never skips.
MESH_PTYHOST_CMD="$1" MESH_REQUIRE_ITF_ADAPTER=1 "$python" -m pytest -q \
  -o xfail_strict=true --junitxml="$report" -m 'ptyhost_t41 or ptyhost_t42 or ptyhost_t43 or ptyhost_t44e' \
  tests/test_ptyhost.py tests/test_ptyhost_env.py \
  tests/test_ptyhost_errors.py tests/test_ptyhost_t41.py tests/test_ptyhost_t42.py \
  tests/test_ptyhost_nonblocking.py tests/test_ptyhost_t43.py \
  tests/test_ptyhost_t44e.py
"$python" - "$report" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
cases = root.findall(".//testcase")
if not cases:
    raise SystemExit("ptyhost-t41: no executed candidate cases")
if any(case.find("skipped") is not None for case in cases):
    raise SystemExit("ptyhost-t41: candidate gate requires zero skips/xfails")
if any(case.find("error") is not None or case.find("failure") is not None for case in cases):
    raise SystemExit("ptyhost-t41: candidate report contains an error/failure")
print(f"ptyhost-t41: {len(cases)} executed candidate cases; zero skips/xfails")
PY
