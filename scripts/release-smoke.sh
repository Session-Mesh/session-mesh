#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Smoke check of a built release binary set before it is uploaded.
#   release-smoke.sh <directory holding mesh-ptyhost, mesh-platform, mesh-read, mesh-board-mcp, mesh-history,
#                     mesh-logout-all, mesh-open, mesh-profile, work-read, work-mcp, work-write>
# - mesh-ptyhost is started on a private runtime directory and answers a `list`
#   request on its socket (one frame: kind C, 4-byte big-endian length, JSON);
# - mesh-platform prints its platform facts;
# - mesh-read and mesh-board-mcp start and exit on closed input;
# - mesh-logout-all refuses an argument, and with no mesh on its port raises the generation on disk;
# - work-read answers a request on a private worklog data repository and refuses an unknown
#   operation; work-mcp answers initialize and lists its work_* tools; work-write refuses an answer
#   to an unknown question and refuses to run in an agent session.
# Needs `nc` with -U (OpenBSD netcat: the Ubuntu and macOS runners have it).
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: release-smoke.sh <binary-directory>" >&2
  exit 2
fi
if ! command -v nc >/dev/null 2>&1; then
  echo "smoke: nc (netcat with -U, e.g. netcat-openbsd) is required to reach the host's socket" >&2
  exit 2
fi
# GNU netcat (0.7.1, the nc of some Arch-based systems) has no -U: refuse at once instead of probing 50 times.
nc_help="$(nc -h 2>&1 || true)"
if ! grep -Eq '\[-[0-9A-Za-z]*U' <<<"$nc_help"; then
  echo "smoke: this nc has no -U option; OpenBSD netcat is required (netcat-openbsd, or the one macOS ships), GNU netcat cannot reach a Unix socket" >&2
  exit 2
fi
bin="$(cd "$1" && pwd -P)"
# A short path: a Unix socket path is limited to about 100 bytes. Canonical (pwd -P): on macOS
# /tmp is a symlink to /private/tmp, and the host refuses a runtime directory whose path is not
# canonical.
runtime="$(cd "$(mktemp -d /tmp/mesh-smoke.XXXXXX)" && pwd -P)"
host_pid=""
cleanup() {
  [ -z "$host_pid" ] || kill "$host_pid" 2>/dev/null || true
  rm -r -f -- "$runtime"
}
trap cleanup EXIT

bash "$(dirname "$0")/smoke-profile.sh" "$bin/mesh-profile" "$runtime"

unset MESH_RUNTIME_DIR
XDG_RUNTIME_DIR="$runtime" "$bin/mesh-ptyhost" 2>"$runtime/stderr" &
host_pid=$!
socket="$runtime/session-mesh/ptyhost.sock"
for _ in $(seq 1 100); do
  [ -S "$socket" ] && break
  kill -0 "$host_pid" 2>/dev/null || { cat "$runtime/stderr" >&2; echo "smoke: mesh-ptyhost exited early" >&2; exit 1; }
  sleep 0.1
done
[ -S "$socket" ] || { echo "smoke: no socket at $socket" >&2; exit 1; }

# `{"op":"list"}` is 13 bytes: frame header C + 00 00 00 0d.
reply=""
for _ in $(seq 1 50); do
  reply="$(printf 'C\000\000\000\015{"op":"list"}' | nc -U -w 2 "$socket" | od -An -c | tr -d ' \n' || true)"
  [ -n "$reply" ] && break
  sleep 0.1
done
# Reply: C, length 00 00 00 02, then the empty list [].
expected='C\0\0\0002[]'
[ "$reply" = "$expected" ] || { echo "smoke: unexpected list reply: $reply" >&2; exit 1; }
echo "smoke: mesh-ptyhost answers a list request"

facts="$("$bin/mesh-platform" capabilities)"
[ -n "$facts" ] || { echo "smoke: mesh-platform printed nothing" >&2; exit 1; }
echo "smoke: mesh-platform prints facts"

# Closed input: the stdio servers must start (a missing library would fail
# here) and finish; mesh-read without configuration exits 78 with a message.
for program in mesh-read mesh-board-mcp; do
  status=0
  "$bin/$program" </dev/null >/dev/null 2>"$runtime/$program.err" || status=$?
  case "$status" in
    0 | 78 | 1) ;;
    *) echo "smoke: $program exited $status" >&2; cat "$runtime/$program.err" >&2; exit 1 ;;
  esac
  echo "smoke: $program starts (exit $status)"
done

# mesh-history, on a private database (FTS5, accent folding, a search for "cafe" finds "Café").
bash "$(dirname "$0")/smoke-history.sh" "$bin/mesh-history" "$runtime"

open_help="$(env -u MESH_CACHE_DIR MESH_CONF_DIR="$runtime" "$bin/mesh-open" --help)"
printf '%s\n' "$open_help" | grep -q '^usage: mesh-open.*--reload.*--watch'

# mesh-logout-all: an argument gives the usage and exit 1; then, on a private configuration
# directory and port 1 (no mesh there), it raises the generation on disk: the HTTP client and the
# generation file both run.
logout_conf="$runtime/logout-all"
mkdir -m 700 "$logout_conf"
printf 'smoke-token\n' >"$logout_conf/token"
status=0
"$bin/mesh-logout-all" --help >/dev/null 2>"$runtime/mesh-logout-all.err" || status=$?
if [ "$status" -ne 1 ] || ! grep -q '^usage: mesh-logout-all' "$runtime/mesh-logout-all.err"; then
  echo "smoke: mesh-logout-all --help exited $status without its usage" >&2
  cat "$runtime/mesh-logout-all.err" >&2
  exit 1
fi
logged_out="$(env -u MESH_CACHE_DIR MESH_CONF_DIR="$logout_conf" MESH_PORT=1 "$bin/mesh-logout-all")"
expected_out='The mesh is not responding: generation raised on disk (1). All devices are signed out.'
[ "$logged_out" = "$expected_out" ] || { echo "smoke: unexpected mesh-logout-all output: $logged_out" >&2; exit 1; }
[ "$(cat "$logout_conf/cookie-generation")" = 1 ] || { echo "smoke: mesh-logout-all did not write generation 1" >&2; exit 1; }
echo "smoke: mesh-logout-all raises the generation on disk when no mesh answers"

# work-read, on a private worklog data repository (WL_HOME) that holds only a taxonomy: a request on
# standard input, as the web server sends it for /api/work/v1, gives the products document (exit 0);
# an unknown operation gives an invalid_input document and exit 2.
work_home="$runtime/worklog"
mkdir -m 700 "$work_home"
printf 'categories:\n  smoke:\n    name: Smoke\n    products:\n      - smoke-product\n' >"$work_home/taxonomy.yaml"
work_out="$(printf '{"op":"products","args":{}}' | env -i HOME="$runtime" WL_HOME="$work_home" "$bin/work-read" --request)" \
  || { echo "smoke: work-read --request failed: $work_out" >&2; exit 1; }
case "$work_out" in
  '{"schema":1,"command":"products",'*'"id":"smoke-product"'*) ;;
  *) echo "smoke: unexpected work-read products document: $work_out" >&2; exit 1 ;;
esac
status=0
work_out="$(printf '{"op":"nope"}' | env -i HOME="$runtime" WL_HOME="$work_home" "$bin/work-read" --request)" || status=$?
if [ "$status" -ne 2 ] || [[ "$work_out" != '{"error":{"code":"invalid_input",'* ]]; then
  echo "smoke: work-read refused an unknown operation with exit $status and $work_out" >&2
  exit 1
fi
echo "smoke: work-read answers a request and refuses an unknown operation"

# work-mcp: initialize, then tools/list, on standard input; it answers both and names its work_* tools.
mcp_out="$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"release-smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' |
  env -i HOME="$runtime" WL_HOME="$work_home" "$bin/work-mcp" 2>"$runtime/work-mcp.err")" \
  || { echo "smoke: work-mcp exited with an error" >&2; cat "$runtime/work-mcp.err" >&2; exit 1; }
if ! grep -q '"name":"work-mcp"' <<<"$mcp_out" || ! grep -q '"name":"work_' <<<"$mcp_out"; then
  echo "smoke: work-mcp did not answer initialize and tools/list: $mcp_out" >&2
  exit 1
fi
echo "smoke: work-mcp answers initialize and lists its work_* tools"

# work-write, on the same repository: an answer to a question it does not hold is not_found (exit 3,
# nothing written), and in an agent session's environment it refuses to run (exit 9).
status=0
work_out="$(printf '{"op":"answer","args":{"question":"N-00000000","text":"smoke"}}' |
  env -i HOME="$runtime" WL_HOME="$work_home" "$bin/work-write" --request)" || status=$?
if [ "$status" -ne 3 ] || [[ "$work_out" != '{"error":{"code":"not_found",'* ]]; then
  echo "smoke: work-write answered an unknown question with exit $status and $work_out" >&2
  exit 1
fi
status=0
work_out="$(printf '{"op":"answer","args":{"question":"N-00000000","text":"smoke"}}' |
  env -i HOME="$runtime" WL_HOME="$work_home" MESH_SESSION=smoke "$bin/work-write" --request)" || status=$?
if [ "$status" -ne 9 ] || [[ "$work_out" != '{"error":{"code":"agent_session",'* ]]; then
  echo "smoke: work-write in an agent session gave exit $status and $work_out" >&2
  exit 1
fi
echo "smoke: work-write refuses an unknown question and an agent session"
