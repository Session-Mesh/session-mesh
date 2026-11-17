#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Reads the output of `uv python list <version> --only-downloads --show-urls` on stdin and prints the
# first download URL of a non-free-threaded CPython build (nothing when there is none).
# Colour is stripped first: a job that sets CLICOLOR_FORCE (the macOS runner does) makes uv wrap the
# URL column in SGR escapes, so the URL no longer starts with "https:".
# The whole input is always read, so the writer never gets a broken pipe under `set -o pipefail`.
set -euo pipefail
esc=$(printf '\033')
sed -e "s/${esc}\\[[0-9;]*m//g" \
  | awk '$2 ~ /^https:/ && $1 !~ /freethreaded/ && url == "" {url = $2} END {if (url != "") print url}'
