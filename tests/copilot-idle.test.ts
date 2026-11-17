// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "Resume when idle" stops an agent that runs in another terminal (SIGTERM) and reopens its conversation in the
// mesh. It must never be offered, and never act, for an agent whose idle state Mesh cannot observe: a Copilot
// outside the mesh reports no timestamp and no state a process listing can read, and a turn, a permission prompt
// and an idle prompt look the same. Mesh never types a wake notice into a Copilot, either.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

function python(code: string): unknown {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-idle-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
      `import asyncio, json, sys, time\nsys.path.insert(0, ${JSON.stringify(REPO)})\nimport server\nfrom aiohttp import web\n${code}`],
    {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: conf, TMPDIR: conf}});
    return JSON.parse(output);
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

describe('resume when idle', () => {
  test('an agent with no observable idle state is never idle, whatever its timestamp says', () => {
    assert.deepEqual(python(`
old = time.time() - 3600
agents = [
    {"type": "copilot", "status": "idle"},
    {"type": "copilot", "status": "idle", "updated": old},
    {"type": "pi", "updated": old},
    {"type": "opencode", "status": "idle"},                 # no conversation found: no timestamp
    {"type": "opencode", "status": "idle", "updated": old},  # quiet: observable
    {"type": "codex", "status": "idle"},
    {"type": "codex", "status": "idle", "updated": old},
    {"type": "codex", "status": "idle", "updated": time.time()},
]
print(json.dumps([server.looks_idle(agent) for agent in agents]))
`), [false, false, false, false, true, false, true, false]);
  });

  test('the watcher never resumes a Copilot, however many polls go by', () => {
    assert.deepEqual(python(`
resumed = []
async def resume_target(target):
    resumed.append(target["pid"])
    return "x"
server.resume_target = resume_target
server.save_pending = lambda: None
async def main():
    target = {"pid": 10, "cwd": "/tmp", "agent": {"type": "copilot", "pid": 11, "status": "idle", "session_id": "s"}}
    data = {"external": [target]}
    server.PENDING.clear()
    server.PENDING[10] = {"since": 0, "agent_pid": 11}
    streak = {}
    for _ in range(6):
        await server._watch_one(10, data, streak)
    print(json.dumps([resumed, 10 in server.PENDING]))
asyncio.run(main())
`), [[], false]);
  });

  test('the API refuses to queue "when idle" for Copilot and Pi, and queues it for Claude', () => {
    assert.deepEqual(python(`
server.save_pending = lambda: None
class Request:
    app = {"organisation_lock": None}
async def sessions(**kwargs):
    return {"external": [
        {"pid": 1, "cwd": "/tmp", "agent": {"type": "copilot", "pid": 2, "session_id": "s"}},
        {"pid": 3, "cwd": "/tmp", "agent": {"type": "pi", "pid": 4, "session_id": "s"}},
        {"pid": 5, "cwd": "/tmp", "agent": {"type": "claude", "pid": 6, "session_id": "s"}}]}
async def json_object(request):
    return Request.body
server.sessions, server.json_object = sessions, json_object
async def ask(pid):
    Request.body = {"pid": pid, "mode": "when-idle"}
    try:
        await server.api_adopt(Request)
        return 200
    except web.HTTPException as exc:
        return [exc.status, exc.text]
async def main():
    server.PENDING.clear()
    print(json.dumps([await ask(1), await ask(3), await ask(5), sorted(server.PENDING)]))
asyncio.run(main())
`), [[400, 'This agent does not report a reliable idle state; manual restart only'],
      [400, 'Pi does not report a reliable idle state; manual restart only'], 200, [5]]);
  });

  test('the interface offers "when idle" only for agents whose idle state is observable', () => {
    const source = fs.readFileSync(path.join(REPO, 'static', 'app.js'), 'utf8');
    const set = /const IDLE_OBSERVABLE_AGENTS = new Set\(\[([^\]]*)\]\)/.exec(source);
    assert.ok(set, 'the set of agents is declared');
    const agents = [...set[1].matchAll(/"([a-z]+)"/g)].map(match => match[1]).sort();
    const server = python('print(json.dumps(sorted(server.IDLE_OBSERVABLE)))') as string[];
    assert.deepEqual(agents, server);
    assert.ok(source.includes('IDLE_OBSERVABLE_AGENTS.has(a.type) ? `<button class="btn primary" data-adopt="when-idle">'));
  });
});

describe('wake', () => {
  test('no wake notice is ever typed into a Copilot, whatever its arguments (autopilot cannot be read from them)', () => {
    assert.deepEqual(python(`
LISTED = [{"name": "a", "pid": 4242, "cwd": "/tmp", "created": 1.0, "activity": 1.0, "attached": 0,
           "pty_capabilities": ["agent_wake_v1", "human_input_lease_v1"],
           "meta": {"agent": "copilot", "known_agent": "copilot", "nonce": "n1"}}]
async def host(request): return LISTED
server.host = host
async def main():
    live = await server._agent_wake_live(None, server.EventState())
    print(json.dumps([sorted(server.AGENT_WAKE_PRESETS), "copilot" in server.AGENT_MAIL_PRESETS,
                      live[0].get("wake_unsupported", False), "idle_since" in live[0]]))
asyncio.run(main())
`), [['claude', 'gemini', 'opencode', 'vibe'], true, true, false]);
  });
});
