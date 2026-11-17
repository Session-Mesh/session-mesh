#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# The shared libraries of the copied native tools. Linux: every library outside glibc travels in
# lib/, with its licence, and the tools find it there. macOS: only system libraries may be loaded,
# anything else stops the build. Run on the target OS: this is deliberately not a cross-compilation
# or notarization step.
set -euo pipefail
root=$(cd "${1:?usage: bundle-native-libs.sh BUNDLE_ROOT}" && pwd -P)
# Where the build system's packages keep their documentation (a test points it elsewhere).
share=${MESH_BUNDLE_SHARE_ROOT:-/usr/share}

# The licence of Debian or Ubuntu package $2 into directory $1: its copyright file, and the
# texts of /usr/share/common-licenses that it names instead of including them (as the GPL and
# LGPL packages do); PACKAGE names the package and its version, SOURCE where its corresponding
# source is offered (the distribution's source package of that version).
debian_licence() {
  local target=$1 package=$2 reference name source
  mkdir -p "$target"
  cp "$share/doc/$package/copyright" "$target/copyright"
  while IFS= read -r reference; do
    name=${reference##*/}
    [ -f "$share/common-licenses/$name" ] \
      || { echo "bundle: $package's copyright names $reference, which the build system does not have" >&2; exit 1; }
    mkdir -p "$target/common-licenses"
    cp "$share/common-licenses/$name" "$target/common-licenses/$name"
  done < <(grep -oE '/usr/share/common-licenses/[A-Za-z0-9._+-]+' "$target/copyright" | sed 's/[.]$//' | sort -u)
  dpkg-query -W -f='${Package} ${Version}\n' "$package" > "$target/PACKAGE"
  source=$(dpkg-query -W -f='${source:Package} ${source:Version}' "$package")
  printf 'The corresponding source of %s is the source package %s, version %s, of the distribution the bundle was built on (apt-get source %s=%s).\n' \
    "$package" "${source% *}" "${source#* }" "${source% *}" "${source#* }" > "$target/SOURCE"
}

# The licence of Arch package $2 into directory $1: its /usr/share/licenses/<package>/, and the texts
# of /usr/share/licenses/spdx/ for the licences its metadata names (libgcc ships only the GCC
# exception there, and names GPL-3.0-or-later WITH GCC-exception-3.1).
arch_licence() {
  local target=$1 package=$2 name
  mkdir -p "$target"
  cp -RL "$share/licenses/$package/." "$target/"
  printf '%s\n' "$package" > "$target/PACKAGE"
  while IFS= read -r name; do
    [ -f "$share/licenses/spdx/$name.txt" ] || continue
    mkdir -p "$target/spdx"
    cp "$share/licenses/spdx/$name.txt" "$target/spdx/$name.txt"
  done < <(LC_ALL=C pacman -Qi "$package" | sed -n 's/^Licenses *: //p' | tr -s ' ()' '\n' | grep -v -x -E 'AND|OR|WITH|')
}

# The licence of RPM package $2 into directory $1 (AlmaLinux, the manylinux_2_28 image of the
# release build): the licence files the package declares (rpm -qL), else those of another
# installed package built from the same source package (libstdc++ declares none; libgcc, from the
# same gcc source, ships the GPL and the runtime library exception).
rpm_licence() {
  local target=$1 package=$2 source files sibling file
  source=$(rpm -q --qf '%{SOURCERPM}' "$package")
  files=$(rpm -qL "$package" | grep '^/' || true)
  if [ -z "$files" ]; then
    for sibling in $(rpm -qa --qf '%{NAME} %{SOURCERPM}\n' | awk -v source="$source" '$2 == source {print $1}' | LC_ALL=C sort); do
      files=$(rpm -qL "$sibling" | grep '^/' || true)
      [ -z "$files" ] || break
    done
  fi
  [ -n "$files" ] || { echo "bundle: no licence file in the RPM package $package nor in any installed package of its source $source" >&2; exit 1; }
  mkdir -p "$target"
  while IFS= read -r file; do cp "$file" "$target/"; done <<< "$files"
  rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\n' "$package" > "$target/PACKAGE"
  printf 'The corresponding source of %s is the source package %s of the distribution the bundle was built on (dnf download --source %s).\n' \
    "$package" "$source" "$package" > "$target/SOURCE"
}

# Linux: the licence texts of the package that installed system library $1, copied into
# licenses/lib/<library>/ with the package's name: Debian and Ubuntu ship them as
# /usr/share/doc/<package>/copyright, Arch under /usr/share/licenses/<package>/. A library copied
# into the bundle travels with its licence: the build stops when none is found. RPM systems
# (rpm -qf) are asked last, through rpm_licence.
library_licence() {
  local library=$1 target candidate package
  target="$root/licenses/lib/$(basename "$library")"
  for candidate in "$library" "$(readlink -f -- "$library")"; do
    if command -v dpkg-query >/dev/null \
        && package=$(dpkg-query -S "$candidate" 2>/dev/null | sed -n '1s/[:,].*//p') && [ -n "$package" ] \
        && [ -f "$share/doc/$package/copyright" ]; then
      debian_licence "$target" "$package"
      return 0
    fi
    if command -v pacman >/dev/null && package=$(pacman -Qqo "$candidate" 2>/dev/null) && [ -n "$package" ] \
        && [ -d "$share/licenses/$package" ] && [ -n "$(ls -A "$share/licenses/$package")" ]; then
      arch_licence "$target" "$package"
      return 0
    fi
    if command -v rpm >/dev/null && package=$(rpm -qf --qf '%{NAME}\n' "$candidate" 2>/dev/null | head -n 1) && [ -n "$package" ]; then
      rpm_licence "$target" "$package"
      return 0
    fi
  done
  echo "bundle: no licence found for the copied library $library (no package of the build system with /usr/share/doc/<package>/copyright or /usr/share/licenses/<package>/, nor an RPM package, owns it)" >&2
  exit 1
}

# macOS: every Mach-O file of the bundle's programs (bin/, libexec/ and the bundled Node) may load
# system libraries only (/usr/lib, /System/Library): the native programs link libSystem alone, and
# Node's official build only system frameworks. Nothing is copied or rewritten; any other library
# stops the build, named with the file it resolves to, rather than being shipped.
macos_check() {
  local file dependency status=0
  while IFS= read -r file; do
    file "$file" | grep -q 'Mach-O' || continue
    while IFS= read -r dependency; do
      case "$dependency" in
        # A system prefix proves nothing when the path climbs out of it (/usr/lib/../../x).
        */../*|*/./*|*/..|*/.) echo "bundle: $file loads $dependency, a path with a . or .. component: the macOS bundle ships no library of its own" >&2 ;;
        /usr/lib/*|/System/Library/*) continue ;;
        /*) echo "bundle: $file loads $dependency ($(realpath "$dependency" 2>/dev/null || echo 'not found')), which is not a library of the system: the macOS bundle ships no library of its own (link it statically, or not at all)" >&2 ;;
        *) echo "bundle: $file loads $dependency, a relative or @-path library: the macOS bundle ships no library of its own" >&2 ;;
      esac
      status=1
    done < <(otool -L "$file" | tail -n +2 | sed 's/^[[:space:]]*//; s/ (compatibility version.*$//')
  done < <(find "$root/bin" "$root/libexec" "$root/runtime/node/bin" -type f -perm -111 -print)
  return "$status"
}
case $(uname -s) in
  Darwin)
    macos_check || exit 1
    ;;
  Linux)
    mkdir -p "$root/lib"
    # glibc and its loader are supplied by the supported target distribution.
    # Any other native dependency must travel beside the executable.
    while IFS= read -r file; do
      file "$file" | grep -q ELF || continue
      ldd "$file" > "$root/lib/.ldd"
      if grep -q 'not found' "$root/lib/.ldd"; then cat "$root/lib/.ldd" >&2; exit 1; fi
      while read -r name arrow dependency rest; do
        [ "$arrow" = '=>' ] || continue
        case "$name" in libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libresolv.so.*|libutil.so.*|*/ld-linux-*|ld-linux-*|*/ld64.so.*|ld64.so.*) continue ;; esac
        case "$dependency" in /*) ;; *) continue ;; esac
        destination="$root/lib/$(basename "$dependency")"
        if [ -e "$destination" ]; then cmp -s "$dependency" "$destination"
        else cp -L "$dependency" "$destination"; library_licence "$dependency"; fi
      done < "$root/lib/.ldd"
      if find "$root/lib" -type f ! -name .ldd -print | grep -q .; then
        command -v patchelf >/dev/null
        case "$file" in
          "$root/runtime/node/bin/"*) rpath="\$ORIGIN/../../../lib" ;;
          *) rpath="\$ORIGIN/../lib" ;;
        esac
        # shellcheck disable=SC2016 # Expanded by the ELF loader, not this shell.
        patchelf --set-rpath "$rpath" "$file"
      fi
    done < <(find "$root/bin" "$root/libexec" "$root/runtime/node/bin" -type f -perm -111 -print)
    while IFS= read -r library; do
      # shellcheck disable=SC2016 # Expanded by the ELF loader, not this shell.
      patchelf --set-rpath '$ORIGIN' "$library"
    done < <(find "$root/lib" -type f ! -name .ldd -print)
    rm -f "$root/lib/.ldd"
    ;;
  *) echo 'bundle: unsupported build operating system' >&2; exit 1 ;;
esac
