// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "Resume when idle" SIGTERMs an agent running in another terminal. It is offered, and acts, only for the agents whose
// idle state Mesh can observe (claude, codex, opencode), and for OpenCode only when its status says idle: a turn that
// has been busy for minutes without writing to the store is not idle.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function python(code: string): unknown {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-observable-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import asyncio, json, sys, time\nsys.path.insert(0, ${JSON.stringify(REPO)})\nimport server\nfrom aiohttp import web\n${code}`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: conf, TMPDIR: conf}});
    return JSON.parse(output);
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

describe('which agents may be restarted when idle', () => {
  test('the observable set is claude, codex and opencode', () => {
    assert.deepEqual(python('print(json.dumps(sorted(server.IDLE_OBSERVABLE)))'), ['claude', 'codex', 'opencode']);
  });

  test('an OpenCode busy for 120 s with a quiet store is not idle; an idle one with a quiet store is', () => {
    assert.deepEqual(python(`
old = time.time() - 120
agents = [
    {"type": "opencode", "status": "busy", "updated": old},
    {"type": "opencode", "status": "waiting", "updated": old},
    {"type": "opencode", "status": None, "updated": old},
    {"type": "opencode", "status": "idle", "updated": old},
    {"type": "opencode", "status": "idle", "updated": time.time()},
]
print(json.dumps([server.looks_idle(agent) for agent in agents]))
`), [false, false, false, true, false]);
  });

  test('Gemini, Antigravity, Copilot, Vibe and Pi are never idle', () => {
    assert.deepEqual(python(`
old = time.time() - 3600
print(json.dumps([server.looks_idle({"type": kind, "status": "idle", "updated": old})
                  for kind in ("gemini", "agy", "copilot", "vibe", "pi")]))
`), [false, false, false, false, false]);
  });

  test('the API refuses "when idle" for Gemini', () => {
    assert.deepEqual(python(`
async def main():
    target = {"pid": 10, "cwd": "/tmp", "agent": {"type": "gemini", "pid": 11, "status": "idle", "session_id": "s"}}
    server.find_target = lambda data, pid: target
    async def sessions(*args, **kwargs):
        return {}
    server.sessions = sessions
    class Request:
        match_info = {}
        app = {"organisation_lock": None, "event_state": None}
        async def json(self):
            return {"pid": 10, "mode": "when-idle"}
        headers = {}
        cookies = {}
    try:
        await server.api_adopt(Request())
        print(json.dumps("accepted"))
    except web.HTTPBadRequest as refusal:
        print(json.dumps(refusal.text))
asyncio.run(main())
`), 'This agent does not report a reliable idle state; manual restart only');
  });

  test('a saved pending request of a non-observable agent is dropped by the watcher', () => {
    assert.deepEqual(python(`
resumed = []
async def resume_target(target):
    resumed.append(target["pid"])
    return "x"
server.resume_target = resume_target
server.save_pending = lambda: None
async def main():
    target = {"pid": 10, "cwd": "/tmp", "agent": {"type": "gemini", "pid": 11, "status": "idle", "session_id": "s",
                                                  "updated": time.time() - 3600}}
    data = {"external": [target]}
    server.PENDING.clear()
    server.PENDING[10] = {"since": 0, "agent_pid": 11}
    await server._watch_one(10, data, {})
    print(json.dumps([resumed, 10 in server.PENDING]))
asyncio.run(main())
`), [[], false]);
  });
});
