# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash disable=SC2153 # CURRENT, PREVIOUS and RELEASES are set by install.sh
# session-mesh installer, releases: the current and previous links, upgrades, rollbacks and the
# pruning of old releases. Sourced by install.sh (both platforms, every kind of install) after
# release_paths, sums_hash, release_fetch and file_sha256; never run on its own. The platform
# parts (scripts/install-linux.sh, scripts/install-macos.sh) decide which jobs they may touch and
# restart them. Written for the bash 3.2 of macOS.
#
# Layout (release_paths): MESH_SHARE/releases/<tag>/ (the release's extracted bundle: app/, bin/,
# libexec/mesh-ptyhost, runtime/, ..., with install.sh), MESH_SHARE/current and MESH_SHARE/previous,
# each a symbolic link "releases/<tag>". The units run from current/, so an upgrade installs the
# new release beside the old one and only swaps current. current/bin/mesh-ptyhost is the bundle's
# wrapper, which executes libexec/mesh-ptyhost of the release current/ named when it started. A
# release installed from its native programs (no bundle for the platform) holds app/, bin/ (the
# programs themselves, current/bin/mesh-ptyhost among them) and install.sh.

RELEASE_KEEP_NOTE="only current and previous are kept"

# The tag a link points at, or nothing when it is absent or not a link to an installed release.
link_tag() {
  local target
  [[ -L $1 ]] || return 0
  target=$(readlink -- "$1") || return 0
  [[ $target == releases/* && ${target#releases/} =~ $RELEASE_TAG_PATTERN && -d $RELEASES/${target#releases/} ]] || return 0
  printf '%s' "${target#releases/}"
}

# Points link $1 at releases/$2: a new link renamed over the old one (GNU mv -T), else replaced in
# two steps (BSD mv has no -T and would move the new link into the directory).
point_link() {
  local link=$1 staged=$MESH_SHARE/.link.$$
  rm -f -- "$staged"
  ln -s -- "releases/$2" "$staged" || refuse "cannot write in $MESH_SHARE"
  if ! mv -fT -- "$staged" "$link" 2>/dev/null; then
    { rm -f -- "$link" && mv -f -- "$staged" "$link"; } || refuse "cannot point $link at releases/$2"
  fi
}

# Makes this release current; the one it replaces becomes previous. OLD_TAG and PREVIOUS_BEFORE
# keep what was there, for release_revert.
OLD_TAG='' PREVIOUS_BEFORE=''
release_activate() {
  OLD_TAG=$(link_tag "$CURRENT")
  PREVIOUS_BEFORE=$(link_tag "$PREVIOUS")
  point_link "$CURRENT" "$1"
  if [[ -n $OLD_TAG && $OLD_TAG != "$1" ]]; then point_link "$PREVIOUS" "$OLD_TAG"; fi
  echo "current -> releases/$1"
}

# Undoes release_activate.
release_revert() {
  if [[ -n $OLD_TAG ]]; then point_link "$CURRENT" "$OLD_TAG"; else rm -f -- "$CURRENT"; fi
  if [[ -n $PREVIOUS_BEFORE ]]; then point_link "$PREVIOUS" "$PREVIOUS_BEFORE"; else rm -f -- "$PREVIOUS"; fi
  if [[ -n $OLD_TAG ]]; then echo "current -> releases/$OLD_TAG"; else echo "current removed"; fi
}

# The release whose mesh-ptyhost the running PTY host executes, when the system says so: on Linux,
# /proc/<pid>/exe of the PTY unit's main process (pty_host_pid), which names the release current/
# pointed at when the host started. Nothing when it cannot be told (macOS, no running host). The
# kernel names the executable by its physical path, so it is compared with the physical path of
# releases/ (HOME may be reached through a symbolic link).
running_pty_tag() {
  local pid exe tag releases
  pid=$(pty_host_pid 2>/dev/null) || return 0
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 0
  exe=$(readlink -- "/proc/$pid/exe" 2>/dev/null) || return 0
  releases=$(cd -- "$RELEASES" 2>/dev/null && pwd -P) || return 0
  # A bundle's host is libexec/mesh-ptyhost (bin/ holds its wrapper); native programs keep it in bin/.
  [[ $exe == "$releases"/*/libexec/mesh-ptyhost || $exe == "$releases"/*/bin/mesh-ptyhost ]] || return 0
  tag=${exe#"$releases"/}
  tag=${tag%%/*}
  if [[ $tag =~ $RELEASE_TAG_PATTERN ]]; then printf '%s' "$tag"; fi
}

# Deletes every release but current, previous and the one the running PTY host was started from,
# and what interrupted runs left behind.
release_prune() {
  local keep_current keep_previous keep_running entry name
  keep_current=$(link_tag "$CURRENT")
  keep_previous=$(link_tag "$PREVIOUS")
  keep_running=$(running_pty_tag)
  for entry in "$RELEASES"/* "$RELEASES"/.stage-* "$RELEASES"/.upgrade-*; do
    [[ -e $entry || -L $entry ]] || continue
    name=${entry##*/}
    [[ $name == "$keep_current" || $name == "$keep_previous" ]] && continue
    if [[ $name == "$keep_running" ]]; then
      echo "kept the older release $name: the running PTY host was started from it"
      continue
    fi
    [[ $name =~ $RELEASE_TAG_PATTERN || $name == .stage-* || $name == .upgrade-* ]] || continue
    rm -rf -- "$entry"
    [[ $name == .* ]] || echo "removed the older release $name ($RELEASE_KEEP_NOTE)"
  done
}

# 0 when the pre-release identifiers $1 come before $2 (semver: dot-separated, numeric ones
# compared as numbers and before alphanumeric ones, these in ASCII order, a shorter list first).
prerelease_older() {
  local i a b
  local -a x y
  # ASCII order whatever the locale: bash 4.1 and later collate [[ < ]] in the current one.
  local LC_ALL=C
  IFS=. read -r -a x <<< "$1"
  IFS=. read -r -a y <<< "$2"
  for ((i = 0; i < ${#x[@]}; i++)); do
    if ((i >= ${#y[@]})); then return 1; fi
    a=${x[i]} b=${y[i]}
    if [[ $a == "$b" ]]; then continue; fi
    if [[ $a =~ ^[0-9]+$ && $b =~ ^[0-9]+$ ]]; then ((10#$a < 10#$b)) && return 0; return 1; fi
    if [[ $a =~ ^[0-9]+$ ]]; then return 0; fi
    if [[ $b =~ ^[0-9]+$ ]]; then return 1; fi
    [[ $a < $b ]] && return 0; return 1
  done
  ((${#x[@]} < ${#y[@]})) && return 0; return 1
}

# 0 when tag $1 is older than tag $2, as semver: major.minor.patch compared as numbers, a
# pre-release (v1.2.0-rc.1) older than its release, pre-releases by their identifiers (rc.9 before
# rc.10).
version_older() {
  local a=${1#v} b=${2#v} i
  local -a x y
  IFS=. read -r -a x <<< "${a%%-*}"
  IFS=. read -r -a y <<< "${b%%-*}"
  for i in 0 1 2; do
    if ((10#${x[i]} < 10#${y[i]})); then return 0; fi
    if ((10#${x[i]} > 10#${y[i]})); then return 1; fi
  done
  if [[ $a != *-* ]]; then return 1; fi
  if [[ $b != *-* ]]; then return 0; fi
  prerelease_older "${a#*-}" "${b#*-}"
}

# The SHA-256 of the native mesh-ptyhost of release $1: a bundle's libexec/mesh-ptyhost, else the
# program of a release installed from its native programs; nothing when neither is there.
release_host_sha256() {
  local host=$RELEASES/$1/libexec/mesh-ptyhost
  [[ -f $host ]] || host=$RELEASES/$1/bin/mesh-ptyhost
  file_sha256 "$host" 2>/dev/null || true
}

# 0 when the native mesh-ptyhost differs between releases $1 and $2 (or one of them is unknown).
pty_host_differs() {
  local before after
  [[ -n $1 && -n $2 ]] || return 0
  before=$(release_host_sha256 "$1")
  after=$(release_host_sha256 "$2")
  [[ -z $before || $before != "$after" ]]
}

# What becomes of the running PTY host after current moved from $1 to $2; $3 restarts it.
# The installer restarts it only with --restart-pty: that ends every mesh session.
pty_host_report() {
  local from=$1 to=$2 restart=$3
  if ! pty_host_differs "$from" "$to"; then
    echo "mesh-ptyhost is unchanged ($from -> $to): the running PTY host and its sessions go on."
    return 0
  fi
  if ((RESTART_PTY)); then
    step "Restarting the PTY host (--restart-pty: every mesh session ends)"
    eval "$restart"
    return 0
  fi
  warn "mesh-ptyhost changed ($from -> $to). The running PTY host keeps the version it started with until it restarts, and restarting it ends every mesh session. When you are ready: $restart (or rerun the installer with --restart-pty)"
}

# The tag of the latest published release: GitHub's /releases/latest never names a draft or a
# pre-release.
latest_release_tag() {
  local json tag pattern='"tag_name"[[:space:]]*:[[:space:]]*"([^"]*)"'
  command -v curl >/dev/null || refuse "curl is needed to ask GitHub for the latest release"
  json=$(curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 \
    -H 'Accept: application/vnd.github+json' -- "$MESH_API_URL/releases/latest") \
    || refuse "cannot ask GitHub for the latest release ($MESH_API_URL/releases/latest); nothing was changed"
  [[ $json =~ $pattern ]] || refuse "GitHub's answer names no release tag; nothing was changed"
  tag=${BASH_REMATCH[1]}
  [[ $tag =~ $RELEASE_TAG_PATTERN ]] || refuse "the latest release has the tag '$tag', which is not a release tag; nothing was changed"
  printf '%s' "$tag"
}

# The target of --upgrade, after the downgrade rule: an older tag only when --to names it.
upgrade_target() {
  local from=$1 target=$UPGRADE_TO
  [[ -n $target ]] || target=$(latest_release_tag) || exit 1
  if [[ $target != "$from" ]] && version_older "$target" "$from" && [[ -z $UPGRADE_TO ]]; then
    refuse "the latest published release $target is older than the installed $from: nothing was changed (to go back, name it: --upgrade --to $target)"
  fi
  printf '%s' "$target"
}

# The SHA256SUMS of release $1, downloaded into directory $2; every line "<sha256>  <asset>".
fetch_sums() {
  local tag=$1 work=$2 line
  release_fetch "$tag" SHA256SUMS "$work/SHA256SUMS" || refuse "cannot obtain the SHA256SUMS of $tag; nothing was changed"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ $RELEASE_SUM_PATTERN ]] || refuse "the SHA256SUMS of $tag has a line that is not '<sha256>  <asset>'; nothing was changed"
  done < "$work/SHA256SUMS"
}

# --upgrade, first stage: finds the release, downloads its SHA256SUMS and its install.sh over
# HTTPS, checks the installer against SHA256SUMS (and its build attestation when gh is on PATH),
# then runs it (the second stage, --from the installed tag): it checks its stamp against that
# SHA256SUMS and installs its own release as any release install does. Called by the platform part after it has checked that
# every job is the installer's own.
release_upgrade() {
  local from target work expected actual
  local -a args
  from=$(link_tag "$CURRENT")
  [[ -n $from ]] || refuse "no release is installed for this account ($CURRENT is missing): run install.sh without --upgrade first"
  target=$(upgrade_target "$from") || exit 1
  if [[ $target == "$from" ]]; then echo "Already at $from: nothing to do."; exit 0; fi
  step "Upgrade $from -> $target"
  work=$(mktemp -d "$RELEASES/.upgrade-$target.XXXXXXXX") || refuse "cannot write in $RELEASES"
  # The path is written into the trap now: on an exit from a function below, the bash 3.2 of macOS
  # runs the trap after this function's locals are gone.
  # shellcheck disable=SC2064 # expanded now, on purpose
  trap "rm -rf -- $(printf %q "$work")" EXIT
  fetch_sums "$target" "$work"
  expected=$(sums_hash "$(cat "$work/SHA256SUMS")" install.sh)
  [[ -n $expected ]] || refuse "the SHA256SUMS of $target lists no install.sh; nothing was changed"
  release_fetch "$target" install.sh "$work/install.sh" || refuse "cannot obtain the install.sh of $target; nothing was changed"
  actual=$(file_sha256 "$work/install.sh") || refuse "no sha256sum or shasum to check install.sh with"
  [[ $actual == "$expected" ]] || refuse "the install.sh of $target has the SHA-256 $actual, not the $expected of its SHA256SUMS: nothing was changed"
  attestation_ok "$work/install.sh" "$target" || refuse "the build attestation of the install.sh of $target does not verify (gh attestation verify, above): nothing was changed"
  echo "install.sh of $target: SHA-256 matches its SHA256SUMS; running it"
  trap - EXIT
  args=(--upgrade --from "$from")
  [[ -z $UPGRADE_TO ]] || args+=(--to "$UPGRADE_TO")
  [[ -z $ASSETS_DIR ]] || args+=(--assets-dir "$ASSETS_DIR")
  ((RESTART_PTY == 0)) || args+=(--restart-pty)
  exec bash "$work/install.sh" "${args[@]}"
}

# --upgrade, second stage (this installer was started by release_upgrade): the same downgrade
# rule, checked again by the installer that is about to act.
release_check_second_stage() {
  [[ -n $UPGRADE_FROM ]] || return 0
  if version_older "$MESH_RELEASE_TAG" "$UPGRADE_FROM" && [[ $UPGRADE_TO != "$MESH_RELEASE_TAG" ]]; then
    refuse "$MESH_RELEASE_TAG is older than the installed $UPGRADE_FROM: a downgrade needs --upgrade --to $MESH_RELEASE_TAG; nothing was changed"
  fi
}

# --rollback: the previous release, which must still be on disk.
rollback_target() {
  local previous
  previous=$(link_tag "$PREVIOUS")
  [[ -n $previous ]] || refuse "there is no previous release to go back to ($PREVIOUS is missing or its release was removed); nothing was changed"
  [[ -n $(link_tag "$CURRENT") ]] || refuse "no release is installed for this account ($CURRENT is missing); nothing was changed"
  printf '%s' "$previous"
}

# Source or bundle install over a release install (--from-source or --ptyhost): current goes, the
# release directories stay, and from now on everything runs from this checkout or bundle.
SWITCH_FROM_RELEASE=0
source_check_release_install() {
  [[ -z $MESH_RELEASE_TAG && ( -e $CURRENT || -L $CURRENT ) ]] || return 0
  ((UNINSTALL == 0)) || return 0
  ((PTY_EXPLICIT)) \
    || refuse "this account runs a release install ($CURRENT). To upgrade it: $CURRENT/install.sh --upgrade. To run this checkout or bundle instead, rerun with --from-source; nothing was changed"
  SWITCH_FROM_RELEASE=1
  warn "this account runs a release install ($CURRENT -> $(readlink -- "$CURRENT" || true)). The installer now removes the link $CURRENT (the releases stay in $RELEASES) and the services, the board MCP server and the mesh commands run from ${RUN_ROOT:-$HERE}."
}
CURRENT_BEFORE=''
source_remove_current() {
  ((SWITCH_FROM_RELEASE)) || return 0
  CURRENT_BEFORE=$(link_tag "$CURRENT")
  rm -f -- "$CURRENT"
  echo "removed $CURRENT; the releases stay in $RELEASES"
}
# Going back from that switch (scripts/install-linux-units.sh, roll_back_web): current again.
source_restore_current() {
  [[ -n $CURRENT_BEFORE ]] || return 0
  point_link "$CURRENT" "$CURRENT_BEFORE"
  echo "current -> releases/$CURRENT_BEFORE"
}
