# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash disable=SC2034 # SERVE and SERVED_HOST are read by the sourcing installer
# session-mesh installer, the parts shared by Linux and macOS: port numbers, the health check, the
# tailnet publication and the mesh-logout-all link. Sourced by install.sh after step, warn and
# refuse; never run on its own. PORT and ACCOUNT are set by the platform part before these
# functions run; HERE, APP_ROOT, RUN_ROOT, BUNDLE_DIR, RELEASES, CURRENT and MESH_RELEASE_TAG by
# install.sh. Written for bash 3.2.

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

# What ~/.local/bin/mesh-logout-all links to: the native program of the bundle the services run
# (RUN_ROOT: an extracted bundle, or current/ for a bundle release, so an upgrade from a release
# whose bin/mesh-logout-all was the Python wrapper lands on the native one); current/bin's for a
# release of native programs; for a source install, the native program scripts/bootstrap.sh
# installs in the opam switch $1 (else the current one), as for mesh-board-mcp. Nothing when that
# switch lacks it.
logout_all_program() {
  local switch=${1:-} switch_bin
  if [[ -n $RUN_ROOT ]]; then printf '%s' "$RUN_ROOT/bin/mesh-logout-all"; return 0; fi
  if [[ -n $MESH_RELEASE_TAG ]]; then printf '%s' "$CURRENT/bin/mesh-logout-all"; return 0; fi
  command -v opam >/dev/null || return 0
  [[ -n $switch ]] || switch=$(opam switch show 2>/dev/null || true)
  [[ -n $switch ]] || return 0
  switch_bin=$(opam var --switch="$switch" bin 2>/dev/null || true)
  [[ -n $switch_bin && -f $switch_bin/mesh-logout-all && -x $switch_bin/mesh-logout-all ]] || return 0
  printf '%s' "$switch_bin/mesh-logout-all"
}

# 0 when $1 is a symbolic link that names a mesh-logout-all of session-mesh, the only thing the
# installer ever replaces at that path: its target is $2 (the program about to be linked), or
# D/bin/mesh-logout-all where D is this install (the code, the bundle, current/, current/app, a
# release under releases/) or another install: a code directory (server.py and install.sh), an
# extracted bundle (env.sh and libexec/mesh-ptyhost) or an opam switch where opam installed the
# session_mesh package (.opam-switch/install/session_mesh.install). A directory that merely holds
# programs of the same names is not one. A file, a directory or any other link is the user's own.
logout_all_link_ours() {
  local target root known
  [[ -L $1 ]] || return 1
  target=$(readlink -- "$1") || return 1
  if [[ -n ${2:-} && $target == "$2" ]]; then return 0; fi
  [[ $target == /*/bin/mesh-logout-all && $target != */../* && $target != */./* ]] || return 1
  root=${target%/bin/mesh-logout-all}
  for known in "${HERE:-}" "${APP_ROOT:-}" "${RUN_ROOT:-}" "${BUNDLE_DIR:-}" "$CURRENT" "$CURRENT/app"; do
    if [[ -n $known && $root == "$known" ]]; then return 0; fi
  done
  if [[ $root == "$RELEASES"/* ]]; then return 0; fi
  if [[ -f $root/server.py && -f $root/install.sh ]]; then return 0; fi
  if [[ -f $root/env.sh && -f $root/libexec/mesh-ptyhost ]]; then return 0; fi
  [[ -f $root/.opam-switch/install/session_mesh.install ]]
}

# Points $1/mesh-logout-all at program $2. Whatever else is at that path is the user's own: it is
# left as it is, and the warning says where the program is.
place_logout_all() {
  local link=$1/mesh-logout-all
  if [[ -e $link || -L $link ]] && ! logout_all_link_ours "$link" "$2"; then
    warn "$link was not made by this installer: it is left as it is. The mesh-logout-all of this install is $2; to use it, remove $link yourself, then: ln -s '$2' '$link'"
    return 0
  fi
  ln -sfn "$2" "$link"
}

# Links mesh-logout-all in directory $1 to logout_all_program, opam switch $2. When there is none,
# a link of session-mesh that no longer resolves (to the Python command a checkout no longer has)
# is removed; any other thing at that path, a working command included, is left. The warning
# names the missing program and how to build it.
link_logout_all() {
  local link=$1/mesh-logout-all program switch='' build='bash scripts/bootstrap.sh --install-only'
  program=$(logout_all_program "${2:-}")
  if [[ -n $program ]]; then place_logout_all "$1" "$program"; return 0; fi
  if [[ ! -e $link ]] && logout_all_link_ours "$link"; then rm -f -- "$link"; fi
  [[ -z ${2:-} ]] || { switch=" '$2'"; build="MESH_OPAM_SWITCH='$2' $build"; }
  if [[ -e $link || -L $link ]]; then
    warn "the native program mesh-logout-all is missing from the opam switch$switch: $link is left as it is. Build the program with $build, then rerun with MESH_OPAM_SWITCH set to that switch"
    return 0
  fi
  warn "mesh-logout-all is not installed: the native program mesh-logout-all is missing from the opam switch$switch. Build it with $build, then rerun with MESH_OPAM_SWITCH set to that switch"
}

# After --rollback: an existing $1/mesh-logout-all follows the release current/ now names. A
# release holds the command as bin/mesh-logout-all (the native program, or a 0.1.x bundle's
# wrapper); a 0.1.x release of native programs had only the Python command app/bin/mesh-logout-all.
relink_logout_all() {
  local link=$1/mesh-logout-all program=$CURRENT/bin/mesh-logout-all
  [[ -e $link || -L $link ]] || return 0
  [[ -f $program && -x $program ]] || program=$CURRENT/app/bin/mesh-logout-all
  if [[ ! -f $program ]]; then
    warn "the release restored holds no mesh-logout-all: $link is left as it is"
    return 0
  fi
  place_logout_all "$1" "$program"
}
