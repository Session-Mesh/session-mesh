#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Build the Linux bundle of this machine's architecture inside the manylinux_2_28 image (AlmaLinux 8,
# glibc 2.28) that .github/workflows/release.yml pins by digest: what is compiled or copied into the
# bundle then needs no glibc newer than the image's, which scripts/release-check-glibc.sh checks on
# the archive afterwards.
#   release-build-bundle-linux.sh <source-tree> <output-dir> [<roster-dir>]
# Run as root in a disposable container with <source-tree> (a git checkout: the bundle takes its
# tracked files and its revision) and <roster-dir> readable and <output-dir> writable. The tree is
# copied first, so the mounts can be read-only and no _build directory is left in them. Writes
# <output-dir>/mesh-linux-<arch>.tar.gz.
# Environment:
#   RELEASE_OPAM_ROOT  opam root (default /opam); mount a cache there to skip the compiler and
#                      dependency build on later runs
#   PYTHON_VERSION     the bundled CPython (default 3.12.9)
#   OCAML_COMPILER     the switch's compiler (default ocaml-base-compiler.5.3.0)
# Pinned: the image (by digest, in the workflow), opam's and uv's static executables (SHA-256 in
# scripts/bundle/linux-builder.sha256), the opam repository commit (scripts/release-pins.sh), the
# Node archive and the Python dependencies (scripts/build-bundle.sh). Not pinned: the AlmaLinux
# packages installed below (zstd, rsync, unzip and the OCaml dependencies' gmp-devel and libev-devel), from the package index of the day, as the Alpine packages
# of scripts/release-build-static.sh. The demo compiler's own test needs bubblewrap, which a
# container cannot run: the bundle is built with --skip-compiler-test, and the caller runs that test
# on the extracted bundle.
# shellcheck disable=SC1091,SC2154 # the pins file is sourced by a computed path and sets opam_repository
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: release-build-bundle-linux.sh <source-tree> <output-dir> [<roster-dir>]" >&2
  exit 2
fi
source_tree="$(cd "$1" && pwd -P)"
output_dir="$2"
roster_dir="${3:-}"
pins="$source_tree/scripts/bundle/linux-builder.sha256"
switch=bundle
# shellcheck source=release-pins.sh
source "$source_tree/scripts/release-pins.sh"

case "$(uname -m)" in
  x86_64) opam_name=opam-2.3.0-x86_64-linux uv_name=uv-x86_64-unknown-linux-musl ;;
  aarch64) opam_name=opam-2.3.0-arm64-linux uv_name=uv-aarch64-unknown-linux-musl ;;
  *) echo "release-build-bundle-linux: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# Downloads the file of scripts/bundle/linux-builder.sha256 whose URL ends with /$1 into $2, and
# checks it against its pinned SHA-256.
fetch_pinned() {
  local line url expected
  line="$(awk -v name="/$1" 'substr($2, length($2) - length(name) + 1) == name' "$pins")"
  expected="${line%%  *}" url="${line#*  }"
  [[ $expected =~ ^[0-9a-f]{64}$ && $url == https://* ]] || { echo "release-build-bundle-linux: no pin for $1 in $pins" >&2; exit 1; }
  curl --proto '=https' -fsSL -o "$2" "$url"
  [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$expected" ] || { echo "release-build-bundle-linux: $1 does not match its pinned SHA-256" >&2; exit 1; }
}

dnf install -y -q zstd rsync unzip gmp-devel libev-devel >/dev/null
tools="$(mktemp -d)"
fetch_pinned "$opam_name" "$tools/opam"
fetch_pinned "$uv_name.tar.gz" "$tools/uv.tar.gz"
tar -xzf "$tools/uv.tar.gz" -C "$tools" --strip-components=1 "$uv_name/uv"
chmod 0755 "$tools/opam" "$tools/uv"
export PATH="$tools:$PATH"

export OPAMROOT="${RELEASE_OPAM_ROOT:-/opam}" OPAMYES=1 OPAMCONFIRMLEVEL=unsafe-yes
# A root restored from a cache belongs to the uid that saved it (the runner user), not to root:
# git refuses the sources opam checked out in it ("dubious ownership", exit 128). The container
# runs as root and is the only user of the root, so it takes ownership; the caller gives it back.
if [ -d "$OPAMROOT" ]; then chown -R 0:0 "$OPAMROOT"; fi
# The container is the sandbox: opam's own (bubblewrap) is disabled.
if [ ! -f "$OPAMROOT/config" ]; then
  opam init --bare --disable-sandboxing --no-setup default "$opam_repository"
fi
# On every run: a root restored from an older cache may still name an older repository commit.
opam repository set-url default "$opam_repository"
opam update default
if ! opam switch list --short | grep -Fxq "$switch"; then
  opam switch create "$switch" "${OCAML_COMPILER:-ocaml-base-compiler.5.3.0}"
fi
export MESH_OPAM_SWITCH="$switch"
# mesh-history carries the pinned SQLite (scripts/build-sqlite.sh) instead of AlmaLinux 8's 3.26,
# built inside the opam root so that a cached root keeps the path its sqlite3 binding recorded.
export MESH_SQLITE_PREFIX="$OPAMROOT/mesh-sqlite"

# A copy owned by root (git refuses a repository owned by another user), with its .git: the bundle
# takes the tracked files and the revision from it.
work="$(mktemp -d)"
rsync -a --no-owner --no-group --exclude _build --exclude _opam --exclude node_modules "$source_tree/" "$work/"
cd "$work"
bash scripts/bootstrap.sh --install-only
roster_args=()
[ -z "$roster_dir" ] || roster_args=(--roster-dir "$roster_dir")
bash scripts/build-bundle.sh --output "$output_dir" --native-bin "$(opam var --switch="$switch" bin)" \
  --python-version "${PYTHON_VERSION:-3.12.9}" --skip-compiler-test ${roster_args[@]+"${roster_args[@]}"}
