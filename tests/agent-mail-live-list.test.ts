// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The mailbox and the wake loop read the PTY host's list of sessions. A list is authoritative only when every
// item has the shape the host emits: a malformed item is a 503 ("Invalid session list"), not a KeyError or an
// AttributeError (a 500, and an exception in the wake loop).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function outcomes(code: string): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
from aiohttp import web
good = {"name": "a", "pid": 5, "cwd": "/tmp", "created": 1.5, "activity": 2.0, "attached": 0, "meta": {"known_agent": "claude"}}

def run(listed):
    try:
        return server._agent_mail_live(listed)
    except web.HTTPServiceUnavailable as refusal:
        return [refusal.status, refusal.text]
${code}`], {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp',
    MESH_CONF_DIR: process.env.TMPDIR ?? '/tmp', TMPDIR: process.env.TMPDIR ?? '/tmp'}});
  return JSON.parse(output);
}

test('a well formed list gives the live agent identities', () => {
  assert.deepEqual(outcomes('print(json.dumps(run([good])))'), [{id: 'a', created: 1.5, agent: 'claude'}]);
});

test('a malformed item, or a list that is not a list, is a 503 and nothing else', () => {
  assert.deepEqual(outcomes(`
bad = [
    [{"name": "a"}],                                   # KeyError before
    [{**good, "meta": None}],                          # AttributeError before
    [{**good, "created": "now"}],
    [good, "not an item"],
    {"error": "x"},
    None,
]
print(json.dumps([run(listed) for listed in bad]))`),
  Array.from({length: 6}, () => [503, 'Invalid session list']));
});
