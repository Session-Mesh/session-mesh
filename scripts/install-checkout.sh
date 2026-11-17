# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash
# session-mesh installer: the start of a source install (install.sh of a git checkout) and of a
# bundle install (app/install.sh of an extracted bundle, which `./mesh install` runs). Sourced by
# install.sh, which has parsed the options and defined refuse and bundle_intact; never run on its
# own. A release install starts in install.sh itself (release_bootstrap), which must run alone.
# Written for the bash 3.2 of macOS.
# shellcheck disable=SC2034 # HERE, APP_ROOT, BUNDLE_DIR and RUN_ROOT are read by install.sh and what it sources

# Source install: HERE is the checkout, and the units run from it. Bundle install (the app/ of an
# extracted bundle, which `./mesh install` runs): the units run from that bundle (RUN_ROOT).
source_bootstrap() {
  HERE="$(cd "$(dirname "$INSTALLER")" && pwd)"
  [[ $HERE != */.local/share/session-mesh/releases/*/app ]] \
    || refuse "this is the code of an installed release; run the release's installer instead: ~/.local/share/session-mesh/current/install.sh"
  ((ROLLBACK + RESTART_PTY == 0)) && [[ -z $ASSETS_DIR ]] \
    || refuse "--rollback, --restart-pty and --assets-dir belong to a release install; this installer is not a release's"
  if [[ -f $HERE/../bundle.json && -f $HERE/../env.sh ]]; then bundle_bootstrap; return 0; fi
  ((UPGRADE == 0)) || refuse "this is a source install (a git clone): to upgrade it, run git pull, then ./install.sh"
  APP_ROOT=$HERE
}
bundle_bootstrap() {
  BUNDLE_DIR=$(cd "$HERE/.." && pwd -P)
  RUN_ROOT=$BUNDLE_DIR
  APP_ROOT=$BUNDLE_DIR/app
  ((UPGRADE == 0)) || refuse "this is an extracted bundle ($BUNDLE_DIR): to move to a newer one, extract it elsewhere and run its ./mesh install --switch-from-bundle, or install a release"
  [[ -z $PTY_ARGUMENT ]] || refuse "--ptyhost belongs to a git checkout; the bundle $BUNDLE_DIR brings its own PTY host"
  bundle_intact "$BUNDLE_DIR" \
    || refuse "$BUNDLE_DIR is not a complete bundle (a file is missing, or a native program does not match its bundle.json): extract the archive again"
}
