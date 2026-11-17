#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Build the public native programs as static musl executables, inside an Alpine
# container (CI release workflow, or locally: see docs/operations.md).
#   release-build-static.sh <source-tree> <output-dir>
# Run as root in a disposable Alpine container with <source-tree> readable and
# <output-dir> writable. The tree is copied first, so the mount can be read-only
# and no _build directory is left in it. The OCaml switch is created here, with
# ocaml-option-static, so that linking is static without changing the default
# development build (an ordinary switch, dynamic against the system libc).
# Environment:
#   RELEASE_OPAM_ROOT  opam root (default /opam); mount a cache there to skip
#                      the compiler and dependency build on later runs
# Dependencies are installed by scripts/bootstrap.sh --deps-only, so the pin
# and the compiler version stay defined in one place.
# Not pinned: the Alpine packages (build-base, opam, ...) come from the package
# index of the day, at whatever version the pinned image's release branch then
# holds. The image (by digest), the opam repository commit and the OCaml
# dependencies are pinned; two builds of one commit may still differ by these
# packages (the C toolchain and musl-dev, the static libc linked in, among them).
# shellcheck disable=SC1091,SC2154 # the pins file is sourced by a computed path and sets opam_repository
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: release-build-static.sh <source-tree> <output-dir>" >&2
  exit 2
fi
source_tree="$(cd "$1" && pwd -P)"
output_dir="$2"
programs="mesh-ptyhost mesh-board-mcp mesh-read mesh-platform mesh-history"
compiler="ocaml-variants.5.3.0+options"
# The fixed opam repository commit (opam_repository), shared with the macOS release job.
# shellcheck source=release-pins.sh
source "$source_tree/scripts/release-pins.sh"

# The package index stays (no --no-cache): opam asks apk which system packages exist.
apk update >/dev/null
apk add build-base bash git curl opam m4 linux-headers pkgconf \
  patch unzip bzip2 xz rsync coreutils findutils binutils file musl-dev gmp-dev >/dev/null

export OPAMROOT="${RELEASE_OPAM_ROOT:-/opam}" OPAMYES=1 OPAMCONFIRMLEVEL=unsafe-yes
# A root restored from a cache belongs to the uid that saved it (the runner user), not to root:
# git refuses the sources opam checked out in it ("dubious ownership", exit 128). The container
# runs as root and is the only user of the root, so it takes ownership; the caller gives it back.
if [ -d "$OPAMROOT" ]; then chown -R 0:0 "$OPAMROOT"; fi
# The container is the sandbox: opam's own (bubblewrap) is disabled.
if [ ! -f "$OPAMROOT/config" ]; then
  opam init --bare --disable-sandboxing --no-setup default "$opam_repository"
fi
# On every run, as the macOS job does: a root restored from an older cache may
# still name an older repository commit.
opam repository set-url default "$opam_repository"
opam update default
if [ ! -d "$OPAMROOT/static" ]; then
  opam switch create static "$compiler" ocaml-option-static
fi
export MESH_OPAM_SWITCH=static
# mesh-history carries the pinned SQLite (scripts/build-sqlite.sh), built inside the opam root so
# that a cached root keeps the path its sqlite3 binding recorded. opam's depext still installs
# Alpine's sqlite-dev for the sqlite3 package, but it is not linked: the binding is built against
# this prefix through pkg-config. The prefix is dedicated to the script (build-sqlite.sh refuses
# any other non-empty directory).
export MESH_SQLITE_PREFIX="$OPAMROOT/mesh-sqlite"

work="$(mktemp -d)"
trap 'rm -r -f -- "$work"' EXIT
rsync -a --exclude _build --exclude .git "$source_tree/" "$work/"
cd "$work"
bash scripts/bootstrap.sh --deps-only
# Static linking is asked of the copy only (the repository's dune files stay as
# they are): ocaml-option-static alone leaves the executables dynamic against
# musl, and -static needs -no-pie, which Alpine's compiler would otherwise add.
cat >>ocaml/dune <<'DUNE'

(env
 (_
  (link_flags
   (-ccopt -static -ccopt -no-pie))))
DUNE
(cd ocaml && opam exec --switch=static -- dune build -p session_mesh @install)

mkdir -p "$output_dir"
for program in $programs; do
  install -m 0755 "ocaml/_build/install/default/bin/$program" "$output_dir/$program"
  strip "$output_dir/$program"
done
