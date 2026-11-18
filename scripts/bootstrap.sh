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
# switch) when set, otherwise the current opam switch. A missing switch is
# created with OCaml 5.3 (OCAML_COMPILER, default ocaml-base-compiler.5.3.0)
# from the pinned opam repository below; an existing one must use OCaml 5.3:
#   MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh --install-only
# An existing switch must already read only that repository (or only the
# session-mesh repository of an earlier run, whose URL follows a changed pin),
# or be the local switch of this checkout (CI): the bootstrap does not change the repositories
# of a switch other projects may share, the current one included, unless
# MESH_OPAM_SELECT_PINNED=1 allows it. Unset, MESH_OPAM_SWITCH is not replaced
# by a switch of the bootstrap's choosing, because install.sh, agentmcp.py and
# scripts/test-local.sh look for the programs in the current switch too.
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
# the pinned opam repository, as release 0.3.0 or later. It installs the
# findlib library ocaml-quint-connect and conflicts with the opam package of
# that name, which earlier versions of this script pinned to a Git revision: a
# stale pin of it is removed below.
# Everything else comes from the opam repository at the commit fixed in
# scripts/release-pins.sh, selected for this switch only.
# shellcheck disable=SC1091,SC2154 # the pins file is sourced by a computed path and sets opam_repository
set -euo pipefail

dune_version="3.24.2"
mcp_kit_pin="mcp-kit.0.2.0+pin"
mcp_kit_source="git+https://gitlab.com/nomadic-labs/ai-harness/ocaml-mcp.git#44a8398745cc55c4e0b66e6748ad597b957dcd10"
worktree="$(cd "$(dirname "$0")/.." && pwd -P)"
switch="${MESH_OPAM_SWITCH:-$(opam switch show 2>/dev/null || true)}"

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
case "$switch" in
  "")
    echo "bootstrap: no current opam switch; name one, created if missing: MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh" >&2
    exit 1
    ;;
  /*) ;;
  */*)
    echo "bootstrap: MESH_OPAM_SWITCH must be a switch name or an absolute directory, not '$switch'." >&2
    exit 1
    ;;
esac
# opam names a local switch by its directory, resolved: an existing directory is compared in that
# form, a missing one is kept as written so that it can be created. A failed listing stops the
# bootstrap instead of passing for a missing switch.
case "$switch" in
  /*) if [ -d "$switch" ]; then switch="$(cd -- "$switch" && pwd -P)"; fi ;;
esac
switches="$(opam switch list --short --color=never)"
switch_exists=yes
printf '%s\n' "$switches" | grep -Fxq -- "$switch" || switch_exists=no
if [ "$mode" = --print-bin ]; then
  if [ "$switch_exists" = no ]; then
    # Named explicitly: OPAMROOT and MESH_OPAM_SWITCH may be set for this run only.
    echo "bootstrap: opam switch '$switch' does not exist; to create it, run: OPAMROOT=$(printf %q "$(opam var root)") MESH_OPAM_SWITCH=$(printf %q "$switch") bash scripts/bootstrap.sh --install-only" >&2
    exit 1
  fi
  opam var --switch="$switch" bin
  exit 0
fi

test_python="${PYTHON:-python3}"
if [ -z "$mode" ] && ! "$test_python" -c 'import pytest' >/dev/null 2>&1; then
  echo "bootstrap: the OCaml tests need pytest, which '$test_python' does not provide." >&2
  echo "bootstrap: to build and install without running them: bash scripts/bootstrap.sh --install-only" >&2
  echo "bootstrap: to run them: scripts/test-local.sh, which prepares a Python environment." >&2
  exit 1
fi

# Packages are read from the opam repository at the fixed commit of scripts/release-pins.sh
# (opam_repository), the one CI and the release builds use, never from the host's repositories,
# which may be older or newer. That repository is registered in the opam root under the name
# session-mesh and selected for this switch only: other switches keep their own selection.
# shellcheck source=release-pins.sh
source "$worktree/scripts/release-pins.sh"
pinned_repository=session-mesh
switch_created=no
# `opam repository list --all` prints a header line that starts with '#', then one line per
# repository: its name, its URL as registered (git+https://...#<commit>), the switches using it.
# opam wraps that table at COLUMNS when it is set, even into a pipe, which would put the URL on a
# line of its own; without COLUMNS it does not wrap a piped table, so COLUMNS is removed here.
repository_url() {
  env -u COLUMNS opam repository list --all --color=never | awk -v name="$1" '$1 == name { print $2 }'
}
# A command printed for the user to copy names the opam root explicitly (OPAMROOT may be set for
# this run only and not in the shell the command is copied into) and shell-quotes every argument.
opam_command() {
  local root
  root="$(opam var root)"
  printf 'opam %s %s --root=%q' "$1" "$2" "$root"
  shift 2
  [ "$#" -eq 0 ] || printf ' %q' "$@"
}
# When the pin has changed since an earlier run, the URL is moved and the command that restores the
# former one is printed: every switch that reads session-mesh follows it.
register_pinned_repository() {
  local previous
  previous="$(repository_url "$pinned_repository")"
  case "$previous" in
    "$opam_repository") ;;
    "") opam repository add --dont-select "$pinned_repository" "$opam_repository" ;;
    *)
      opam repository set-url "$pinned_repository" "$opam_repository"
      echo "bootstrap: the opam repository $pinned_repository now points at $opam_repository" >&2
      # opam lists a URL unredacted: a former URL with userinfo (user:password@) is not printed.
      if [[ "$previous" =~ ^[^:/]+://[^/@]*@ ]]; then
        echo "bootstrap: (its former URL carried credentials and is not printed; restore it from your own opam configuration if needed)." >&2
      else
        echo "bootstrap: (to undo: $(opam_command repository set-url "$pinned_repository" "$previous"))." >&2
      fi
      ;;
  esac
}
# The local switch of this checkout (the _opam that setup-ocaml creates in CI) serves this
# project only, so its repositories may be changed without asking. opam names it by the checkout
# directory; a switch named by $worktree/_opam would be another one, stored in $worktree/_opam/_opam.
is_checkout_switch() {
  local directory
  case "$switch" in
    /*) directory="$(cd -- "$switch" 2>/dev/null && pwd -P)" || return 1 ;;
    *) return 1 ;;
  esac
  [ "$directory" = "$worktree" ]
}
refuse_shared_switch() {
  local dedicated=session-mesh root
  # The retries name the opam root, as the undo commands do: OPAMROOT may be set for this run only.
  root="$(printf %q "$(opam var root)")"
  [ "$switch" != "$dedicated" ] || dedicated=session-mesh-pinned
  echo "bootstrap: the opam switch '$switch' reads the repositories '${1:-}', not only $opam_repository." >&2
  echo "bootstrap: other projects may use that switch, so its repositories are left as they are. Either:" >&2
  echo "bootstrap: - use a dedicated switch, created if missing: OPAMROOT=$root MESH_OPAM_SWITCH=$dedicated bash scripts/bootstrap.sh $mode" >&2
  echo "bootstrap: - or make '$switch' read only that commit: OPAMROOT=$root MESH_OPAM_SWITCH=$(printf '%q' "$switch") MESH_OPAM_SELECT_PINNED=1 bash scripts/bootstrap.sh $mode" >&2
  echo "bootstrap:   (the bootstrap then prints the command that restores its repositories)." >&2
  exit 1
}
# A switch that already reads only the pinned commit, under any name, is left as it is. A switch
# that reads only session-mesh was set up for this project (by an earlier bootstrap, or opted in):
# when the pin has changed, the URL of session-mesh follows it, without asking. Another switch is
# moved to the pinned commit only when this run created it, when it is the checkout's local switch,
# or with MESH_OPAM_SELECT_PINNED=1; the repositories it read are printed as the undo command.
select_pinned_repository() {
  local selected listed
  selected="$(opam repository list --switch="$switch" --short --color=never)"
  case "$selected" in
    "" | *$'\n'*) ;;
    "$pinned_repository")
      register_pinned_repository
      return 0
      ;;
    *) [ "$(repository_url "$selected")" != "$opam_repository" ] || return 0 ;;
  esac
  listed="$(printf '%s' "$selected" | tr '\n' ' ')"
  if [ "$switch_created" = no ] && [ "${MESH_OPAM_SELECT_PINNED:-}" != 1 ] && ! is_checkout_switch; then
    refuse_shared_switch "$listed"
  fi
  register_pinned_repository
  opam repository set-repos --switch="$switch" "$pinned_repository"
  echo "bootstrap: '$switch' now reads packages only from $opam_repository" >&2
  # Repository names are single words, so the list is split on purpose.
  # shellcheck disable=SC2086
  echo "bootstrap: (to undo: $(opam_command repository set-repos "--switch=$switch" $listed))." >&2
}
# A failed compiler installation can leave the switch registered without a compiler; a rerun would
# then find it and stop at the compiler check. Both failures name the command that removes it.
partial_switch() {
  echo "bootstrap: $1 If the bootstrap failed while creating '$switch', remove it and rerun: $(opam_command switch remove "$switch")" >&2
  exit 1
}
if [ "$switch_exists" = no ]; then
  register_pinned_repository
  case "$switch" in
    /*) mkdir -p -- "$switch" ;;
  esac
  # --no-install: in a directory that holds opam files (the checkout's ocaml/), opam would otherwise
  # pin and install those packages while creating the switch, before the pins below.
  opam switch create --no-switch --no-install --repos="$pinned_repository" "$switch" "${OCAML_COMPILER:-ocaml-base-compiler.5.3.0}" \
    || partial_switch "creating the opam switch '$switch' failed."
  switch_created=yes
fi

# ocamlc is run from the switch's bin directory: by name, opam exec could find another OCaml on the
# host's PATH when the switch has none.
if ! switch_bin="$(opam var --switch="$switch" bin)" \
  || ! compiler="$(opam exec --switch="$switch" -- "$switch_bin/ocamlc" -version)"; then
  partial_switch "no OCaml compiler runs in the opam switch '$switch'."
fi
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
select_pinned_repository

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
