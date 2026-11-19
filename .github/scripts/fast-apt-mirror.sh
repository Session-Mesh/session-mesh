#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Make apt on a GitHub-hosted Ubuntu runner retry and give up on stalled transfers, and point it at
# a fast mirror, before anything installs packages (apt-get, ocaml/setup-ocaml, playwright --with-deps).
#   bash .github/scripts/fast-apt-mirror.sh
# Why: the hosted images read /etc/apt/sources.list.d/ubuntu.sources with
# `URIs: mirror+file:/etc/apt/apt-mirrors.txt`, and the mirror that list resolves to varies per job;
# on some runs a regional EC2 mirror delivered 57-99 kB/s with stalls of 20-200 s per package.
# What it does:
#   1. writes an apt configuration with retries and a 20 s network timeout (a stall, not a total time),
#      named zzz-ci-retries so it sorts after the runner image's own zz-retries and wins;
#   2. on x86_64 with a DEB822 ubuntu.sources, points every Ubuntu URI (the mirror+file list, any
#      *archive.ubuntu.com host and security.ubuntu.com, so the -security stanza too: the hosted
#      images fetch from security.ubuntu.com, which answered 503 for whole jobs on 2026-11-19) at
#      azure.archive.ubuntu.com, which carries the -security suites as well, then checks the result
#      with an `apt-get update` limited to ubuntu.sources, bounded by `timeout` and run with
#      --error-on=any (apt's default "persistent" mode turns a failed fetch into a warning
#      with exit status 0, which would keep a dead mirror); if that fails, the original file is restored.
# Trade-off: the previous `mirror+file:` list had fallback mirrors, a single URI has none. Keeping the
# original list as a second URI is not done: sources.list(5) only says several URIs behave like several
# entries, "listed in order of preference", with no documented fallback from one to the other, and the
# check and every later `apt-get update` would also query the slow mirror. Instead,
# .github/scripts/apt-install.sh retries, and before its last attempt runs this script with
# `--fallback`, which points the same URIs at archive.ubuntu.com (CI_APT_FALLBACK_URI), a second
# host that also carries every suite.
# It never fails the job: every problem is a notice and the exit status is 0. apt still verifies the
# signatures. Disable with CI_APT_MIRROR_DISABLE=1 in the environment of the step, or remove the step.
# No-op off Linux. The paths and the mirrors can be overridden for the tests of the script.
set -euo pipefail

conf_file="${CI_APT_CONF_FILE:-/etc/apt/apt.conf.d/zzz-ci-retries}"
sources_file="${CI_APT_SOURCES_FILE:-/etc/apt/sources.list.d/ubuntu.sources}"
# Outside sources.list.d, where apt would complain about an unknown extension.
backup_file="${CI_APT_BACKUP_FILE:-/etc/apt/ubuntu.sources.ci-original}"
failed_marker="${backup_file}.restore-failed"
mirror_uri="${CI_APT_MIRROR_URI:-http://azure.archive.ubuntu.com/ubuntu/}"
fallback_uri="${CI_APT_FALLBACK_URI:-http://archive.ubuntu.com/ubuntu/}"
check_seconds="${CI_APT_CHECK_SECONDS:-120}"

notice() { echo "fast-apt-mirror: $*"; }

write_retries() {
  printf '%s\n' \
    'Acquire::Retries "3";' \
    'Acquire::http::Timeout "20";' \
    'Acquire::https::Timeout "20";' | sudo tee "$conf_file" >/dev/null
}

# Rewrites, on every URIs line, the Ubuntu URIs (the mirror+file list, any *archive.ubuntu.com host,
# security.ubuntu.com) to $1; any other URI (a third-party repository) is left as it is.
# Idempotent: a line already on that mirror is rewritten to the same text.
switch_sources() {
  local tmp status
  tmp="$(mktemp)" || return 1
  MIRROR_URI="$1" awk '
    /^URIs:/ {
      out = $0
      gsub(/mirror\+file:\/etc\/apt\/apt-mirrors\.txt/, "\001", out)
      gsub(/http:\/\/[A-Za-z0-9.-]*archive\.ubuntu\.com\/ubuntu\/?/, "\001", out)
      gsub(/http:\/\/security\.ubuntu\.com\/ubuntu\/?/, "\001", out)
      while ((p = index(out, "\001")) > 0) out = substr(out, 1, p - 1) ENVIRON["MIRROR_URI"] substr(out, p + 1)
      print out
      next
    }
    { print }
  ' "$sources_file" >"$tmp" && sudo cp "$tmp" "$sources_file"
  status=$?
  rm -f "$tmp"
  return $status
}

mirror_answers() {
  sudo timeout "$check_seconds" apt-get update -q \
    --error-on=any -o "Dir::Etc::sourcelist=$sources_file" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null
}

restore_sources() {
  if sudo cp -p "$backup_file" "$sources_file"; then
    sudo rm -f "$backup_file" || true
  else
    sudo touch "$failed_marker" || true
    notice "restore failed: $backup_file holds the original, $sources_file may still name $mirror_uri"
  fi
}

# True only when an archive URIs line really names the new mirror.
is_switched() { grep -q "^URIs:.*${mirror_uri}" "$sources_file"; }

main() {
  if [ "$(uname -s)" != "Linux" ] || [ "${CI_APT_MIRROR_DISABLE:-0}" = "1" ]; then
    return 0
  fi
  if ! write_retries; then
    notice "could not write $conf_file, leaving apt unchanged"
    return 0
  fi
  notice "retries and timeouts written to $conf_file"
  apt-config dump Acquire::Retries Acquire::http::Timeout Acquire::https::Timeout 2>/dev/null | sed "s/^/fast-apt-mirror: effective /" || true
  if [ "$(uname -m)" != "x86_64" ] || [ ! -f "$sources_file" ]; then
    notice "no DEB822 ubuntu.sources on x86_64, keeping the runner's mirror"
    return 0
  fi
  if [ -f "$failed_marker" ]; then
    notice "an earlier restore failed, not touching $sources_file (original in $backup_file)"
    return 0
  fi
  if [ -f "$backup_file" ]; then
    if is_switched; then
      notice "mirror already switched, nothing to do"
    else
      notice "a backup exists but $sources_file is not switched, not touching it"
    fi
    return 0
  fi
  if ! grep -q '^URIs:' "$sources_file" || ! sudo cp -p "$sources_file" "$backup_file"; then
    notice "cannot back up $sources_file, keeping the runner's mirror"
    return 0
  fi
  if switch_sources "$mirror_uri" && mirror_answers; then
    notice "using $mirror_uri"
    return 0
  fi
  notice "$mirror_uri did not answer in ${check_seconds} s, restoring the original sources"
  restore_sources
  return 0
}

# --fallback, run by apt-install.sh before its last attempt: points the Ubuntu URIs at the second
# host, whatever they name now (the fast mirror, or the runner's own list after a restore). No check
# of its own: the caller runs `apt-get update` next and reports its errors.
fallback() {
  if [ "$(uname -s)" != "Linux" ] || [ "${CI_APT_MIRROR_DISABLE:-0}" = "1" ]; then
    return 0
  fi
  if [ "$(uname -m)" != "x86_64" ] || [ ! -f "$sources_file" ] || [ -f "$failed_marker" ]; then
    notice "fallback: no DEB822 ubuntu.sources to change on this runner"
    return 0
  fi
  if switch_sources "$fallback_uri"; then
    notice "fallback: the Ubuntu URIs now name $fallback_uri"
  else
    notice "fallback: could not rewrite $sources_file"
  fi
}

case "${1:-}" in
  --fallback) fallback || notice "unexpected error in the fallback, continuing" ;;
  *) main || notice "unexpected error, continuing" ;;
esac
exit 0
