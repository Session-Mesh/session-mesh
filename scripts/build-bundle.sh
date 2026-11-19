#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Build on the target OS/architecture. uv, Node and compiled native artifacts are
# build dependencies only; the resulting archive performs no runtime downloads.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT=
NPM_DIR=
NATIVE=${MESH_BIN_DIR:-}
NODE=${MESH_BUILD_NODE:-}
NODE_VERSION=${MESH_BUNDLE_NODE_VERSION:-24.11.1}
ROSTER=${MESH_BUNDLE_ROSTER_DIR:-}
PYTHON_VERSION=${MESH_BUNDLE_PYTHON_VERSION:-3.12.9}
COMPILER_TEST=1
while (($#)); do
  case $1 in
    --output) OUTPUT=$2; shift 2 ;;
    --native-bin) NATIVE=$2; shift 2 ;;
    --node) NODE=$2; shift 2 ;;
    --python-version) PYTHON_VERSION=$2; shift 2 ;;
    --roster-dir) ROSTER=$2; shift 2 ;;
    --skip-compiler-test) COMPILER_TEST=0; shift ;;
    *) echo "usage: $0 --output DIR --native-bin DIR [--node PATH] [--python-version VERSION] [--roster-dir DIR] [--skip-compiler-test]" >&2; exit 2 ;;
  esac
done
[[ -n $OUTPUT && -n $NATIVE ]] || { echo 'bundle: output and native binaries are required' >&2; exit 2; }
[[ -z $NODE || -x $NODE ]] || { echo 'bundle: supplied Node must be executable' >&2; exit 2; }
[[ -z $ROSTER || -f $ROSTER/scripts/roster-roadmap.cjs ]] || { echo 'bundle: invalid public Roster distribution' >&2; exit 2; }
command -v uv >/dev/null || { echo 'bundle: uv is a build dependency' >&2; exit 2; }
command -v zstd >/dev/null || { echo 'bundle: zstd is a build dependency (CPython licence metadata)' >&2; exit 2; }
if [[ $(uname -s) == Linux ]]; then
  command -v patchelf >/dev/null || { echo 'bundle: patchelf is a Linux build dependency' >&2; exit 2; }
fi
for name in mesh-ptyhost mesh-board-mcp mesh-read mesh-platform mesh-history mesh-logout-all work-read work-mcp; do
  [[ -f $NATIVE/$name && -x $NATIVE/$name ]] || { echo "bundle: missing executable $name" >&2; exit 2; }
done
case $(uname -s) in Linux) OS=linux ;; Darwin) OS=macos ;; *) echo 'bundle: unsupported OS' >&2; exit 2 ;; esac
case $(uname -m) in x86_64) ARCH=x86_64 ;; arm64|aarch64) ARCH=arm64 ;; *) echo 'bundle: unsupported architecture' >&2; exit 2 ;; esac
mkdir -p "$OUTPUT"

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# The licence texts of the bundled CPython, from python-build-standalone's own metadata: the "full"
# archive of the same release and platform as the build uv installs carries python/PYTHON.json
# (which licence each extension's statically linked library has) and python/licenses/. Its
# SHA-256 is pinned in scripts/bundle/python-licenses.sha256; a build without a pin stops.
# Sets PYTHON_RELEASE; extracts python/ into $STAGE/python-licences.
python_licences() {
  local url name expected
  url=$(uv --color never python list "$1" --only-downloads --show-urls | bash "$ROOT/scripts/bundle/python-download-url.sh")
  [[ $url =~ /releases/download/([0-9]+)/cpython-[0-9.]+%2B[0-9]+-(.+)-install_only ]] \
    || { echo "bundle: uv names no python-build-standalone download for CPython $1" >&2; exit 1; }
  PYTHON_RELEASE=${BASH_REMATCH[1]}
  name=$(awk -v prefix="cpython-$1+$PYTHON_RELEASE-${BASH_REMATCH[2]}-" 'index($2, prefix) == 1 && $2 ~ /-full\.tar\.zst$/ {print $2}' \
    "$ROOT/scripts/bundle/python-licenses.sha256")
  expected=$(awk -v file="$name" '$2 == file {print $1}' "$ROOT/scripts/bundle/python-licenses.sha256")
  [[ -n $name && $expected =~ ^[a-f0-9]{64}$ ]] \
    || { echo "bundle: no pinned SHA-256 for the licence metadata of CPython $1 ($PYTHON_RELEASE ${BASH_REMATCH[2]}) in scripts/bundle/python-licenses.sha256" >&2; exit 1; }
  curl --proto =https -fsSL "${url%/*}/${name//+/%2B}" -o "$STAGE/python-full.tar.zst"
  [[ $(sha256_of "$STAGE/python-full.tar.zst") == "$expected" ]] || { echo "bundle: $name does not match its pinned SHA-256" >&2; exit 1; }
  mkdir -p "$STAGE/python-licences"
  zstd -dc "$STAGE/python-full.tar.zst" | tar -xf - -C "$STAGE/python-licences" python/PYTHON.json python/licenses
  rm -f "$STAGE/python-full.tar.zst"
}
OUTPUT=$(cd "$OUTPUT" && pwd)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/mesh-bundle.XXXXXXXX")
# macOS TMPDIR commonly traverses /var -> /private/var. npm 11 treats a
# symlinked --prefix as a local-package link and rejects the unchanged lockfile.
# Use the physical directory for every builder, retaining locked npm ci.
STAGE=$(cd "$STAGE" && pwd -P)
trap 'rm -rf "$STAGE"' EXIT
NAME=mesh-$OS-$ARCH
BUNDLE=$STAGE/$NAME
mkdir -p "$BUNDLE/app" "$BUNDLE/bin" "$BUNDLE/libexec" "$BUNDLE/runtime/node/bin" "$BUNDLE/runtime/python"
# app/ is the public tracked tree, never a developer's virtualenv, local credentials, node_modules
# or untracked private harness files. The tests, the CI files and ocaml/ (the source of the native
# programs) stay out: licenses/SOURCE names the repository and revision that hold all of them.
while IFS= read -r -d '' path; do
  case $path in
    tests/*|.github/*|ocaml/*) continue ;;
  esac
  mkdir -p "$BUNDLE/app/$(dirname "$path")"
  cp -p "$ROOT/$path" "$BUNDLE/app/$path"
done < <(git -C "$ROOT" ls-files -z)
# Include this build's packaging templates even while qualifying a local diff.
cp -p "$ROOT/scripts/bundle/mesh" "$BUNDLE/mesh"
cp -p "$ROOT/scripts/bundle/env.sh" "$BUNDLE/env.sh"
cp -p "$ROOT/scripts/bundle/mesh-python" "$BUNDLE/bin/mesh-python"
cp -p "$ROOT/scripts/bundle/mesh-ptyhost" "$BUNDLE/bin/mesh-ptyhost"
cp -p "$ROOT/scripts/bundle/mesh-helper" "$BUNDLE/bin/mesh-helper"
for name in mesh-event mesh-open mesh-attach mesh-rename; do
  [[ ! -f $ROOT/bin/$name ]] || cp -p "$BUNDLE/bin/mesh-helper" "$BUNDLE/bin/$name"
done
cp -p "$NATIVE/mesh-ptyhost" "$BUNDLE/libexec/mesh-ptyhost"
# mesh-logout-all, work-read and work-mcp are native: no wrapper, no Python. work-read must be
# bin/work-read: the web server runs it from MESH_BIN_DIR for /api/work/v1 (docs/work-read.md).
for name in mesh-board-mcp mesh-read mesh-platform mesh-history mesh-logout-all work-read work-mcp; do cp -p "$NATIVE/$name" "$BUNDLE/bin/$name"; done
if [[ -z $NODE ]]; then
  NODE_OS=$OS
  [[ $OS != macos ]] || NODE_OS=darwin
  NODE_ARCH=$ARCH
  [[ $ARCH != x86_64 ]] || NODE_ARCH=x64
  NODE_NAME=node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH
  # The archive's SHA-256 is pinned in the repository (scripts/bundle/node.sha256, one line per
  # version and platform), never read from the server that serves the archive.
  EXPECTED=$(awk -v file="$NODE_NAME.tar.gz" '$2 == file {print $1}' "$ROOT/scripts/bundle/node.sha256")
  [[ $EXPECTED =~ ^[a-f0-9]{64}$ ]] \
    || { echo "bundle: no pinned SHA-256 for $NODE_NAME.tar.gz in scripts/bundle/node.sha256" >&2; exit 1; }
  curl --proto =https -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz" -o "$STAGE/node.tar.gz"
  if command -v sha256sum >/dev/null; then ACTUAL=$(sha256sum "$STAGE/node.tar.gz"); else ACTUAL=$(shasum -a 256 "$STAGE/node.tar.gz"); fi
  [[ ${ACTUAL%% *} == "$EXPECTED" ]] || { echo "bundle: $NODE_NAME.tar.gz does not match its pinned SHA-256" >&2; exit 1; }
  tar -xzf "$STAGE/node.tar.gz" -C "$STAGE"
  NODE=$STAGE/$NODE_NAME/bin/node
  # npm of the same pinned archive, for the npm ci below: a builder may have no npm of its own.
  NPM_DIR=$STAGE/$NODE_NAME/bin
  cp "$STAGE/$NODE_NAME/LICENSE" "$BUNDLE/runtime/node/LICENSE"
elif [[ -f $(dirname "$NODE")/../LICENSE ]]; then
  # A supplied Node from an official archive keeps its LICENSE beside bin/.
  cp "$(dirname "$NODE")/../LICENSE" "$BUNDLE/runtime/node/LICENSE"
fi
cp -p "$NODE" "$BUNDLE/runtime/node/bin/node"
# The TSX compiler imports esbuild at runtime. Install into the copied tree only:
# never a shared development node_modules, and never by downloading at user start.
PATH="$BUNDLE/runtime/node/bin:${NPM_DIR:+$NPM_DIR:}$PATH" npm ci --prefix "$BUNDLE/app/demo-compiler" \
  --ignore-scripts --no-audit --no-fund
# The compiler's own test: on Linux the bubblewrap sandbox (it requires /usr/bin/bwrap); elsewhere,
# that the bundled esbuild compiles and that the launcher refuses, since it only runs in bubblewrap.
# --skip-compiler-test leaves it to the caller, for a builder where bubblewrap cannot run (a
# container): the caller runs app/demo-compiler/test-compiler.mjs of the extracted bundle.
if ((COMPILER_TEST)); then
  PATH="$BUNDLE/runtime/node/bin:$PATH" "$BUNDLE/runtime/node/bin/node" \
    "$BUNDLE/app/demo-compiler/test-compiler.mjs"
fi
# Isolated uv installation: it must not add interpreter links to the builder's
# normal PATH or replace its interpreter. Only the redistributable tree is copied.
UV_PYTHON_INSTALL_DIR="$STAGE/python-download" UV_PYTHON_BIN_DIR="$STAGE/python-links" \
  uv python install "$PYTHON_VERSION"
PYTHON=$(UV_PYTHON_INSTALL_DIR="$STAGE/python-download" uv python find --managed-python "$PYTHON_VERSION")
PYTHON_ROOT=$(cd "$(dirname "$PYTHON")/.." && pwd)
cp -a "$PYTHON_ROOT/." "$BUNDLE/runtime/python/"
uv pip install --python "$BUNDLE/runtime/python/bin/python3" --break-system-packages --require-hashes \
  --only-binary :all: -r "$ROOT/scripts/bundle/requirements.lock"
# Nothing at runtime needs pip, ensurepip, IDLE, tkinter or the Tcl/Tk scripts: they leave the bundle,
# and with them the notices of what pip vendors (certifi, requests, urllib3, rich and others).
PYTHON_LIB="$BUNDLE/runtime/python/lib"
rm -rf "$PYTHON_LIB"/python3.*/site-packages/pip "$PYTHON_LIB"/python3.*/site-packages/pip-*.dist-info \
  "$PYTHON_LIB"/python3.*/ensurepip "$PYTHON_LIB"/python3.*/idlelib "$PYTHON_LIB"/python3.*/tkinter \
  "$PYTHON_LIB"/python3.*/turtledemo "$PYTHON_LIB"/tcl8* "$PYTHON_LIB"/tk8* "$PYTHON_LIB"/Tix* "$PYTHON_LIB"/itcl* \
  "$PYTHON_LIB"/thread2* "$BUNDLE/runtime/python/bin"/pip* "$BUNDLE/runtime/python/bin"/idle3*
mkdir -p "$BUNDLE/licenses"
cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$BUNDLE/licenses/"
if [[ -n $ROSTER ]]; then
  mkdir -p "$BUNDLE/optional/roster"
  cp -a "$ROSTER/." "$BUNDLE/optional/roster/"
  # A pinned checkout is accepted as input; its Git control directory is never
  # part of the end-user runtime (nor any checkout credentials or remote config).
  rm -rf "$BUNDLE/optional/roster/.git"
  # The project observation runs each CLI through a wrapper that starts it with the bundled Node
  # (env.sh names the wrappers): the CLIs need no executable bit and no node on PATH.
  for name in roster-roadmap roster-pipeline; do
    [[ ! -f $BUNDLE/optional/roster/scripts/$name.cjs ]] || cp -p "$ROOT/scripts/bundle/mesh-roster" "$BUNDLE/libexec/mesh-$name"
  done
fi
[[ -f $ROOT/scripts/bundle-native-libs.sh ]] || { echo 'bundle: native library closure helper missing' >&2; exit 1; }
bash "$ROOT/scripts/bundle-native-libs.sh" "$BUNDLE"
# The third-party notices: every embedded component with its licence text, or the build stops.
python_licences "$PYTHON_VERSION"
SOURCE_REVISION=$(git -C "$ROOT" rev-parse HEAD)
DIRTY=()
[[ -z $(git -C "$ROOT" status --porcelain --untracked-files=no) ]] || DIRTY=(--dirty)
# The repository licenses/SOURCE names: MESH_BUNDLE_SOURCE_URL, else the repository a GitHub
# Actions run builds (GitHub sets GITHUB_SERVER_URL and GITHUB_REPOSITORY in every step).
SOURCE_URL=${MESH_BUNDLE_SOURCE_URL:-https://github.com/Session-Mesh/session-mesh}
if [[ -z ${MESH_BUNDLE_SOURCE_URL:-} && -n ${GITHUB_SERVER_URL:-} && -n ${GITHUB_REPOSITORY:-} ]]; then
  SOURCE_URL=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY
fi
OPENSSL_VERSION=$("$BUNDLE/runtime/python/bin/python3" -c 'import ssl; print(ssl.OPENSSL_VERSION.split()[1])')
"$BUNDLE/runtime/node/bin/node" "$ROOT/scripts/bundle-licenses.mjs" --bundle "$BUNDLE" --source-root "$ROOT" \
  --revision "$SOURCE_REVISION" --source-url "$SOURCE_URL" --openssl-version "$OPENSSL_VERSION" \
  --python "$STAGE/python-licences/python" --python-release "$PYTHON_RELEASE" --ocaml-root "$ROOT/ocaml" \
  ${MESH_OPAM_SWITCH:+--opam-switch "$MESH_OPAM_SWITCH"} ${DIRTY[@]+"${DIRTY[@]}"}
MESH_BUNDLE_ROOT="$BUNDLE" MESH_BUNDLE_SOURCE_REV=$SOURCE_REVISION \
  "$BUNDLE/runtime/node/bin/node" --input-type=module <<'JS'
import {writeFileSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.env.MESH_BUNDLE_ROOT;
const native={};
for(const path of ['libexec/mesh-ptyhost','bin/mesh-board-mcp','bin/mesh-read','bin/mesh-platform','bin/mesh-history','bin/mesh-logout-all',
    'bin/work-read','bin/work-mcp'])
  native[path]=createHash('sha256').update(readFileSync(`${root}/${path}`)).digest('hex');
writeFileSync(`${root}/bundle.json`,JSON.stringify({kind:'mesh-binary-bundle',version:1,
  source_revision:process.env.MESH_BUNDLE_SOURCE_REV,
  platform:process.platform,arch:process.arch,node:process.version,
  python:execFileSync(`${root}/runtime/python/bin/python3`,['--version'],{encoding:'utf8'}).trim(),native},null,2)+'\n');
JS
chmod +x "$BUNDLE/mesh" "$BUNDLE/bin/"*
tar -czf "$OUTPUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
if command -v sha256sum >/dev/null; then (cd "$OUTPUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256");
else (cd "$OUTPUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256"); fi
printf 'bundle: %s\n' "$OUTPUT/$NAME.tar.gz"
