# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash
# session-mesh installer, Linux part (systemd user units). Sourced by install.sh after it has
# defined the shared functions (scripts/install-common.sh) and the release ones
# (scripts/install-release.sh); never run on its own. HERE holds the code the units are
# rendered from; APP_ROOT is the directory they run it from (current/app for a release install);
# RUN_ROOT, for a release or bundle install, is the bundle whose Python, wrappers and native
# programs they run (current/ for a release install).

UNIT="session-mesh.service"
PTY_UNIT="session-mesh-pty.service"
UNIT_DIR="$HOME/.config/systemd/user"

NO_USER_SESSION="session-mesh needs a systemd user session: run ./install.sh as your own user, in a login session with systemd (do not use sudo or root; a container or WSL without systemd is not supported)"
user_session_refusal() { refuse "$NO_USER_SESSION ($1 failed)"; }
((EUID != 0)) || refuse "$NO_USER_SESSION"
# shellcheck source=scripts/install-linux-units.sh
source "$HERE/scripts/install-linux-units.sh"

# The port of an already installed web unit, or nothing. Rerunning the installer without MESH_PORT
# keeps it instead of falling back to 7690. Read as systemd reads it: the unit, then its drop-ins
# (systemctl --user edit), the last assignment winning, quoted or not; an empty `Environment=`
# line resets the earlier ones, as in systemd. Printed as the value, a newline and the file that
# set it (a reset in a drop-in gives the server's default, 7690, whatever the unit says); a line
# naming MESH_PORT in another form gives the value "unreadable", refused below
# rather than silently replaced by 7690. `EnvironmentFile=` is not read: its file may set
# MESH_PORT and would override every `Environment=` line, so it gives the value "envfile",
# refused below.
# MESH_PORT itself, not a variable whose name ends with it (FOO_MESH_PORT).
NAMES_MESH_PORT='(^|[^A-Za-z0-9_])MESH_PORT'
installed_port() {
  local file line value found=
  [[ -f $UNIT_DIR/$UNIT && ! -L $UNIT_DIR/$UNIT ]] || return 0
  for file in "$UNIT_DIR/$UNIT" "$UNIT_DIR/$UNIT.d"/*.conf; do
    [[ -f $file ]] || continue
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*[#\;] ]] && continue
      if [[ $line =~ ^[[:space:]]*EnvironmentFile[[:space:]]*= ]]; then
        found="envfile"$'\n'"$file"
      elif [[ $found == envfile$'\n'* ]]; then
        continue
      elif [[ $line =~ ^[[:space:]]*Environment[[:space:]]*=[[:space:]]*$ ]]; then
        # In a drop-in, the reset also drops the unit's MESH_PORT: the server's default applies.
        if [[ $file == "$UNIT_DIR/$UNIT" ]]; then found=; else found="7690"$'\n'"$file"; fi
      elif [[ $line =~ ^[[:space:]]*Environment=(\"MESH_PORT=([^\"]*)\"|MESH_PORT=([^[:space:]\"]*))[[:space:]]*$ ]]; then
        value="${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
        found="${value:-unreadable}"$'\n'"$file"
      elif [[ $line =~ $NAMES_MESH_PORT ]]; then
        found="unreadable"$'\n'"$file"
      fi
    done < "$file"
  done
  printf '%s' "$found"
}
INSTALLED=$(installed_port)
INSTALLED_PORT=${INSTALLED%%$'\n'*}
INSTALLED_FROM=${INSTALLED#*$'\n'}
if [[ $INSTALLED_PORT == envfile ]]; then
  refuse "$INSTALLED_FROM uses EnvironmentFile=, which the installer does not read (it may set MESH_PORT): move MESH_PORT to an Environment= line, or remove that line, then rerun"
fi
PORT=${MESH_PORT:-${INSTALLED_PORT:-7690}}

# A drop-in's MESH_PORT overrides the unit the installer writes: another MESH_PORT would not apply.
if [[ -n $INSTALLED && $INSTALLED_FROM != "$UNIT_DIR/$UNIT" && -n ${MESH_PORT:-} \
      && $MESH_PORT != "$INSTALLED_PORT" ]] && ((UNINSTALL == 0)); then
  refuse "$INSTALLED_FROM sets MESH_PORT and overrides the installed unit: change the port there, or rerun without MESH_PORT"
fi
if ! port_number "$PORT"; then
  [[ -n ${MESH_PORT:-} ]] || refuse "$INSTALLED_FROM sets MESH_PORT to $PORT, which the installer cannot read as a port number; set MESH_PORT to the port to use"
  refuse "MESH_PORT must be a port number"
fi
if [[ -z ${MESH_PORT:-} && -n $INSTALLED_PORT ]]; then
  echo "Keeping the installed port $PORT (set MESH_PORT to change it)."
elif [[ -n $INSTALLED_PORT && $INSTALLED_PORT != "$PORT" ]] && ((UNINSTALL == 0)); then
  warn "the port changes from $INSTALLED_PORT to $PORT (MESH_PORT)"
fi
[[ ! $HERE =~ [[:cntrl:]] ]] || refuse "checkout path contains a control character"

# systemd rejects an executable path with a quote, a backslash or a glob character.
# shellcheck disable=SC1003 # the backslash pattern is meant literally
systemd_safe_path() {
  [[ $1 != *'"'* && $1 != *"'"* && $1 != *'\'* && $1 != *'*'* && $1 != *'?'* && $1 != *'['* ]]
}
unsupported_path() { refuse "$1 executable path contains unsupported quote/backslash/glob; choose a systemd-compatible installed path"; }


if ((UNINSTALL)); then
  step "Stopping session-mesh"
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT"
  echo "The PTY host (and so the mesh sessions) keeps running. To stop everything: systemctl --user disable --now $PTY_UNIT"
  [[ ! -d $RELEASES ]] || echo "The installed releases stay in $RELEASES. A PTY unit that runs $CURRENT/bin/mesh-ptyhost needs them to start again: remove them only after stopping it (systemctl --user disable --now $PTY_UNIT, which ends every mesh session)."
  systemctl --user daemon-reload 2>/dev/null || user_session_refusal "systemctl --user daemon-reload"
  if command -v tailscale >/dev/null; then remove_serve_publication; fi
  exit 0
fi

# --rollback, and the first stage of --upgrade: only the installer's own units, nothing else.
if ((ROLLBACK)); then linux_rollback; fi
if ((UPGRADE)) && [[ -z $UPGRADE_FROM ]]; then
  require_own_units
  release_upgrade
fi
release_check_second_stage
source_check_release_install

# As the hosts: MESH_RUNTIME_DIR, else XDG_RUNTIME_DIR, else /run/user/<uid>; empty counts as unset.
endpoint="${MESH_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/run/user/$EUID}}/session-mesh/ptyhost.sock"
# A stopped PTY unit can leave its socket behind (a host killed by SIGKILL, or a unit written by an
# older installer, without RuntimeDirectory=). The file is removed only when it is a socket of this
# account on which nothing accepts a connection: curl exits 7 when the connection is refused.
remove_stale_endpoint() {
  local code=0 remedy="if no PTY host is running (systemctl --user status $PTY_UNIT), remove it with: rm -- '$endpoint' then run the installer again"
  [[ -S $endpoint && ! -L $endpoint && -O $endpoint ]] \
    || refuse "$endpoint exists while $PTY_UNIT is not running, and it is not a socket of this account; $remedy"
  command -v curl >/dev/null || refuse "the PTY socket $endpoint exists while $PTY_UNIT is not running; $remedy"
  curl --noproxy '*' -s -o /dev/null --max-time 2 --unix-socket "$endpoint" http://localhost/ || code=$?
  ((code == 7)) || refuse "something answers on $endpoint while $PTY_UNIT is not running (a PTY host started by hand?); stop it, or $remedy"
  rm -f -- "$endpoint"
  warn "removed the stale PTY socket $endpoint: its unit was stopped and nothing answered on it"
}
# Earlier installs ran the Python PTY host (ptyhost.py), which this version no longer contains:
# its unit would start nothing. A source install refuses, and says how to switch, before anything
# is changed (a release install replaces the unit an installer wrote: release_pty_decision).
# Only the effective command counts: the files are read in the order systemd applies them (the
# unit, then its drop-ins) and an empty `ExecStart=` discards the commands set before it, so a
# drop-in that replaces the Python host with the native one is not refused.
refuse_python_host() {
  local file line value offender=
  local python_host='ptyhost\.py([[:space:]"'\'']|$)'
  for file in "$@"; do
    [[ -f $file ]] || continue
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*ExecStart[[:space:]]*=(.*)$ ]] || continue
      value=${BASH_REMATCH[1]}
      if [[ $value =~ ^[[:space:]]*$ ]]; then offender=; continue; fi
      if [[ $value =~ $python_host ]]; then offender=$file; fi
    done < "$file"
  done
  [[ -n $offender ]] || return 0
  refuse "$PTY_UNIT ($offender) runs the Python PTY host, which is gone: the PTY host is now the native mesh-ptyhost. To switch, stop the unit and remove it (this ends every mesh session): systemctl --user disable --now $PTY_UNIT; rm -- '$offender'; systemctl --user daemon-reload; then rerun the installer"
}
OPAM_SWITCH=${MESH_OPAM_SWITCH:-}
choose_opam_switch() {
  [[ -z $RUN_ROOT$MESH_RELEASE_TAG ]] || { OPAM_SWITCH=''; return 0; }
  if [[ -z $OPAM_SWITCH ]] && command -v opam >/dev/null; then
    OPAM_SWITCH=$(opam switch show 2>/dev/null || true)
  fi
  [[ ! $OPAM_SWITCH =~ [[:cntrl:]] ]] || refuse "MESH_OPAM_SWITCH contains a control character"
}
# Source install, the native host: --ptyhost, else mesh-ptyhost on PATH, else the bin directory
# of the opam switch; bundle install: the bundle's own. Checked as systemd will run it.
find_native_host() {
  local switch_bin
  [[ -n $PTY_BINARY || -z $BUNDLE_DIR ]] || PTY_BINARY=$BUNDLE_DIR/bin/mesh-ptyhost
  if [[ -z $PTY_BINARY ]]; then
    PTY_BINARY=$(command -v mesh-ptyhost || true)
    if [[ -z $PTY_BINARY && -n $OPAM_SWITCH ]] && command -v opam >/dev/null; then
      switch_bin=$(opam var --switch="$OPAM_SWITCH" bin 2>/dev/null || true)
      [[ -z $switch_bin || ! -x $switch_bin/mesh-ptyhost ]] || PTY_BINARY=$switch_bin/mesh-ptyhost
    fi
  fi
  # shellcheck disable=SC2016 # a command for the reader to run, printed literally
  [[ -n $PTY_BINARY ]] || refuse 'the native PTY host mesh-ptyhost is missing: build it with bash scripts/bootstrap.sh --install-only (then rerun with --from-source, or pass --ptyhost "$(opam var --switch=SWITCH bin)/mesh-ptyhost"), pass a host you obtained yourself with --ptyhost /absolute/path, or install a release instead (docs/install.md, "Install a release")'
  [[ $PTY_BINARY == /* && ! $PTY_BINARY =~ [[:cntrl:]] ]] || refuse "native binary must be an absolute literal path"
  PTY_BINARY=$(readlink -e -- "$PTY_BINARY") || refuse "native binary unavailable"
  [[ -f $PTY_BINARY && -x $PTY_BINARY && ! $PTY_BINARY =~ [[:cntrl:]] ]] || refuse "native binary must be an executable regular file"
  systemd_safe_path "$PTY_BINARY" || unsupported_path native
}

# What to do with the PTY unit: create it, rewrite it (REWRITE_PTY: never restarted), or leave it.
# (START_PTY and CREATE_PTY are initialised in install-linux-units.sh.)
REWRITE_PTY=0 PRESERVED_PTY=0
decide_pty() {
  local local_config=0
  [[ ! -e $UNIT_DIR/$PTY_UNIT && ! -L $UNIT_DIR/$PTY_UNIT &&
     ! -e $UNIT_DIR/$PTY_UNIT.d && ! -L $UNIT_DIR/$PTY_UNIT.d ]] || local_config=1
  case "$active/$sub" in
    active/running) ;;
    inactive/dead|failed/failed)
      [[ ! -e $endpoint && ! -L $endpoint ]] || remove_stale_endpoint
      START_PTY=1 ;;
    *) refuse "PTY unit is transitional or unknown" ;;
  esac
  if [[ $load == loaded && -n $fragment ]]; then
    if [[ -L $UNIT_DIR/$PTY_UNIT ]]; then
      [[ -e $UNIT_DIR/$PTY_UNIT && $(readlink -e -- "$UNIT_DIR/$PTY_UNIT") != /dev/null ]] \
        || refuse "local PTY unit is masked or dangling"
    fi
    if [[ -n $MESH_RELEASE_TAG ]]; then release_pty_decision; return 0; fi
    if ((SWITCH_FROM_RELEASE)); then switch_pty_decision; return 0; fi
    dropin_files "$dropins"
    refuse_python_host "$fragment" ${DROPIN_FILES[@]+"${DROPIN_FILES[@]}"}
    ((PTY_EXPLICIT == 0)) || refuse "existing PTY configuration preserved; explicit migration is not supported"
  elif [[ $load == not-found && $active == inactive && $sub == dead &&
          -z $fragment && -z $dropins && $local_config == 0 ]]; then
    CREATE_PTY=1
    [[ -z $MESH_RELEASE_TAG ]] || PTY_BINARY=$CURRENT/bin/mesh-ptyhost
  else
    refuse "PTY configuration is masked, incomplete or ambiguous"
  fi
}
observe_both_units
check_overriding_dropins
check_bundle_install
decide_pty
[[ -z $MESH_RELEASE_TAG ]] || release_web_decision
if ((CREATE_PTY || REWRITE_PTY)); then
  [[ -f $HERE/systemd/$PTY_UNIT.in && -r $HERE/systemd/$PTY_UNIT.in ]] || refuse "PTY unit template unavailable"
  choose_opam_switch
  [[ -n $MESH_RELEASE_TAG ]] || find_native_host
fi

dependency_help() {
  printf '%s\n' "Install the missing packages, for example:" \
    "  Debian, Ubuntu: sudo apt install python3 python3-aiohttp curl   (optional: python3-cryptography)" \
    "  Fedora:         sudo dnf install python3 python3-aiohttp curl   (optional: python3-cryptography)" \
    "  Arch:           sudo pacman -S python python-aiohttp curl       (optional: python-cryptography)" \
    "  Or a venv:      python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" \
    "                  then run: MESH_PYTHON=\"\$PWD/.venv/bin/python\" ./install.sh"
}

# A release or bundle install runs the bundle's own Python, with its locked dependencies: nothing
# is asked of this machine's Python. The units name it through RUN_ROOT (current/ for a release).
check_bundle_python() {
  PYTHON=$RUN_ROOT/bin/mesh-python
  systemd_safe_path "$PYTHON" || unsupported_path interpreter
  "$BUNDLE_DIR/bin/mesh-python" -c 'import aiohttp, cryptography' \
    || refuse "the bundled Python of $BUNDLE_DIR cannot import its dependencies: extract the bundle again"
  command -v curl >/dev/null || refuse "missing: curl (the installer checks the web server with it)"
  echo "ok: bundled Python ($PYTHON)"
}

check_python() {
  local python_version missing=()
  step "Dependencies"
  if [[ -n $RUN_ROOT ]]; then check_bundle_python; return 0; fi
  # The interpreter checked here is the one the units run.
  PYTHON=${MESH_PYTHON:-$(command -v python3 || true)}
  if [[ -z $PYTHON ]]; then missing+=(python3)
  elif [[ $PYTHON != /* || $PYTHON =~ [[:cntrl:]] || ! -f $PYTHON || ! -x $PYTHON ]]; then
    refuse "the interpreter must be an absolute path to an executable file (MESH_PYTHON or python3 on PATH)"
  elif ! systemd_safe_path "$PYTHON"; then unsupported_path interpreter
  # A version that cannot be read falls through to the aiohttp check, which then fails.
  elif python_version=$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) \
       && [[ $python_version =~ ^([0-9]{1,3})\.([0-9]{1,3})$ ]] \
       && ((10#${BASH_REMATCH[1]} < 3 || (10#${BASH_REMATCH[1]} == 3 && 10#${BASH_REMATCH[2]} < 10))); then
    refuse "session-mesh needs Python 3.10 or newer; $PYTHON is Python $python_version (set MESH_PYTHON to a newer interpreter)"
  elif ! "$PYTHON" -c 'import aiohttp'; then missing+=(aiohttp)
  fi
  command -v curl >/dev/null || missing+=(curl)
  if ((${#missing[@]})); then echo "missing: ${missing[*]}"; dependency_help; exit 1; fi
  "$PYTHON" -c 'import cryptography' 2>/dev/null \
    || echo "optional: the Python cryptography package enables push notifications"
  echo "ok: $PYTHON"
}
check_python

if ((TAILSCALE)); then
  step "Tailscale publication check (before any change)"
  command -v tailscale >/dev/null || refuse "--tailscale requested but tailscale is not installed; nothing was changed"
  read_serve_state
  serve_refusal "nothing was changed" "already publishes"
  echo "ok"
fi
# Resolved before any change: USER may be unset (cron, su, some containers).
ACCOUNT=${USER:-$(id -un)} || refuse "cannot determine the user name"
[[ -n $ACCOUNT && ! $ACCOUNT =~ [[:cntrl:]] ]] || refuse "cannot determine the user name"

choose_opam_switch

# One left-to-right pass: a substituted value is never scanned again for @TOKEN@.
render_line() {
  local line=$1 out='' prefix rest token
  while [[ $line == *@*@* ]]; do
    prefix=${line%%@*}; rest=${line#*@}; token=${rest%%@*}
    case $token in
      ROOT) out+=$prefix$(systemd_quote "$APP_ROOT"); line=${rest#*@} ;;
      PYTHON) out+=$prefix$(systemd_quote "$PYTHON"); line=${rest#*@} ;;
      PTYHOST) out+=$prefix$(systemd_quote "$PTY_BINARY"); line=${rest#*@} ;;
      PORT) out+=$prefix$(systemd_quote "$PORT"); line=${rest#*@} ;;
      *) out+=$prefix@; line=$rest ;;
    esac
  done
  printf '%s\n' "$out$line"
}
render_unit() {
  local line
  while IFS= read -r line; do
    if [[ $line == '@ENV_OPAM_SWITCH@' ]]; then
      [[ -z $OPAM_SWITCH ]] || printf 'Environment="MESH_OPAM_SWITCH=%s"\n' "$(systemd_quote "$OPAM_SWITCH")"
    else
      render_line "$line"
    fi
  done < "$1"
}

# A source install without mesh-board-mcp in its opam switch gives agents no board.
board_warning() {
  local switch_bin=''
  [[ -z $RUN_ROOT$MESH_RELEASE_TAG ]] || return 0
  if [[ -n $OPAM_SWITCH ]] && command -v opam >/dev/null; then
    switch_bin=$(opam var --switch="$OPAM_SWITCH" bin 2>/dev/null || true)
  fi
  [[ -n $switch_bin && -f $switch_bin/mesh-board-mcp && -x $switch_bin/mesh-board-mcp ]] \
    || warn "mesh-board-mcp is not in an opam switch: agents get no board MCP server (messages, requests, whiteboard). Build it with bash scripts/bootstrap.sh --install-only, then rerun with MESH_OPAM_SWITCH set"
}

step "systemd user service"
mkdir -p "$UNIT_DIR"
WEB_UNIT_BEFORE=$(cat "$UNIT_DIR/$UNIT" 2>/dev/null || true)
# units are rendered from templates so the code can live anywhere
rm -f "$UNIT_DIR/$UNIT"
render_unit "$HERE/systemd/$UNIT.in" > "$UNIT_DIR/$UNIT"
if ((REWRITE_PTY)); then PTY_UNIT_BEFORE=$(cat "$UNIT_DIR/$PTY_UNIT" 2>/dev/null || true); fi
if ((CREATE_PTY || REWRITE_PTY)); then
  render_unit "$HERE/systemd/$PTY_UNIT.in" > "$UNIT_DIR/$PTY_UNIT"
fi
board_warning
if [[ -n $MESH_RELEASE_TAG ]]; then release_activate "$MESH_RELEASE_TAG"; else source_remove_current; fi
systemctl --user daemon-reload
systemctl --user enable "$PTY_UNIT" "$UNIT" >/dev/null
# ptyhost is only started, never restarted: restarting it would end the mesh sessions.
if ((START_PTY)); then systemctl --user start "$PTY_UNIT"; fi
if ! restart_web; then
  if can_go_back; then roll_back_web "${MESH_RELEASE_TAG:-${RUN_ROOT:-$HERE}}"; fi
  systemctl --user status "$UNIT" --no-pager
  exit 1
fi
echo "running on 127.0.0.1:$PORT"
if ! loginctl show-user "$ACCOUNT" -p Linger 2>/dev/null | grep -q yes; then
  warn "the service stops when you log out; to keep it running: sudo loginctl enable-linger $ACCOUNT"
fi
report_pty_host
[[ -z $MESH_RELEASE_TAG ]] || release_prune

step "Commands mesh-open, mesh-attach, mesh-rename and mesh-logout-all"
mkdir -p "$HOME/.local/bin"
for cmd in mesh-open mesh-attach mesh-rename; do
  ln -sfn "${RUN_ROOT:-$APP_ROOT}/bin/$cmd" "$HOME/.local/bin/$cmd"
done
link_logout_all "$HOME/.local/bin" "$OPAM_SWITCH"
echo "mesh-open FILE : open a local document in the page side panel"
echo "mesh-attach [NAME] : open (or join) a mesh session in this terminal"
echo "mesh-rename NAME   : rename the current mesh session (--folder: file it)"
echo "mesh-logout-all    : log out every browser (the token and the sessions do not change)"

URL="http://127.0.0.1:$PORT"
if ((TAILSCALE)); then
  step "Publishing on the tailnet (tailscale serve)"
  publish_tailscale
  URL="https://$SERVED_HOST"
fi

step "Ready"
if [[ -n $MESH_RELEASE_TAG ]]; then INSTALL_COMMAND=$CURRENT/install.sh; else INSTALL_COMMAND=$HERE/install.sh; fi
cat <<EOF
  URL      : $URL
  token    : cat ~/.config/session-mesh/token
  logs     : journalctl --user -u session-mesh -f
  uninstall: $INSTALL_COMMAND --uninstall
EOF
if [[ -n $MESH_RELEASE_TAG ]]; then
  echo "  release  : $MESH_RELEASE_TAG (upgrade: $INSTALL_COMMAND --upgrade; back: $INSTALL_COMMAND --rollback)"
fi
