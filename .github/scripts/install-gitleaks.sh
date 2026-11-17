#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Install the pinned gitleaks release binary into <directory> after checking its
# SHA-256, for the public CI only (leak-guard runs it for the secret rules).
#   bash .github/scripts/install-gitleaks.sh "$RUNNER_TEMP/gitleaks"
# Version and digest come from the release's own checksums file
# (gitleaks_8.30.1_checksums.txt, entry gitleaks_8.30.1_linux_x64.tar.gz),
# re-checked against the downloaded archive on 2026-11-13.
set -euo pipefail

version="8.30.1"
digest="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
archive="gitleaks_${version}_linux_x64.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}"

if [ "$#" -ne 1 ]; then
  echo "usage: install-gitleaks.sh <directory>" >&2
  exit 2
fi
target="$1"
mkdir -p "$target"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$target/$archive" "$url"
echo "$digest  $target/$archive" | sha256sum --check --strict -
tar -xzf "$target/$archive" -C "$target" gitleaks
rm -f "$target/$archive"
"$target/gitleaks" version
