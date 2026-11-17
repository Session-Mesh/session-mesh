#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Installs the pre-commit hook of session-mesh: it runs scripts/check-copyright.sh on the staged
# files and refuses a commit that adds or changes a source file without its SPDX header.
#
# Usage: scripts/install-git-hooks.sh [--force]
#
# The hook goes where Git looks for hooks (`git rev-parse --git-path hooks`, which follows
# core.hooksPath and linked worktrees). An existing pre-commit hook that this script did not write
# is left alone unless --force is given. To fix a refused commit: scripts/check-copyright.sh --fix
# then stage the files again. Bypassing the hook (--no-verify) is not supported; CI runs the same check.

set -euo pipefail

readonly MARKER="# session-mesh pre-commit hook (scripts/install-git-hooks.sh)"
force=false
case "${1:-}" in
--force) force=true ;;
"") ;;
*)
	echo "Usage: $0 [--force]" >&2
	exit 2
	;;
esac

repo_root=$(git rev-parse --show-toplevel) || {
	echo "install-git-hooks: not inside a git repository" >&2
	exit 2
}
hooks_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-path hooks)
hook="$hooks_dir/pre-commit"
mkdir -p "$hooks_dir"

if [[ -e "$hook" ]] && ! grep -qF "$MARKER" "$hook" && ! $force; then
	echo "install-git-hooks: $hook exists and was not written by this script; use --force to replace it" >&2
	exit 1
fi

cat >"$hook" <<EOF
#!/usr/bin/env bash
$MARKER
set -euo pipefail
root=\$(git rev-parse --show-toplevel)
exec bash "\$root/scripts/check-copyright.sh" --staged
EOF
chmod +x "$hook"
echo "Installed the pre-commit hook: $hook"
echo "It runs scripts/check-copyright.sh --staged before every commit."
