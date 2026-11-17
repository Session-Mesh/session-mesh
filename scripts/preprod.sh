#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# A pre-production mesh, started from this checkout, that cannot disturb the live one.
#   scripts/preprod.sh start     ptyhost + server on port 7691 (see the variables below)
#   scripts/preprod.sh stop      close its sessions, stop its server and ptyhost (only those)
#   scripts/preprod.sh status    running or not, URL, token file
#   scripts/preprod.sh check     only the safety check (exit 0: nothing here is the live mesh's)
#
# What is separate from the live mesh: the port, the config dir (MESH_CONF_DIR: token, snapshot,
# mesh.json, push store, VAPID key, pending), the cache dir (MESH_CACHE_DIR: uploads, history
# cache) and the runtime dir (MESH_RUNTIME_DIR and XDG_RUNTIME_DIR: hence the ptyhost socket; both
# are set, since MESH_RUNTIME_DIR takes precedence and an inherited one would name the live
# socket). HOME is NOT changed, so
# claude and codex keep their logins. Push is off (MESH_PUSH=0): no subscription, no notification.
# It installs nothing and never touches the systemd units.
#
# Variables (all optional):
#   MESH_PREPROD_PORT     listen port                  (default 7691)
#   MESH_PREPROD_DIR      config + cache + pid files   (default ~/.cache/session-mesh-preprod)
#   MESH_PREPROD_RUNTIME  its runtime dir              (default /tmp/session-mesh-preprod-<uid>)
#   MESH_PYTHON            prepared Python interpreter  (default worktree .venv, then python3)
#   MESH_PTYHOST_CMD      absolute path of the native PTY host executable, no arguments (default: mesh-ptyhost on PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MESH_PREPROD_PORT:-7691}"
BASE="${MESH_PREPROD_DIR:-$HOME/.cache/session-mesh-preprod}"
RUNTIME="${MESH_PREPROD_RUNTIME:-/tmp/session-mesh-preprod-$(id -u)}"
CONF="$BASE/conf"
CACHE="$BASE/cache"
SOCK="$RUNTIME/session-mesh/ptyhost.sock"
PY="${MESH_PYTHON:-python3}"
[ -z "${MESH_PYTHON:-}" ] && [ -x "$ROOT/.venv/bin/python" ] && PY="$ROOT/.venv/bin/python"
PTYHOST=()
if [ -n "${MESH_PTYHOST_CMD:-}" ]; then
  # One path, no arguments (CONTRIBUTING.md, "Which PTY host the tests run"): never split.
  PTYHOST=("$MESH_PTYHOST_CMD")
elif command -v mesh-ptyhost >/dev/null 2>&1; then
  PTYHOST=("$(command -v mesh-ptyhost)")
fi

die() { echo "preprod: $*" >&2; exit 1; }

real() { realpath -m -- "$1"; }

# true when $1 is $2 or inside it
within() { case "$1/" in "$2"/*) return 0 ;; esac; return 1; }

# true when the pid in file $1 is a live process of this launcher: it was started with
# MESH_PREPROD_ROOT=$ROOT in its environment (the native host's command line names no checkout)
pid_alive() {
  local pid
  pid="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && grep -azqxF -- "MESH_PREPROD_ROOT=$ROOT" "/proc/$pid/environ" 2>/dev/null
}

port_busy() {
  "$PY" - "$PORT" <<'PYEOF'
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # a port in TIME_WAIT is free
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(0)
sys.exit(1)
PYEOF
}

safety_check() {
  { [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ]; } || die "invalid port: $PORT"
  # The live mesh: port 7690 (or the MESH_PORT this shell carries), ~/.config/session-mesh, and
  # the user's own runtime dir (where its ptyhost socket is): MESH_RUNTIME_DIR, else
  # XDG_RUNTIME_DIR, else /run/user/<uid>; each one this shell carries is checked.
  local live_port="${MESH_PORT:-7690}" uid
  uid="$(id -u)"
  if [ "$PORT" = 7690 ] || [ "$PORT" = "$live_port" ]; then die "refusing: port $PORT is the live mesh's"; fi
  local live_conf conf
  live_conf="$(real "$HOME/.config/session-mesh")"
  conf="$(real "$CONF")"
  if within "$conf" "$live_conf" || within "$live_conf" "$conf"; then
    die "refusing: config dir $conf is, or contains, the live mesh's ($live_conf)"
  fi
  local runtime live_runtime
  runtime="$(real "$RUNTIME")"
  for live_runtime in "/run/user/$uid" "${XDG_RUNTIME_DIR:-/run/user/$uid}" \
      "${MESH_RUNTIME_DIR:-/run/user/$uid}"; do
    live_runtime="$(real "$live_runtime")"
    if [ "$runtime" = "$live_runtime" ] || [ "$(real "$SOCK")" = "$live_runtime/session-mesh/ptyhost.sock" ]; then
      die "refusing: runtime dir $runtime (socket $SOCK) is the live mesh's"
    fi
  done
  if ! pid_alive "$BASE/server.pid" && port_busy; then
    die "refusing: port $PORT is already in use by something else"
  fi
  return 0
}

run_mesh() {   # run "$@" with the pre-production environment
  env MESH_RUNTIME_DIR="$RUNTIME" XDG_RUNTIME_DIR="$RUNTIME" MESH_CONF_DIR="$CONF" MESH_CACHE_DIR="$CACHE" \
      MESH_PORT="$PORT" MESH_PUSH=0 "$@"
}

require_runtime() {
  # Fail before creating a socket, pid file or child process.  A fresh worktree
  # often has no .venv, and silently falling through to a system Python without
  # aiohttp used to leave an opaque server.log failure after the launch timeout.
  if ! "$PY" -c 'import aiohttp' >/dev/null 2>&1; then
    die "selected Python cannot import aiohttp: $PY (set MESH_PYTHON or create this worktree's .venv)"
  fi
  if [ "${#PTYHOST[@]}" -eq 0 ]; then
    die "no native PTY host: set MESH_PTYHOST_CMD to the mesh-ptyhost executable (scripts/bootstrap.sh builds it), or put mesh-ptyhost on PATH"
  fi
}

report() {
  echo "pre-production mesh: http://127.0.0.1:$PORT/login?token=\$(cat $CONF/token)"
  echo "  token   : $CONF/token"
  echo "  config  : $CONF   cache: $CACHE"
  echo "  socket  : $SOCK"
  echo "  logs    : $BASE/server.log  $BASE/ptyhost.log"
  echo "  push    : off (MESH_PUSH=0)"
}

launch() {   # launch NAME COMMAND...: a new session, so stopping it never signals this shell; the pid file holds the process itself
  local name=$1
  shift
  run_mesh MESH_PREPROD_ROOT="$ROOT" setsid sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$BASE/$name.pid" "$@" \
    >>"$BASE/$name.log" 2>&1 < /dev/null &
}

start() {
  safety_check
  require_runtime
  mkdir -p -m 700 "$BASE" "$CONF" "$CACHE" "$RUNTIME"
  if ! pid_alive "$BASE/ptyhost.pid"; then
    launch ptyhost "${PTYHOST[@]}"
  fi
  if ! pid_alive "$BASE/server.pid"; then
    launch server "$PY" "$ROOT/server.py"
  fi
  local i
  for i in $(seq 1 100); do
    if [ -S "$SOCK" ] && port_busy; then break; fi
    sleep 0.1
  done
  if ! { [ -S "$SOCK" ] && port_busy; }; then die "did not come up, see $BASE/server.log and $BASE/ptyhost.log"; fi
  report
}

stop_pid() {   # stop the launcher's own process in pid file $1, nothing else
  if pid_alive "$1"; then
    local pid i
    pid="$(cat "$1")"
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$1"
}

close_sessions() {   # stopping ptyhost alone would leave its shells running: close each first
  [ -S "$SOCK" ] || return 0
  run_mesh "$PY" - "$ROOT" <<'PYEOF' || true
import asyncio, sys
sys.path.insert(0, sys.argv[1])
import ptyhost
async def main():
    for s in await ptyhost.request({"op": "list"}):
        await ptyhost.request({"op": "kill", "name": s["name"]})
asyncio.run(main())
PYEOF
}

stop() {
  safety_check
  stop_pid "$BASE/server.pid"
  if pid_alive "$BASE/ptyhost.pid"; then close_sessions; sleep 0.5; fi
  stop_pid "$BASE/ptyhost.pid"
  echo "pre-production mesh stopped"
}

status() {
  if pid_alive "$BASE/server.pid" && pid_alive "$BASE/ptyhost.pid"; then
    echo "running"
    report
  else
    echo "stopped"
    exit 3
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  check) safety_check; echo "ok: port $PORT, config $CONF, runtime $RUNTIME are not the live mesh's" ;;
  *) echo "usage: $0 start|stop|status|check" >&2; exit 2 ;;
esac
