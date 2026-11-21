// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Two guards of the organisation file (mesh.json: the names, folders and order the owner gave the sessions) that a
// rename relies on to last: a listing that failed (the PTY host slow, gone, or answering something that is not a
// list) forgets nothing, and the file is replaced in one step, private, never rewritten in place. The server is
// imported with a fake PTY host connection, under a throwaway configuration folder; no session runs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';

const ARRANGED = {folders: ['Projects'], order: ['a'], sessions: {a: {created: 1.0, label: 'Chosen name', folder: 'Projects'}}};

/** Run `code` (Python, after `import asyncio, json, server`) with mesh.json holding `before`, in a throwaway
 * configuration folder; [what it printed (JSON), mesh.json after, the folder]. `keep`: leave the folder (the caller
 * removes it). */
function python(before: unknown, code: string, keep = false): [unknown, Record<string, any>, string] {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'organize-guards-'));
  try {
    if (before !== null) fs.writeFileSync(path.join(conf, 'mesh.json'), JSON.stringify(before), {mode: 0o600});
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import asyncio, json, sys\nsys.path.insert(0, ${JSON.stringify(REPO)})\nimport server\n${code}`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: conf,
      TMPDIR: conf}});
    const file = path.join(conf, 'mesh.json');
    return [JSON.parse(output.trim().split('\n').pop()!), fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}, conf];
  } finally {
    if (!keep) fs.rmSync(conf, {recursive: true, force: true});
  }
}

/** A PTY host connection whose requests run `reply` (Python: raise, or return what the host answers). */
const host = (reply: string): string => `
async def host_identity(): return "h"
async def request(message):
    ${reply}
server.ptyhost.host_identity = host_identity
server.ptyhost.request = request
`;

const LISTINGS = `
async def main():
    await server.sessions()                                         # unlocked: it prunes itself
    await server.sessions(organisation_lock=asyncio.Lock())         # the page's: pruned under the lock
    server.list_sessions([], False)                                 # what both are given after a failure
asyncio.run(main())
print(json.dumps(True))
`;

for (const [why, reply] of [['the host does not answer', 'raise OSError("gone")'],
  ['the host times out', 'raise asyncio.TimeoutError()'],
  ['the host answers something that is not a list', 'return {"error": "busy"}']]) {
  test(`a listing that failed (${why}) forgets no name, folder or place`, () => {
    const [, after] = python(ARRANGED, host(reply) + LISTINGS);
    assert.deepEqual(after, ARRANGED);
  });
}

test('a listing that succeeded without the session forgets it (what the guard above keeps from a failure)', () => {
  const [, after] = python(ARRANGED, host('return []') + LISTINGS);
  assert.deepEqual([after.sessions, after.order], [{}, []]);
});

test('mesh.json is replaced in one step, never rewritten in place, and stays private', () => {
  const [, after, conf] = python(ARRANGED, `
import os, organize
os.link(organize.FILE, organize.FILE.with_name("earlier"))
organize.apply({"op": "rename", "id": "a", "label": "Another name"}, [{"name": "a", "created": 1.0}])
print(json.dumps(True))
`, true);
  try {
    assert.equal(after.sessions.a.label, 'Another name');
    // a reader holding the earlier file (here a second link to it) never sees a half-written one: it keeps it whole
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(conf, 'earlier'), 'utf8')), ARRANGED);
    assert.equal(fs.statSync(path.join(conf, 'mesh.json')).nlink, 1, 'a new file took its place');
    assert.equal(fs.statSync(path.join(conf, 'mesh.json')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
});

test('a first mesh.json is created private', () => {
  const [, after, conf] = python(null, `
import os, organize
os.umask(0o022)
organize.apply({"op": "rename", "id": "a", "label": "First"}, [{"name": "a", "created": 1.0}])
print(json.dumps(True))
`, true);
  try {
    assert.equal(after.sessions.a.label, 'First');
    assert.equal(fs.statSync(path.join(conf, 'mesh.json')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
});
