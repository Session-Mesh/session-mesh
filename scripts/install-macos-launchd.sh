# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash
# launchd part of the macOS installer: sourced by scripts/install-macos.sh, never run on its own.
# Domains, the plists of the two jobs, and the only sudo (boot-time daemons, asked first).

# Commands run as root are named by their absolute path, never looked up on PATH.
SUDO_LAUNCHCTL=/bin/launchctl
SUDO_INSTALL=/usr/bin/install
# shellcheck disable=SC2034 # used by scripts/install-macos.sh
SUDO_RM=/bin/rm

job_loaded() { launchctl print "$1/$2" >/dev/null 2>&1; }
# The first domain a job is loaded in (gui/UID, user/UID or system), or nothing.
job_domain() {
  local domain
  for domain in "gui/$EUID" "user/$EUID" system; do
    if job_loaded "$domain" "$1"; then echo "$domain"; return 0; fi
  done
}
# The job's "state = ..." line, as launchctl print shows it: running, not running, ...
job_state() {
  local line
  while IFS= read -r line; do
    line=${line#"${line%%[![:space:]]*}"}
    if [[ $line == 'state = '* ]]; then echo "${line#state = }"; return 0; fi
  done < <(launchctl print "$1/$2" 2>/dev/null)
}

# sudo runs only after confirm_sudo got a yes typed on a terminal.
SUDO_CONFIRMED=0
confirm_sudo() {
  local answer=''
  ((SUDO_CONFIRMED == 0)) || return 0
  [[ -t 0 ]] || refuse "$2"
  printf '%s\nRun these commands with sudo now? [y/N] ' "$1"
  read -r answer || true
  # [y/N]: y or yes in any case, surrounding blanks ignored, nothing else (bash 3.2: no ${var,,}).
  answer=${answer#"${answer%%[![:space:]]*}"}
  answer=${answer%"${answer##*[![:space:]]}"}
  case $answer in [yY] | [yY][eE][sS]) ;; *) refuse "sudo declined; nothing was changed" ;; esac
  SUDO_CONFIRMED=1
}
privileged() {
  ((SUDO_CONFIRMED)) || refuse "internal error: sudo without confirmation"
  case $1 in
    /usr/bin/install | /bin/launchctl | /bin/rm) ;;
    *) refuse "internal error: sudo of a command outside the allowlist ($1)" ;;
  esac
  sudo "$@"
}
# launchctl in DOMAIN: through sudo for the system domain (the boot-time daemons).
launchctl_in() {
  local domain=$1
  shift
  if [[ $domain == system ]]; then privileged "$SUDO_LAUNCHCTL" "$@"; else launchctl "$@"; fi
}

# Unloads a job from one domain. launchd may still be stopping the job when bootout returns, and
# then answers non-zero ("36: Operation now in progress"): whatever the status, wait up to 5 s for
# the job to go. A job that is no longer loaded there is not an error; one still loaded is, and the
# bootout status (its message is shown above) is reported.
unload_job() {
  local domain=$1 label=$2 status=0
  launchctl_in "$domain" bootout "$domain/$label" || status=$?
  for _ in $(seq 50); do
    job_loaded "$domain" "$label" || return 0
    sleep 0.1
  done
  local command="launchctl bootout $domain/$label"
  [[ $domain != system ]] || command="sudo $SUDO_LAUNCHCTL bootout $domain/$label"
  ((status == 0)) || refuse "$command failed (status $status); the job is still loaded"
  refuse "launchd did not unload $label (inspect: launchctl print $domain/$label)"
}
# Unloads a job from every domain it is loaded in.
boot_out() {
  local domain
  for domain in "gui/$EUID" "user/$EUID" system; do
    if job_loaded "$domain" "$1"; then unload_job "$domain" "$1"; fi
  done
}
boot_in() {
  # shellcheck disable=SC2153 # DOMAIN is chosen by scripts/install-macos.sh
  launchctl_in "$DOMAIN" bootstrap "$DOMAIN" "$1" \
    || refuse "launchctl bootstrap $DOMAIN $1 failed (inspect: launchctl print $DOMAIN)"
}

# XML text for a <string>: the five predefined entities. A control character cannot be written
# in a plist (XML 1.0): plist_values_safe refuses it before anything is rendered, in this shell
# (a refusal inside $(...) would only end that subshell). plutil -lint checks the whole file.
plist_values_safe() {
  local value
  for value in "$@"; do [[ ! $value =~ [[:cntrl:]] ]] || return 1; done
}
xml_escape() {
  local value=$1 out='' char i
  for ((i = 0; i < ${#value}; i++)); do
    char=${value:i:1}
    case $char in
      '&') out+='&amp;' ;; '<') out+='&lt;' ;; '>') out+='&gt;' ;;
      '"') out+='&quot;' ;; "'") out+='&apos;' ;; *) out+=$char ;;
    esac
  done
  printf '%s' "$out"
}
xml_string() { printf '<string>%s</string>' "$(xml_escape "$1")"; }

# The keys that differ between the two forms: an agent is limited to its session type; a daemon
# runs as this account, with the environment a login would give (launchd gives a daemon none).
render_form_keys() {
  if [[ $FORM == daemon ]]; then
    printf '  <key>UserName</key>%s\n  <key>GroupName</key>%s\n' "$(xml_string "$ACCOUNT")" "$(xml_string "$GROUP")"
  else
    printf '  <key>LimitLoadToSessionType</key>%s\n' "$(xml_string "$SESSION_TYPE")"
  fi
}

# Prints a plist: label, log file, then arguments up to "--", then NAME=VALUE environment pairs.
render_plist() {
  local label=$1 log=$2 item
  shift 2
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0">' '<dict>'
  printf '  <key>Label</key>%s\n  <key>ProgramArguments</key>\n  <array>\n' "$(xml_string "$label")"
  while (($#)) && [[ $1 != -- ]]; do printf '    %s\n' "$(xml_string "$1")"; shift; done
  shift
  printf '  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n'
  for item in "$@"; do
    printf '    <key>%s</key>%s\n' "$(xml_escape "${item%%=*}")" "$(xml_string "${item#*=}")"
  done
  printf '  </dict>\n  <key>WorkingDirectory</key>%s\n' "$(xml_string "$PW_HOME")"
  render_form_keys
  printf '  <key>RunAtLoad</key><true/>\n'
  printf '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n'
  printf '  <key>ThrottleInterval</key><integer>%d</integer>\n' "$THROTTLE_SECONDS"
  printf '  <key>StandardOutPath</key>%s\n  <key>StandardErrorPath</key>%s\n' "$(xml_string "$log")" "$(xml_string "$log")"
  printf '%s\n' '</dict>' '</plist>'
}

# Renders a plist into the staging directory and checks it with plutil -lint; STAGED is its path.
# Nothing is installed yet: every value is checked before any change.
stage_plist() {
  local label=$1
  plist_values_safe "$@" "$PW_HOME" "$ACCOUNT" "$GROUP" \
    || refuse "a value for the launchd job $label contains a control character; nothing was changed"
  STAGED=$(mktemp "$STAGE_DIR/$label.XXXXXXXX") || refuse "cannot write in $STAGE_DIR"
  if ! render_plist "$@" > "$STAGED" || ! plutil -lint -s "$STAGED" >/dev/null; then
    refuse "could not write a valid launchd plist for $label; nothing was changed"
  fi
  chmod 644 "$STAGED"
}

# The environment of both jobs; a daemon also gets the variables a login sets.
job_environment() {
  JOB_ENV=("MESH_RUNTIME_DIR=$RUNTIME_DIR" "PATH=$AGENT_PATH" "LANG=$AGENT_LANG")
  if [[ $FORM == daemon ]]; then
    JOB_ENV+=("HOME=$PW_HOME" "USER=$ACCOUNT" "LOGNAME=$ACCOUNT" "SHELL=$LOGIN_SHELL")
  fi
}

remove_stage() { rm -f -- "$STAGE_DIR"/*; rmdir -- "$STAGE_DIR" 2>/dev/null || true; }

mac_stage_plists() {
  STAGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/session-mesh-plists.XXXXXXXX") || refuse "cannot create a temporary directory"
  trap remove_stage EXIT
  job_environment
  PTY_STAGED=
  if [[ $PTY_ACTION == create || $PTY_REWRITE == 1 ]]; then
    stage_plist "$PTY_LABEL" "$LOG_DIR/pty.log" "$PTY_BINARY" -- "${JOB_ENV[@]}"
    PTY_STAGED=$STAGED
  fi
  stage_plist "$WEB_LABEL" "$LOG_DIR/web.log" "$PYTHON" "$APP_ROOT/server.py" -- "${JOB_ENV[@]}" \
    "MESH_PORT=$PORT" ${OPAM_SWITCH:+"MESH_OPAM_SWITCH=$OPAM_SWITCH"}
  WEB_STAGED=$STAGED
}

# The commands of this run that sudo will execute, one per line, in the order they run.
daemon_sudo_commands() {
  local install="$SUDO_INSTALL -m 644 -o root -g wheel" pty="system/$PTY_LABEL"
  [[ -z $PTY_STAGED ]] || echo "  $install <new plist> '$PTY_PLIST'"
  echo "  $install <new plist> '$WEB_PLIST'"
  case $PTY_ACTION in
    create|bootstrap) echo "  $SUDO_LAUNCHCTL bootstrap system '$PTY_PLIST'" ;;
    reload) echo "  $SUDO_LAUNCHCTL bootout $pty   (the PTY host is not running: no session ends)"
      echo "  $SUDO_LAUNCHCTL bootstrap system '$PTY_PLIST'" ;;
    kickstart) echo "  $SUDO_LAUNCHCTL kickstart $pty   (starts the stopped PTY host)" ;;
  esac
  if job_loaded system "$WEB_LABEL"; then
    echo "  $SUDO_LAUNCHCTL bootout system/$WEB_LABEL   (stops the web server; the PTY host keeps running)"
  fi
  echo "  $SUDO_LAUNCHCTL bootstrap system '$WEB_PLIST'"
}

# Daemons only: the one confirmation, asked before any change, lists every sudo command.
mac_confirm_daemons() {
  [[ $FORM == daemon ]] || return 0
  confirm_sudo "--at-boot installs boot-time daemons (owner root, group wheel, mode 644) that launchd starts at boot as $ACCOUNT. This run executes with sudo:
$(daemon_sudo_commands)" \
    "--at-boot needs sudo and asks before using it: run it from a terminal; nothing was changed"
}

# Agents: renamed into ~/Library/LaunchAgents. Daemons: installed as root:wheel 0644, which
# launchd requires of /Library/LaunchDaemons.
mac_install_plists() {
  # The log files exist before launchd opens them, so that they belong to this account.
  if ! { mkdir -p "$LOG_DIR" && touch "$LOG_DIR/pty.log" "$LOG_DIR/web.log"; }; then
    refuse "cannot create the logs in $LOG_DIR"
  fi
  if [[ $FORM == agent ]]; then
    mkdir -p "$AGENT_DIR" || refuse "cannot create $AGENT_DIR"
    [[ -z $PTY_STAGED ]] || mv -f -- "$PTY_STAGED" "$PTY_PLIST"
    mv -f -- "$WEB_STAGED" "$WEB_PLIST"
  else
    if [[ -n $PTY_STAGED ]]; then
      privileged "$SUDO_INSTALL" -m 644 -o root -g wheel "$PTY_STAGED" "$PTY_PLIST" || refuse "sudo install of $PTY_PLIST failed"
    fi
    privileged "$SUDO_INSTALL" -m 644 -o root -g wheel "$WEB_STAGED" "$WEB_PLIST" || refuse "sudo install of $WEB_PLIST failed"
  fi
  remove_stage
  trap - EXIT
}

# PTY_ACTION reload: the agent is loaded but not running and its plist changed; loading it again
# applies the new plist and ends no session (no host runs).
mac_start_pty() {
  case $PTY_ACTION in
    create|bootstrap) boot_in "$PTY_PLIST" ;;
    reload) boot_out "$PTY_LABEL"; boot_in "$PTY_PLIST" ;;
    kickstart)
      launchctl_in "$PTY_DOMAIN" kickstart "$PTY_DOMAIN/$PTY_LABEL" \
        || refuse "launchctl kickstart $PTY_DOMAIN/$PTY_LABEL failed" ;;
  esac
}

# The web server is replaced: unloaded (stopped) and loaded again with its plist, then given up
# to 6 s to answer.
mac_restart_web() {
  boot_out "$WEB_LABEL"
  boot_in "$WEB_PLIST"
  for _ in $(seq 20); do
    health && return 0
    sleep 0.3
  done
  health
}

# Status 1 when the web server does not answer (the caller decides between exit and rollback).
mac_start_jobs() {
  mac_start_pty
  if ! mac_restart_web; then
    echo "the server does not answer on 127.0.0.1:$PORT; the end of $LOG_DIR/web.log:" >&2
    tail -n 20 "$LOG_DIR/web.log" >&2 2>/dev/null || true
    return 1
  fi
  echo "running on 127.0.0.1:$PORT"
  mac_lifetime_note
}

# What keeps the jobs running, by form; the analogue of the Linux linger warning.
mac_lifetime_note() {
  if [[ $FORM == daemon ]]; then
    echo "Boot-time daemons: launchd starts them at boot as $ACCOUNT, with nobody logged in."
    echo "With FileVault on, a restart waits until the disk is unlocked before anything starts."
  elif [[ $SESSION_TYPE == Aqua ]]; then
    warn "the agents belong to your graphical login (gui/$EUID): logging out stops them, and with them every mesh session; launchd starts them again at the next graphical login"
  else
    warn "no graphical login: the agents are loaded in the background domain user/$EUID. They run until the Mac restarts, and are not loaded again after a restart until you rerun ./install.sh or run: launchctl bootstrap user/$EUID '$PTY_PLIST' && launchctl bootstrap user/$EUID '$WEB_PLIST'"
    warn "to start them at boot with nobody logged in, install them once as boot-time daemons (needs sudo, asked first): ./install.sh --uninstall; launchctl bootout user/$EUID/$PTY_LABEL (this ends every mesh session); rm '$PTY_PLIST'; ./install.sh --at-boot"
  fi
}
