// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "Restart now" on a Copilot running in another terminal stops it and reopens its conversation in the mesh. Outside
// the mesh no hook reports the conversation: the id read from `--resume=<uuid>` is the one it started with, which a
// /new or /resume inside Copilot may have changed. The move is refused, and the agent is not stopped.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SESSION = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';

function adopt(source: string | null): {outcome: string; alive: boolean} {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-adopt-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import asyncio, json, subprocess, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import server
from aiohttp import web
victim = subprocess.Popen(["sleep", "60"])
async def fake_host(message):
    return [] if message.get("op") == "list" else {"ok": True}
server.host = fake_host
async def main():
    agent = {"type": "copilot", "pid": victim.pid, "session_id": ${JSON.stringify(SESSION)}, "argv": ["copilot"]}
    if ${source === null ? 'False' : 'True'}:
        agent["identity_source"] = ${JSON.stringify(source)}
    target = {"pid": 1, "cwd": ${JSON.stringify(conf)}, "agent": agent}
    try:
        outcome = await server.resume_target(target)
        outcome = "relaunched"
    except web.HTTPException as refusal:
        outcome = [refusal.status, refusal.text]
    alive = victim.poll() is None
    victim.kill()
    victim.wait()
    print(json.dumps({"outcome": outcome, "alive": alive}))
asyncio.run(main())`],
    {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: conf, TMPDIR: conf}});
    return JSON.parse(output) as {outcome: string; alive: boolean};
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

describe('moving a Copilot from another terminal into the mesh', () => {
  test('a conversation read from its arguments is refused and the agent keeps running', () => {
    const result = adopt('argv_session');
    assert.deepEqual(result.outcome[0], 409);
    assert.match(result.outcome[1], /cannot be known/);
    assert.equal(result.alive, true);
  });

  test('so is one with no recorded source', () => {
    const result = adopt(null);
    assert.equal(result.outcome[0], 409);
    assert.equal(result.alive, true);
  });

  test('a conversation reported by hooks is moved, the agent is stopped', () => {
    const result = adopt('copilot_hooks');
    assert.equal(result.outcome, 'relaunched');
    assert.equal(result.alive, false);
  });
});
