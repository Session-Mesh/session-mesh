// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Two guards between the Python client of the PTY host and the native host it talks to:
// - the environment the web server expects a session's shell to keep (ptyhost._KEEP_ENV) is the list the native
//   host keeps (Mesh_ptyhost.whitelist): a difference would make the server judge a launch on another environment;
// - no test starts `ptyhost.py` as a host (it is only a client module): the host is MESH_PTYHOST_CMD, through
//   nativePtyhost(), which fails with a clear message when it is not set.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

test('the client environment list equals the native host whitelist', () => {
  const source = fs.readFileSync(path.join(REPO, 'ocaml', 'lib', 'mesh_ptyhost.ml'), 'utf8');
  const block = /let whitelist =\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  const native = [...block.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
  assert.ok(native.length > 10, 'the whitelist was found in the OCaml source');
  const client = JSON.parse(execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
    `import json, sys\nsys.path.insert(0, ${JSON.stringify(REPO)})\nimport ptyhost\nprint(json.dumps(list(ptyhost._KEEP_ENV)))`],
  {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp', TMPDIR: process.env.TMPDIR ?? '/tmp'}})) as string[];
  assert.deepEqual([...client].sort(), [...native].sort());
});

test('no test starts ptyhost.py as the host', () => {
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.(ts|mjs|cjs)$/.test(entry.name) || entry.name === path.basename(import.meta.filename)
        || entry.name === 'ptyhost-python-removed.test.ts') continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/'ptyhost\.py'\)|, 'ptyhost\.py'\]/.test(text)) offenders.push(path.relative(REPO, file));
    }
  };
  visit(path.join(REPO, 'tests'));
  assert.deepEqual(offenders, []);
});
