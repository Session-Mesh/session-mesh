// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function nativeMeshCommand(name: string): string[] {
  const variable = `MESH_${name.slice('mesh-'.length).replaceAll('-', '_').toUpperCase()}_CMD`;
  const raw = process.env[variable];
  if (raw) {
    if (!raw.trimStart().startsWith('[')) return [raw];
    const argv: unknown = JSON.parse(raw);
    assert.ok(Array.isArray(argv) && argv.length > 0 && argv.every(item => typeof item === 'string'),
      `${variable} must be a path or a JSON array of strings`);
    return argv as string[];
  }

  function isExecutable(file: string): boolean {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  const repo = path.resolve(import.meta.dirname, '..', '..');
  const file = `${name.replaceAll('-', '_')}_main.exe`;
  const built = path.join(repo, 'ocaml', '_build', 'default', 'bin', file);
  if (isExecutable(built)) return [built];
  const switchArgs = process.env.MESH_OPAM_SWITCH ? [`--switch=${process.env.MESH_OPAM_SWITCH}`] : [];
  const opam = spawnSync('opam', ['var', ...switchArgs, 'bin'], {encoding: 'utf8'});
  const installed = opam.status === 0 ? path.join(opam.stdout.trim(), name) : '';
  if (installed && isExecutable(installed)) return [installed];
  throw new Error(`no ${name} to test: set ${variable} to the absolute path of the native program, `
    + 'or build it (scripts/bootstrap.sh, or dune build in ocaml/)');
}
