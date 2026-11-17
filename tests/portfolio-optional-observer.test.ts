// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The Git observer of the portfolio is optional: missing, the worktree view is one honest
// `unavailable`; installed, it is used as before.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.MESH_PYTHON || 'python3';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-observer-'));
after(() => fs.rmSync(scratch, {recursive: true, force: true}));

const COLLECT = `
import asyncio, json, sys
import portfolio
inventory = portfolio.observed_inventory(
    [{"name": "a", "created": 1, "cwd": sys.argv[2]}], listed=True, observed_at=5.0)
asyncio.run(portfolio.collect_worktrees(inventory, root=sys.argv[1], observed_at=5.0))
print(json.dumps(inventory["worktrees"]))
`;

function collect(root: string): {state: string; directories: Array<{state: string}>} {
  const run = spawnSync(PYTHON, ['-c', COLLECT, root, scratch], {cwd: REPO, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('without the observer the worktrees are unavailable, with no per-directory rows', () => {
  const worktrees = collect(path.join(scratch, 'empty-root'));
  assert.equal(worktrees.state, 'unavailable');
  assert.deepEqual(worktrees.directories, []);
});

test('an installed observer is still used', () => {
  const root = path.join(scratch, 'root');
  const bin = path.join(root, '_opam', 'bin');
  fs.mkdirSync(bin, {recursive: true});
  const observer = path.join(bin, 'gitwright-worktree-observe');
  fs.writeFileSync(observer, '#!/bin/sh\necho \'{"state":"observed","worktrees":[]}\'\n', {mode: 0o755});
  const worktrees = collect(root);
  assert.equal(worktrees.state, 'observed');
  assert.deepEqual(worktrees.directories.map(row => row.state), ['observed']);
});
