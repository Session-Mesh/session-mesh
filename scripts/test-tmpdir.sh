#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Allocate private short scratch without overwriting an explicit filesystem
# choice. No cleanup of existing files/directories or ambient runtime sockets.
mesh_prepare_test_tmpdir() {
  local parent="${TMPDIR-/tmp}" physical LC_ALL=C
  case "$parent" in
    /*) ;;
    *) echo 'test scratch: require an absolute existing parent.' >&2; return 1 ;;
  esac
  if [ ! -d "$parent" ] || [ -L "$parent" ] || [ ! -w "$parent" ]; then
    echo 'test scratch: require a writable physical parent directory.' >&2
    return 1
  fi
  physical="$(cd -- "$parent" && pwd -P)" || return 1
  # Pinned Dune 3.24.2 adds build_XXXXXX_dune beneath sm.XXXXXX. Its Python
  # interop fixture adds pd-home-XXXXXXXX/runtime/session-mesh/ptyhost.sock:
  # 79 bytes of suffix, leaving 28 of Linux's 107 non-NUL pathname bytes.
  if [ "$physical" != "$parent" ] || [ "${#parent}" -gt 28 ]; then
    echo 'test scratch: canonical parent must be at most 28 bytes for sockets.' >&2
    return 1
  fi
  TMPDIR="$(mktemp -d "$parent/sm.XXXXXX")" || return 1
  export TMPDIR
}
