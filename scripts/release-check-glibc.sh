#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Checks that no ELF file of a Linux bundle needs a glibc newer than the floor of the Linux bundles
# (BUNDLE_GLIBC_FLOOR of install.sh, read by scripts/release-floor.sh).
#   release-check-glibc.sh <bundle-archive>
# For every ELF file of the extracted archive: the newest GLIBC_<version> among the symbol versions
# its dynamic symbols require (objdump -T); a static executable requires none. Prints each file's
# newest version, then the bundle's, and fails when one is newer than the floor or when objdump
# cannot read a file.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: release-check-glibc.sh <bundle-archive>" >&2
  exit 2
fi
floor="$(bash "$(dirname "$0")/release-floor.sh" glibc)"
command -v objdump >/dev/null || { echo "release-check-glibc: objdump (binutils) is needed" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -r -f -- "$work"' EXIT
tar -xzf "$1" -C "$work"

is_elf() { [ "$(head -c 4 -- "$1" | od -An -c | tr -d ' \n')" = '177ELF' ]; }

# The newest of the versions $1 and $2 ("none" is older than any).
newest() {
  if [ "$1" = none ]; then echo "$2"; elif [ "$2" = none ]; then echo "$1"; else printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1; fi
}

# The newest GLIBC_ version file $1 requires, "none" for a static file; fails if objdump cannot read it.
newest_glibc() {
  local symbols
  if ! symbols="$(LC_ALL=C objdump -T -- "$1" 2>&1)"; then
    case "$symbols" in *"not a dynamic object"*) echo none; return 0 ;; esac
    printf '%s\n' "$symbols" >&2
    return 1
  fi
  symbols="$(printf '%s\n' "$symbols" | grep -oE '\bGLIBC_[0-9]+(\.[0-9]+)+' | sed 's/^GLIBC_//' | sort -V | tail -n 1)"
  echo "${symbols:-none}"
}

bundle_newest=none count=0 failed=0
while IFS= read -r -d '' file; do
  is_elf "$file" || continue
  name="${file#"$work"/}"
  count=$((count + 1))
  if ! version="$(newest_glibc "$file")"; then
    echo "release-check-glibc: objdump cannot read $name" >&2
    failed=1
    continue
  fi
  printf '%-8s %s\n' "$version" "$name"
  if [ "$version" != none ] && [ "$(newest "$floor" "$version")" != "$floor" ]; then
    echo "release-check-glibc: $name requires GLIBC_$version, newer than the floor $floor" >&2
    failed=1
  fi
  bundle_newest="$(newest "$bundle_newest" "$version")"
done < <(find "$work" -type f -print0 | LC_ALL=C sort -z)
[ "$count" -gt 0 ] || { echo "release-check-glibc: no ELF file in $1" >&2; exit 1; }
echo "release-check-glibc: $count ELF files; the newest glibc symbol version required is GLIBC_$bundle_newest; the floor is $floor"
[ "$failed" -eq 0 ]
