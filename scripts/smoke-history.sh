#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Probe a mesh-history executable on a private database.
#   smoke-history.sh <mesh-history> <scratch-directory>
# The SQLite it carries must have FTS5 with the accent-folding tokenizer (level 2 needs SQLite
# 3.27; the release builds link one pinned version on every platform), and a search for "cafe"
# must find the chunk "Café". The SQLite it reports (hello: sqlite_version) must be the one pinned in
# scripts/bundle/sqlite.sha256, so that a build linked against another library is refused. Shared by release-smoke.sh (the built programs) and
# smoke-bundle.sh (the extracted bundle).
set -euo pipefail

if [ "$#" -ne 2 ] || [ ! -x "$1" ] || [ ! -d "$2" ]; then
  echo "usage: smoke-history.sh <mesh-history> <scratch-directory>" >&2
  exit 2
fi
history="$1"
scratch="$2"
pins="$(dirname "$0")/bundle/sqlite.sha256"
# the pin names the amalgamation as XXYYZZ00 (3540100 is 3.54.1)
digits="$(sed -n 's/.*sqlite-amalgamation-\([0-9]\{7\}\)\.zip.*/\1/p' "$pins" | head -n 1)"
[ -n "$digits" ] || { echo "smoke: $pins names no SQLite amalgamation" >&2; exit 1; }
pinned="$((10#${digits:0:1})).$((10#${digits:1:2})).$((10#${digits:3:2}))"
requests='{"op":"hello"}
{"op":"ingest","agent":"claude","id":"smoke","path":"/t/smoke.jsonl","cwd":"/w","title":"Smoke","started":1,"updated":2,"summary":"","chunks":[{"seq":0,"role":"user","text":"Le Café du matin"}]}
{"op":"search","q":"cafe","mode":"text","limit":5}'
out="$(printf '%s\n' "$requests" | MESH_HISTORY_DB="$scratch/history.sqlite" "$history" 2>"$scratch/mesh-history.err")" \
  || { cat "$scratch/mesh-history.err" >&2; echo "smoke: mesh-history failed" >&2; exit 1; }
grep -q '"tokenizer":"unicode61 remove_diacritics 2"' <<<"$out" \
  || { echo "smoke: mesh-history has no remove_diacritics 2 tokenizer: $out" >&2; exit 1; }
grep -q "\"sqlite_version\":\"$pinned\"" <<<"$(head -n 1 <<<"$out")" \
  || { echo "smoke: mesh-history does not report the pinned SQLite $pinned: $(head -n 1 <<<"$out")" >&2; exit 1; }
grep -q '"id":"smoke"' <<<"$(tail -n 1 <<<"$out")" \
  || { echo "smoke: mesh-history search did not find the ingested chunk: $out" >&2; exit 1; }
echo "smoke: mesh-history indexes and searches (FTS5, accents folded, SQLite $pinned)"
