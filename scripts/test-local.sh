#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Run the complete local-mode test suite: the OCaml build and tests (the native
# PTY host that every other test starts), frontend checks, Node tests, ruff, the
# Python and browser suite, then the native ptyhost gate.
#   scripts/test-local.sh            everything
#   scripts/test-local.sh -k menu    extra arguments go to pytest
#   scripts/test-local.sh --preflight-only   check prerequisites only
# Python: MESH_PYTHON when set, otherwise .venv/, created from the pinned
# requirements, or completed when its install did not finish
# (scripts/test-local-python.sh). Chromium: MESH_CHROMIUM when set, otherwise the
# newest Playwright build under ~/.cache/ms-playwright, installed when absent.
# OCaml: MESH_OPAM_SWITCH (see scripts/bootstrap.sh), otherwise the current
# opam switch. Tests are discovered by name, so adding one needs no edit here:
# tests/**/*.test.{ts,mjs,cjs} for Node and tests/**/test_*.py for pytest.
set -euo pipefail
cd "$(dirname "$0")/.."
# The hosts take MESH_RUNTIME_DIR before XDG_RUNTIME_DIR: a caller's value would let a test
# reach a real socket. Every test sets its own runtime directory.
unset MESH_RUNTIME_DIR
preflight_only=0
if [ "${1:-}" = --preflight-only ]; then
  preflight_only=1
  shift
  [ "$#" -eq 0 ] || { echo 'test-local: --preflight-only takes no argument.' >&2; exit 2; }
fi

require_tools() {
  local tool
  for tool in node npm git opam python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "test-local: missing required tool: $tool" >&2; exit 1; }
  done
  local version major minor
  version="$(node -p 'process.versions.node')"
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\. ]] || { echo "test-local: unknown Node version $version" >&2; exit 1; }
  major=$((10#${BASH_REMATCH[1]})); minor=$((10#${BASH_REMATCH[2]}))
  if ! (( (major == 22 && minor >= 13) || major >= 24 )); then
    echo "test-local: Node $version is unsupported; use 22.13+ or 24+ (type stripping)." >&2
    exit 1
  fi
  # The demo compiler test runs scripts/compile-demo-tsx.sh, confined by bubblewrap.
  [ -x /usr/bin/bwrap ] || { echo 'test-local: missing /usr/bin/bwrap (package bubblewrap).' >&2; exit 1; }
  if ! /usr/bin/bwrap --unshare-all --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
      -- /usr/bin/true; then
    echo 'test-local: bubblewrap cannot create its namespaces (Ubuntu 24.04: see docs/development.md, section "bubblewrap and Ubuntu 24.04").' >&2
    exit 1
  fi
}

# select_python: MESH_PYTHON, otherwise .venv/, created or completed as needed.
source scripts/test-local-python.sh

select_chromium() {
  local chrome
  if [ -z "${MESH_CHROMIUM:-}" ]; then
    chrome="$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1 || true)"
    if [ -z "$chrome" ] && [ "$preflight_only" -eq 0 ]; then
      "$PY" -m playwright install chromium
      chrome="$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1 || true)"
    fi
    [ -n "$chrome" ] && export MESH_CHROMIUM="$chrome"
  fi
  if [ "$preflight_only" -eq 0 ] && { [ -z "${MESH_CHROMIUM:-}" ] || [ ! -x "$MESH_CHROMIUM" ]; }; then
    echo 'test-local: Chromium is missing; set MESH_CHROMIUM.' >&2
    exit 1
  fi
  export MESH_REQUIRE_BROWSER=1
}

# Short private scratch for sockets, prepared before anything is installed.
prepare_scratch() {
  source scripts/test-tmpdir.sh
  mesh_prepare_test_tmpdir
}

frontend_checks() {
  npm ci --ignore-scripts --no-audit --no-fund
  npm run check
  npm run check:folder-state
  npm run check:pane-actions
  npm run check:workspace-spec
  npm run check:ptyhost-lifecycle
  npm ci --ignore-scripts --no-audit --no-fund --prefix demo-compiler
  npm test --prefix demo-compiler
}

node_tests() {
  local files=()
  mapfile -d '' files < <(find tests -type f \( -name '*.test.ts' -o -name '*.test.mjs' -o -name '*.test.cjs' \) \
    -not -path '*/node_modules/*' -print0 | sort -z)
  [ "${#files[@]}" -eq 0 ] || node --experimental-strip-types --test "${files[@]}"
}

# Builds, tests and installs the OCaml package, then makes the installed host the one
# every test starts (MESH_PTYHOST_CMD).
build_native_host() {
  bash scripts/bootstrap.sh
  local switch="${MESH_OPAM_SWITCH:-$(opam switch show)}"
  NATIVE_HOST="$(opam var --switch="$switch" bin)/mesh-ptyhost"
  export MESH_PTYHOST_CMD="$NATIVE_HOST"
}

ptyhost_gate() {
  PYTHON="$PY" bash scripts/test-ptyhost-t41.sh "$NATIVE_HOST"
  MESH_NATIVE_PTYHOST="$NATIVE_HOST" MESH_REQUIRE_NATIVE_PROJECTS=1 \
    MESH_PYTHON="$PY" node --experimental-strip-types --test tests/projects-workspace.test.ts
}

require_tools
select_python
select_chromium
if [ "$preflight_only" -eq 1 ]; then
  echo 'test-local: preflight OK'
  exit 0
fi
"$PY" scripts/check-test-environment.py requirements-dev.txt requirements-browser.txt
prepare_scratch
# The host first: the frontend checks include project tests that start it, as in CI.
build_native_host
frontend_checks
node_tests
"$PY" -m ruff check .
"$PY" -m pytest -q "$@"
ptyhost_gate
echo 'test-local: PASS'
