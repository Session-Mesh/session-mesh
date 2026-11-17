#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Install, check or remove the Session Mesh plugin of Antigravity (agy).
#   scripts/agy-setup.sh install     write the plugin, validate it, `agy plugin install` it
#   scripts/agy-setup.sh status      `agy plugin list`: is session-mesh installed and enabled
#   scripts/agy-setup.sh uninstall   `agy plugin uninstall session-mesh`
#
# agy has no per-session configuration (no flag, no inline setting, no environment variable for another
# configuration directory), so the board tools and the state hooks of a terminal started by Session Mesh
# come from this plugin, which you install once. It holds no credential: the bridge and the hook read
# the session token from the environment of the terminal. Outside one the hook does nothing and the
# bridge exits with an error, so every agy then starts a failing `mesh-board` MCP server. `install`
# runs agy's own `plugin install` and fails (writing nothing) when the bridge is not executable; it
# never edits an agy configuration file itself. `uninstall` leaves what agy's own install created:
# ~/.gemini/config/import_manifest.json ({"imports": null}) and an empty plugins/ directory.
# Reinstall after moving the checkout or the installed binaries: the plugin names their absolute paths.
#
# Variables: MESH_AGY (the agy executable, default `agy` from PATH), MESH_PYTHON (default python3).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGY="${MESH_AGY:-agy}"
PY="${MESH_PYTHON:-python3}"
NAME="session-mesh"

die() { echo "agy-setup: $*" >&2; exit 1; }
command -v "$AGY" >/dev/null 2>&1 || [ -x "$AGY" ] || die "no agy executable ($AGY)"

case "${1:-}" in
  install)
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    "$PY" -I "$ROOT/agentmcp.py" agy-plugin "$work/$NAME"
    "$AGY" plugin validate --strict "$work/$NAME"
    "$AGY" plugin install "$work/$NAME"
    ;;
  status)
    "$AGY" plugin list
    ;;
  uninstall)
    "$AGY" plugin uninstall "$NAME"
    ;;
  *)
    die "usage: agy-setup.sh install|status|uninstall"
    ;;
esac
