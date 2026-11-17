# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash disable=SC2034 # SERVE and SERVED_HOST are read by the sourcing installer
# session-mesh installer, the parts shared by Linux and macOS: port numbers, the health check and
# the tailnet publication. Sourced by install.sh after step, warn and refuse; never run on its own.
# PORT and ACCOUNT are set by the platform part before these functions run. Written for bash 3.2.

# 1-65535 without a leading zero (bash arithmetic would read one as octal). The digits are
# listed: under a UTF-8 locale [0-9] and [[:digit:]] may also match other scripts' digits.
port_number() {
  case $1 in ''|0*|*[!0123456789]*) return 1 ;; esac
  ((${#1} <= 5 && 10#$1 <= 65535))
}

# Removes JSON whitespace outside strings only; whitespace inside a string is kept, so such a
# string can never match the "ours" pattern below. Prints nothing for an oversized input.
json_compact() {
  local raw=$1 out='' char in_string=0 escaped=0 i
  ((${#raw} <= 4096)) || return 0
  for ((i = 0; i < ${#raw}; i++)); do
    char=${raw:i:1}
    if ((in_string)); then
      if ((escaped)); then escaped=0
      elif [[ $char == "\\" ]]; then escaped=1
      elif [[ $char == '"' ]]; then in_string=0
      fi
    elif [[ $char == '"' ]]; then in_string=1
    elif [[ $char == [[:space:]] ]]; then continue
    fi
    out+=$char
  done
  printf '%s' "$out"
}

# Reads this node's tailscale serve configuration into SERVE: "empty", "ours" (exactly the HTTPS
# root proxied to this service; host in SERVED_HOST), "unreadable" (status command failed, or
# printed nothing or null: tailscaled stopped, for example) or "foreign" (anything else).
# Only "empty" and "ours" are ever acted on.
SERVE=foreign
SERVED_HOST=
read_serve_state() {
  local raw compact ours
  SERVE=unreadable SERVED_HOST=
  raw=$(tailscale serve status --json) || return 0
  compact=$(json_compact "$raw")
  [[ -n $compact && $compact != null ]] || return 0
  SERVE=foreign
  ours='^\{"TCP":\{"443":\{"HTTPS":true\}\},"Web":\{"([A-Za-z0-9.-]+):443":\{"Handlers":\{"/":\{"Proxy":"http://127\.0\.0\.1:'"$PORT"'"\}\}\}\}\}$'
  if [[ $compact == '{}' ]]; then SERVE=empty
  elif [[ $compact =~ $ours ]]; then SERVE=ours SERVED_HOST=${BASH_REMATCH[1]}
  fi
}
serve_refusal() {
  case $SERVE in
    unreadable) refuse "tailscale serve status is unreadable (is tailscaled running?); $1 (inspect: tailscale serve status)" ;;
    foreign) refuse "tailscale serve $2 something else on this node; $1 (inspect: tailscale serve status)" ;;
  esac
}

# --uninstall: removes this service's publication only, never another one.
remove_serve_publication() {
  read_serve_state
  case $SERVE in
    ours)
      tailscale serve --https=443 off
      echo "Removed this service's tailscale serve publication (HTTPS root of this node)."
      ;;
    empty) ;;
    unreadable) warn "tailscale serve status is unreadable (is tailscaled running?): left untouched" ;;
    *) warn "tailscale serve publishes something other than this service: left untouched" ;;
  esac
}

# --noproxy: a proxy set in the environment (http_proxy) must not answer for the loopback service.
health() { curl --noproxy '*' -fs -o /dev/null "http://127.0.0.1:$PORT/login"; }

# The only sudo: asked on the terminal first; without a terminal or a yes, refuse and name it.
grant_operator() {
  local command="sudo tailscale set --operator=$ACCOUNT" answer=''
  [[ -t 0 ]] || refuse "tailscale needs operator rights; run '$command' yourself, then rerun with --tailscale (the service already runs on 127.0.0.1:$PORT)"
  printf 'tailscale refuses without operator rights. Run "%s" now? [y/N] ' "$command"
  read -r answer || true
  # [y/N]: y or yes in any case, surrounding blanks ignored, nothing else (bash 3.2: no ${var,,}).
  answer=${answer#"${answer%%[![:space:]]*}"}
  answer=${answer%"${answer##*[![:space:]]}"}
  case $answer in [yY] | [yY][eE][sS]) ;; *) refuse "not published; the service runs on 127.0.0.1:$PORT" ;; esac
  sudo tailscale set --operator="$ACCOUNT"
}

publish_tailscale() {
  local serve_error
  read_serve_state
  serve_refusal "nothing was published" "now publishes"
  if [[ $SERVE == empty ]]; then
    serve_error=$(mktemp "${TMPDIR:-/tmp}/mesh-serve.XXXXXXXX")
    trap 'rm -f -- "$serve_error"' EXIT
    # stderr goes to the terminal as it is written (tailscale may print a URL and wait) and to a
    # file, to recognise a missing operator right afterwards.
    if ! { tailscale serve --bg "$PORT" 2>&1 >&3 | tee "$serve_error" >&2; } 3>&1; then
      grep -qi "access denied\|operator" "$serve_error" || refuse "tailscale serve failed (its output is above); the service runs on 127.0.0.1:$PORT"
      grant_operator
      tailscale serve --bg "$PORT"
    fi
    rm -f -- "$serve_error"
    trap - EXIT
    read_serve_state
  fi
  [[ $SERVE == ours ]] || refuse "tailscale serve does not show the expected publication"
}
