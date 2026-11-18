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
#   2. on x86_64 with a DEB822 ubuntu.sources, points the Ubuntu archive URIs at
#      azure.archive.ubuntu.com (a stanza whose Suites end in -security is left untouched, whatever
#      its URI), then checks the result with an
#      `apt-get update` limited to ubuntu.sources, bounded by `timeout` and run with
#      --error-on=any (apt's default "persistent" mode turns a failed fetch into a warning
#      with exit status 0, which would keep a dead mirror); if that fails, the original file is restored.
# Trade-off: the previous `mirror+file:` list had fallback mirrors, a single URI has none, so if azure
# dies after the check, installs fail despite the retries. Keeping the original list as a second URI is
# not done: sources.list(5) only says several URIs behave like several entries, "listed in order of
# preference", with no documented fallback from one to the other, and the check and every later
# `apt-get update` would also query the slow mirror.
# It never fails the job: every problem is a notice and the exit status is 0. apt still verifies the
# signatures. Disable with CI_APT_MIRROR_DISABLE=1 in the environment of the step, or remove the step.
# No-op off Linux. The paths and the mirror can be overridden for the tests of the script.
set -euo pipefail

conf_file="${CI_APT_CONF_FILE:-/etc/apt/apt.conf.d/zzz-ci-retries}"
sources_file="${CI_APT_SOURCES_FILE:-/etc/apt/sources.list.d/ubuntu.sources}"
# Outside sources.list.d, where apt would complain about an unknown extension.
backup_file="${CI_APT_BACKUP_FILE:-/etc/apt/ubuntu.sources.ci-original}"
failed_marker="${backup_file}.restore-failed"
mirror_uri="${CI_APT_MIRROR_URI:-http://azure.archive.ubuntu.com/ubuntu/}"
check_seconds="${CI_APT_CHECK_SECONDS:-120}"

notice() { echo "fast-apt-mirror: $*"; }

write_retries() {
  printf '%s\n' \
    'Acquire::Retries "3";' \
    'Acquire::http::Timeout "20";' \
    'Acquire::https::Timeout "20";' | sudo tee "$conf_file" >/dev/null
}

# Rewrites the URIs line of every stanza whose Suites do not include a "-security" suite. Stanzas are
# the blank-line separated paragraphs; the runner image may list the security stanza on the same
# mirror+file: list as the archive one, so a plain per-line substitution would move it too.
# Idempotent: a stanza already on the mirror is rewritten to the same text.
switch_sources() {
  local tmp status
  tmp="$(mktemp)" || return 1
  MIRROR_URI="$mirror_uri" awk '
    function flush(   k, out, p) {
      for (k = 1; k <= n; k++) {
        out = lines[k]
        if (!secure && out ~ /^URIs:/) {
          sub(/mirror\+file:\/etc\/apt\/apt-mirrors\.txt/, "\001", out)
          sub(/http:\/\/[A-Za-z0-9.-]*archive\.ubuntu\.com\/ubuntu\/?/, "\001", out)
          while ((p = index(out, "\001")) > 0) out = substr(out, 1, p - 1) ENVIRON["MIRROR_URI"] substr(out, p + 1)
        }
        print out
      }
      n = 0; secure = 0
    }
    /^[ \t]*$/ { flush(); print; next }
    { lines[++n] = $0 }
    /^Suites:/ { for (f = 2; f <= NF; f++) if ($f ~ /-security$/) secure = 1 }
    END { flush() }
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
  if switch_sources && mirror_answers; then
    notice "using $mirror_uri"
    return 0
  fi
  notice "$mirror_uri did not answer in ${check_seconds} s, restoring the original sources"
  restore_sources
  return 0
}

main || notice "unexpected error, continuing"
exit 0
