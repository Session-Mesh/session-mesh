# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash disable=SC2034,SC2153 # shares its variables with install.sh and scripts/install-macos.sh
# session-mesh installer, macOS: releases with launchd jobs (--upgrade, --rollback, moving
# between a release install and a source install). Sourced by scripts/install-macos.sh; never run
# on its own. Written for the bash 3.2 of macOS.
#
# A job is the installer's own when its plist is a regular file and its program runs from
# ~/.local/share/session-mesh/current/: the PTY job's ProgramArguments[0] is
# <current>/bin/mesh-ptyhost, the web job's ProgramArguments[1] is <current>/app/server.py.
# --upgrade and --rollback act only on those; a release install preserves another PTY job.
# Jobs that run another extracted bundle D in place (D/bin/mesh-python D/app/server.py, and
# D/bin/mesh-ptyhost) are left alone unless --switch-from-bundle (mac_check_bundle_install).

PRESERVED_PTY=0 MAC_SWITCH_PTY=0 INSTALL_COMMAND=$HERE/install.sh

mac_job_runs() { [[ -f $1 && ! -L $1 && $(plist_value "$1" "ProgramArguments.$2" 2>/dev/null || true) == "$3" ]]; }

mac_require_own_jobs() {
  mac_job_runs "$WEB_PLIST" 1 "$CURRENT/app/server.py" \
    || refuse "$WEB_PLIST is not the job a release install writes (running $CURRENT/app/server.py): run the release installer without --upgrade to replace it; nothing was changed"
  mac_job_runs "$PTY_PLIST" 0 "$CURRENT/bin/mesh-ptyhost" \
    || refuse "$PTY_PLIST does not run the release's PTY host ($CURRENT/bin/mesh-ptyhost): the installer never replaces a PTY host it did not install. To move to the release's host (this ends every mesh session): launchctl bootout $DOMAIN/$PTY_LABEL; rm '$PTY_PLIST'; then run the release installer without --upgrade. Nothing was changed"
}

mac_pty_restart_command() {
  if [[ $FORM == daemon ]]; then echo "sudo launchctl kickstart -k system/$PTY_LABEL"; else echo "launchctl kickstart -k $DOMAIN/$PTY_LABEL"; fi
}

# An installed PTY job (scripts/install-macos.sh, mac_observe_pty).
mac_existing_pty() {
  local own=0
  if mac_job_runs "$PTY_PLIST" 0 "$CURRENT/bin/mesh-ptyhost"; then own=1; fi
  if [[ -n $MESH_RELEASE_TAG ]]; then
    ((own == 0)) || return 0
    [[ -z $UPGRADE_FROM ]] || mac_require_own_jobs
    PRESERVED_PTY=1
    warn "$PTY_PLIST was not written by a release install: it is preserved and its PTY host is not the release's. To use the release's host (this ends every mesh session): launchctl bootout $DOMAIN/$PTY_LABEL; rm '$PTY_PLIST'; then rerun this installer"
  elif ((SWITCH_FROM_RELEASE)); then
    if ((own)); then MAC_SWITCH_PTY=1; else PRESERVED_PTY=1; fi
  else
    ((PTY_EXPLICIT == 0)) || refuse "existing PTY configuration preserved; explicit migration is not supported"
  fi
}

# Source install over a release install: the release's own PTY job is rewritten for the host of
# this checkout; a running host is not restarted (mac_after_start says so).
mac_switch_pty() {
  PTY_BINARY=$PTY_ARGUMENT
  mac_find_ptyhost
  PTY_REWRITE=1
  [[ $PTY_ACTION != kickstart ]] || PTY_ACTION=reload
}

# --rollback: current back to the previous release, the web job reloaded and checked.
mac_rollback() {
  local target
  mac_require_own_jobs
  target=$(rollback_target) || exit 1
  if [[ $FORM == daemon ]]; then
    confirm_sudo "--rollback reloads the boot-time web daemon with sudo: $SUDO_LAUNCHCTL bootout system/$WEB_LABEL; $SUDO_LAUNCHCTL bootstrap system '$WEB_PLIST'" \
      "--rollback of boot-time daemons needs sudo and asks before using it: run it from a terminal; nothing was changed"
  fi
  step "Rollback $(link_tag "$CURRENT") -> $target"
  release_activate "$target"
  if ! mac_restart_web; then
    release_revert
    mac_restart_web || refuse "$target did not answer on 127.0.0.1:$PORT, and neither does $OLD_TAG after going back (logs: $LOG_DIR/web.log)"
    refuse "$target was not kept: its web server did not answer on 127.0.0.1:$PORT, and $OLD_TAG runs again (logs: $LOG_DIR/web.log)"
  fi
  echo "running $target on 127.0.0.1:$PORT"
  pty_host_report "$OLD_TAG" "$target" "$(mac_pty_restart_command)"
  exit 0
}

# The directory D when job plist $1 runs D/bin/$3 (ProgramArguments.0) of a bundle.
mac_job_bundle() {
  local program dir
  [[ -f $1 && ! -L $1 ]] || return 1
  program=$(plist_value "$1" ProgramArguments.0 2>/dev/null) || return 1
  dir=${program%/bin/*}
  [[ $program == "$dir/bin/$2" && -f $dir/env.sh && -f $dir/libexec/mesh-ptyhost ]] || return 1
  printf '%s' "$dir"
}

# Jobs that run another bundle in place are left as they are unless --switch-from-bundle. Even
# then the PTY job is preserved (launchd cannot point it elsewhere without stopping the host and
# its sessions), and nothing of that bundle is deleted.
mac_check_bundle_install() {
  local web pty other=''
  web=$(mac_job_bundle "$WEB_PLIST" mesh-python) || web=''
  [[ -z $web || $(plist_value "$WEB_PLIST" ProgramArguments.1 2>/dev/null || true) == "$web/app/server.py" ]] || web=''
  pty=$(mac_job_bundle "$PTY_PLIST" mesh-ptyhost) || pty=''
  [[ -z $web || $web == "$RUN_ROOT" ]] || other=$web
  [[ -z $pty || $pty == "$RUN_ROOT" ]] || other=${other:-$pty}
  [[ -n $other ]] || return 0
  ((SWITCH_FROM_BUNDLE)) \
    || refuse "this account's jobs run the bundle in $other; they were left as they are. To run ${RUN_ROOT:-$HERE} instead, rerun with --switch-from-bundle (the web job moves; the PTY job and its sessions keep running from $other; $other is never deleted)"
  warn "--switch-from-bundle: the web job moves from the bundle in $other to ${RUN_ROOT:-$HERE}. The PTY job is preserved and keeps running the host of $other with its sessions: keep $other; the installer never deletes it."
}

# The bundle's own Python and its locked dependencies; nothing is asked of this Mac's Python.
mac_check_bundle_python() {
  PYTHON=$RUN_ROOT/bin/mesh-python
  "$BUNDLE_DIR/bin/mesh-python" -c 'import aiohttp, cryptography' \
    || refuse "the bundled Python of $BUNDLE_DIR cannot import its dependencies: extract the bundle again"
  command -v curl >/dev/null || refuse "missing: curl (the installer checks the web server with it)"
  echo "ok: bundled Python ($PYTHON)"
}

# Before anything is observed: --rollback, the first stage of --upgrade, and the checks of the
# second stage, of a source install over a release install and of another bundle's jobs.
mac_release_actions() {
  [[ -z $MESH_RELEASE_TAG ]] || INSTALL_COMMAND=$CURRENT/install.sh
  if ((RESTART_PTY)) && [[ $FORM == daemon ]]; then
    refuse "--restart-pty is not available for boot-time daemons: restart the PTY host yourself (this ends every mesh session): sudo launchctl kickstart -k system/$PTY_LABEL"
  fi
  ((ROLLBACK == 0)) || mac_rollback
  if ((UPGRADE)) && [[ -z $UPGRADE_FROM ]]; then
    mac_require_own_jobs
    release_upgrade
  fi
  release_check_second_stage
  source_check_release_install
  mac_check_bundle_install
}

mac_board_warning() {
  [[ -z $RUN_ROOT$MESH_RELEASE_TAG ]] || return 0
  [[ -n $MAC_SWITCH_BIN && -x $MAC_SWITCH_BIN/mesh-board-mcp ]] \
    || warn "mesh-board-mcp is not in an opam switch: agents get no board MCP server (messages, requests, whiteboard). Build it with bash scripts/bootstrap.sh --install-only, then rerun with MESH_OPAM_SWITCH set"
}

mac_activate() {
  if [[ -n $MESH_RELEASE_TAG ]]; then release_activate "$MESH_RELEASE_TAG"; else source_remove_current; fi
}

# Release install: the web job's plist before it is replaced, for mac_start_failed (the plist of
# a git checkout's install when no release was installed yet).
WEB_PLIST_BEFORE=''
mac_save_web_plist() {
  [[ -n $MESH_RELEASE_TAG && -f $WEB_PLIST && ! -L $WEB_PLIST ]] || return 0
  WEB_PLIST_BEFORE=$(cat -- "$WEB_PLIST") || WEB_PLIST_BEFORE=''
}
mac_restore_web_plist() {
  local saved
  saved=$(mktemp "$LOG_DIR/.web-plist.XXXXXXXX") || return 1
  { printf '%s\n' "$WEB_PLIST_BEFORE" > "$saved" && chmod 644 "$saved"; } || { rm -f -- "$saved"; return 1; }
  if [[ $FORM == agent ]]; then
    mv -f -- "$saved" "$WEB_PLIST"
    return
  fi
  privileged "$SUDO_INSTALL" -m 644 -o root -g wheel "$saved" "$WEB_PLIST" || { rm -f -- "$saved"; return 1; }
  rm -f -- "$saved"
}

# The web server did not answer: a release that replaced something goes back to it: the release
# it replaced, or the web job of a git checkout (its plist restored).
mac_start_failed() {
  local before=$OLD_TAG
  [[ -n $MESH_RELEASE_TAG ]] || exit 1
  if [[ -n $OLD_TAG ]]; then
    [[ $OLD_TAG != "$MESH_RELEASE_TAG" ]] || exit 1
  else
    [[ -n $WEB_PLIST_BEFORE ]] || exit 1
    before="the installation it replaced ($WEB_PLIST as it was)"
  fi
  warn "the web server does not answer with $MESH_RELEASE_TAG: going back to $before"
  release_revert
  mac_undo_pty_start
  if [[ -z $OLD_TAG ]]; then
    mac_restore_web_plist || refuse "$MESH_RELEASE_TAG did not answer on 127.0.0.1:$PORT, and $WEB_PLIST could not be restored$PTY_UNDONE (logs: $LOG_DIR/web.log)"
  fi
  mac_restart_web || refuse "$MESH_RELEASE_TAG did not answer on 127.0.0.1:$PORT, and neither does $before after going back$PTY_UNDONE (logs: $LOG_DIR/web.log)"
  refuse "$MESH_RELEASE_TAG was not kept: its web server did not answer on 127.0.0.1:$PORT, and $before runs again$PTY_UNDONE (logs: $LOG_DIR/web.log)"
}

# Going back, PTY job: a job this run loaded (it had none, or its plist was not loaded) runs no
# mesh session yet; it is unloaded again, and a plist this run created is removed. A job that was
# loaded but stopped is left running (launchd cannot return it to that state without unloading it).
PTY_UNDONE=''
mac_undo_pty_start() {
  case $PTY_ACTION in
    create|bootstrap) ;;
    kickstart|reload)
      PTY_UNDONE="; the PTY host it started keeps running (it holds no mesh session)"
      return 0 ;;
    *) return 0 ;;
  esac
  boot_out "$PTY_LABEL"
  PTY_UNDONE="; the PTY job it loaded is unloaded, as it was before"
  [[ $PTY_ACTION == create ]] || return 0
  if [[ $FORM == agent ]]; then rm -f -- "$PTY_PLIST"; else privileged "$SUDO_RM" -f -- "$PTY_PLIST"; fi
  PTY_UNDONE="; the PTY job it created is unloaded and $PTY_PLIST removed"
}

# The PTY host's process cannot be mapped to its release on macOS (no /proc): running_pty_tag
# finds nothing, and the pruning keeps current and previous only.
pty_host_pid() { return 1; }

# After the web server answers: what happened to a PTY host that kept running, then the pruning.
mac_after_start() {
  if [[ $PTY_ACTION == keep ]] && ((PRESERVED_PTY == 0)); then
    if [[ -n $MESH_RELEASE_TAG ]]; then
      pty_host_report "$OLD_TAG" "$MESH_RELEASE_TAG" "$(mac_pty_restart_command)"
    elif ((MAC_SWITCH_PTY)); then
      warn "$PTY_PLIST now runs $PTY_BINARY. The running PTY host keeps the release's program until launchd loads the job again, which ends every mesh session: launchctl bootout $DOMAIN/$PTY_LABEL; launchctl bootstrap $DOMAIN '$PTY_PLIST'"
    fi
  fi
  [[ -z $MESH_RELEASE_TAG ]] || release_prune
}
