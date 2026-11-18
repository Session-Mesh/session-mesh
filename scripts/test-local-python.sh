#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# The Python of scripts/test-local.sh, which sources this file and calls select_python
# (tests/test-local-python.test.ts drives it with a stand-in python3). Reads preflight_only
# (1: change nothing); sets PY, and outside a preflight PATH, VIRTUAL_ENV and MESH_PYTHON.
#
# MESH_PYTHON when set, used as it is. Otherwise .venv/: created with python3 when absent, and
# ready only once the pinned packages are installed in it, which the marker below records. A .venv
# without it (an install that did not finish, or a .venv made by hand) is completed by the next run.

# The Pythons that .venv may be created from: every pin of requirements-dev.txt and
# requirements-browser.txt needs 3.10 or later, and aiohttp 3.14.3 has binary wheels for
# CPython 3.10 to 3.14 only (pip falls back to a source build, which fails, on a newer one).
# Move the bounds with those pins.
venv_python_min=3.10
venv_python_max=3.14
venv_marker=.venv/.test-local-installed

# Exits unless the interpreter $1 is Python $venv_python_min to $venv_python_max. Plain shell
# arithmetic (no sort -V or -C, which BusyBox lacks), so 3.100 is not read as 3.10.
require_venv_python() {
  local interpreter="$1" version major minor
  version="$("$interpreter" -c 'import sys; print("%d.%d" % sys.version_info[:2])')" \
    || { echo "test-local: $interpreter does not run." >&2; exit 1; }
  major=${version%%.*}
  minor=${version#*.}
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+$ ]] || [ "$major" -ne 3 ] \
      || [ "$minor" -lt "${venv_python_min#3.}" ] || [ "$minor" -gt "${venv_python_max#3.}" ]; then
    echo "test-local: $interpreter is Python $version; the pinned test packages install on Python $venv_python_min to $venv_python_max." >&2
    if [ -e .venv ]; then
      echo "test-local: move .venv aside, create it with one of those, then run this script again, which installs the packages:" >&2
    else
      echo "test-local: create .venv with one of those, then run this script again, which installs the packages:" >&2
    fi
    echo "  python$venv_python_max -m venv .venv" >&2
    exit 1
  fi
}

# Installs the pinned packages into .venv, then writes the marker.
venv_install() {
  .venv/bin/python -m pip install -q -r requirements-dev.txt -r requirements-browser.txt && : > "$venv_marker"
}

select_python() {
  if [ -n "${MESH_PYTHON:-}" ]; then
    PY="$(command -v -- "$MESH_PYTHON")" || { echo 'test-local: MESH_PYTHON is not executable.' >&2; exit 1; }
    case "$PY" in /*) ;; *) PY="$PWD/$PY" ;; esac
    PATH="$(dirname "$PY"):$PATH"
  else
    if [ ! -f "$venv_marker" ]; then
      if [ ! -e .venv ]; then
        require_venv_python python3
        [ "$preflight_only" -eq 0 ] || { echo 'test-local: .venv absent (created by a full run).'; PY=python3; return; }
        # Whatever step fails, remove the .venv this run made: the next run starts afresh.
        if ! python3 -m venv .venv || ! venv_install; then
          rm -rf .venv
          echo 'test-local: creating .venv or installing the test packages into it failed; .venv was removed.' >&2
          exit 1
        fi
      else
        [ -x .venv/bin/python ] \
          || { echo 'test-local: .venv exists but has no bin/python; move it aside or set MESH_PYTHON.' >&2; exit 1; }
        require_venv_python .venv/bin/python
        [ "$preflight_only" -eq 0 ] \
          || { echo 'test-local: .venv incomplete (its packages are installed by a full run).'; PY="$PWD/.venv/bin/python"; return; }
        # A .venv this script did not finish: completed, never removed (it may not be this run's).
        venv_install \
          || { echo 'test-local: installing the test packages into .venv failed; fix the cause, then run this script again.' >&2; exit 1; }
      fi
    fi
    PY="$PWD/.venv/bin/python"
    VIRTUAL_ENV="$PWD/.venv"
    PATH="$VIRTUAL_ENV/bin:$PATH"
    export VIRTUAL_ENV
  fi
  # Node tests that start the real server read the interpreter from MESH_PYTHON.
  export PATH MESH_PYTHON="$PY"
}
