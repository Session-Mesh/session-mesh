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
  for tool in node npm git opam python3 jq; do
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
  # The demo compiler test runs scripts/compile-demo-tsx.sh, confined by bubblewrap, on Linux only:
  # elsewhere the launcher refuses to run the compiler and the tests check that refusal instead
  # (demo-compiler/README.md).
  if [ "$(uname -s)" = Linux ]; then
    [ -x /usr/bin/bwrap ] || { echo 'test-local: missing /usr/bin/bwrap (package bubblewrap).' >&2; exit 1; }
    if ! /usr/bin/bwrap --unshare-all --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
        -- /usr/bin/true; then
      echo 'test-local: bubblewrap cannot create its namespaces (Ubuntu 24.04: see docs/development.md, section "bubblewrap and Ubuntu 24.04").' >&2
      exit 1
    fi
  fi
}

# select_python: MESH_PYTHON, otherwise .venv/, created or completed as needed.
source scripts/test-local-python.sh
# node_tests: every tests/**/*.test.{ts,mjs,cjs}; a failing find fails the run.
source scripts/test-local-node.sh

# The newest executable Playwright Chromium under PLAYWRIGHT_BROWSERS_PATH, in the layout of this
# system: on macOS chrome-mac/Chromium.app (Playwright 1.56) or chrome-mac-arm64/Google Chrome for
# Testing.app (later builds). A revision whose browser is not executable is passed over.
newest_chromium() {
  local layout candidate newest=''
  case "$(uname -s)" in
    Darwin) layout='chromium-*/chrome-mac*/*.app/Contents/MacOS/*' ;;
    *) layout='chromium-*/chrome-linux*/chrome' ;;
  esac
  # shellcheck disable=SC2086 # $layout is a glob.
  while IFS= read -r candidate; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then newest=$candidate; fi
  done < <(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/$layout 2>/dev/null | sort -V)
  printf '%s\n' "$newest"
}

select_chromium() {
  local chrome
  # The tests pin Playwright's browsers to ~/.cache/ms-playwright (tests/conftest.py), which is
  # Playwright's own default on Linux only (macOS: ~/Library/Caches): install and look there.
  export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if [ -z "${MESH_CHROMIUM:-}" ]; then
    chrome="$(newest_chromium)"
    if [ -z "$chrome" ] && [ "$preflight_only" -eq 0 ]; then
      "$PY" -m playwright install chromium
      chrome="$(newest_chromium)"
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
  # macOS sets TMPDIR to a per-user directory under /var/folders: too long for the socket paths, and
  # /var is a symlink, as is /tmp. Unless TMPDIR names another directory, use the physical /private/tmp.
  local user_tmp
  if [ "$(uname -s)" = Darwin ]; then
    user_tmp="$(getconf DARWIN_USER_TEMP_DIR)"
    if [ -z "${TMPDIR:-}" ] || [ "${TMPDIR%/}" = "${user_tmp%/}" ]; then
      TMPDIR=/private/tmp
    fi
  fi
  source scripts/test-tmpdir.sh
  mesh_prepare_test_tmpdir
}

frontend_checks() {
  npm ci --ignore-scripts --no-audit --no-fund
  npm run check
  npm run check:folder-state
  npm run check:flow
  npm run check:pane-actions
  npm run check:workspace-spec
  npm run check:ptyhost-lifecycle
  npm ci --ignore-scripts --no-audit --no-fund --prefix demo-compiler
  npm test --prefix demo-compiler
}

# Build, test and install the OCaml package, then point the tests at the installed programs.
build_native_host() {
  bash scripts/bootstrap.sh
  local switch="${MESH_OPAM_SWITCH:-$(opam switch show)}"
  local bin
  bin="$(opam var --switch="$switch" bin)"
  NATIVE_HOST="$bin/mesh-ptyhost"
  export MESH_PTYHOST_CMD="$NATIVE_HOST"
  export MESH_MESH_HISTORY_CMD="$bin/mesh-history"
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
# These slow polling scenarios use their own fixture so the general browser suite remains isolated.
MESH_ENTRY_REFRESH_TEST=1 MESH_REQUIRE_BROWSER=1 MESH_REQUIRE_WORK_READ=1 MESH_PYTHON="$PY" \
  node --experimental-strip-types --test --test-name-pattern='entry task refresh preserves|isolated question disappearance' \
  tests/work-view-state-browser.test.ts
"$PY" -m ruff check .
"$PY" -m pytest -q "$@"
ptyhost_gate
echo 'test-local: PASS'
