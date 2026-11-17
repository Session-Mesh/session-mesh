// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The PTY host the tests start is the native one, named by MESH_PTYHOST_CMD (the absolute path of the executable;
// words separated by spaces when it needs arguments). ptyhost.py is only the Python client module of the web server.
export function nativePtyhost(): string[] {
  const argv = (process.env.MESH_PTYHOST_CMD ?? '').trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    throw new Error('set MESH_PTYHOST_CMD to the native PTY host (scripts/bootstrap.sh builds ocaml/_build/default/bin/mesh_ptyhost_main.exe)');
  }
  return argv;
}
