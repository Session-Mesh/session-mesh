#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Probe a release's own helper, never the developer's configuration or command override.
set -euo pipefail
helper=${1:?usage: smoke-profile.sh HELPER SCRATCH}
scratch=${2:?usage: smoke-profile.sh HELPER SCRATCH}
[[ -f $helper && -x $helper ]] || { echo "smoke: missing executable $helper" >&2; exit 1; }
conf=$scratch/profile-config
mkdir -m 700 "$conf"
reply=$(printf '%s\n' '{"version":1,"op":"profiles.list"}' |
  env -i HOME="$scratch" MESH_CONF_DIR="$conf" "$helper")
expected='{"version":1,"ok":true,"data":{"configured":false,"registry_revision":null,"profiles":[]}}'
[[ $reply == "$expected" ]] || { echo "smoke: unexpected mesh-profile response: $reply" >&2; exit 1; }
echo 'smoke: mesh-profile answers profiles.list on a private configuration'
