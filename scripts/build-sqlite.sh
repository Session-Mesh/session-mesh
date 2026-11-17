#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Build the pinned SQLite amalgamation (scripts/bundle/sqlite.sha256) into a static library with
# FTS5 and a pkg-config file, for the release builds of mesh-history.
#   build-sqlite.sh <prefix>
# Writes <prefix>/lib/libsqlite3.a, <prefix>/include/sqlite3.h and <prefix>/lib/pkgconfig/sqlite3.pc.
# The OCaml sqlite3 binding asks pkg-config for its flags when it is installed, so with
# PKG_CONFIG_PATH=<prefix>/lib/pkgconfig it compiles against this header and records a link against
# this library: the executable then carries SQLite itself, at one version on every platform, and
# needs neither the system's libsqlite3 (not among the libraries macOS releases may link, and old
# on AlmaLinux 8) nor its version. scripts/bootstrap.sh does that when MESH_SQLITE_PREFIX is set.
# Loadable extensions are compiled out (no dlopen, no -ldl); the binding is told so too
# (SQLITE3_DISABLE_LOADABLE_EXTENSIONS, set by bootstrap.sh). Only a C compiler, curl and unzip
# are needed. The build is skipped when <prefix> already holds this version, built with the same
# flags and compiler.
# <prefix> must be a directory dedicated to this build: it is created if missing, and an existing
# one is accepted only when it is empty or carries the ownership marker this script writes
# (.mesh-sqlite-prefix). Any other non-empty directory (a home, ~/.local, /usr/local) is refused
# untouched. The script only ever replaces the files it installs. A prefix containing whitespace is
# refused (pkg-config flags built from it would be split), and so is an existing one that is not
# readable, writable and searchable (its content could not be judged).
# Concurrent builds into one prefix are not locked: run one at a time per prefix. A CC wrapper
# (ccache, distcc) is recorded in the stamp by its own name and --version, not the real compiler's.
# SQLite is in the public domain (docs/binary-bundles.md, third-party components).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: build-sqlite.sh <prefix>" >&2
  exit 2
fi
if [[ $1 =~ [[:space:]] ]]; then
  echo "build-sqlite: the prefix must not contain whitespace (pkg-config would split its flags): $1" >&2
  exit 2
fi
here="$(cd "$(dirname "$0")" && pwd -P)"
pins="$here/bundle/sqlite.sha256"
marker_name=.mesh-sqlite-prefix
mkdir -p "$1"
prefix="$(cd "$1" && pwd -P)"
if [[ $prefix =~ [[:space:]] ]]; then
  echo "build-sqlite: the prefix must not contain whitespace (pkg-config would split its flags): $prefix" >&2
  exit 2
fi
if ! { [ -r "$prefix" ] && [ -w "$prefix" ] && [ -x "$prefix" ]; }; then
  echo "build-sqlite: $prefix is not readable, writable and searchable; nothing is touched" >&2
  exit 1
fi
listing="$(ls -A "$prefix")"
if [ ! -f "$prefix/$marker_name" ] && [ -n "$listing" ]; then
  echo "build-sqlite: $prefix is not empty and was not created by this script; use a dedicated directory (nothing in it is touched)" >&2
  exit 1
fi
read -r expected url <"$pins"
[[ $expected =~ ^[0-9a-f]{64}$ && $url == https://* ]] || { echo "build-sqlite: bad pin in $pins" >&2; exit 1; }
archive="${url##*/}"
name="${archive%.zip}"
cc="${CC:-cc}"
cflags=(-O2 -fPIC -DSQLITE_ENABLE_FTS5 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_THREADSAFE=1)
# The stamp names everything that changes the object code: pin, flags, compiler and its version, and
# the macOS deployment target (clang reads it from the environment).
cc_version="$("$cc" --version 2>/dev/null | head -n 1 || true)"
stamp="$expected ${cflags[*]} $cc [$cc_version] target=${MACOSX_DEPLOYMENT_TARGET:-}"
if [ -f "$prefix/stamp" ] && [ "$(cat "$prefix/stamp")" = "$stamp" ] && [ -f "$prefix/lib/libsqlite3.a" ]; then
  echo "build-sqlite: $name already built in $prefix"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -r -f -- "$work"' EXIT
curl --proto '=https' --proto-redir '=https' -fsSL -o "$work/$archive" "$url"
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$work/$archive" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/$archive" | cut -d' ' -f1)"
fi
[ "$actual" = "$expected" ] || { echo "build-sqlite: $archive does not match its pinned SHA-256" >&2; exit 1; }
unzip -q "$work/$archive" -d "$work"
src="$work/$name"
[ -f "$src/sqlite3.c" ] || { echo "build-sqlite: $archive holds no $name/sqlite3.c" >&2; exit 1; }

version="$(sed -n 's/^#define SQLITE_VERSION  *"\(.*\)"$/\1/p' "$src/sqlite3.h")"
mkdir -p "$prefix/lib/pkgconfig" "$prefix/include"
: >"$prefix/$marker_name"
rm -f -- "$prefix/stamp" "$prefix/lib/libsqlite3.a" "$prefix/include/sqlite3.h" "$prefix/lib/pkgconfig/sqlite3.pc"
"$cc" "${cflags[@]}" -c "$src/sqlite3.c" -o "$work/sqlite3.o"
ar rcs "$prefix/lib/libsqlite3.a" "$work/sqlite3.o"
ranlib "$prefix/lib/libsqlite3.a"
cp "$src/sqlite3.h" "$prefix/include/sqlite3.h"
cat >"$prefix/lib/pkgconfig/sqlite3.pc" <<PC
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: SQLite
Description: SQLite $version amalgamation with FTS5 (pinned, static)
Version: $version
Libs: -L\${libdir} -lsqlite3 -lm -lpthread
Cflags: -I\${includedir}
PC
printf '%s' "$stamp" >"$prefix/stamp"
echo "build-sqlite: SQLite $version built in $prefix"
