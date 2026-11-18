# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash disable=SC2034,SC2153 # shares its variables with scripts/install-linux.sh and install.sh
# session-mesh installer, Linux: what the installer may do with each systemd user unit. Sourced
# by scripts/install-linux.sh; never run on its own.
#
# A unit is the installer's own ("ours") when its fragment is the installer's regular file in
# UNIT_DIR, it has no drop-in, and its one ExecStart runs from ~/.local/share/session-mesh/current/:
#   session-mesh.service      ExecStart=:"<python>" "<current>/app/server.py"
#   session-mesh-pty.service  ExecStart=:"<current>/bin/mesh-ptyhost"
# "bundle": the same file shape, running another extracted bundle D in place (an earlier
# `./mesh install`, or a bundle unpacked by hand such as under ~/.local/libexec/session-mesh):
#   session-mesh.service      ExecStart=:"<D>/bin/mesh-python" "<D>/app/server.py"
#   session-mesh-pty.service  ExecStart=:"<D>/bin/mesh-ptyhost"
# with D/env.sh and D/libexec/mesh-ptyhost present; KIND_DIR is then D. check_bundle_install
# leaves those alone unless --switch-from-bundle.
# "legacy": the same file shape, written by an installer of a git checkout (the web server or
# the Python PTY host of a checkout). A release install replaces those after saying so. Any
# other unit is the user's: --upgrade and --rollback refuse, an install preserves the PTY unit.

# Unit values are written inside "...": backslash and quote are escaped and % (a systemd
# specifier) is doubled. ExecStart=: disables $ substitution, so $ stays literal.
systemd_quote() { local value=${1//\\/\\\\}; value=${value//\"/\\\"}; printf '%s' "${value//%/%%}"; }

# Observes unit $1 without reading ExecStart or environment/credential data: sets load, active,
# sub, fragment, dropins. $2 names it in refusals. Its failure is the first sign of a missing
# user session (sudo, root, container, WSL).
observe_unit() {
  local observation key value reload=
  local -A observed=()
  observation=$(systemctl --user show "$1" --property=LoadState,ActiveState,SubState,FragmentPath,DropInPaths,NeedDaemonReload 2>/dev/null) \
    || user_session_refusal "systemctl --user show"
  load='' active='' sub='' fragment='' dropins=''
  while IFS='=' read -r key value; do
    # ${observed[$key]+x} rather than the -v operator of bash 4.2: the bash 3.2 of macOS parses
    # this file, though it never runs it.
    [[ -z ${observed[$key]+x} ]] || refuse "ambiguous $2 manager observation"
    observed[$key]=1
    case $key in
      LoadState) load=$value ;; ActiveState) active=$value ;; SubState) sub=$value ;;
      FragmentPath) fragment=$value ;; DropInPaths) dropins=$value ;;
      NeedDaemonReload) reload=$value ;;
      *) refuse "unexpected $2 manager observation" ;;
    esac
  done <<< "$observation"
  [[ ${#observed[@]} == 6 && $reload == no ]] || refuse "$2 configuration requires reload or observation is incomplete"
}

# The value of the only ExecStart line of file $1; fails when there is not exactly one.
single_exec() {
  local line value='' count=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*ExecStart[[:space:]]*=(.*)$ ]] || continue
    value=${BASH_REMATCH[1]} count=$((count + 1))
  done < "$1"
  ((count == 1)) && printf '%s' "$value"
}

# The directory D of a bundle whose wrapper is $1 (D/bin/<name>), when D holds a bundle.
bundle_of() {
  local dir=${1%/bin/*}
  [[ $1 == "$dir/bin/$2" && -f $dir/env.sh && -f $dir/libexec/mesh-ptyhost ]] && printf '%s' "$dir"
}

# KIND: ours, bundle (KIND_DIR its directory), legacy, absent or user, for unit $1 (web or pty)
# as observed by observe_unit.
unit_kind() {
  local file=$UNIT_DIR/$2 value current python
  KIND=user KIND_DIR=''
  if [[ $load == not-found && -z $fragment && ! -e $file && ! -L $file ]]; then KIND=absent; return 0; fi
  if [[ $load != loaded || $fragment != "$file" || -n $dropins || -L $file || ! -f $file || -e $file.d ]]; then return 0; fi
  value=$(single_exec "$file") || return 0
  current=$(systemd_quote "$CURRENT")
  # The interpreter: the first quoted word of an ExecStart=:"<python>" "<script>" line.
  python=${value#:\"} && python=${python%%\"*}
  case $1 in
    web) if [[ $value == ":\"$python\" \"$current/app/server.py\"" ]]; then KIND=ours
         elif KIND_DIR=$(bundle_of "$python" mesh-python) && [[ $value == ":\"$KIND_DIR/bin/mesh-python\" \"$KIND_DIR/app/server.py\"" ]]; then KIND=bundle
         elif [[ $value =~ ^:\"[^\"]+\"\ \"[^\"]+/server\.py\"$ ]]; then KIND=legacy
         fi ;;
    pty) if [[ $value == ":\"$current/bin/mesh-ptyhost\"" ]]; then KIND=ours
         elif KIND_DIR=$(bundle_of "$python" mesh-ptyhost) && [[ $value == ":\"$KIND_DIR/bin/mesh-ptyhost\"" ]]; then KIND=bundle
         elif [[ $value =~ ^:\"[^\"]+\"\ \"[^\"]+/ptyhost\.py\"$ ]]; then KIND=legacy
         fi ;;
  esac
  [[ $KIND == bundle ]] || KIND_DIR=''
}

# The kinds of both units: WEB_KIND, PTY_KIND and their bundle directories WEB_BUNDLE, PTY_BUNDLE
# (the PTY observation stays in load, active, ...).
WEB_KIND='' WEB_BUNDLE='' PTY_BUNDLE='' WEB_DROPINS='' PTY_DROPINS=''
observe_both_units() {
  observe_unit "$UNIT" web
  unit_kind web "$UNIT"
  WEB_KIND=$KIND WEB_BUNDLE=$KIND_DIR WEB_DROPINS=$dropins
  observe_unit "$PTY_UNIT" PTY
  unit_kind pty "$PTY_UNIT"
  PTY_KIND=$KIND PTY_BUNDLE=$KIND_DIR PTY_DROPINS=$dropins
}

# The drop-in files named by systemd's DropInPaths $1, into DROPIN_FILES. systemd separates them
# with a space and does not quote a path that holds one: a path ends at ".conf" before a space or
# at the end, where the file exists.
DROPIN_FILES=()
dropin_files() {
  local rest=$1 part path=''
  DROPIN_FILES=()
  while [[ -n $rest ]]; do
    part=${rest%% *}
    if [[ $part == "$rest" ]]; then rest=''; else rest=${rest#* }; fi
    if [[ -n $path ]]; then path="$path $part"; else path=$part; fi
    [[ -n $path ]] || continue
    if [[ $path == *.conf && ( -f $path || -z $rest ) ]]; then DROPIN_FILES+=("$path"); path=''; fi
  done
  [[ -z $path ]] || DROPIN_FILES+=("$path")
}

# The settings a drop-in may set that override what the installer writes into a unit.
OVERRIDING_KEYS='ExecStart|Environment|EnvironmentFile|UnsetEnvironment|PassEnvironment'
# An Environment= line that sets MESH_PORT itself: the name starts the value or follows a space or a
# quote, so FOO_MESH_PORT=1 does not count.
PORT_SETTING="^[[:space:]]*Environment[[:space:]]*=(.*[[:space:]\"'])?MESH_PORT=([0-9]+)"

# The first drop-in of unit $1 (systemd's DropInPaths $2, and $UNIT_DIR/$1.d) that sets what the
# installer writes: printed as three lines, the file, the MESH_PORT it sets (empty when none) and
# the settings it sets among OVERRIDING_KEYS. Fails when there is none.
overriding_dropin() {
  local file line keys port
  dropin_files "$2"
  for file in ${DROPIN_FILES[@]+"${DROPIN_FILES[@]}"} "$UNIT_DIR/$1.d"/*.conf; do
    [[ -f $file ]] || continue
    keys='' port=''
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*($OVERRIDING_KEYS)[[:space:]]*= ]] || continue
      [[ " $keys " == *" ${BASH_REMATCH[1]}= "* ]] || keys="$keys${keys:+ }${BASH_REMATCH[1]}="
      [[ ! $line =~ $PORT_SETTING ]] || port=${BASH_REMATCH[2]}
    done < "$file"
    [[ -n $keys ]] || continue
    printf '%s\n%s\n%s' "$file" "$port" "$keys"
    return 0
  done
  return 1
}

# What a refusal of check_overriding_dropins leaves: a release install has already downloaded and
# checked its release into releases/<tag> (its own installer runs from there), nothing else.
dropin_refusal_state() {
  if [[ -n $MESH_RELEASE_TAG ]]; then
    printf '%s' "the services, their units and current/ were not changed; release $MESH_RELEASE_TAG stays downloaded and checked in $RELEASES/$MESH_RELEASE_TAG, where a rerun finds it"
  else
    printf '%s' 'nothing was changed'
  fi
}

# A release, bundle or switching install rewrites the units with its own command and environment.
# A drop-in (an overlay such as one made with systemctl --user edit) that sets them still wins: the
# service would keep running what the drop-in says, and the health check would pass on it. Refused
# before the units change, with the way to migrate; the installer never edits or removes a drop-in.
# (A source install keeps reading MESH_PORT from a drop-in: installed_port.)
check_overriding_dropins() {
  local name dropins found file keys port hint
  [[ -n $MESH_RELEASE_TAG || -n $RUN_ROOT ]] || ((SWITCH_FROM_BUNDLE || SWITCH_FROM_RELEASE)) || return 0
  for name in "$UNIT" "$PTY_UNIT"; do
    if [[ $name == "$UNIT" ]]; then dropins=$WEB_DROPINS; else dropins=$PTY_DROPINS; fi
    found=$(overriding_dropin "$name" "$dropins") || continue
    file=${found%%$'\n'*} found=${found#*$'\n'}
    port=${found%%$'\n'*} keys=${found#*$'\n'}
    hint=''
    [[ -z $port ]] || hint=" The drop-in sets MESH_PORT=$port, which the moved-aside drop-in no longer gives: rerun with MESH_PORT=$port in the environment to keep that port."
    refuse "$file, a drop-in of $name, sets $keys: it overrides the command and environment this installer writes into $name, so $name would keep running what the drop-in says instead of ${RUN_ROOT:-$HERE}. The installation's own unit provides the server: before switching, remove the drop-in or move it aside (mv -- '$file' '$file.disabled'), run systemctl --user daemon-reload, then rerun this installer.$hint The installer never edits or removes a drop-in; $(dropin_refusal_state)"
  done
}

# An account whose units run another extracted bundle in place is left as it is: refused before
# any change, unless --switch-from-bundle, which says what moves and what stays. Nothing of that
# bundle is ever deleted: a running PTY host may still execute it.
SWITCHED_FROM=''
check_bundle_install() {
  local other=''
  [[ -z $WEB_BUNDLE || $WEB_BUNDLE == "$RUN_ROOT" ]] || other=$WEB_BUNDLE
  [[ -z $PTY_BUNDLE || $PTY_BUNDLE == "$RUN_ROOT" ]] || other=${other:-$PTY_BUNDLE}
  [[ -n $other ]] || return 0
  SWITCHED_FROM=$other
  ((SWITCH_FROM_BUNDLE)) \
    || refuse "this account's services run the bundle in $other; they were left as they are. To run ${RUN_ROOT:-$HERE} instead, rerun with --switch-from-bundle (the web service moves; the running PTY host and its sessions keep running from $other until it restarts; $other is never deleted)"
  warn "--switch-from-bundle: the services move from the bundle in $other to ${RUN_ROOT:-$HERE}. The running PTY host keeps running from $other, with its sessions, until it restarts (restarting it ends every mesh session). Keep $other until then; the installer never deletes it."
  [[ -z $PTY_BUNDLE || $PTY_BUNDLE == "$RUN_ROOT" ]] || REWRITE_PTY=1
}

# --upgrade and --rollback act only on the installer's own units.
require_own_units() {
  observe_both_units
  [[ $WEB_KIND == ours ]] || refuse "$UNIT_DIR/$UNIT is not the unit a release install writes (its own file, no drop-in, running $CURRENT/app/server.py): the installer does not change it. Run the release installer without --upgrade to replace it, or adapt it by hand; nothing was changed"
  [[ $PTY_KIND == ours ]] || refuse "$PTY_UNIT is not the unit a release install writes (its own file $UNIT_DIR/$PTY_UNIT, no drop-in, running $CURRENT/bin/mesh-ptyhost): the installer never replaces a PTY host it did not install. To move it to the release's host (this ends every mesh session): systemctl --user disable --now $PTY_UNIT; remove its unit file and drop-ins; systemctl --user daemon-reload; then run the release installer without --upgrade. Nothing was changed"
}

PTY_RESTART_COMMAND="systemctl --user restart $PTY_UNIT"

# The main process of the PTY unit (for running_pty_tag); 0 or nothing when it does not run.
pty_host_pid() {
  local shown
  shown=$(systemctl --user show "$PTY_UNIT" -p MainPID 2>/dev/null) || return 1
  [[ $shown == *MainPID=* ]] || return 1
  shown=${shown#*MainPID=}
  printf '%s' "${shown%%[!0-9]*}"
}

# Starts the web unit again and waits up to 6 s for it to answer.
restart_web() {
  systemctl --user restart "$UNIT" || true
  for _ in $(seq 20); do
    health && return 0
    sleep 0.3
  done
  health
}

# The web server did not answer on the new release or bundle: current goes back (a release
# install; a switch from a release gets its link back), the unit files as they were, the web server
# restarts on what it ran before: the previous release, the git checkout whose units a first
# release install replaced, or the bundle or release a switch moved from. The PTY host is never
# restarted.
# START_PTY and CREATE_PTY are read by undo_pty_start: set here, before any path that can reach
# roll_back_web (--rollback runs it before decide_pty assigns them for a real install).
WEB_UNIT_BEFORE='' PTY_UNIT_BEFORE='' PTY_UNDONE='' START_PTY=0 CREATE_PTY=0
roll_back_web() {
  local before=${OLD_TAG:-the installation it replaced ($UNIT as it was)}
  warn "the web server does not answer with $1: going back to $before"
  if [[ -n $MESH_RELEASE_TAG ]]; then release_revert; else source_restore_current; fi
  undo_pty_start
  if [[ -n $WEB_UNIT_BEFORE ]]; then printf '%s\n' "$WEB_UNIT_BEFORE" > "$UNIT_DIR/$UNIT"; fi
  if [[ -n $PTY_UNIT_BEFORE ]]; then printf '%s\n' "$PTY_UNIT_BEFORE" > "$UNIT_DIR/$PTY_UNIT"; fi
  systemctl --user daemon-reload
  systemctl --user status "$UNIT" --no-pager || true
  if restart_web; then
    refuse "$1 was not kept: its web server did not answer on 127.0.0.1:$PORT, and $before runs again$PTY_UNDONE (logs: journalctl --user -u session-mesh)"
  fi
  refuse "$1 did not answer on 127.0.0.1:$PORT and neither does $before after going back$PTY_UNDONE (logs: journalctl --user -u session-mesh)"
}

# Going back from a release install that started the PTY host: the host was not running before,
# so it holds no mesh session; it is stopped again, and a PTY unit this run created is disabled
# and removed. PTY_UNDONE says so in the final message.
undo_pty_start() {
  ((START_PTY)) || return 0
  if ! systemctl --user stop "$PTY_UNIT"; then
    PTY_UNDONE="; the PTY host it started could not be stopped: systemctl --user stop $PTY_UNIT"
    return 0
  fi
  PTY_UNDONE="; the PTY host it started is stopped, as it was before"
  ((CREATE_PTY)) || return 0
  systemctl --user disable "$PTY_UNIT" >/dev/null 2>&1 || true
  rm -f -- "$UNIT_DIR/$PTY_UNIT"
  PTY_UNDONE="; the PTY host it started is stopped and $PTY_UNIT, which it created, is removed"
}

# An install whose web server does not answer goes back when it replaced something: for a release
# install, another release or the web unit it replaced (OLD_TAG is then empty); for any install,
# the web unit of the bundle (--switch-from-bundle) or release (--from-source) it moved from.
can_go_back() {
  if [[ -n $MESH_RELEASE_TAG && -n $OLD_TAG ]]; then
    [[ $OLD_TAG != "$MESH_RELEASE_TAG" ]] && return 0
    return 1
  fi
  [[ -n $MESH_RELEASE_TAG || -n $SWITCHED_FROM ]] || ((SWITCH_FROM_RELEASE)) || return 1
  [[ -n $WEB_UNIT_BEFORE ]] && return 0
  return 1
}

# --rollback: current back to the previous release, the web server restarted and checked.
linux_rollback() {
  local target
  require_own_units
  target=$(rollback_target) || exit 1
  step "Rollback $(link_tag "$CURRENT") -> $target"
  WEB_UNIT_BEFORE=$(cat "$UNIT_DIR/$UNIT")
  release_activate "$target"
  restart_web || roll_back_web "$target"
  echo "running $target on 127.0.0.1:$PORT"
  relink_logout_all "$HOME/.local/bin" \
    || warn "could not relink $HOME/.local/bin/mesh-logout-all to the release restored; check that link"
  pty_host_report "$OLD_TAG" "$target" "$PTY_RESTART_COMMAND"
  exit 0
}

# Release install, PTY unit: create it, keep the installer's own, replace a checkout's Python
# host after saying so, rewrite another bundle's (check_bundle_install, never restarted), preserve
# any other (an upgrade refuses it).
release_pty_decision() {
  case $PTY_KIND in
    ours) ;;
    bundle) [[ -z $UPGRADE_FROM ]] || require_own_units ;;
    legacy)
      warn "$PTY_UNIT runs the Python PTY host of a git checkout, which is gone. The installer replaces the unit with the release's native host ($CURRENT/bin/mesh-ptyhost); no data or configuration moves, the checkout is left as it is."
      REWRITE_PTY=1 ;;
    *)
      dropin_files "$dropins"
      refuse_python_host "$fragment" ${DROPIN_FILES[@]+"${DROPIN_FILES[@]}"}
      [[ -z $UPGRADE_FROM ]] || require_own_units
      PRESERVED_PTY=1
      warn "$PTY_UNIT was not written by a release install: it is preserved and its PTY host is not the release's. To use the release's host (this ends every mesh session): systemctl --user disable --now $PTY_UNIT; remove its unit file and drop-ins; systemctl --user daemon-reload; then rerun this installer" ;;
  esac
  PTY_BINARY=$CURRENT/bin/mesh-ptyhost
}

# Source install over a release install: the release's own PTY unit is rewritten for the host
# of the checkout; any other PTY unit is preserved.
switch_pty_decision() {
  if [[ $PTY_KIND == ours ]]; then REWRITE_PTY=1; else PRESERVED_PTY=1; fi
}

# Release install, web unit: notice for a checkout's unit, refusal of a user's unit on upgrade.
release_web_decision() {
  case $WEB_KIND in
    bundle) [[ -z $UPGRADE_FROM ]] || require_own_units ;;
    legacy) warn "$UNIT runs the web server of a git checkout; the installer replaces it with the release's ($CURRENT/app/server.py). No data or configuration moves, the checkout is left as it is." ;;
    user) [[ -z $UPGRADE_FROM ]] || require_own_units ;;
  esac
}

# After the web server answers: what happened to the PTY host.
report_pty_host() {
  if ((PRESERVED_PTY || START_PTY)); then return 0; fi
  if [[ -n $MESH_RELEASE_TAG ]]; then
    if ((REWRITE_PTY)); then OLD_TAG=''; fi
    pty_host_report "$OLD_TAG" "$MESH_RELEASE_TAG" "$PTY_RESTART_COMMAND"
  elif ((REWRITE_PTY)); then
    warn "$PTY_UNIT now runs $PTY_BINARY. The running PTY host keeps the program it started with until it restarts, and restarting it ends every mesh session. When you are ready: $PTY_RESTART_COMMAND"
  fi
}
