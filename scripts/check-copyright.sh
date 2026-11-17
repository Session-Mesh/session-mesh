#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Checks (and with --fix inserts) the SPDX license and copyright header of every first-party
# source file of session-mesh. The header text is the same in each language's comment style:
#
#   SPDX-License-Identifier: AGPL-3.0-or-later
#   Copyright (c) 2026 Atacama <contact@atacama.tech>
#
# Usage:
#   scripts/check-copyright.sh                check every tracked source file
#   scripts/check-copyright.sh --staged       check the staged files only (the pre-commit hook)
#   scripts/check-copyright.sh --fix [FILE..] insert the missing headers (all tracked files by default)
#   scripts/check-copyright.sh FILE..         check the named files
#
# Which files are sources: .ml .mli (OCaml), .ts .tsx .js .mjs .cjs (// comments), .py and .sh
# (# comments), .css, .html, and extensionless files that start with a shebang. A tracked file
# matching a pattern of scripts/copyright-exclude.txt is never checked or modified. Run from any
# directory of the repository; the exclusion file can be replaced with COPYRIGHT_EXCLUDE_FILE.
# Exit status: 0 all headers present, 1 a header is missing or wrong, 2 usage or environment error.

set -euo pipefail

readonly SPDX_LINE="SPDX-License-Identifier: AGPL-3.0-or-later"
readonly COPYRIGHT_LINE="Copyright (c) 2026 Atacama <contact@atacama.tech>"
readonly SCAN_LINES=15

usage() {
	sed -n '/^# Checks/,/^$/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
}

fix_mode=false
staged_mode=false
files=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	--fix) fix_mode=true ;;
	--staged) staged_mode=true ;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		shift
		files+=("$@")
		break
		;;
	-*)
		echo "check-copyright: unknown option $1" >&2
		exit 2
		;;
	*) files+=("$1") ;;
	esac
	shift
done

repo_root=$(git rev-parse --show-toplevel) || {
	echo "check-copyright: not inside a git repository" >&2
	exit 2
}
cd "$repo_root"

exclude_file=${COPYRIGHT_EXCLUDE_FILE:-scripts/copyright-exclude.txt}
exclude_patterns=()
if [[ -f "$exclude_file" ]]; then
	while IFS= read -r line || [[ -n "$line" ]]; do
		line=${line%%#*}
		line=${line#"${line%%[![:space:]]*}"}
		line=${line%"${line##*[![:space:]]}"}
		[[ -n "$line" ]] && exclude_patterns+=("$line")
	done <"$exclude_file"
fi

is_excluded() {
	local path="$1" pattern
	for pattern in "${exclude_patterns[@]+"${exclude_patterns[@]}"}"; do
		# shellcheck disable=SC2254
		case "$path" in $pattern) return 0 ;; esac
	done
	return 1
}

# Prints the comment style of a file: ocaml, slash, hash, css, html, or nothing if it is not a source.
file_kind() {
	local path="$1" first
	case "$path" in
	*.ml | *.mli) echo ocaml ;;
	*.ts | *.tsx | *.js | *.mjs | *.cjs) echo slash ;;
	*.py | *.sh) echo hash ;;
	*.css) echo css ;;
	*.html) echo html ;;
	*)
		[[ "$(basename "$path")" == *.* ]] && return 0
		IFS= read -r first <"$path" 2>/dev/null || true
		case "$first" in
		'#!'*python*) echo hash ;;
		'#!'*sh* | '#!'*bash*) echo hash ;;
		'#!'*node* | '#!'*deno* | '#!'*bun*) echo slash ;;
		esac
		;;
	esac
}

render_header() {
	case "$1" in
	ocaml)
		printf '%s\n' \
			'(******************************************************************************)' \
			'(*                                                                            *)'
		printf '(* %-74s *)\n' "$SPDX_LINE" "$COPYRIGHT_LINE"
		printf '%s\n' \
			'(*                                                                            *)' \
			'(******************************************************************************)'
		;;
	slash) printf '// %s\n// %s\n' "$SPDX_LINE" "$COPYRIGHT_LINE" ;;
	hash) printf '# %s\n# %s\n' "$SPDX_LINE" "$COPYRIGHT_LINE" ;;
	css) printf '/*\n * %s\n * %s\n */\n' "$SPDX_LINE" "$COPYRIGHT_LINE" ;;
	html) printf '<!--\n  %s\n  %s\n-->\n' "$SPDX_LINE" "$COPYRIGHT_LINE" ;;
	esac
}

# Prints "ok", "missing", "wrong" or "manual:<reason>" for a file.
header_state() {
	local path="$1" head has_spdx=false has_copyright=false
	head=$(head -n "$SCAN_LINES" "$path")
	[[ "$head" == *"$SPDX_LINE"* ]] && has_spdx=true
	[[ "$head" == *"$COPYRIGHT_LINE"* ]] && has_copyright=true
	if $has_spdx && $has_copyright; then
		echo ok
		return
	fi
	if grep -Eq '^[[:space:]]*(\(\*|//|#|/\*|\*|<!--)?[[:space:]]*(SPDX-License-Identifier|Copyright \(c\))' <<<"$head"; then
		echo wrong
		return
	fi
	echo missing
}

# Number of leading lines that must stay first (shebang, encoding line, @charset, doctype), or
# "manual:<reason>" when the file starts in a way the fixer does not handle.
preamble_lines() {
	local kind="$1" path="$2" first second
	IFS= read -r first <"$path" || true
	second=$(sed -n 2p "$path")
	if [[ "$(head -c 3 "$path" | od -An -tx1 | tr -d ' \n')" == efbbbf ]]; then
		echo "manual:starts with a byte order mark"
		return
	fi
	case "$kind" in
	ocaml) echo 0 ;;
	slash | hash)
		if [[ "$first" == '#!'* ]]; then
			if [[ "$kind" == hash && "$second" =~ coding[:=] ]]; then echo 2; else echo 1; fi
		elif [[ "$kind" == hash && "$first" =~ ^[[:space:]]*#.*coding[:=] ]]; then
			echo 1
		else
			echo 0
		fi
		;;
	css) if [[ "$first" == '@charset'* ]]; then echo 1; else echo 0; fi ;;
	html)
		if [[ "${first,,}" =~ ^[[:space:]]*\<!doctype ]]; then
			echo 1
		else
			echo "manual:no doctype on the first line"
		fi
		;;
	esac
}

fix_file() {
	local kind="$1" path="$2" preamble tmp mode
	preamble=$(preamble_lines "$kind" "$path")
	if [[ "$preamble" == manual:* ]]; then
		echo "MANUAL: $path (${preamble#manual:})" >&2
		return 1
	fi
	tmp=$(mktemp)
	mode=$(stat -c '%a' "$path")
	{
		[[ "$preamble" -gt 0 ]] && head -n "$preamble" "$path"
		render_header "$kind"
		local rest_first
		rest_first=$(tail -n +"$((preamble + 1))" "$path" | head -n 1)
		# A blank line separates the header from the code, except after an HTML doctype.
		if [[ "$kind" != html && -n "$rest_first" ]]; then echo; fi
		tail -n +"$((preamble + 1))" "$path"
	} >"$tmp"
	chmod "$mode" "$tmp"
	mv "$tmp" "$path"
	echo "FIXED: $path"
}

if [[ ${#files[@]} -eq 0 ]]; then
	if $staged_mode; then
		mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
	else
		mapfile -t files < <(git ls-files)
	fi
fi

offenders=()
fixed=0
unfixable=0
checked=0
for path in "${files[@]+"${files[@]}"}"; do
	[[ -f "$path" && ! -L "$path" && -s "$path" ]] || continue
	is_excluded "$path" && continue
	kind=$(file_kind "$path")
	[[ -n "$kind" ]] || continue
	checked=$((checked + 1))
	state=$(header_state "$path")
	case "$state" in
	ok) ;;
	wrong)
		offenders+=("$path (a different license or copyright header; fix by hand)")
		;;
	missing)
		if $fix_mode; then
			if fix_file "$kind" "$path"; then fixed=$((fixed + 1)); else unfixable=$((unfixable + 1)); fi
		else
			offenders+=("$path (no SPDX header)")
		fi
		;;
	esac
done

if $fix_mode; then
	echo "check-copyright: $fixed header(s) inserted, $checked source file(s) examined"
	if [[ ${#offenders[@]} -gt 0 ]]; then
		printf 'ERROR: %s\n' "${offenders[@]}" >&2
	fi
	[[ ${#offenders[@]} -eq 0 && $unfixable -eq 0 ]] || exit 1
	exit 0
fi

if [[ ${#offenders[@]} -gt 0 ]]; then
	printf 'ERROR: %s\n' "${offenders[@]}" >&2
	echo "check-copyright: ${#offenders[@]} of $checked source file(s) without the expected header." >&2
	echo "  Run scripts/check-copyright.sh --fix to insert it." >&2
	exit 1
fi
echo "check-copyright: all $checked source file(s) carry the SPDX header"
