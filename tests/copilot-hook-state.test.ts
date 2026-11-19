// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What the Copilot hooks report must win over what the process arguments say, in every listing the server makes
// (the page, the ten-second snapshot loop, the idle watcher, an adoption, a restore, a session action): a
// listing that left the hooks out would record the argv conversation instead of the one the terminal is in after
// a /new or /resume, and a restart would resume the wrong one. The server is imported and driven with a fake PTY
// host and a fake process listing; no Copilot runs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');

/** Runs Python code after the shared fakes: `described(sid)` is a listing of one Copilot whose argv names ARGV_SID,
 * `hook(state, sid)` records what its plugin reported, and `state_after(sid)` is a fresh hook state holding it. */
function python(code: string): unknown {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hook-state-'));
  const prelude = `
import asyncio, json, sys, time
sys.path.insert(0, ${JSON.stringify(REPO)})
import respawn, server
ARGV_SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
NEW_SID = "11111111-2222-4333-8444-555555555555"
RESUMED_SID = "99999999-8888-4777-8666-555555555555"
RAW = [{"name": "a", "pid": 4242, "cwd": "/tmp", "created": 1.0, "activity": 1.0, "attached": 0,
        "meta": {"agent": "copilot", "known_agent": "copilot", "nonce": "n1"}}]

def described(session_id=ARGV_SID):
    agent = {"type": "copilot", "status": "idle", "session_id": session_id,
             "identity_source": "argv_session" if session_id else None,
             "argv": ["copilot"] + ([f"--resume={session_id}"] if session_id else []), "pid": 4242}
    return {"mesh": [{"id": "a", "name": "a", "kind": "mesh", "created": 1.0, "cwd": "/tmp", "cmd": "copilot",
                      "activity": 1.0, "attached": 0, "known_agent": "copilot", "rank": None, "label": None,
                      "folder": None, "agent": agent}],
            "external": [], "folders": [], "moved": {}, "opens": {}, "home": "/", "now": time.time()}

async def host_identity(): return "h"
async def host_request(request): return RAW
server.ptyhost.host_identity = host_identity
server.ptyhost.request = host_request
ARGV_ONLY = {"session_id": ARGV_SID}
server.list_sessions = lambda raw, listed=True: described(ARGV_ONLY["session_id"])

def hook(state, session, kind="done"):
    event = {"type": kind, "at": time.time(), "received": time.time(), "received_steady": time.monotonic(),
             "id": None, "detail": {"source": "copilot", "session": session}}
    assert state.apply("a", "n1", event)

def recorded():
    """The conversation the snapshot would resume if the PTY host went away now."""
    respawn.update([], True, now=time.time() + 100)
    entry = respawn.lost_entry("a")
    return [entry["agent"]]
`;
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `${prelude}\n${code}`], {
      cwd: REPO, encoding: 'utf8',
      env: {PATH: process.env.PATH, HOME: conf, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: conf, TMPDIR: conf}});
    return JSON.parse(output);
  } finally {
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

const IDS = {argv: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', fresh: '11111111-2222-4333-8444-555555555555',
  resumed: '99999999-8888-4777-8666-555555555555'};

describe('Copilot conversation from the hooks', () => {
  test('a listing made with no explicit state (watcher, adoption, restore) applies the hooks, after /new and /resume too', () => {
    assert.deepEqual(python(`
async def main():
    state = server.EventState()
    server._LIVE_EVENT_STATE = state
    seen = []
    for reported in (NEW_SID, NEW_SID, RESUMED_SID, NEW_SID):    # /new, listing again, /resume, /resume back
        hook(state, reported)
        data = await server.sessions()
        seen.append(data["mesh"][0]["agent"]["session_id"])
        seen.append(data["mesh"][0]["agent"]["session_id"])
    print(json.dumps(seen))
asyncio.run(main())
`), [IDS.fresh, IDS.fresh, IDS.fresh, IDS.fresh, IDS.resumed, IDS.resumed, IDS.fresh, IDS.fresh]);
  });

  test('the snapshot records the conversation of the hooks, not the one read from argv, so a restart resumes it', () => {
    const recorded = python(`
async def main():
    state = server.EventState()
    server._LIVE_EVENT_STATE = state
    hook(state, NEW_SID)
    await server.sessions()                  # the page, the watcher: any listing
    hook(state, RESUMED_SID)
    await server.sessions()
    print(json.dumps([entry["session_id"] for entry in recorded()]))
asyncio.run(main())
`);
    assert.deepEqual(recorded, [IDS.resumed]);
  });

  test('the snapshot loop passes the hook state of the app, also when no module-level state is set', () => {
    const recorded = python(`
async def main():
    state = server.EventState()
    server._LIVE_EVENT_STATE = None          # only the loop's own argument can carry the hooks
    hook(state, NEW_SID)
    server.SNAPSHOT_EVERY = 0.01
    class Nothing:   # no wake line unfollowed, no session request
        def unconfirmed(self): return set()
        def pending(self): return []
    app = {"event_state": state, "organisation_lock": asyncio.Lock(), "sessions_state": server.SessionsState(),
           "claude_wakes": Nothing(), "codex_wakes": Nothing(), "session_requests": Nothing()}
    task = asyncio.create_task(server.snapshot_loop(app))
    await asyncio.sleep(0.5)
    task.cancel()
    print(json.dumps([entry["session_id"] for entry in recorded()]))
asyncio.run(main())
`);
    assert.deepEqual(recorded, [IDS.fresh]);
  });

  test('the hook state of the app is the default of every listing made without one', () => {
    assert.deepEqual(python(`
async def main():
    state = server.EventState()
    server._LIVE_EVENT_STATE = state
    hook(state, NEW_SID)
    data = await server.sessions()
    print(json.dumps(data["mesh"][0]["agent"]["identity_source"]))
asyncio.run(main())
`), 'copilot_hooks');
  });

  test('a Copilot started bare (no conversation in its arguments) is a running conversation for the restore guard', () => {
    assert.deepEqual(python(`
async def main():
    ARGV_ONLY["session_id"] = None
    state = server.EventState()
    server._LIVE_EVENT_STATE = state
    hook(state, NEW_SID)
    print(json.dumps(sorted(server.running_conversations(await server.sessions()))))
asyncio.run(main())
`), [IDS.fresh]);
  });

  test('a session action reads the conversation from the hooks too (a bare Copilot has none without them)', () => {
    assert.deepEqual(python(`
ARGV_ONLY["session_id"] = None
state = server.EventState()
server._LIVE_EVENT_STATE = state
hook(state, NEW_SID)
agent = server._describe_with_hooks(RAW)["mesh"][0]["agent"]
print(json.dumps([agent["session_id"], agent["identity_source"]]))
`), [IDS.fresh, 'copilot_hooks']);
  });

  test('a conversation that is not a UUID is never taken from a hook', () => {
    assert.deepEqual(python(`
async def main():
    state = server.EventState()
    server._LIVE_EVENT_STATE = state
    hook(state, "not-a-uuid-but-long-enough")
    data = await server.sessions()
    print(json.dumps(data["mesh"][0]["agent"]["session_id"]))
asyncio.run(main())
`), IDS.argv);
  });
});

describe('agent tables', () => {
  test('the recovery snapshot knows Copilot and OpenCode (a restore-time parser built on AGENT_TYPES accepts them)', () => {
    assert.deepEqual(python(`
print(json.dumps([sorted(set(("copilot", "opencode")) - set(respawn.AGENT_TYPES)), "copilot" in server.AGENT_TYPES]))
`), [[], true]);
  });
});

describe('Copilot hook helper', () => {
  const run = (code: string): unknown => {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import importlib.machinery, importlib.util, json
loader = importlib.machinery.SourceFileLoader("mesh_event", ${JSON.stringify(path.join(REPO, 'bin', 'mesh-event'))})
spec = importlib.util.spec_from_loader("mesh_event", loader)
mesh_event = importlib.util.module_from_spec(spec)
loader.exec_module(mesh_event)
${code}`], {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH}});
    return JSON.parse(output);
  };

  test('an error that is not recoverable is reported, a recoverable one says nothing', () => {
    assert.deepEqual(run(`
kinds = []
for recoverable in (True, False, None):
    event = mesh_event.copilot_event("errorOccurred", {"recoverable": recoverable, "sessionId": "${IDS.fresh}"}, 1.0)
    kinds.append(event and event["type"])
print(json.dumps(kinds))
`), [null, 'error', null]);
  });

  test('a conversation that is not a UUID is not reported', () => {
    assert.deepEqual(run(`
good = mesh_event.copilot_event("agentStop", {"sessionId": "${IDS.fresh}"}, 1.0)
bad = mesh_event.copilot_event("agentStop", {"sessionId": "not-a-uuid-but-long-enough"}, 1.0)
print(json.dumps([good["detail"].get("session"), bad["detail"].get("session")]))
`), [IDS.fresh, null]);
  });
});
