#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Fixed inputs of the release builds, sourced by scripts/release-build-static.sh (Linux) and by the
# macOS job of .github/workflows/release.yml. Both are part of the CI cache keys.
#
# The opam repository is read at this commit, not at its moving head, so that the same source tree
# gives the same dependency versions whenever it is built. Moving it is a release decision: change
# it here, and read the build and smoke results before tagging.
# shellcheck disable=SC2034  # read by the scripts that source this file
opam_repository="git+https://github.com/ocaml/opam-repository.git#d5bbc6fd758bf0283bc922684316a9bdc2c256ea"
