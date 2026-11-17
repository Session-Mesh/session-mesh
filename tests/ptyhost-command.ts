// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The command that starts the native PTY host under test: [MESH_PTYHOST_CMD] when set, else
// `mesh-ptyhost` from PATH. MESH_PTYHOST_CMD is one absolute path, no arguments (CONTRIBUTING.md,
// "Which PTY host the tests run"): never split or unquoted, so a path with spaces works. When no
// host is found the tests fail, they are not skipped: build the host with scripts/bootstrap.sh and
// point MESH_PTYHOST_CMD at ocaml/_build/default/bin/mesh_ptyhost_main.exe, or put mesh-ptyhost
// on PATH.
import fs from 'node:fs';
import path from 'node:path';

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExecutableFile(path.join(dir, name))) return path.join(dir, name);
  }
  return undefined;
}

export function ptyhostArgv(): string[] {
  const configured = process.env.MESH_PTYHOST_CMD ?? '';
  if (configured) {
    if (!path.isAbsolute(configured) || !isExecutableFile(configured)) {
      throw new Error('MESH_PTYHOST_CMD must be the absolute path of the mesh-ptyhost executable, and nothing else '
        + `(no arguments, no quoting); got ${JSON.stringify(configured)}`);
    }
    return [configured];
  }
  const found = onPath('mesh-ptyhost');
  if (found) return [found];
  throw new Error('no native PTY host to test: set MESH_PTYHOST_CMD to the absolute path of the mesh-ptyhost executable '
    + '(built with scripts/bootstrap.sh: ocaml/_build/default/bin/mesh_ptyhost_main.exe), or put mesh-ptyhost on PATH');
}
