#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# The oldest systems the prebuilt files of a release run on, read from install.sh, which defines
# them once, for the installer (what it installs on a machine) and for the release build (what it
# checks the files against).
#   release-floor.sh glibc            the glibc of the Linux bundles (BUNDLE_GLIBC_FLOOR)
#   release-floor.sh macos-bundle     the macOS of the macOS bundle (BUNDLE_MACOS_FLOOR)
#   release-floor.sh macos-programs   the macOS of the macOS native programs (PROGRAMS_MACOS_FLOOR)
set -euo pipefail

case "${1:-}:$#" in
  glibc:1) name=BUNDLE_GLIBC_FLOOR ;;
  macos-bundle:1) name=BUNDLE_MACOS_FLOOR ;;
  macos-programs:1) name=PROGRAMS_MACOS_FLOOR ;;
  *) echo "usage: release-floor.sh glibc|macos-bundle|macos-programs" >&2; exit 2 ;;
esac
installer="$(dirname "$0")/../install.sh"
values="$(sed -n "s/^$name=\([0-9][0-9]*\.[0-9][0-9]*\)\$/\1/p" "$installer")"
if [ -z "$values" ] || [ "$(printf '%s\n' "$values" | wc -l)" -ne 1 ]; then
  echo "release-floor: install.sh must define $name=<major>.<minor> exactly once" >&2
  exit 1
fi
printf '%s\n' "$values"
