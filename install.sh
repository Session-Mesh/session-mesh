#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# session-mesh: install the user services on loopback, optionally publish them on the tailnet.
#
# Three kinds of install, decided by the stamp below and by where this file is:
# - Release install: the install.sh of a release, stamped with its tag and the SHA-256 of every
#   other asset of that release. It downloads this platform's bundle mesh-<os>-<arch>.tar.gz of
#   that tag, checks it against the stamp, extracts it into ~/.local/share/session-mesh/releases/<tag>/
#   and points ~/.local/share/session-mesh/current at it. The services run from current/, with the
#   bundle's own Python, Node and native programs: nothing else is needed on this machine. When the
#   release has no bundle for this platform, or this machine is older than the bundle needs
#   (BUNDLE_*_FLOOR below), it installs the native programs <program>-<os>-<arch> and the code
#   archive session-mesh-<tag>.tar.gz instead, checked the same way, into releases/<tag>/{bin,app};
#   the web server then runs this machine's Python (MESH_PYTHON, else python3 on PATH).
#     bash install.sh                   install this release (or move to it from another one)
#     install.sh --upgrade [--to TAG]   move to the latest published release (or TAG): its
#                                       install.sh is checked against its SHA256SUMS, then it runs
#   With gh on PATH and logged in, the build attestation of every downloaded file is checked as
#   well (made by the release workflow from that tag); MESH_REQUIRE_ATTESTATION=1 refuses to install
#   without that check.
#     install.sh --rollback             back to the previous release
#     --restart-pty                     also restart the PTY host (ends every mesh session)
#     --assets-dir /absolute/dir        take the release assets from that directory, not GitHub
# - Bundle install: app/install.sh of an extracted bundle archive (what `./mesh install` runs).
#   The services run from that directory, with the bundle's Python and programs; it must stay where
#   it is while they run.
# - Source install: install.sh of a git checkout (empty stamp). The services run from the
#   checkout; the native PTY host is --ptyhost /absolute/path, else mesh-ptyhost on PATH, else the
#   opam switch (scripts/bootstrap.sh builds it). --from-source also moves an account installed
#   from a release to this checkout.
# An account whose services run another extracted bundle (an earlier `./mesh install`, or a bundle
# unpacked by hand under ~/.local/libexec/session-mesh) is left as it is: a release, bundle or
# source install refuses to replace its services unless --switch-from-bundle is given, and never
# deletes that bundle.
# All:
#   --tailscale    also publish on the tailnet (asks before any sudo)
#   --uninstall    stop the web service and remove only its own tailnet publication
#   --at-boot      macOS: boot-time launchd daemons instead of agents (asks before sudo)
# MESH_PYTHON=/absolute/python selects the interpreter of a source install or of a release installed
# from its native programs (for example a venv); default: python3 on PATH. Installs from a bundle
# always run the bundle's own Python.
# MESH_PORT selects the loopback port; default: the port of the installed web unit, otherwise 7690.
# Linux: needs a systemd user session of an ordinary account: never run it with sudo or as root.
# macOS: launchd agents (scripts/install-macos.sh). Runtime directory there: MESH_RUNTIME_DIR,
# else XDG_RUNTIME_DIR, else ~/Library/Application Support/session-mesh/run.
# MESH_OPAM_SWITCH: the opam switch of a source install's native programs (default: the current one).
# docs/operations.md describes upgrades, rollbacks, source installs and moving between them.
# Written for the bash 3.2 of macOS up to the platform dispatch.

# @release-stamp-begin
MESH_RELEASE_TAG=''
MESH_RELEASE_SUMS=''
# @release-stamp-end

set -euo pipefail

step() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
refuse() { echo "installer: $*" >&2; exit 1; }

INSTALLER=${BASH_SOURCE[0]}
SYSTEM=Linux
if command -v uname >/dev/null; then SYSTEM=$(uname -s); fi
MESH_REPO_URL=https://github.com/Session-Mesh/session-mesh
MESH_API_URL=https://api.github.com/repos/Session-Mesh/session-mesh
RELEASE_TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
RELEASE_SUM_PATTERN='^[0-9a-f]{64}  [A-Za-z0-9._-]+$'
# The oldest systems a release's prebuilt files run on, read by the release build too, which checks
# its files against them (scripts/release-floor.sh): the glibc of the Linux bundles, the macOS of the
# macOS bundle (its Node) and of the macOS native programs; the static Linux programs run anywhere.
BUNDLE_GLIBC_FLOOR=2.28
BUNDLE_MACOS_FLOOR=13.5
PROGRAMS_MACOS_FLOOR=13.0

usage() {
  cat >&2 <<USAGE
usage: $0 [--tailscale] [--at-boot] [--restart-pty] [--assets-dir DIR] [--switch-from-bundle]   (release install)
       $0 --upgrade [--to TAG] [--restart-pty] [--assets-dir DIR]       (release install)
       $0 --rollback [--restart-pty]                                    (release install)
       $0 [--tailscale] [--at-boot] [--switch-from-bundle]                 (bundle install: ./mesh install)
       $0 [--tailscale] [--at-boot] [--ptyhost ABSOLUTE_PATH | --from-source] [--switch-from-bundle]   (source install)
       $0 --uninstall
USAGE
  exit 2
}

# The options of both platforms and every kind of install. Combinations are checked here; what
# one kind of install refuses is checked by release_bootstrap and source_bootstrap.
PTY_BINARY='' PTY_ARGUMENT='' PTY_EXPLICIT=0 UNINSTALL=0 TAILSCALE=0 AT_BOOT=0
UPGRADE=0 ROLLBACK=0 RESTART_PTY=0 UPGRADE_TO='' UPGRADE_FROM='' ASSETS_DIR='' SWITCH_FROM_BUNDLE=0
absolute_argument() { [[ $1 == /* && ! $1 =~ [[:cntrl:]] ]] || usage; }
release_tag_argument() { [[ $1 =~ $RELEASE_TAG_PATTERN ]] || usage; }
parse_arguments() {
  while (($#)); do
    case $1 in
      --uninstall) ((UNINSTALL == 0)) || usage; UNINSTALL=1; shift ;;
      --tailscale) ((TAILSCALE == 0)) || usage; TAILSCALE=1; shift ;;
      --at-boot) ((AT_BOOT == 0)) || usage; AT_BOOT=1; shift ;;
      --ptyhost) (($# >= 2 && PTY_EXPLICIT == 0)) || usage; absolute_argument "$2"
        PTY_BINARY=$2; PTY_ARGUMENT=$2; PTY_EXPLICIT=1; shift 2 ;;
      --from-source) ((PTY_EXPLICIT == 0)) || usage; PTY_EXPLICIT=1; shift ;;
      --upgrade) ((UPGRADE == 0)) || usage; UPGRADE=1; shift ;;
      --rollback) ((ROLLBACK == 0)) || usage; ROLLBACK=1; shift ;;
      --restart-pty) ((RESTART_PTY == 0)) || usage; RESTART_PTY=1; shift ;;
      --to) (($# >= 2)) && [[ -z $UPGRADE_TO ]] || usage; release_tag_argument "$2"; UPGRADE_TO=$2; shift 2 ;;
      --from) (($# >= 2)) && [[ -z $UPGRADE_FROM ]] || usage; release_tag_argument "$2"; UPGRADE_FROM=$2; shift 2 ;;
      --assets-dir) (($# >= 2)) && [[ -z $ASSETS_DIR ]] || usage; absolute_argument "$2"; ASSETS_DIR=$2; shift 2 ;;
      --switch-from-bundle) ((SWITCH_FROM_BUNDLE == 0)) || usage; SWITCH_FROM_BUNDLE=1; shift ;;
      *) usage ;;
    esac
  done
  check_combination
}
check_combination() {
  if ((UNINSTALL)); then
    ((TAILSCALE + AT_BOOT + PTY_EXPLICIT + UPGRADE + ROLLBACK + RESTART_PTY + SWITCH_FROM_BUNDLE == 0)) && [[ -z $ASSETS_DIR ]] || usage
  fi
  if ((UPGRADE + ROLLBACK)); then ((TAILSCALE + AT_BOOT + PTY_EXPLICIT + SWITCH_FROM_BUNDLE == 0 && UPGRADE + ROLLBACK == 1)) || usage; fi
  if [[ -n $UPGRADE_TO || -n $UPGRADE_FROM ]]; then ((UPGRADE)) || usage; fi
  # Offline, an upgrade needs the tag: the latest release can only be asked from GitHub.
  if [[ -n $ASSETS_DIR ]] && ((UPGRADE)) && [[ -z $UPGRADE_TO$UPGRADE_FROM ]]; then usage; fi
  if ((ROLLBACK)) && [[ -n $ASSETS_DIR ]]; then usage; fi
  return 0
}

# The home of the account: on macOS the user database's (id -P), as the launchd jobs use it.
account_home() {
  local entry home
  if [[ $SYSTEM == Darwin ]]; then
    entry=$(id -P) || refuse "cannot read this account's entry in the user database (id -P)"
    IFS=: read -r _ _ _ _ _ _ _ _ home _ <<< "$entry"
  else
    home=${HOME:-}
  fi
  [[ $home == /* && ! $home =~ [[:cntrl:]] ]] || refuse "cannot determine the home directory"
  printf '%s' "$home"
}

# Where releases live: MESH_SHARE/releases/<tag>/ is the extracted bundle of that release (app/,
# bin/, libexec/, runtime/, ...) plus its stamped install.sh and release.sha256; MESH_SHARE/current
# and MESH_SHARE/previous are symbolic links to releases/<tag>. Configuration and data never go
# there.
release_paths() {
  MESH_SHARE=$1/.local/share/session-mesh
  RELEASES=$MESH_SHARE/releases
  CURRENT=$MESH_SHARE/current
  PREVIOUS=$MESH_SHARE/previous
}

file_sha256() {
  local out
  if command -v sha256sum >/dev/null; then out=$(sha256sum -- "$1") || return 1
  elif command -v shasum >/dev/null; then out=$(shasum -a 256 -- "$1") || return 1
  else return 1
  fi
  printf '%s' "${out%% *}"
}

# The hash recorded for asset $2 in the "<sha256>  <asset>" lines $1, or nothing.
sums_hash() {
  local line
  while IFS= read -r line; do
    if [[ $line =~ $RELEASE_SUM_PATTERN && ${line#*  } == "$2" ]]; then printf '%s' "${line%%  *}"; return 0; fi
  done <<< "$1"
}

# One directory of the install path: created 0755 when absent, then owned by this account and
# not writable by group or others. $2 = strict: a symbolic link is refused (a link above, such as
# a dotfile manager's ~/.local, is followed).
check_dir() {
  local dir=$1 mode
  [[ -d $dir ]] || mkdir -m 755 -- "$dir" || refuse "cannot create $dir"
  [[ ${2:-} != strict || ! -L $dir ]] || refuse "$dir is a symbolic link: refused"
  [[ -d $dir && -O $dir ]] || refuse "$dir is not a directory owned by you"
  mode=$(ls -ldL -- "$dir") && mode=${mode%% *}
  [[ ${mode:5:1} != w && ${mode:8:1} != w ]] || refuse "$dir is writable by group or others (chmod go-w it): refused, nothing was installed there"
}

# Fetches asset $2 of release $1 into the file $3: the copy in --assets-dir, else the download.
release_fetch() {
  local url=$MESH_REPO_URL/releases/download/$1/$2
  if [[ -n $ASSETS_DIR ]]; then
    [[ -f $ASSETS_DIR/$2 ]] || { echo "installer: --assets-dir: $ASSETS_DIR/$2 is not a file" >&2; return 1; }
    cp -- "$ASSETS_DIR/$2" "$3"
    return
  fi
  command -v curl >/dev/null || { echo "installer: curl is needed to download $url" >&2; return 1; }
  echo "Downloading $url"
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 1800 -o "$3" -- "$url" \
    || { echo "installer: cannot download $url (no such asset, or the network is down)" >&2; return 1; }
}

# The Sigstore build attestation of file $1, which must have been made by the release workflow
# from tag $2; checked with gh when it is on PATH and logged in. A failed check is printed and
# returns 1. Without gh, or with gh not logged in (exit 4), the reader is told once how to check by
# hand, and the SHA-256 checks still apply; MESH_REQUIRE_ATTESTATION=1 makes that a refusal.
ATTESTATION_ARGS=(--repo Session-Mesh/session-mesh --signer-workflow Session-Mesh/session-mesh/.github/workflows/release.yml)
ATTESTATION_NOTED=0
attestation_ok() {
  local out status=0
  if ! command -v gh >/dev/null; then
    attestation_skipped "gh is not on PATH" "install gh (https://cli.github.com/), run gh auth login, then" "$2"
    return
  fi
  out=$(gh attestation verify "$1" "${ATTESTATION_ARGS[@]}" --source-ref "refs/tags/$2" 2>&1) || status=$?
  ((status != 0)) || return 0
  if ((status == 4)); then
    attestation_skipped "gh is not logged in" "run gh auth login, then" "$2"
    return
  fi
  printf '%s\n' "$out" >&2
  return 1
}
# $1 why the attestation cannot be checked, $2 what to do first, $3 the tag.
attestation_skipped() {
  if [[ ${MESH_REQUIRE_ATTESTATION:-} == 1 ]]; then
    echo "installer: $1, and MESH_REQUIRE_ATTESTATION=1 requires the build attestation to be checked" >&2
    return 1
  fi
  ((ATTESTATION_NOTED)) && return 0
  ATTESTATION_NOTED=1
  warn "$1: the build attestation of the downloaded files was not checked (their SHA-256 was). To check a file by hand, $2: gh attestation verify FILE ${ATTESTATION_ARGS[*]} --source-ref refs/tags/$3"
}

# A refusal while staging: the staging directory goes, nothing of the release is installed.
STAGE=''
stage_abort() { [[ -z $STAGE ]] || rm -rf -- "$STAGE"; STAGE=''; refuse "$* Nothing was installed."; }

# Fetches asset $1 of this release into $2 and checks it against the stamp.
stage_asset() {
  local expected actual
  expected=$(sums_hash "$MESH_RELEASE_SUMS" "$1")
  [[ -n $expected ]] || stage_abort "this installer records no SHA-256 for $1."
  release_fetch "$MESH_RELEASE_TAG" "$1" "$2" || stage_abort "cannot obtain $1."
  actual=$(file_sha256 "$2") || stage_abort "no sha256sum or shasum to check $1 with."
  [[ $actual == "$expected" ]] || stage_abort "the SHA-256 of $1 is $actual, not the $expected this installer records for $MESH_RELEASE_TAG: the downloaded files were deleted."
  attestation_ok "$2" "$MESH_RELEASE_TAG" || stage_abort "the build attestation of $1 does not verify (gh attestation verify, above): the downloaded files were deleted."
}

# Second stage of --upgrade: every hash stamped in this installer must be a line of the release's
# SHA256SUMS that the first stage downloaded next to it.
check_stamp_in_sums() {
  local sums line
  sums=$(dirname "$INSTALLER")/SHA256SUMS
  [[ -f $sums ]] || refuse "--upgrade --from: no SHA256SUMS next to $INSTALLER; run --upgrade from the installed release instead"
  while IFS= read -r line; do
    grep -qxF -- "$line" "$sums" || refuse "this installer records '$line', which the SHA256SUMS of $MESH_RELEASE_TAG does not list: nothing was installed"
  done <<< "$MESH_RELEASE_SUMS"
}

# The bundle archive of a platform, as scripts/build-bundle.sh names it: one top directory
# mesh-<os>-<arch>/ with the launcher, the code (app/), the wrappers and native programs (bin/,
# libexec/), the Python and Node runtimes (runtime/) and bundle.json, which records the SHA-256 of
# the six native programs.
bundle_asset() { printf 'mesh-%s.tar.gz' "$1"; }
BUNDLE_FILES=(mesh env.sh bundle.json app/install.sh app/server.py bin/mesh-python bin/mesh-ptyhost
  libexec/mesh-ptyhost bin/mesh-board-mcp bin/mesh-read bin/mesh-platform bin/mesh-history bin/mesh-logout-all)
BUNDLE_NATIVE='^ *"((bin|libexec)/mesh-[a-z-]+)": "([0-9a-f]{64})",?$'

# 0 when directory $1 holds a bundle whose native programs have the hashes of its bundle.json.
bundle_intact() {
  local dir=$1 file line count=0 actual
  for file in "${BUNDLE_FILES[@]}"; do [[ -f $dir/$file ]] || return 1; done
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ $BUNDLE_NATIVE ]] || continue
    file=${BASH_REMATCH[1]}
    actual=$(file_sha256 "$dir/$file") || return 1
    [[ $actual == "${BASH_REMATCH[3]}" ]] || return 1
    count=$((count + 1))
  done < "$dir/bundle.json"
  ((count == 6))
}

# Bundle: builds the release in a staging directory: the archive is checked before it is unpacked,
# the unpacked bundle against its own manifest, then the bundle is renamed into place:
# releases/<tag> appears complete or not at all.
stage_bundle() {
  local tag=$MESH_RELEASE_TAG asset name
  asset=$(bundle_asset "$1") name=mesh-$1
  STAGE=$(mktemp -d "$RELEASES/.stage-$tag.XXXXXXXX") || refuse "cannot write in $RELEASES"
  chmod 755 "$STAGE" || stage_abort "cannot prepare $STAGE."
  step "Release $tag ($1)"
  stage_asset "$asset" "$STAGE/$asset"
  # GNU and BSD tar both refuse members with an absolute or ../ path.
  { tar -xzf "$STAGE/$asset" -C "$STAGE" && rm -f -- "$STAGE/$asset"; } || stage_abort "cannot unpack $asset."
  { [[ $(ls -A -- "$STAGE") == "$name" ]] && bundle_intact "$STAGE/$name"; } \
    || stage_abort "$asset does not hold one complete bundle $name/ whose native programs match its bundle.json."
  { cp -- "$INSTALLER" "$STAGE/$name/install.sh" && chmod 0755 "$STAGE/$name/install.sh" \
    && printf '%s  %s\n' "$(sums_hash "$MESH_RELEASE_SUMS" "$asset")" "$asset" > "$STAGE/$name/release.sha256" \
    && chmod -R go-w "$STAGE/$name"; } || stage_abort "cannot prepare $STAGE/$name."
  mv -- "$STAGE/$name" "$RELEASES/$tag" || stage_abort "cannot rename $STAGE/$name to $RELEASES/$tag."
  rm -rf -- "$STAGE"
  STAGE=''
  echo "installed, SHA-256 verified: $RELEASES/$tag (bundle $asset)"
}

# A bundle already on disk is reused when it was unpacked from the stamped archive and its native
# programs still match its bundle.json.
check_installed_bundle() {
  local dir=$RELEASES/$MESH_RELEASE_TAG asset
  asset=$(bundle_asset "$1")
  { [[ -f $dir/release.sha256 && $(cat -- "$dir/release.sha256") == "$(sums_hash "$MESH_RELEASE_SUMS" "$asset")  $asset" ]] \
    && bundle_intact "$dir"; } || refuse "$dir is incomplete or was modified; if no service runs from it, remove it (rm -rf -- '$dir') and rerun"
  echo "Release $MESH_RELEASE_TAG is already on disk, bundle checked: $dir"
}

# Native programs (a release without a bundle for this platform): the code archive
# session-mesh-<tag>.tar.gz and the six programs <program>-<os>-<arch>, each checked against the
# stamp before anything is unpacked, laid out as releases/<tag>/app (the code) and
# releases/<tag>/bin (the programs); app/bin/mesh-board-mcp links to the release's own, where the
# agents' board configuration looks for it. The services then run this machine's Python.
RELEASE_PROGRAMS=(mesh-ptyhost mesh-board-mcp mesh-read mesh-platform mesh-history mesh-logout-all)
code_asset() { printf 'session-mesh-%s.tar.gz' "$MESH_RELEASE_TAG"; }
stage_programs() {
  local tag=$MESH_RELEASE_TAG program release
  STAGE=$(mktemp -d "$RELEASES/.stage-$tag.XXXXXXXX") || refuse "cannot write in $RELEASES"
  release=$STAGE/release
  { chmod 755 "$STAGE" && mkdir -m 755 "$release" "$release/bin"; } || stage_abort "cannot prepare $STAGE."
  step "Release $tag ($1, native programs and code; no bundle for this platform)"
  stage_asset "$(code_asset)" "$STAGE/code.tar.gz"
  for program in "${RELEASE_PROGRAMS[@]}"; do
    stage_asset "$program-$1" "$release/bin/$program"
    chmod 0755 "$release/bin/$program" || stage_abort "cannot set the mode of $program."
  done
  { tar -xzf "$STAGE/code.tar.gz" -C "$STAGE" && [[ -d $STAGE/session-mesh-$tag ]]; } \
    || stage_abort "the code archive does not hold session-mesh-$tag/."
  { mv -- "$STAGE/session-mesh-$tag" "$release/app" && mkdir -p "$release/app/bin" \
    && ln -s ../../bin/mesh-board-mcp "$release/app/bin/mesh-board-mcp" \
    && code_manifest "$release/app" > "$release/app.manifest" \
    && cp -- "$INSTALLER" "$release/install.sh" && chmod 0755 "$release/install.sh" && chmod -R go-w "$release"; } \
    || stage_abort "cannot unpack the code archive."
  mv -- "$release" "$RELEASES/$tag" || stage_abort "cannot rename $release to $RELEASES/$tag."
  rm -rf -- "$STAGE"
  STAGE=''
  echo "installed, SHA-256 verified: $RELEASES/$tag (the code and ${RELEASE_PROGRAMS[*]} for $1)"
}

# Code directory $1's files' SHA-256 and links' targets, sorted, without the __pycache__ of Python.
code_manifest() {
  local -a tool=(sha256sum)
  command -v sha256sum >/dev/null || tool=(shasum -a 256)
  (cd -- "$1" && find . -name __pycache__ -prune -o -type f -print | LC_ALL=C sort | tr '\n' '\0' | xargs -0 "${tool[@]}" -- \
    && find . -name __pycache__ -prune -o -type l -print | LC_ALL=C sort | while IFS= read -r link; do
      printf 'link %s -> %s\n' "$link" "$(readlink -- "$link")"
    done)
}

# Native programs already on disk are reused when each still has its stamped hash and the code
# still matches the manifest recorded when it was unpacked (app.manifest).
check_installed_programs() {
  local dir=$RELEASES/$MESH_RELEASE_TAG program actual manifest
  for program in "${RELEASE_PROGRAMS[@]}"; do
    actual=$(file_sha256 "$dir/bin/$program" 2>/dev/null || true)
    [[ -n $actual && $actual == "$(sums_hash "$MESH_RELEASE_SUMS" "$program-$1")" ]] \
      || refuse "$dir is incomplete or was modified ($program); if no service runs from it, remove it (rm -rf -- '$dir') and rerun"
  done
  manifest=$(code_manifest "$dir/app" 2>/dev/null) || manifest=''
  [[ -f $dir/app.manifest && -n $manifest && $manifest == "$(cat -- "$dir/app.manifest")" ]] \
    || refuse "$dir is incomplete or was modified (its code, app/, differs from app.manifest); if no service runs from it, remove it (rm -rf -- '$dir') and rerun"
  echo "Release $MESH_RELEASE_TAG is already on disk, programs and code checked: $dir"
}

# This machine's platform, as a bundle names it (BUNDLE_PLATFORM, scripts/build-bundle.sh) and as the
# native programs name it (PROGRAM_PLATFORM, <program>-<os>-<arch>); empty when none is built for it.
release_platforms() {
  BUNDLE_PLATFORM='' PROGRAM_PLATFORM=''
  case "$SYSTEM/$(uname -m)" in
    Linux/x86_64) BUNDLE_PLATFORM=linux-x86_64 PROGRAM_PLATFORM=linux-x86_64 ;;
    Linux/aarch64|Linux/arm64) BUNDLE_PLATFORM=linux-arm64 PROGRAM_PLATFORM=linux-aarch64 ;;
    Darwin/arm64) BUNDLE_PLATFORM=macos-arm64 PROGRAM_PLATFORM=macos-arm64 ;;
    Darwin/x86_64) BUNDLE_PLATFORM=macos-x86_64 ;;
  esac
}

# 0 when this installer records the code archive and the six programs of platform $1.
release_has_programs() {
  local program
  [[ -n $1 && -n $(sums_hash "$MESH_RELEASE_SUMS" "$(code_asset)") ]] || return 1
  for program in "${RELEASE_PROGRAMS[@]}"; do [[ -n $(sums_hash "$MESH_RELEASE_SUMS" "$program-$1") ]] || return 1; done
}

# The platforms this installer records bundles (mesh-<platform>.tar.gz) and native programs
# (mesh-ptyhost-<platform>) for, for a refusal.
stamped_platforms() {
  local line name bundles='' programs=''
  while IFS= read -r line; do
    name=${line#*  }
    if [[ $name == mesh-*.tar.gz ]]; then name=${name#mesh-}; bundles="$bundles${bundles:+, }${name%.tar.gz}"; fi
    if [[ $name == mesh-ptyhost-* ]]; then programs="$programs${programs:+, }${name#mesh-ptyhost-}"; fi
  done <<< "$MESH_RELEASE_SUMS"
  printf 'bundles: %s; native programs: %s' "${bundles:-none}" "${programs:-none}"
}

# Version $1 (<major>[.<minor>[.<patch>]]) as a number that orders as the versions do; fails when
# it is not a version. version_at_least: 0 when version $1 is version $2 or newer.
version_key() {
  [[ $1 =~ ^([0-9]+)(\.([0-9]+))?(\.([0-9]+))? ]] || return 1
  printf '%d%05d%05d' "$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[3]:-0}))" "$((10#${BASH_REMATCH[5]:-0}))"
}
version_at_least() { local have want; have=$(version_key "$1") && want=$(version_key "$2") && ((have >= want)); }

# This machine against the floors: MACHINE_SYSTEM (its macOS or glibc; getconf fails on musl),
# BUNDLE_FITS and PROGRAMS_FIT (1 when it can run each), BUNDLE_WHY (why not the bundle).
machine_floors() {
  local version
  BUNDLE_FITS=0 PROGRAMS_FIT=1
  if [[ $SYSTEM == Darwin ]]; then
    version=$(sw_vers -productVersion 2>/dev/null) || version=''
    MACHINE_SYSTEM="macOS ${version:-of unknown version}"
    if version_at_least "$version" "$BUNDLE_MACOS_FLOOR"; then BUNDLE_FITS=1; fi
    if ! version_at_least "$version" "$PROGRAMS_MACOS_FLOOR"; then PROGRAMS_FIT=0; fi
    BUNDLE_WHY="this Mac runs $MACHINE_SYSTEM; the bundle needs macOS $BUNDLE_MACOS_FLOOR or later"
    return 0
  fi
  version=$(getconf GNU_LIBC_VERSION 2>/dev/null) || version=''
  if [[ $version == "glibc "* ]]; then
    MACHINE_SYSTEM=$version
    if version_at_least "${version#glibc }" "$BUNDLE_GLIBC_FLOOR"; then BUNDLE_FITS=1; fi
  else
    MACHINE_SYSTEM="no glibc (the C library could not be identified: getconf GNU_LIBC_VERSION failed)"
  fi
  BUNDLE_WHY="this machine has $MACHINE_SYSTEM; the bundle needs glibc $BUNDLE_GLIBC_FLOOR or later"
}

# What this release installs here (RELEASE_KIND): this platform's bundle if this machine meets its
# floor, else the native programs and the code (run with this machine's Python) if it meets theirs.
release_kind() {
  local has_bundle=0
  release_platforms
  [[ -n $BUNDLE_PLATFORM$PROGRAM_PLATFORM ]] \
    || refuse "there is no prebuilt bundle or native program for $SYSTEM $(uname -m): install from a git clone instead (docs/operations.md, \"Source installs\")"
  machine_floors
  if [[ -n $BUNDLE_PLATFORM && -n $(sums_hash "$MESH_RELEASE_SUMS" "$(bundle_asset "$BUNDLE_PLATFORM")") ]]; then has_bundle=1; fi
  if ((has_bundle && BUNDLE_FITS)); then
    RELEASE_KIND=bundle RELEASE_PLATFORM=$BUNDLE_PLATFORM
  elif ((PROGRAMS_FIT)) && release_has_programs "$PROGRAM_PLATFORM"; then
    ((has_bundle == 0)) || warn "not the bundle $(bundle_asset "$BUNDLE_PLATFORM"): $BUNDLE_WHY. Installing the native programs and the code instead, run with this machine's Python (MESH_PYTHON, else python3 on PATH)"
    RELEASE_KIND=programs RELEASE_PLATFORM=$PROGRAM_PLATFORM
  elif ((has_bundle)) || release_has_programs "$PROGRAM_PLATFORM"; then
    refuse "release $MESH_RELEASE_TAG does not run on this machine ($MACHINE_SYSTEM): its bundles need glibc $BUNDLE_GLIBC_FLOOR or later (Linux) or macOS $BUNDLE_MACOS_FLOOR or later, its native programs macOS $PROGRAMS_MACOS_FLOOR or later on a Mac: install from a git clone instead (docs/operations.md, \"Source installs\")"
  else
    refuse "release $MESH_RELEASE_TAG has neither a bundle for ${BUNDLE_PLATFORM:-this machine} nor native programs for ${PROGRAM_PLATFORM:-this machine} (it has $(stamped_platforms)): install from a git clone instead (docs/operations.md, \"Source installs\")"
  fi
}

# Release install: makes sure releases/<tag> holds this release; HERE is then its code, and the
# units run from current/ (APP_ROOT). A bundle's units run its own Python and programs (BUNDLE_DIR,
# RUN_ROOT); native programs run with this machine's Python.
release_bootstrap() {
  local line
  [[ $MESH_RELEASE_TAG =~ $RELEASE_TAG_PATTERN ]] || refuse "the release stamp of this installer is damaged: download install.sh again"
  while IFS= read -r line; do
    [[ $line =~ $RELEASE_SUM_PATTERN ]] || refuse "the release stamp of this installer is damaged: download install.sh again"
  done <<< "$MESH_RELEASE_SUMS"
  ((PTY_EXPLICIT == 0)) || refuse "--ptyhost and --from-source belong to a source install (run them from a git clone); this installer is release $MESH_RELEASE_TAG"
  [[ -f $INSTALLER && -r $INSTALLER ]] || refuse "run the release installer from a file (bash install.sh), not from a pipe: it keeps a copy of itself for --upgrade and --rollback"
  INSTALLER=$(cd "$(dirname "$INSTALLER")" && pwd)/$(basename "$INSTALLER")
  [[ -z $UPGRADE_FROM ]] || check_stamp_in_sums
  release_kind
  check_dir "$1/.local"
  check_dir "$1/.local/share"
  check_dir "$MESH_SHARE" strict
  check_dir "$RELEASES" strict
  if [[ -d $RELEASES/$MESH_RELEASE_TAG ]]; then "check_installed_$RELEASE_KIND" "$RELEASE_PLATFORM"; else "stage_$RELEASE_KIND" "$RELEASE_PLATFORM"; fi
  HERE=$RELEASES/$MESH_RELEASE_TAG/app
  APP_ROOT=$CURRENT/app
  [[ $RELEASE_KIND == bundle ]] || return 0
  BUNDLE_DIR=$RELEASES/$MESH_RELEASE_TAG
  RUN_ROOT=$CURRENT
}

parse_arguments "$@"
((EUID != 0)) || refuse "run the installer as your own user, never with sudo or as root (session-mesh runs as your account)"
ACCOUNT_HOME=$(account_home) || exit 1
release_paths "$ACCOUNT_HOME"
BUNDLE_DIR='' RUN_ROOT=''
if [[ -n $MESH_RELEASE_TAG ]]; then
  release_bootstrap "$ACCOUNT_HOME"
else
  # shellcheck source=scripts/install-checkout.sh
  source "$(dirname "$INSTALLER")/scripts/install-checkout.sh"
  source_bootstrap
fi

# shellcheck source=scripts/install-common.sh
source "$HERE/scripts/install-common.sh"
# shellcheck source=scripts/install-release.sh
source "$HERE/scripts/install-release.sh"
if [[ $SYSTEM == Darwin ]]; then
  # shellcheck source=scripts/install-macos.sh
  source "$HERE/scripts/install-macos.sh"
else
  ((AT_BOOT == 0)) || refuse "--at-boot is for macOS; on Linux, keep the services running after logout with: sudo loginctl enable-linger \$USER"
  # shellcheck source=scripts/install-linux.sh
  source "$HERE/scripts/install-linux.sh"
fi
