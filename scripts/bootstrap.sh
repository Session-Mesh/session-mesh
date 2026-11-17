#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Install the local-mode OCaml package (mesh-ptyhost, mesh-board-mcp, mesh-history,
# mesh-read, mesh-platform) into one opam switch.
#   bootstrap.sh --install-only   dependencies, build, install: all that is
#                                 needed to use the native programs
#   bootstrap.sh                  the same, and the OCaml tests run before the
#                                 installation, for development and CI
# Both install the same dependencies, test dependencies included: opam 2.1
# does not add the test dependencies of a package that is already installed,
# so a switch prepared without them could not run the tests afterwards.
# Some OCaml tests drive the native PTY host through the Python test harness
# tests/ptyhost_proc.py, so the default mode needs a Python with pytest (the
# interpreter named by PYTHON, otherwise python3) and stops before installing
# anything when it has none. scripts/test-local.sh provides one; with
# --install-only no Python is involved.
#
# The switch is MESH_OPAM_SWITCH (a name or the absolute directory of a local
# switch) when set, otherwise the current opam switch. It must already exist
# and use OCaml 5.3:
#   opam switch create session-mesh ocaml-base-compiler.5.3.0
#   MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh --install-only
# The server finds mesh-board-mcp in the bin directory of that same switch
# (agentmcp.py): run it with the same MESH_OPAM_SWITCH, or inside that opam
# environment. `bootstrap.sh --print-bin` prints that directory and installs
# nothing. `bootstrap.sh --deps-only` stops after the dependency phase (dune, the
# mcp-kit pin, the package's dependencies and test dependencies): it neither
# builds, tests nor installs the package. CI uses it to seed its cache.
# MESH_SQLITE_PREFIX=<dir> (release builds) makes mesh-history carry its own pinned
# SQLite instead of the system's: scripts/build-sqlite.sh builds it into <dir> and the
# sqlite3 binding is installed against it. <dir> must be dedicated to that build (missing, empty,
# or one this script made before): a directory with other content is refused and left alone.
# Without MESH_SQLITE_PREFIX the system libsqlite3 (with FTS5) is used; 3.27 or newer is needed
# for accent folding, older versions fall back to remove_diacritics 1.
#
# One dependency is pinned, provisionally, to a public revision of its source
# repository, read over HTTPS without authentication, until a release has the
# API it needs:
# - mcp-kit: mesh-board-mcp needs an API newer than the 0.2.0 release (response
#   policy, compatibility resource). The pin is versioned 0.2.0+pin so that
#   ocaml/dune-project can require more than the released 0.2.0.
# quint-connect (test only, the ITF replay of the ptyhost lifecycle) comes from
# the default opam repository, as release 0.3.0 or later. It installs the
# findlib library ocaml-quint-connect and conflicts with the opam package of
# that name, which earlier versions of this script pinned to a Git revision: a
# stale pin of it is removed below.
# Everything else comes from the default opam repository.
set -euo pipefail

dune_version="3.24.2"
mcp_kit_pin="mcp-kit.0.2.0+pin"
mcp_kit_source="git+https://gitlab.com/nomadic-labs/ai-harness/ocaml-mcp.git#44a8398745cc55c4e0b66e6748ad597b957dcd10"
worktree="$(cd "$(dirname "$0")/.." && pwd -P)"
switch="${MESH_OPAM_SWITCH:-$(opam switch show)}"

mode="${1:-}"
case "$#:$mode" in
  0: | 1:--print-bin | 1:--deps-only | 1:--install-only) ;;
  *)
    echo "usage: bootstrap.sh [--print-bin | --deps-only | --install-only]" >&2
    exit 2
    ;;
esac
if [ ! -f "$worktree/ocaml/dune-project" ]; then
  echo "bootstrap: no OCaml project under $worktree/ocaml." >&2
  exit 1
fi
if ! opam switch list --short | grep -Fxq -- "$switch"; then
  echo "bootstrap: opam switch '$switch' does not exist; create it with OCaml 5.3 first." >&2
  exit 1
fi
if [ "$mode" = --print-bin ]; then
  opam var --switch="$switch" bin
  exit 0
fi
compiler="$(opam exec --switch="$switch" -- ocamlc -version)"
# Only OCaml 5.3 is accepted: it is the compiler CI builds and tests with
# (.github/workflows/public-ci.yml, OCAML_COMPILER). ocaml/dune-project states
# the same range (>= 5.3 & < 5.4); widen both once CI covers another release.
case "$compiler" in
  5.3.*) ;;
  *)
    echo "bootstrap: expected OCaml 5.3.x in '$switch', got $compiler." >&2
    exit 1
    ;;
esac

test_python="${PYTHON:-python3}"
if [ -z "$mode" ] && ! "$test_python" -c 'import pytest' >/dev/null 2>&1; then
  echo "bootstrap: the OCaml tests need pytest, which '$test_python' does not provide." >&2
  echo "bootstrap: to build and install without running them: bash scripts/bootstrap.sh --install-only" >&2
  echo "bootstrap: to run them: scripts/test-local.sh, which prepares a Python environment." >&2
  exit 1
fi

# Pin dune's version: installing it is not enough, the dependency phase below
# otherwise upgrades it to the newest release.
opam pin add --switch="$switch" --no-action --yes dune "$dune_version"
opam install --switch="$switch" "dune.$dune_version" --yes
opam pin add --switch="$switch" --no-action --yes "$mcp_kit_pin" "$mcp_kit_source"
# Switches prepared by earlier versions pin ocaml-quint-connect to a Git
# revision. quint-connect conflicts with that package, so drop the stale pin
# (this also removes the pinned package) before the dependency phase.
if opam pin list --switch="$switch" --short | grep -Fxq -- ocaml-quint-connect; then
  opam pin remove --switch="$switch" --yes ocaml-quint-connect
fi
# Release builds only: mesh-history carries its own pinned SQLite (scripts/build-sqlite.sh) instead
# of the system's libsqlite3. The sqlite3 binding takes its flags from pkg-config when it is
# installed, so the pinned prefix must come first there, and loadable extensions are compiled out
# of both. The binding records its link flags in its sqlite3.cmxa, so one already installed against
# another SQLite is refused: it would link the system's. Use a fresh switch. The check runs before
# and again after the dependency step, which may itself have installed the binding.
check_sqlite_binding() {
  local archive
  archive="$(opam var --switch="$switch" lib)/sqlite3/sqlite3.cmxa"
  if [ -f "$archive" ] && ! grep -aqF -- "-L$sqlite_prefix/lib" "$archive"; then
    echo "bootstrap: the sqlite3 binding of '$switch' is not linked against $sqlite_prefix; use a switch without it." >&2
    exit 1
  fi
}
if [ -n "${MESH_SQLITE_PREFIX:-}" ]; then
  bash "$worktree/scripts/build-sqlite.sh" "$MESH_SQLITE_PREFIX"
  sqlite_prefix="$(cd "$MESH_SQLITE_PREFIX" && pwd -P)"
  export PKG_CONFIG_PATH="$sqlite_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export SQLITE3_DISABLE_LOADABLE_EXTENSIONS=1
  check_sqlite_binding
fi
opam install --switch="$switch" "$worktree/ocaml" --deps-only --with-test --yes
if [ -n "${MESH_SQLITE_PREFIX:-}" ]; then
  check_sqlite_binding
fi
if [ "$mode" = --deps-only ]; then
  echo "bootstrap: dependencies installed in '$switch'."
  exit 0
fi
# Test rules read fixtures beside the package, so build and test the working
# tree in place, then install those exact artifacts.
(cd "$worktree/ocaml" && opam exec --switch="$switch" -- dune build -p session_mesh @install)
if [ -z "$mode" ]; then
  # The native project tests run the real catalog validator, which lives outside the dune root.
  PYTHON="$test_python" MESH_PROJECT_VALIDATOR_ENTRY="$worktree/tools/project-observation.mjs" \
    MESH_PTYHOST_CMD="$worktree/ocaml/_build/default/bin/mesh_ptyhost_main.exe" \
    opam exec --switch="$switch" -- dune runtest --root "$worktree/ocaml"
fi
opam install --switch="$switch" "$worktree/ocaml" --assume-built --yes
opam exec --switch="$switch" -- bash -c 'command -v mesh-ptyhost mesh-board-mcp mesh-read mesh-history >/dev/null'
if [ -z "$mode" ]; then
  echo "bootstrap: local OCaml package built, tested and installed in '$switch'."
else
  echo "bootstrap: local OCaml package built and installed in '$switch' (tests not run)."
fi
