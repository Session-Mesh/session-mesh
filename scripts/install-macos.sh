# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash
# session-mesh installer, macOS part. Sourced by install.sh after it has defined step, warn,
# refuse, port_number, health, read_serve_state, serve_refusal, remove_serve_publication and
# publish_tailscale; never run on its own. HERE holds the code the jobs are rendered from;
# APP_ROOT is the directory they run it from (current/app for a release install); RUN_ROOT, for a
# release or bundle install, is the bundle whose Python, wrappers and programs they run.
#
# Two launchd jobs, as the two systemd units on Linux:
#   io.session-mesh.pty  the native PTY host (owns the mesh terminals; the installer never restarts it)
#   io.session-mesh.web  the web server on 127.0.0.1:MESH_PORT
# By default they are agents in ~/Library/LaunchAgents, installed without sudo: in the graphical
# login session (gui/UID) when there is one, else in the background domain (user/UID), which
# lasts until the Mac restarts. With --at-boot they are daemons in /Library/LaunchDaemons that
# launchd starts at boot as this account (UserName), with nobody logged in: the analogue of
# `loginctl enable-linger` on Linux, and like it the one step that needs sudo (asked first).
# Both jobs receive the same MESH_RUNTIME_DIR: an installed PTY job's, else MESH_RUNTIME_DIR, else
# XDG_RUNTIME_DIR, else ~/Library/Application Support/session-mesh/run, as the native host and
# ptyhost.py resolve it. ~ is always the home of the user database (id -P), not $HOME: it also
# holds the agents (~/Library/LaunchAgents), the logs (~/Library/Logs/session-mesh/{pty,web}.log)
# and the command links (~/.local/bin).
#
# Written for the bash 3.2 of macOS: no associative arrays, no empty array under set -u.

# shellcheck source=scripts/install-macos-launchd.sh
source "$HERE/scripts/install-macos-launchd.sh"
# shellcheck source=scripts/install-macos-release.sh
source "$HERE/scripts/install-macos-release.sh"

PTY_LABEL=io.session-mesh.pty
WEB_LABEL=io.session-mesh.web
DAEMON_DIR=/Library/LaunchDaemons
# A host that refuses to start (runtime directory unusable, another host holding the lock) exits
# with status 1. KeepAlive restarts only an unsuccessful exit (a crash, a kill, a refusal), and
# ThrottleInterval spaces two starts by at least 30 s: launchd has no start limit like systemd's,
# so a persistent refusal retries twice a minute instead of every 10 s (launchd's default).
# A process that ran longer than that is restarted at once.
THROTTLE_SECONDS=30

((EUID != 0)) || refuse "session-mesh installs launchd jobs that run as you: run ./install.sh as your own user (do not use sudo or root; --at-boot asks for sudo itself)"

MAC_SWITCH_BIN=
PTY_REWRITE=0

# The oldest macOS: 12.3 from a checkout (plutil -extract ... raw, readlink -f); for a bundle or a
# release's native programs, their floor (install.sh: BUNDLE_MACOS_FLOOR, PROGRAMS_MACOS_FLOOR).
mac_check_version() {
  local version floor=12.3 what=session-mesh
  if [[ -n $BUNDLE_DIR ]]; then floor=$BUNDLE_MACOS_FLOOR what='the bundle'
  elif [[ -n $MESH_RELEASE_TAG ]]; then floor=$PROGRAMS_MACOS_FLOOR what="the native programs of release $MESH_RELEASE_TAG"; fi
  version=$(sw_vers -productVersion 2>/dev/null) || refuse "cannot read the macOS version (sw_vers -productVersion)"
  version_at_least "$version" "$floor" || refuse "$what needs macOS $floor or later; this Mac runs macOS $version"
}

# The account from the user database (id -P prints its passwd entry): name, home and login
# shell. The home is the database's, not $HOME, as the native host uses for the
# default runtime directory.
mac_account() {
  local entry
  entry=$(id -P) || refuse "cannot read this account's entry in the user database (id -P)"
  IFS=: read -r ACCOUNT _ _ _ _ _ _ _ PW_HOME LOGIN_SHELL <<< "$entry"
  GROUP=$(id -gn) || refuse "cannot read this account's primary group (id -gn)"
  [[ -n $ACCOUNT && $PW_HOME == /* && -n $GROUP ]] || refuse "unexpected user database entry for this account: $entry"
  LOGIN_SHELL=${LOGIN_SHELL:-/bin/zsh}
  AGENT_DIR=$PW_HOME/Library/LaunchAgents
  LOG_DIR=$PW_HOME/Library/Logs/session-mesh
}

# One value of a plist (a key path such as EnvironmentVariables.PATH). Status 2: the file is not
# a readable plist; status 1: the key is absent.
plist_value() {
  plutil -lint -s "$1" >/dev/null 2>&1 || return 2
  plutil -extract "$2" raw -o - "$1" 2>/dev/null || return 1
}
plist_env() { plist_value "$1" "EnvironmentVariables.$2"; }
present() { [[ -e $1 || -L $1 ]]; }

# FORM: agent (~/Library/LaunchAgents) or daemon (/Library/LaunchDaemons, --at-boot). Decided
# before any change from the installed files: the two jobs are never left in different forms.
mac_choose_form() {
  local agents=0 daemons=0 label
  for label in "$PTY_LABEL" "$WEB_LABEL"; do
    present "$AGENT_DIR/$label.plist" && agents=1
    present "$DAEMON_DIR/$label.plist" && daemons=1
  done
  ((agents == 0 || daemons == 0 || UNINSTALL)) \
    || refuse "session-mesh has both launchd agents ($AGENT_DIR) and boot-time daemons ($DAEMON_DIR); keep one form: $0 --uninstall, then remove the PTY job of the form you drop (this ends its mesh sessions), then rerun"
  FORM=agent
  if ((AT_BOOT)); then
    ((agents == 0)) || refuse "session-mesh is installed as launchd agents; moving to boot-time daemons ends every mesh session, so the installer does not do it: $0 --uninstall; launchctl bootout user/$EUID/$PTY_LABEL (or gui/$EUID/$PTY_LABEL); rm '$AGENT_DIR/$PTY_LABEL.plist'; then $0 --at-boot"
    FORM=daemon
  elif ((daemons && UNINSTALL == 0)); then
    refuse "session-mesh is installed as boot-time daemons ($DAEMON_DIR): rerun with --at-boot (it asks before using sudo), or use --uninstall"
  fi
  if [[ $FORM == daemon ]]; then JOB_DIR=$DAEMON_DIR; else JOB_DIR=$AGENT_DIR; fi
  PTY_PLIST=$JOB_DIR/$PTY_LABEL.plist
  WEB_PLIST=$JOB_DIR/$WEB_LABEL.plist
}

# The launchd domain. Daemons: system. Agents: the session type of an installed PTY agent wins,
# so that both agents always share one domain; otherwise the graphical login session when there
# is one, else the background domain, where an agent loads only if its plist says Background.
mac_choose_domain() {
  local gui=0 installed='' code=0
  launchctl print "gui/$EUID" >/dev/null 2>&1 && gui=1
  if [[ $FORM == daemon ]]; then DOMAIN=system SESSION_TYPE=; return 0; fi
  if present "$PTY_PLIST"; then
    installed=$(plist_value "$PTY_PLIST" LimitLoadToSessionType) || code=$?
    ((code == 0 || UNINSTALL)) || refuse "$PTY_PLIST has no readable LimitLoadToSessionType; nothing was changed"
  fi
  SESSION_TYPE=$installed
  if [[ -z $SESSION_TYPE ]]; then
    if ((gui)); then SESSION_TYPE=Aqua; else SESSION_TYPE=Background; fi
  fi
  case $SESSION_TYPE in
    Aqua)
      ((gui || UNINSTALL)) || refuse "the PTY agent was installed for a graphical login (LimitLoadToSessionType Aqua in $PTY_PLIST) and this Mac has no graphical login session now; nothing was changed. Rerun the installer while you are logged in graphically, or install for the background domain: $0 --uninstall; rm '$PTY_PLIST'; $0 (or $0 --at-boot)"
      DOMAIN=gui/$EUID ;;
    Background)
      DOMAIN=user/$EUID
      if ((gui && UNINSTALL == 0)) && [[ -n $installed ]]; then echo "Keeping the background domain user/$EUID of the installed PTY agent for both agents."; fi ;;
    *) ((UNINSTALL)) || refuse "$PTY_PLIST has an unexpected LimitLoadToSessionType ($SESSION_TYPE); nothing was changed" ;;
  esac
}

# As on Linux: rerunning without MESH_PORT keeps the installed web job's port; a value that
# cannot be read is refused rather than replaced by 7690.
mac_choose_port() {
  local installed='' code=0
  if ((UNINSTALL == 0)) && present "$WEB_PLIST" && [[ ! -f $WEB_PLIST || -L $WEB_PLIST ]]; then
    refuse "$WEB_PLIST is not a regular file (a symbolic link is refused); nothing was changed"
  fi
  if [[ -f $WEB_PLIST && ! -L $WEB_PLIST ]]; then
    installed=$(plist_env "$WEB_PLIST" MESH_PORT) || code=$?
    if ((code == 2)); then installed=unreadable
    elif ((code == 0)); then installed=${installed:-unreadable}
    fi
  fi
  PORT=${MESH_PORT:-${installed:-7690}}
  if ! port_number "$PORT"; then
    [[ -n ${MESH_PORT:-} ]] || refuse "$WEB_PLIST sets MESH_PORT to $PORT, which the installer cannot read as a port number; set MESH_PORT to the port to use"
    refuse "MESH_PORT must be a port number"
  fi
  if [[ -z ${MESH_PORT:-} && -n $installed ]]; then
    echo "Keeping the installed port $PORT (set MESH_PORT to change it)."
  elif [[ -n $installed && $installed != "$PORT" ]] && ((UNINSTALL == 0)); then
    warn "the port changes from $installed to $PORT (MESH_PORT)"
  fi
}

# Removes the web job of each form found, from every domain it is loaded in; the PTY host keeps
# running, as on Linux.
mac_uninstall() {
  local agent_web=$AGENT_DIR/$WEB_LABEL.plist daemon_web=$DAEMON_DIR/$WEB_LABEL.plist pty_domain
  step "Stopping session-mesh"
  if present "$daemon_web" || launchctl print "system/$WEB_LABEL" >/dev/null 2>&1; then
    confirm_sudo "Removing the boot-time web daemon needs sudo: $SUDO_LAUNCHCTL bootout system/$WEB_LABEL (when it is loaded); $SUDO_RM -f '$daemon_web'" \
      "the boot-time web daemon needs sudo to be removed and the installer asks first: run --uninstall from a terminal, or run: sudo launchctl bootout system/$WEB_LABEL; sudo rm -f '$daemon_web'"
    boot_out "$WEB_LABEL"
    privileged "$SUDO_RM" -f -- "$daemon_web" || refuse "sudo $SUDO_RM of $daemon_web failed"
  else
    boot_out "$WEB_LABEL"
  fi
  rm -f -- "$agent_web"
  pty_domain=$(job_domain "$PTY_LABEL")
  if present "$DAEMON_DIR/$PTY_LABEL.plist"; then
    echo "The PTY host (and so the mesh sessions) keeps running. To stop everything: sudo launchctl bootout system/$PTY_LABEL; sudo rm '$DAEMON_DIR/$PTY_LABEL.plist'"
  else
    echo "The PTY host (and so the mesh sessions) keeps running. To stop everything: launchctl bootout ${pty_domain:-$DOMAIN}/$PTY_LABEL; rm '$AGENT_DIR/$PTY_LABEL.plist'"
  fi
  if command -v tailscale >/dev/null; then remove_serve_publication; fi
  exit 0
}

# MESH_RUNTIME_DIR: the one an installed PTY job already runs with (the server must use the
# same), else the order of the hosts and clients: MESH_RUNTIME_DIR, else XDG_RUNTIME_DIR (empty
# counts as unset), else the default, which the installer may create.
mac_choose_runtime_dir() {
  local installed code=0 bytes
  RUNTIME_DEFAULT=0
  if present "$PTY_PLIST"; then
    [[ -f $PTY_PLIST && ! -L $PTY_PLIST ]] || refuse "$PTY_PLIST is not a regular file"
    installed=$(plist_env "$PTY_PLIST" MESH_RUNTIME_DIR) || code=$?
    ((code == 0)) && [[ -n $installed ]] \
      || refuse "$PTY_PLIST has no readable MESH_RUNTIME_DIR; the installer does not change an existing PTY job (removing it ends every mesh session)"
    [[ -z ${MESH_RUNTIME_DIR:-} || $MESH_RUNTIME_DIR == "$installed" ]] \
      || refuse "the installed PTY host uses MESH_RUNTIME_DIR=$installed ($PTY_PLIST); rerun without MESH_RUNTIME_DIR or with that value"
    RUNTIME_DIR=$installed
  elif [[ -n ${MESH_RUNTIME_DIR:-} ]]; then
    RUNTIME_DIR=$MESH_RUNTIME_DIR
  elif [[ -n ${XDG_RUNTIME_DIR:-} ]]; then
    RUNTIME_DIR=$XDG_RUNTIME_DIR
  else
    RUNTIME_DIR="$PW_HOME/Library/Application Support/session-mesh/run" RUNTIME_DEFAULT=1
  fi
  [[ $RUNTIME_DIR == /* && ! $RUNTIME_DIR =~ [[:cntrl:]] ]] \
    || refuse "MESH_RUNTIME_DIR (or XDG_RUNTIME_DIR) must be an absolute path without control characters"
  ENDPOINT=$RUNTIME_DIR/session-mesh/ptyhost.sock
  bytes=$(LC_ALL=C; echo "${#ENDPOINT}")
  ((bytes <= 103)) || refuse "the PTY socket path $ENDPOINT is $bytes bytes, over macOS's 103-byte limit: set MESH_RUNTIME_DIR to a shorter private directory; nothing was changed"
}

private_dir() {
  local dir=$1 mode
  [[ -d $dir && ! -L $dir ]] || refuse "$dir is not a directory (a symbolic link is refused)"
  [[ -O $dir ]] || refuse "$dir is not owned by you"
  mode=$(ls -ld -- "$dir") && mode=${mode%% *}
  [[ ${mode:5:1} != w && ${mode:8:1} != w ]] || refuse "$dir is writable by group or others (chmod 700 it)"
}

# The checks the native host makes, so that a directory it would refuse is refused here first.
check_runtime_dir() {
  private_dir "$RUNTIME_DIR"
  [[ $(cd -P -- "$RUNTIME_DIR" && pwd -P) == "$RUNTIME_DIR" ]] \
    || refuse "the runtime directory $RUNTIME_DIR is not canonical (a symbolic link or a trailing slash): use the resolved path"
}

# The default as the native host makes it: Library/Application Support must exist; session-mesh
# and run are created with mode 0700 and checked one by one (a symbolic link is refused).
prepare_runtime_dir() {
  local support="$PW_HOME/Library/Application Support" dir
  if ((RUNTIME_DEFAULT)); then
    [[ -d $support && ! -L $support ]] || refuse "$support does not exist; set MESH_RUNTIME_DIR to a private directory"
    for dir in "$support/session-mesh" "$RUNTIME_DIR"; do
      present "$dir" || mkdir -m 700 -- "$dir" || refuse "cannot create $dir"
      private_dir "$dir"
    done
  elif ! present "$RUNTIME_DIR"; then
    if ! { mkdir -p -- "$(dirname -- "$RUNTIME_DIR")" && mkdir -m 700 -- "$RUNTIME_DIR"; }; then
      refuse "cannot create the runtime directory $RUNTIME_DIR"
    fi
  fi
  check_runtime_dir
}

# As on Linux: a socket left by a host that was killed is removed only when the runtime
# directory passes the host's checks, the socket belongs to this account and nothing accepts a
# connection on it (curl exits 7).
remove_stale_endpoint() {
  local code=0 remedy="if no PTY host is running (launchctl print $DOMAIN/$PTY_LABEL), remove it with: rm -- '$ENDPOINT' then run the installer again"
  check_runtime_dir
  private_dir "$RUNTIME_DIR/session-mesh"
  [[ -S $ENDPOINT && ! -L $ENDPOINT && -O $ENDPOINT ]] \
    || refuse "$ENDPOINT exists while the PTY job is not running, and it is not a socket of this account; $remedy"
  command -v curl >/dev/null || refuse "the PTY socket $ENDPOINT exists while the PTY job is not running; $remedy"
  curl --noproxy '*' -s -o /dev/null --max-time 2 --unix-socket "$ENDPOINT" http://localhost/ || code=$?
  ((code == 7)) || refuse "something answers on $ENDPOINT while the PTY job is not running (a PTY host started by hand?); stop it, or $remedy"
  rm -f -- "$ENDPOINT"
  warn "removed the stale PTY socket $ENDPOINT: its job was not running and nothing answered on it"
}

# PTY_ACTION: create (no job), bootstrap (plist, not loaded), kickstart (loaded, stopped) or
# keep (running). The installer never restarts a running host: that would end the mesh sessions.
mac_observe_pty() {
  local domain state
  domain=$(job_domain "$PTY_LABEL")
  if ! present "$PTY_PLIST"; then
    [[ -z $domain ]] || refuse "launchd has $PTY_LABEL loaded ($domain) but $PTY_PLIST is missing; unload it first: launchctl bootout $domain/$PTY_LABEL (this ends every mesh session)"
    PTY_ACTION=create
  else
    mac_existing_pty
    if [[ -z $domain ]]; then PTY_ACTION=bootstrap
    else
      state=$(job_state "$domain" "$PTY_LABEL")
      case $state in
        running) PTY_ACTION=keep ;;
        'not running') PTY_ACTION=kickstart PTY_DOMAIN=$domain ;;
        *) refuse "PTY job is transitional or unknown (state: ${state:-none}; inspect: launchctl print $domain/$PTY_LABEL)" ;;
      esac
    fi
  fi
  if [[ $PTY_ACTION != keep ]] && present "$ENDPOINT"; then remove_stale_endpoint; fi
}

# An installed PTY plist keeps its program and runtime directory; its LANG and PATH follow this
# run. launchd reads a plist when it loads the job: a new file changes nothing in a running host
# (nor in a restart after a crash, which reuses the loaded definition), so a running host is left
# alone and the reader is told; a loaded but stopped one is loaded again (PTY_ACTION reload).
mac_pty_env_update() {
  local lang='' path='' code=0 sudo when
  PTY_REWRITE=0
  [[ $PTY_ACTION != create ]] || return 0
  lang=$(plist_env "$PTY_PLIST" LANG) || true
  path=$(plist_env "$PTY_PLIST" PATH) || true
  [[ $lang != "$AGENT_LANG" || $path != "$AGENT_PATH" ]] || return 0
  PTY_BINARY=$(plist_value "$PTY_PLIST" ProgramArguments.0) || code=$?
  ((code == 0)) && [[ $PTY_BINARY == /* ]] || refuse "$PTY_PLIST has no readable program; nothing was changed"
  PTY_REWRITE=1
  case $PTY_ACTION in
    kickstart) PTY_ACTION=reload ;;
    keep)
      if [[ $FORM == daemon ]]; then sudo='sudo ' when='at the next boot'; else sudo='' when='at the next login or boot'; fi
      warn "LANG or PATH of the PTY job changes in $PTY_PLIST (LANG '$lang' -> '$AGENT_LANG'). The running PTY host keeps its environment until launchd loads the job again: $when, or now with ${sudo}launchctl bootout $DOMAIN/$PTY_LABEL (this ends every mesh session) then ${sudo}launchctl bootstrap $DOMAIN '$PTY_PLIST'" ;;
  esac
}

# The native host: a release's, through current/; a bundle's own; for a source install
# --ptyhost, else mesh-ptyhost on PATH, else the opam switch's bin directory.
mac_find_ptyhost() {
  local switch_bin
  if [[ -n $MESH_RELEASE_TAG ]]; then PTY_BINARY=$CURRENT/bin/mesh-ptyhost; return 0; fi
  [[ -n $PTY_BINARY || -z $BUNDLE_DIR ]] || PTY_BINARY=$BUNDLE_DIR/bin/mesh-ptyhost
  if [[ -z $PTY_BINARY ]]; then
    PTY_BINARY=$(command -v mesh-ptyhost || true)
    if [[ -z $PTY_BINARY && -n $OPAM_SWITCH ]] && command -v opam >/dev/null; then
      switch_bin=$(opam var --switch="$OPAM_SWITCH" bin 2>/dev/null || true)
      [[ -z $switch_bin || ! -x $switch_bin/mesh-ptyhost ]] || PTY_BINARY=$switch_bin/mesh-ptyhost
    fi
    # shellcheck disable=SC2016 # a command for the reader to run, printed literally
    [[ -n $PTY_BINARY ]] \
      || refuse 'native mesh-ptyhost missing; run MESH_OPAM_SWITCH=<switch> bash scripts/bootstrap.sh --install-only, then rerun with --from-source and that MESH_OPAM_SWITCH, or use --ptyhost "$(opam var --switch=<switch> bin)/mesh-ptyhost", or pass a host you obtained yourself with --ptyhost /absolute/path'
  fi
  [[ $PTY_BINARY == /* && ! $PTY_BINARY =~ [[:cntrl:]] ]] || refuse "native binary must be an absolute literal path"
  PTY_BINARY=$(readlink -f -- "$PTY_BINARY") || refuse "native binary unavailable"
  [[ -f $PTY_BINARY && -x $PTY_BINARY && ! $PTY_BINARY =~ [[:cntrl:]] ]] || refuse "native binary must be an executable regular file"
}

mac_dependency_help() {
  printf '%s\n' "Install the missing packages with Homebrew, for example:" \
    "  brew install python opam" \
    "  then a venv: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" \
    "  then run:    MESH_PYTHON=\"\$PWD/.venv/bin/python\" ./install.sh"
}

# The interpreter checked here is the one the web job runs. /usr/bin/python3 of the Xcode
# Command Line Tools is often older than 3.10 and has no aiohttp: the venv hint follows.
mac_check_python() {
  local version missing=''
  if [[ -n $RUN_ROOT ]]; then mac_check_bundle_python; return 0; fi
  PYTHON=${MESH_PYTHON:-$(command -v python3 || true)}
  if [[ -z $PYTHON ]]; then missing='python3'
  elif [[ $PYTHON != /* || $PYTHON =~ [[:cntrl:]] || ! -f $PYTHON || ! -x $PYTHON ]]; then
    refuse "the interpreter must be an absolute path to an executable file (MESH_PYTHON or python3 on PATH)"
  elif version=$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) \
       && [[ $version =~ ^([0-9]{1,3})\.([0-9]{1,3})$ ]] \
       && ((10#${BASH_REMATCH[1]} < 3 || (10#${BASH_REMATCH[1]} == 3 && 10#${BASH_REMATCH[2]} < 10))); then
    refuse "session-mesh needs Python 3.10 or newer; $PYTHON is Python $version (set MESH_PYTHON to a newer interpreter)"
  elif ! "$PYTHON" -c 'import aiohttp'; then missing='aiohttp'
  fi
  command -v curl >/dev/null || missing="${missing:+$missing }curl"
  if [[ -n $missing ]]; then echo "missing: $missing"; mac_dependency_help; exit 1; fi
  "$PYTHON" -c 'import cryptography' 2>/dev/null \
    || echo "optional: the Python cryptography package enables push notifications"
  echo "ok: $PYTHON"
}

# The jobs' LANG: the installer's, else the installed PTY job's, else the account's region
# (defaults read -g AppleLocale, fr_FR -> fr_FR.UTF-8) when that locale exists, else
# en_US.UTF-8. An ssh login often has no LANG; without one the mesh shells run in the C locale.
mac_choose_lang() {
  local region=''
  AGENT_LANG=${LANG:-}
  if [[ -z $AGENT_LANG ]] && present "$PTY_PLIST"; then AGENT_LANG=$(plist_env "$PTY_PLIST" LANG || true); fi
  if [[ -z $AGENT_LANG ]] && command -v defaults >/dev/null; then
    region=$(defaults read -g AppleLocale 2>/dev/null || true)
    region=${region%%@*}
    if [[ $region =~ ^[a-z]{2,3}_[A-Z]{2}$ ]] && locale -a 2>/dev/null | grep -qx "$region.UTF-8"; then
      AGENT_LANG=$region.UTF-8
    fi
  fi
  AGENT_LANG=${AGENT_LANG:-en_US.UTF-8}
}

# The jobs' PATH (launchd gives only /usr/bin:/bin:/usr/sbin:/sbin): the programs of the current
# release (a release install) or the opam switch (a source install), the mesh commands, Homebrew
# on Apple silicon and Intel.
mac_agent_path() {
  local switch_bin='' release_bin='' run_root
  if [[ -n $OPAM_SWITCH ]] && command -v opam >/dev/null; then
    switch_bin=$(opam var --switch="$OPAM_SWITCH" bin 2>/dev/null || true)
  fi
  if [[ $switch_bin != /* || $switch_bin == *:* || $switch_bin =~ [[:cntrl:]] ]]; then switch_bin=''; fi
  MAC_SWITCH_BIN=$switch_bin
  # A release installed from its native programs keeps them in current/bin, as a bundle does.
  run_root=$RUN_ROOT
  [[ -z $MESH_RELEASE_TAG ]] || run_root=$CURRENT
  if [[ -n $run_root && $run_root != *:* ]]; then release_bin=$run_root/bin; fi
  AGENT_PATH=${release_bin:+$release_bin:}${switch_bin:+$switch_bin:}$PW_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
}

# tailscale on PATH, else the CLI inside the Tailscale app.
mac_tailscale_cli() {
  local app=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  command -v tailscale >/dev/null && return 0
  [[ -x $app ]] || return 0
  tailscale() { "$app" "$@"; }
}
# No sudo on macOS: the Tailscale app serves for the logged-in user, without an operator setting.
grant_operator() {
  refuse "tailscale serve was refused (its output is above); the installer runs no sudo for Tailscale on macOS. Check that Tailscale is running and logged in for this user, then rerun with --tailscale (the service already runs on 127.0.0.1:$PORT)"
}

# mesh-logout-all is a native program (link_logout_all, install-common.sh). The other clients need only
# the standard library (no aiohttp) and run on Python 3.9 or newer, so
# python3 on PATH, the system one included, runs them.
mac_link_commands() {
  local cmd
  step "Commands mesh-open, mesh-attach, mesh-rename and mesh-logout-all"
  mkdir -p "$PW_HOME/.local/bin"
  for cmd in mesh-open mesh-attach mesh-rename; do
    ln -sfn "${RUN_ROOT:-$APP_ROOT}/bin/$cmd" "$PW_HOME/.local/bin/$cmd"
  done
  link_logout_all "$PW_HOME/.local/bin" "${OPAM_SWITCH:-}"
  echo "mesh-open FILE : open a local document in the page side panel"
  echo "mesh-attach [NAME] : open (or join) a mesh session in this terminal"
  echo "mesh-rename NAME   : rename the current mesh session (--folder: file it)"
  echo "mesh-logout-all    : log out every browser (the token and the sessions do not change)"
}

mac_choose_opam_switch() {
  OPAM_SWITCH=${MESH_OPAM_SWITCH:-}
  if [[ -n $RUN_ROOT$MESH_RELEASE_TAG ]]; then OPAM_SWITCH=''; return 0; fi
  if [[ -z $OPAM_SWITCH ]] && command -v opam >/dev/null; then
    OPAM_SWITCH=$(opam switch show 2>/dev/null || true)
  fi
  [[ ! $OPAM_SWITCH =~ [[:cntrl:]] ]] || refuse "MESH_OPAM_SWITCH contains a control character"
}

# Everything is read and checked before the first change (mac_stage_plists only renders into a
# temporary directory; prepare_runtime_dir is the first change).
mac_observe() {
  mac_choose_opam_switch
  mac_choose_runtime_dir
  mac_observe_pty
  [[ $PTY_ACTION != create ]] || mac_find_ptyhost
  step "Dependencies"
  mac_check_python
  mac_choose_lang
  mac_agent_path
  mac_pty_env_update
  ((MAC_SWITCH_PTY == 0)) || mac_switch_pty
  if ((TAILSCALE)); then
    step "Tailscale publication check (before any change)"
    command -v tailscale >/dev/null || refuse "--tailscale requested but tailscale is not installed; nothing was changed"
    read_serve_state
    serve_refusal "nothing was changed" "already publishes"
    echo "ok"
  fi
}

mac_ready() {
  local restart="launchctl kickstart -k $DOMAIN/$WEB_LABEL"
  [[ $FORM == agent ]] || restart="sudo $restart"
  step "Ready"
  cat <<READY
  URL      : $1
  token    : cat '$PW_HOME/.config/session-mesh/token'
  runtime  : $RUNTIME_DIR
  logs     : tail -f '$LOG_DIR/web.log'   (PTY host: pty.log)
  restart  : $restart   (the web server only)
  uninstall: $INSTALL_COMMAND --uninstall
READY
  if [[ -n $MESH_RELEASE_TAG ]]; then
    echo "  release  : $MESH_RELEASE_TAG (upgrade: $INSTALL_COMMAND --upgrade; back: $INSTALL_COMMAND --rollback)"
  fi
}

mac_main() {
  local url
  mac_check_version
  mac_account
  [[ ! $HERE =~ [[:cntrl:]] ]] || refuse "checkout path contains a control character"
  mac_choose_form
  mac_choose_domain
  mac_choose_port
  mac_tailscale_cli
  ((UNINSTALL == 0)) || mac_uninstall
  mac_release_actions
  mac_observe
  if [[ $FORM == daemon ]]; then step "launchd boot-time daemons (system domain, as $ACCOUNT)"; else step "launchd agents ($DOMAIN)"; fi
  mac_board_warning
  mac_stage_plists
  mac_confirm_daemons
  prepare_runtime_dir
  mac_save_web_plist
  mac_install_plists
  mac_activate
  mac_start_jobs || mac_start_failed
  mac_after_start
  mac_link_commands
  url="http://127.0.0.1:$PORT"
  if ((TAILSCALE)); then
    step "Publishing on the tailnet (tailscale serve)"
    publish_tailscale
    url="https://$SERVED_HOST"
  fi
  mac_ready "$url"
}

mac_main
