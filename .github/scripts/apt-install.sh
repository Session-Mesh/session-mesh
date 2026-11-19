#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Install Ubuntu packages on a CI runner, surviving a package mirror that fails for a few minutes.
#   bash .github/scripts/apt-install.sh PACKAGE...
#   bash .github/scripts/apt-install.sh PACKAGE... --if-available PACKAGE...
#   bash .github/scripts/apt-install.sh --playwright-deps BROWSER
# The packages after --if-available are installed only when the package index knows them (setup-ocaml
# installs darcs, g++-multilib, gcc-multilib and mercurial on that condition; Ubuntu 24.04 has no darcs).
# The second form installs the system packages Playwright needs for BROWSER, the list taken from
# `python -m playwright install-deps --dry-run BROWSER` (what `playwright install --with-deps` runs).
# Every workflow job installs its Ubuntu packages through this script, after
# .github/scripts/fast-apt-mirror.sh; tests/ci-apt-mirror.test.ts refuses a bare apt-get install.
#
# Each attempt runs `apt-get update`, then `apt-get install --download-only`, each bounded by
# `timeout` (killing a download is safe, apt resumes it on the next attempt). Once every package is in
# the local archive, the real install runs without a bound and without the network. An attempt that
# fails with a mirror error is retried after a pause: the time bound, or a failed fetch (a 5xx, a
# connection or name resolution error, a hash mismatch) from a source the script manages (*.ubuntu.com,
# the hosts of fast-apt-mirror.sh, and the runner image's list mirror+file:/etc/apt/apt-mirrors.txt, which
# apt names in place of the host). Only the error lines of the failing command's output count: a warning
# such as apt's `_apt` sandbox notice (Permission denied) does not hide a mirror error. Before the last attempt
# `fast-apt-mirror.sh --fallback` points the Ubuntu URIs at a second host (not when CI_APT_MIRROR_DISABLE=1
# is set in this step's environment). Any other failure (an unknown package, a dependency conflict, a
# full disk, a lock, an error from another host) fails at once: retrying would not help. `apt-get update`
# runs with --error-on=any: a fetch error from a managed host fails the attempt, so --if-available never
# skips a package because the index is incomplete; an error from another host only warns.
# When every attempt failed, the job fails with an `::error` annotation titled
# "Package mirror unavailable" that names the hosts in the errors.
# A command killed after the grace period (status 137) counts as the time bound, like status 124.
# Worst case with the defaults: 3 x (120 s + 600 s + 2 x 30 s kill grace) + 30 s + 60 s = 40.5 min if every attempt
# runs into the time bounds; a mirror that refuses or errors fails each attempt in seconds, and the
# whole run then costs about the pauses, 1.5 min, plus apt's own retries.
# Settings (the tests shorten them): CI_APT_ATTEMPTS (3), CI_APT_PAUSES ("30 60", seconds, one per
# retry, the last one repeated), CI_APT_UPDATE_SECONDS (120), CI_APT_DOWNLOAD_SECONDS (600),
# CI_APT_KILL_GRACE (30), CI_APT_MIRROR_SCRIPT (the fast-apt-mirror.sh next to this script),
# CI_APT_PYTHON (python).
set -uo pipefail

attempts="${CI_APT_ATTEMPTS:-3}"
read -r -a pauses <<<"${CI_APT_PAUSES:-30 60}"
update_seconds="${CI_APT_UPDATE_SECONDS:-120}"
download_seconds="${CI_APT_DOWNLOAD_SECONDS:-600}"
mirror_script="${CI_APT_MIRROR_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/fast-apt-mirror.sh}"
python="${CI_APT_PYTHON:-python}"
lock_option='DPkg::Lock::Timeout=120'
kill_grace="${CI_APT_KILL_GRACE:-30}"
# The hosts this script manages: the Ubuntu hosts (any *.ubuntu.com) and the mirror and fallback hosts
# fast-apt-mirror.sh is configured with. Only errors from these count as a mirror outage (and from the
# hosted runner's mirror+file: list, which apt names in place of a host: see failing_hosts).
managed_hosts="[A-Za-z0-9.-]+\\.ubuntu\\.com"
for uri in "${CI_APT_MIRROR_URI:-}" "${CI_APT_FALLBACK_URI:-}"; do
  uri="${uri#*://}"
  [ -z "${uri%%/*}" ] || managed_hosts="$managed_hosts|${uri%%/*}"
done
# Local failures that name a mirror URL in apt's output without the mirror being at fault.
local_errors='No space left on device|Write error|Read-only file system|Permission denied|Could not get lock|Unable to lock|Unable to acquire the dpkg|Could not open file|Input/output error|Cannot allocate memory'
mirror_errors='Failed to fetch|^Err:|Could not connect|Could not resolve|Temporary failure resolving|Connection failed|Connection timed out|Unable to connect|Unable to fetch some archives|Hash Sum mismatch|File has unexpected size|Mirror sync in progress|Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error|Undetermined Error|Some index files failed to download'

say() { echo "apt-install: $*"; }

fail() {
  echo "::error title=$1::$2"
  say "$2"
  exit 1
}

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

# The packages of `playwright install-deps --dry-run`, whose one line reads
#   sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends PKG PKG ..."
playwright_packages() {
  local printed rest
  printed="$("$python" -m playwright install-deps --dry-run "$1")" || return 1
  rest="${printed#*--no-install-recommends}"
  [ "$rest" != "$printed" ] || return 1
  rest="${rest//\"/ }"
  rest="${rest//\'/ }"
  read -r -a packages <<<"${rest//$'\n'/ }"
}

# Runs one apt-get command as root under a time bound (killed outright ${kill_grace} s after the
# TERM), keeping its output, and only its output, for the classification of its failure.
bounded() {
  local seconds="$1"
  shift
  : >"$output"
  sudo timeout -k "$kill_grace" "$seconds" apt-get "$@" 2>&1 | tee "$output"
  return "${PIPESTATUS[0]}"
}

# The packages to install: the required ones, plus each --if-available one the package index knows
# (the test setup-ocaml applies to its optional packages, with apt-cache show).
select_packages() {
  local package shown
  selected=("${packages[@]}")
  for package in "${optional[@]}"; do
    # Read the whole output first: `grep -q` closing the pipe early would fail the pipeline (SIGPIPE, pipefail).
    shown="$(apt-cache show --no-all-versions "$package" 2>/dev/null)"
    if [[ $'\n'"$shown"$'\n' == *$'\nPackage: '"$package"$'\n'* ]]; then
      selected+=("$package")
    else
      say "skipping $package: not in the package index"
    fi
  done
}

# The failed fetches in the output of the last command: each `Err:` line with the indented lines
# that explain it, and each `Failed to fetch` line. With `all`, every `E:` line as well.
error_lines() {
  awk -v all="${1:-}" '/^Err:/ { block = 1; print; next }
    /^[ \t]/ { if (block) print; next }
    { block = 0 }
    /Failed to fetch/ || (all && /^E: /) { print }' "$output"
}

# The managed sources named by a failed fetch in the output of the last command, one per line: a
# managed host from a URL or from a name resolution error, or the runner's mirror list.
failing_hosts() {
  error_lines | grep -oE "https?://[^/ :]+|mirror\+file:/etc/apt/apt-mirrors\.txt|(resolving|Could not resolve) '[^']+'" \
    | sed -E "s#^https?://##; s#^(resolving|Could not resolve) '##; s#'\$##" \
    | grep -E "^($managed_hosts)$|^mirror\+file:/etc/apt/apt-mirrors\.txt$" | sort -u
}

# Succeeds when the error lines of the last command name a local failure (full disk, lock).
local_failure() {
  error_lines all | grep -Eq "$local_errors"
}

# Succeeds when the last command failed with status $1 because of a package mirror: the time bound
# (124, or 137 when it had to be killed after the grace period), or a failed fetch from a source this
# script manages. A local error (full disk, lock) or an error from any other host is not one.
is_mirror_failure() {
  [ "$1" -eq 124 ] || [ "$1" -eq 137 ] && return 0
  local_failure && return 1
  error_lines all | grep -Eq "$mirror_errors" && [ -n "$(failing_hosts)" ]
}

# apt-get update runs with --error-on=any so that a failed index fetch fails the command (apt's
# default turns it into a warning with status 0, and a package could then look unknown). A failure
# that names no managed host (a third-party repository) is reported and does not stop the attempt.
update_index() {
  local status
  bounded "$update_seconds" update -q --error-on=any -o "$lock_option"
  status=$?
  [ "$status" -ne 0 ] || return 0
  if is_mirror_failure "$status" || local_failure; then
    return "$status"
  fi
  say "apt-get update reported errors only from hosts this script does not manage (status $status), continuing"
}

attempt() {
  update_index || return
  select_packages
  [ "${#selected[@]}" -gt 0 ] || return 0
  bounded "$download_seconds" install -y -q --no-install-recommends --download-only -o "$lock_option" "${selected[@]}"
}

packages=()
optional=()
selected=()
if [ "${1:-}" = "--playwright-deps" ]; then
  [ $# -eq 2 ] || fail "apt-install usage" "usage: apt-install.sh --playwright-deps BROWSER"
  playwright_packages "$2" || fail "apt-install could not list packages" "playwright install-deps --dry-run $2 printed no apt-get install line"
else
  while [ $# -gt 0 ] && [ "$1" != "--if-available" ]; do
    packages+=("$1")
    shift
  done
  if [ $# -gt 0 ]; then
    shift
    optional=("$@")
  fi
fi
[ $((${#packages[@]} + ${#optional[@]})) -gt 0 ] || fail "apt-install usage" "no package to install"
for package in "${packages[@]}" "${optional[@]}"; do
  [[ "$package" =~ ^[a-z0-9][a-z0-9.+:-]*$ ]] || fail "apt-install refused a package name" "not a package name: $package"
done
say "installing ${#packages[@]} packages: ${packages[*]}${optional[*]:+, and if available: ${optional[*]}}"

hosts=""
for ((number = 1; number <= attempts; number++)); do
  attempt
  status=$?
  if [ "$status" -eq 0 ]; then
    if [ "${#selected[@]}" -eq 0 ]; then
      say "none of the packages is available, nothing to install"
      exit 0
    fi
    if sudo apt-get install -y -q --no-install-recommends -o "$lock_option" "${selected[@]}"; then
      say "installed on attempt $number of $attempts"
      exit 0
    fi
    fail "apt-get install failed" "the packages were downloaded but apt-get install failed: not a mirror outage"
  fi
  if ! is_mirror_failure "$status"; then
    fail "apt-get failed" "apt-get failed with status $status and no mirror error in its output: not retried (see the log above)"
  fi
  seen="$(failing_hosts)"
  hosts="$(printf '%s\n%s\n' "$hosts" "$seen" | grep . | sort -u)"
  say "attempt $number of $attempts failed with a mirror error${seen:+ from $(paste -sd, - <<<"$seen" | sed 's/,/, /g')} (status $status)"
  [ "$number" -lt "$attempts" ] || break
  if [ "$number" -eq $((attempts - 1)) ] && [ "${CI_APT_MIRROR_DISABLE:-0}" != "1" ]; then
    bash "$mirror_script" --fallback || true
  fi
  pause="${pauses[number - 1]:-${pauses[${#pauses[@]} - 1]}}"
  say "retrying in $pause s"
  sleep "$pause"
done
fail "Package mirror unavailable" "package mirror unavailable: ${#packages[@]} packages could not be downloaded in $attempts attempts${hosts:+ (errors from $(paste -sd, - <<<"$hosts" | sed "s/,/, /g"))}. Probably not a code failure: re-run the job."
