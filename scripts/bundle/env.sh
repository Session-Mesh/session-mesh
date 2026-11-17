# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# shellcheck shell=bash
# Sourced by the bundle entry points. The caller sets an absolute MESH_BUNDLE_ROOT.
export MESH_BIN_DIR="$MESH_BUNDLE_ROOT/bin"
export MESH_PYTHON="$MESH_BUNDLE_ROOT/bin/mesh-python"
export MESH_PROJECT_OBSERVATION_RUNTIME="$MESH_BUNDLE_ROOT/runtime/node/bin/node"
export MESH_PROJECT_OBSERVATION_ENTRY="$MESH_BUNDLE_ROOT/app/tools/project-observation.mjs"
# The project observation worker runs the public Roster CLIs through libexec/mesh-roster-*, which
# start them with the bundled Node: they begin with #!/usr/bin/env node, and that Node is not on PATH.
if [[ -f $MESH_BUNDLE_ROOT/optional/roster/scripts/roster-roadmap.cjs ]]; then
  export MESH_PROJECT_ROSTER_CLI="$MESH_BUNDLE_ROOT/libexec/mesh-roster-roadmap"
fi
if [[ -f $MESH_BUNDLE_ROOT/optional/roster/scripts/roster-pipeline.cjs ]]; then
  export MESH_PROJECT_ROSTER_PIPELINE_CLI="$MESH_BUNDLE_ROOT/libexec/mesh-roster-pipeline"
fi
# Only the bundle's own commands go on PATH. The web server and the PTY host start through these
# wrappers and pass PATH to every mesh session: the bundled Node and Python are called by absolute
# path (MESH_PYTHON, MESH_PROJECT_OBSERVATION_RUNTIME, libexec/mesh-roster-*) and never shadow the
# user's node or python3.
export PATH="$MESH_BIN_DIR:$PATH"
# Ambient developer settings must not choose a different Python or opam bridge.
unset PYTHONHOME PYTHONPATH OPAM_SWITCH_PREFIX MESH_OPAM_SWITCH
export PYTHONNOUSERSITE=1
