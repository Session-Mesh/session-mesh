#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# The files of a release (.github/workflows/release.yml).
#   release-assets.sh name <binary-directory> <os>-<arch> <output-directory>
#     Copy the built programs under their release names: <program>-<os>-<arch>, where <os>-<arch>
#     is one of TARGETS (linux-x86_64, linux-aarch64, macos-arm64).
#   release-assets.sh collect <os>-<arch> <artifact-directory> <directory>
#     Copy the ten programs of one target from the directory its build job's artifact was
#     downloaded into, refusing that directory unless it holds exactly those ten regular files:
#     an artifact can then provide the programs of its own target only.
#   release-assets.sh collect-bundle <platform> <artifact-directory> <directory>
#     The same for the bundle archive mesh-<platform>.tar.gz of one of BUNDLE_PLATFORMS
#     (linux-x86_64, linux-arm64, macos-arm64): exactly that one regular file.
#   release-assets.sh bundle <tag> <commit> <directory>
#     Run at the root of the repository. <directory> holds the 30 named programs and the bundle
#     archives, and nothing else: the 3 bundles, or the 2 Linux bundles when the macOS bundle was
#     not qualified (the one bundle a release may lack; its job is the only one allowed to fail).
#     Adds the code archive session-mesh-<tag>.tar.gz (git archive of <commit>), install.sh of
#     <commit> with the tag and the checksums of every other asset stamped into it
#     (scripts/release-stamp-installer.sh), and SHA256SUMS over every file, the stamped installer
#     included.
set -euo pipefail

PROGRAMS="mesh-ptyhost mesh-board-mcp mesh-read mesh-platform mesh-history mesh-logout-all mesh-profile work-read work-mcp work-write"
TARGETS="linux-x86_64 linux-aarch64 macos-arm64"
BUNDLE_PLATFORMS="linux-x86_64 linux-arm64 macos-arm64"
# The bundle a release may be published without.
OPTIONAL_BUNDLE=macos-arm64
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

usage() {
  echo "usage: release-assets.sh name <binary-directory> <os>-<arch> <output-directory>" >&2
  echo "       release-assets.sh collect <os>-<arch> <artifact-directory> <directory>" >&2
  echo "       release-assets.sh collect-bundle <platform> <artifact-directory> <directory>" >&2
  echo "       release-assets.sh bundle <tag> <commit> <directory>" >&2
  exit 2
}

# $1 is one of the words of $2 (the $3), or the script stops.
check_one_of() {
  case " $2 " in
    *" $1 "*) ;;
    *) echo "release-assets: '$1' is not one of the $3 ($2)" >&2; exit 2 ;;
  esac
}

name_programs() {
  [ "$#" -eq 3 ] && [ -d "$1" ] || usage
  check_one_of "$2" "$TARGETS" targets
  mkdir -p "$3"
  local program
  for program in $PROGRAMS; do
    [ -x "$1/$program" ] || { echo "release-assets: $1/$program is missing" >&2; exit 1; }
    install -m 0755 "$1/$program" "$3/$program-$2"
  done
  ls -l "$3"
}

# The ten asset names of one target, sorted.
target_programs() {
  local program
  for program in $PROGRAMS; do echo "$program-$1"; done | LC_ALL=C sort
}

archive_of() { printf 'mesh-%s.tar.gz\n' "$1"; }

# Copies into $3, with mode $4, the files $5 (sorted, one per line) of the artifact directory $2 of
# $1, refusing the artifact unless it holds exactly those regular files, and a file already in $3.
take_exactly() {
  local what="$1" artifact="$2" directory="$3" mode="$4" expected="$5" present file
  present="$(cd "$artifact" && find . -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)"
  if [ "$present" != "$expected" ] || [ "$(find "$artifact" -mindepth 1 | wc -l)" -ne "$(printf '%s\n' "$expected" | wc -l)" ]; then
    echo "release-assets: the $what artifact must hold exactly $(printf '%s\n' "$expected" | tr '\n' ' '); it holds:" >&2
    (cd "$artifact" && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort) >&2
    exit 1
  fi
  mkdir -p "$directory"
  for file in $present; do
    [ ! -e "$directory/$file" ] || { echo "release-assets: $directory/$file already exists" >&2; exit 1; }
    install -m "$mode" "$artifact/$file" "$directory/$file"
  done
}

collect() {
  [ "$#" -eq 3 ] && [ -d "$2" ] || usage
  check_one_of "$1" "$TARGETS" targets
  take_exactly "$1" "$2" "$3" 0755 "$(target_programs "$1")"
}

collect_bundle() {
  [ "$#" -eq 3 ] && [ -d "$2" ] || usage
  check_one_of "$1" "$BUNDLE_PLATFORMS" "bundle platforms"
  take_exactly "$1 bundle" "$2" "$3" 0644 "$(archive_of "$1")"
}

# The 30 program asset names and the bundle archives, sorted: all 3 bundles, or (with $1 = without)
# all but the optional one.
expected_assets() {
  local program target platform
  {
    for program in $PROGRAMS; do
      for target in $TARGETS; do echo "$program-$target"; done
    done
    for platform in $BUNDLE_PLATFORMS; do
      [ "${1:-}" = without ] && [ "$platform" = "$OPTIONAL_BUNDLE" ] && continue
      archive_of "$platform"
    done
  } | LC_ALL=C sort
}

# Refuses a directory that holds anything but exactly the programs and the bundles, in one of the
# two allowed forms: with every bundle, or without the optional one.
check_assets() {
  local present
  present="$(cd "$1" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  if [ "$present" = "$(expected_assets)" ]; then return 0; fi
  if [ "$present" = "$(expected_assets without)" ]; then
    echo "release-assets: no $(archive_of "$OPTIONAL_BUNDLE"): this release is published without it"
    return 0
  fi
  echo "release-assets: $1 must hold exactly the 30 programs and the 3 bundles ($(expected_assets | tr '\n' ' ')), or the same without $(archive_of "$OPTIONAL_BUNDLE"); it holds:" >&2
  printf '%s\n' "$present" >&2
  exit 1
}

bundle() {
  [ "$#" -eq 3 ] && [ -d "$3" ] || usage
  local tag="$1" commit="$2" directory="$3" archive="session-mesh-$1.tar.gz" assets
  [[ "$tag" =~ $TAG_PATTERN ]] || { echo "release-assets: not a release tag: $tag" >&2; exit 1; }
  check_assets "$directory"
  mapfile -t assets < <(cd "$directory" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  git archive --format=tar.gz --prefix="session-mesh-$tag/" -o "$directory/$archive" "$commit"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  git show "$commit:install.sh" >"$work/install.sh"
  (cd "$directory" && sha256sum -- "$archive" "${assets[@]}") >"$work/sums"
  bash "$(dirname "$0")/release-stamp-installer.sh" "$work/install.sh" "$tag" "$work/sums" "$directory/install.sh"
  (cd "$directory" && sha256sum -- install.sh "$archive" "${assets[@]}") >"$directory/SHA256SUMS"
  cat "$directory/SHA256SUMS"
}

case "${1:-}" in
  name) shift; name_programs "$@" ;;
  collect) shift; collect "$@" ;;
  collect-bundle) shift; collect_bundle "$@" ;;
  bundle) shift; bundle "$@" ;;
  *) usage ;;
esac
