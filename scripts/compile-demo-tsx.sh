#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

# Local compiler primitive. It does not authenticate an agent, store a revision,
# encrypt an artifact, or execute the resulting bundle.
set -eu

if [ "$#" -ne 0 ]; then
  exit 78
fi
# The confinement is bubblewrap's (Linux namespaces): on any other system the
# compiler is refused, never run unconfined.
system=$(uname -s 2>/dev/null || echo unknown)
if [ "$system" != Linux ]; then
  echo "compile-demo-tsx: the demo compiler runs only on Linux, inside bubblewrap; it is not available on $system." >&2
  exit 78
fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
compiler="$root/demo-compiler"
if [ ! -f "$compiler/compile-cli.mjs" ] || [ ! -d "$compiler/node_modules/esbuild" ]; then
  exit 78
fi
if [ ! -x /usr/bin/bwrap ]; then
  echo 'compile-demo-tsx: bubblewrap (/usr/bin/bwrap) is required.' >&2
  exit 78
fi

# Node is the caller's choice (MESH_NODE, otherwise `node` on its PATH), like
# any program the caller runs. The sandbox, not the binary's location, confines
# the guest source: only the resolved file is bound read-only at a fixed path,
# so a Node installed outside /usr (nvm, a tarball under /opt) works too.
node=${MESH_NODE:-$(command -v node || true)}
case "$node" in
  /*) ;;
  *) echo 'compile-demo-tsx: Node not found; set MESH_NODE to its absolute path.' >&2; exit 78 ;;
esac
node=$(readlink -f -- "$node") || exit 78
if [ ! -f "$node" ] || [ ! -x "$node" ]; then
  echo 'compile-demo-tsx: MESH_NODE is not an executable file.' >&2
  exit 78
fi

# Virtual address space (RLIMIT_AS) of each process, esbuild's Go binary included. x86_64 keeps 1 GiB (the
# Go runtime needs about 700-800 MiB there just to reserve its page summaries, so the margin is thin).
# aarch64 gets 2 GiB: with 1 GiB the compiler refused its input on real arm64 runners (release dry run
# 44098318205), the Go runtime failing to reserve address space being the leading suspect. The heap, CPU,
# descriptor and time bounds below are the same everywhere.
case $(uname -m 2>/dev/null || echo unknown) in
  aarch64|arm64) address_space=2147483648 ;;
  *) address_space=1073741824 ;;
esac

exec /usr/bin/timeout -k 1s 6s /usr/bin/prlimit \
  --as="$address_space" --cpu=4 --nofile=64 --core=0 -- \
  /usr/bin/bwrap --unshare-all --new-session --die-with-parent \
  --clearenv --setenv HOME /tmp --setenv PATH /usr/bin:/bin \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /etc/ld.so.cache /etc/ld.so.cache \
  --ro-bind "$node" /run/mesh-node \
  --ro-bind "$compiler" /app --proc /proc --dev /dev --tmpfs /tmp \
  --chdir /app -- /run/mesh-node --jitless --max-old-space-size=128 /app/compile-cli.mjs
