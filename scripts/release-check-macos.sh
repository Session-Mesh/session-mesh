#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Checks of the macOS release build (.github/workflows/release.yml, macOS job).
#   release-check-macos.sh links <executable>...
#     every executable links /usr/lib/libSystem.B.dylib and nothing else: a Homebrew
#     or opam library would not exist on the machine that downloads the binary.
#   release-check-macos.sh linker-log <build-log>
#     the build output has no linker warning that an object was built for a newer
#     macOS version than the deployment target (such a binary may fail to load there).
#   release-check-macos.sh runtime-minos <deployment-target>
#     the OCaml runtime archive (libasmrun.a) of the current switch was built for at
#     most <deployment-target>: a cached switch is not rebuilt, so its objects are
#     only linked again, and the check above would not see an older build of them.
#   release-check-macos.sh bundle <bundle-archive> <deployment-target>
#     every Mach-O file of the extracted bundle (programs, libraries, Python extensions)
#     was built for at most <deployment-target>, and loads no library by an absolute path
#     outside /usr/lib and /System/Library: the bundle's own libraries are loaded through
#     @loader_path, @executable_path or @rpath.
# Needs otool (Xcode command line tools), file, and ocamlc (or ocamlfind) for runtime-minos.
set -euo pipefail

usage() {
  echo "usage: release-check-macos.sh links <executable>... | linker-log <file> | runtime-minos <version> | bundle <archive> <version>" >&2
  exit 2
}

check_links() {
  local program libraries status=0
  for program in "$@"; do
    otool -L "$program"
    # The first line names the file itself; the others are its libraries.
    libraries="$(otool -L "$program" | tail -n +2 | awk '{print $1}')"
    if [ "$libraries" != "/usr/lib/libSystem.B.dylib" ]; then
      echo "::error::$program must link /usr/lib/libSystem.B.dylib only, it links: $(echo "$libraries" | tr '\n' ' ')" >&2
      status=1
    fi
  done
  return "$status"
}

check_linker_log() {
  [ -f "$1" ] || { echo "release-check-macos: no build log at $1" >&2; return 2; }
  if grep -F 'built for newer macOS version' "$1" >&2; then
    echo "::error::an object was built for a newer macOS version than the deployment target" >&2
    return 1
  fi
  echo "linker: no object built for a newer macOS version"
}

# Succeeds when version $1 <= $2 (a missing component counts as 0).
version_le() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); k = (n > m ? n : m)
    for (i = 1; i <= k; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 }
    exit 0 }'
}

# The minimum macOS version of every object in an archive or file, one per line, read from
# LC_BUILD_VERSION (minos) or the older LC_VERSION_MIN_MACOSX (version).
minimum_versions() {
  otool -l "$1" | awk '
    $1 == "cmd" { wanted = ($2 == "LC_BUILD_VERSION" || $2 == "LC_VERSION_MIN_MACOSX"); next }
    wanted && ($1 == "minos" || $1 == "version") { print $2; wanted = 0 }'
}

check_runtime_minos() {
  local target="$1" stdlib archive versions version status=0
  stdlib="$(ocamlfind ocamlc -where 2>/dev/null || ocamlc -where)"
  archive="$stdlib/libasmrun.a"
  [ -f "$archive" ] || { echo "release-check-macos: no OCaml runtime at $archive" >&2; return 1; }
  versions="$(minimum_versions "$archive")"
  [ -n "$versions" ] || { echo "::error::no macOS version recorded in $archive" >&2; return 1; }
  for version in $(echo "$versions" | sort -u); do
    if ! version_le "$version" "$target"; then
      echo "::error::$archive holds objects built for macOS $version, newer than the deployment target $target" >&2
      status=1
    fi
  done
  [ "$status" -ne 0 ] || echo "runtime: $archive built for macOS $(echo "$versions" | sort -u | tr '\n' ' ')(target $target)"
  return "$status"
}

# The absolute libraries file $1 loads outside the system, one per line. otool prints a header line
# ending in ":" per file and, for a universal file, per architecture; a library's own install name
# (otool -D) is not a dependency.
foreign_libraries() {
  local own
  own="$(otool -D "$1")"
  otool -L "$1" | OWN="$own" awk '
    BEGIN { n = split(ENVIRON["OWN"], names, "\n"); for (i = 1; i <= n; i++) own[names[i]] = 1 }
    /:$/ { next }
    $1 in own { next }
    # The @rpath, @loader_path and @executable_path forms are resolved inside the bundle (as before). Any other path with a . or .. component,
    # or not absolute, is foreign whatever its prefix.
    $1 ~ /^@(rpath|loader_path|executable_path)\// { next }
    $1 ~ /\/\.\.?(\/|$)/ { print $1; next }
    $1 !~ /^\// { print $1; next }
    $1 !~ /^\/(usr\/lib|System\/Library)\// { print $1 }'
}

# Checks one Mach-O file of a bundle: its minimum macOS versions and what it loads.
check_bundle_file() {
  local file="$1" target="$2" version foreign status=0
  for version in $(minimum_versions "$file" | sort -u); do
    if ! version_le "$version" "$target"; then
      echo "::error::$file was built for macOS $version, newer than the deployment target $target" >&2
      status=1
    fi
  done
  foreign="$(foreign_libraries "$file")"
  if [ -n "$foreign" ]; then
    echo "::error::$file loads $(echo "$foreign" | tr '\n' ' ')from outside the bundle and the system" >&2
    status=1
  fi
  return "$status"
}

check_bundle() {
  local archive="$1" target="$2" work file count=0 status=0
  [ -f "$archive" ] || { echo "release-check-macos: no bundle archive at $archive" >&2; return 2; }
  work="$(mktemp -d)"
  tar -xzf "$archive" -C "$work"
  while IFS= read -r -d '' file; do
    file "$file" | grep -q 'Mach-O' || continue
    count=$((count + 1))
    check_bundle_file "$file" "$target" || status=1
  done < <(find "$work" -type f -print0)
  rm -r -f -- "$work"
  [ "$count" -gt 0 ] || { echo "::error::$archive holds no Mach-O file" >&2; return 1; }
  [ "$status" -ne 0 ] || echo "bundle: $count Mach-O files, each built for macOS $target or older, none loading a library from outside the bundle and the system"
  return "$status"
}

[ "$#" -ge 2 ] || usage
command="$1"
shift
case "$command" in
  links) check_links "$@" ;;
  linker-log) [ "$#" -eq 1 ] || usage; check_linker_log "$1" ;;
  runtime-minos) [ "$#" -eq 1 ] || usage; check_runtime_minos "$1" ;;
  bundle) [ "$#" -eq 2 ] || usage; check_bundle "$1" "$2" ;;
  *) usage ;;
esac
