#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Install Ubuntu packages on a CI runner, surviving a package mirror that fails for a few minutes.
#   bash .github/scripts/apt-install.sh PACKAGE...
#   bash .github/scripts/apt-install.sh --playwright-deps BROWSER
# The second form installs the system packages Playwright needs for BROWSER, the list taken from
# `python -m playwright install-deps --dry-run BROWSER` (what `playwright install --with-deps` runs).
# Every workflow job installs its Ubuntu packages through this script, after
# .github/scripts/fast-apt-mirror.sh; tests/ci-apt-mirror.test.ts refuses a bare apt-get install.
#
# Each attempt runs `apt-get update`, then `apt-get install --download-only`, each bounded by
# `timeout` (killing a download is safe, apt resumes it on the next attempt). Once every package is in
# the local archive, the real install runs without a bound and without the network. An attempt that
# fails with a mirror error (a failed fetch, a 5xx, a connection or name resolution error, a hash
# mismatch, or the time bound) is retried after a pause; before the last attempt
# `fast-apt-mirror.sh --fallback` points the Ubuntu URIs at a second host. Any other failure (an
# unknown package, a dependency conflict) fails at once: retrying would not help.
# When every attempt failed, the job fails with an `::error` annotation titled
# "Package mirror unavailable" that names the hosts in the errors.
# Worst case with the defaults: 3 x (120 s + 600 s) + 30 s + 60 s = 37.5 min if every attempt
# runs into the time bounds; a mirror that refuses or errors fails each attempt in seconds, and the
# whole run then costs about the pauses, 1.5 min, plus apt's own retries.
# Settings (the tests shorten them): CI_APT_ATTEMPTS (3), CI_APT_PAUSES ("30 60", seconds, one per
# retry, the last one repeated), CI_APT_UPDATE_SECONDS (120), CI_APT_DOWNLOAD_SECONDS (600),
# CI_APT_MIRROR_SCRIPT (the fast-apt-mirror.sh next to this script), CI_APT_PYTHON (python).
set -uo pipefail

attempts="${CI_APT_ATTEMPTS:-3}"
read -r -a pauses <<<"${CI_APT_PAUSES:-30 60}"
update_seconds="${CI_APT_UPDATE_SECONDS:-120}"
download_seconds="${CI_APT_DOWNLOAD_SECONDS:-600}"
mirror_script="${CI_APT_MIRROR_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/fast-apt-mirror.sh}"
python="${CI_APT_PYTHON:-python}"
lock_option='DPkg::Lock::Timeout=120'
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

# Runs one apt-get command as root under a time bound, keeping its output for the classification.
bounded() {
  local seconds="$1"
  shift
  sudo timeout "$seconds" apt-get "$@" 2>&1 | tee -a "$output"
  return "${PIPESTATUS[0]}"
}

attempt() {
  : >"$output"
  bounded "$update_seconds" update -q || return
  bounded "$download_seconds" install -y -q --no-install-recommends --download-only -o "$lock_option" "${packages[@]}"
}

failing_hosts() {
  grep -E "$mirror_errors" "$output" | grep -oE 'https?://[^/ ]+' | sed -E 's#^https?://##' | sort -u | paste -sd, - | sed 's/,/, /g'
}

packages=()
if [ "${1:-}" = "--playwright-deps" ]; then
  [ $# -eq 2 ] || fail "apt-install usage" "usage: apt-install.sh --playwright-deps BROWSER"
  playwright_packages "$2" || fail "apt-install could not list packages" "playwright install-deps --dry-run $2 printed no apt-get install line"
else
  packages=("$@")
fi
[ "${#packages[@]}" -gt 0 ] || fail "apt-install usage" "no package to install"
for package in "${packages[@]}"; do
  [[ "$package" =~ ^[a-z0-9][a-z0-9.+:-]*$ ]] || fail "apt-install refused a package name" "not a package name: $package"
done
say "installing ${#packages[@]} packages: ${packages[*]}"

hosts=""
for ((number = 1; number <= attempts; number++)); do
  attempt
  status=$?
  if [ "$status" -eq 0 ]; then
    if sudo apt-get install -y -q --no-install-recommends -o "$lock_option" "${packages[@]}"; then
      say "installed on attempt $number of $attempts"
      exit 0
    fi
    fail "apt-get install failed" "the packages were downloaded but apt-get install failed: not a mirror outage"
  fi
  if [ "$status" -ne 124 ] && ! grep -Eq "$mirror_errors" "$output"; then
    fail "apt-get failed" "apt-get failed with status $status and no mirror error in its output: not retried (see the log above)"
  fi
  hosts="$(failing_hosts)"
  say "attempt $number of $attempts failed with a mirror error${hosts:+ from $hosts} (status $status)"
  [ "$number" -lt "$attempts" ] || break
  if [ "$number" -eq $((attempts - 1)) ]; then
    bash "$mirror_script" --fallback || true
  fi
  pause="${pauses[number - 1]:-${pauses[${#pauses[@]} - 1]}}"
  say "retrying in $pause s"
  sleep "$pause"
done
fail "Package mirror unavailable" "package mirror unavailable: ${#packages[@]} packages could not be downloaded in $attempts attempts${hosts:+ (errors from $hosts)}. Not a code failure: re-run the job."
